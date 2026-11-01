# Baked data format

Written by `python -m bake pack` (`bake/format.py`, `bake/pack.py`). All binaries are
little-endian.

## Files

| File | What |
|---|---|
| `index.json` | `{"schema": 1, "months": {city: [month, ...]}}`: the city-months that have data; the site offers only these |
| `manifest.json` | Room, conventions, furniture, activities, occupant states (zones and owner grids), legend, cities and their baked days |
| `{city}/{MM}.bin` | Facades and lux for every slot of that month's baked day, for every state |
| `{city}/{MM}.json` | Slot list (stamp, sun, sky), the record state order, solve outcome and metrics per record |

## `{city}/{MM}.bin`

Header, 32 bytes:

| Offset | Type | Field |
|---|---|---|
| 0 | char[4] | magic `RFB1` |
| 4 | u16 | version, 1 |
| 6 | u16 | flags; bit 0 = Radiance lux present |
| 8 | u16 | `n_slots` |
| 10 | u16 | `n_states` (the sidecar's `states` lists them in order) |
| 12 | u32 | `record_bytes`, 4352 |
| 16 | u8 | month, 1–12 |
| 17 | u8 | city index, in manifest order |
| 18 | u16 | reserved, 0 |
| 20 | u32 | reserved, 0 |
| 24 | u32 | reserved, 0 |
| 28 | u32 | CRC-32 of everything after the header |

Records follow, slot-major then state. Record `(slot, state)` starts at
`32 + (slot * n_states + state) * 4352`:

| Offset | Type | Field |
|---|---|---|
| +0 | u8[256] | facade: bit `i = wall*512 + row*32 + col`, walls S, N, E, W, row 0 = ceiling, LSB-first within each byte, 1 = window |
| +256 | u16[1024] | surrogate lux on the 0.6 m work plane, floor grid row-major (row 0 = N edge, col 0 = W edge) |
| +2304 | u16[1024] | Radiance lux, same grid |

Lux is rounded and clamped to 0–65534; **65535 means missing** (Radiance not run, or failed
twice). Metrics in the sidecar are computed from the float values before quantising.

## State order

The sidecar's `states` array: the manifest's states in order (activity states, then the
standing positions), then `baseline`, the conventional L05 facade at the same slot.
