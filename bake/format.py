"""The baked data format: one binary file per city and month, plus a JSON sidecar.

`{city}/{MM}.bin`, little-endian throughout:

    header (32 bytes)
      0  char[4]  magic "RFB1"
      4  u16      version (1)
      6  u16      flags (bit 0: Radiance lux present)
      8  u16      n_slots
     10  u16      n_states (the sidecar's `states` lists them in order)
     12  u32      record_bytes (4352)
     16  u8       month (1-12)
     17  u8       city index (manifest order)
     18  u16      reserved (0)
     20  u32      reserved (0)
     24  u32      reserved (0)
     28  u32      CRC-32 of everything after the header

    records, slot-major then state: record (slot, state) at 32 + (slot * n_states + state) * 4352
      +0     u8[256]    facade: bit i = wall*512 + row*32 + col, walls S,N,E,W, row 0 = ceiling,
                        LSB-first within each byte, 1 = window
      +256   u16[1024]  surrogate lux on the 0.6 m plane, floor grid row-major (row 0 = N edge)
      +2304  u16[1024]  Radiance lux, same grid

Lux is rounded and clamped to 0..65534; 65535 means missing (Radiance not run or failed).
Metrics are computed from the float values before quantising (report.py).
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

import numpy as np

MAGIC = b"RFB1"
VERSION = 1
FLAG_RADIANCE = 1
HEADER = struct.Struct("<4sHHHHIBBHIII")
FACADE_BYTES = 256
GRID = 1024
RECORD_BYTES = FACADE_BYTES + 2 * 2 * GRID
MISSING = 65535
assert HEADER.size == 32 and RECORD_BYTES == 4352


def pack_bits(binary) -> bytes:
    flat = np.asarray(binary, dtype=np.uint8).reshape(-1)
    if flat.size != 2048:
        raise ValueError(f"facade must have 2048 panels, got {flat.size}")
    return np.packbits(flat > 0, bitorder="little").tobytes()


def unpack_bits(data: bytes) -> np.ndarray:
    return np.unpackbits(np.frombuffer(data, dtype=np.uint8), bitorder="little")[:2048]


def encode_lux(lux) -> bytes:
    if lux is None:
        return np.full(GRID, MISSING, dtype="<u2").tobytes()
    a = np.asarray(lux, dtype=np.float64).reshape(-1)
    if a.size != GRID:
        raise ValueError(f"lux grid must have {GRID} cells, got {a.size}")
    out = np.where(np.isfinite(a), np.clip(np.rint(a), 0, MISSING - 1), MISSING)
    return out.astype("<u2").tobytes()


def decode_lux(data: bytes) -> np.ndarray:
    a = np.frombuffer(data, dtype="<u2").astype(np.float32)
    a[a == MISSING] = np.nan
    return a


def write_month(path: Path, month: int, city_index: int, records: list) -> int:
    """records[slot][state] = (binary, lux_surrogate, lux_radiance | None). Returns bytes."""
    n_slots = len(records)
    n_states = len(records[0]) if records else 0
    body = bytearray()
    has_rad = False
    for row in records:
        if len(row) != n_states:
            raise ValueError("every slot needs the same states")
        for binary, sur, rad in row:
            has_rad |= rad is not None
            body += pack_bits(binary) + encode_lux(sur) + encode_lux(rad)
    header = HEADER.pack(MAGIC, VERSION, FLAG_RADIANCE if has_rad else 0, n_slots, n_states,
                         RECORD_BYTES, month, city_index, 0, 0, 0, zlib.crc32(body))
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(header + bytes(body))
    tmp.replace(path)
    return len(header) + len(body)


def read_month(path: Path) -> dict:
    data = path.read_bytes()
    (magic, version, flags, n_slots, n_states, rec, month, city_index,
     _r16, _r32a, _r32b, crc) = HEADER.unpack_from(data, 0)
    if magic != MAGIC or version != VERSION or rec != RECORD_BYTES:
        raise ValueError(f"{path}: not an RFB1 v{VERSION} file")
    body = data[HEADER.size:]
    if len(body) != n_slots * n_states * rec or zlib.crc32(body) != crc:
        raise ValueError(f"{path}: size or CRC mismatch")
    fac = np.zeros((n_slots, n_states, 2048), dtype=np.uint8)
    sur = np.zeros((n_slots, n_states, GRID), dtype=np.float32)
    rad = np.zeros((n_slots, n_states, GRID), dtype=np.float32)
    for s in range(n_slots):
        for k in range(n_states):
            o = (s * n_states + k) * rec
            fac[s, k] = unpack_bits(body[o:o + FACADE_BYTES])
            sur[s, k] = decode_lux(body[o + FACADE_BYTES:o + FACADE_BYTES + 2 * GRID])
            rad[s, k] = decode_lux(body[o + FACADE_BYTES + 2 * GRID:o + rec])
    return {"month": month, "city_index": city_index, "flags": flags, "n_slots": n_slots,
            "n_states": n_states, "facades": fac, "lux_surrogate": sur, "lux_radiance": rad}
