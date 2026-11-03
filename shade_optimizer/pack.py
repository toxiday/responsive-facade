"""The site's shade data: web/public/data/{city}/{MM}.shades.bin and {MM}.shades.json.

The same RFB1 layout as the responsive facade's month files (bake/format.py, FORMAT.md), one
record per (slot, state) for every state in the manifest. There is no baseline record: the
conventional facade is the shades' frame ("frame" in the sidecar, as packed facade bits). The
sidecar is a month sidecar with, per record, how far each shade is lowered ("drops", rows,
window by window as in "windows"), whether the shades were solved or kept from the hour before
("ship") and how many moved ("flips"), and the bake's metrics for the record. bake/pack.py's
index lists the city-months that have shade files under "shades".
"""

from __future__ import annotations

import json

from bake import bench, config, report, room, slots, verify
from bake import format as fmt
from bake import pack as bake_pack
from bake.solve import _bits_hex, bits_from_hex

from .run import chain_path
from .shades import load_baseline


def pack_month(city: str, month: int) -> dict:
    v3 = config.import_v3()
    rad_params = verify._rad_params()
    day = slots.load(city)["months"][month - 1]
    states = [s.id for s in room.states()]
    docs = {sid: json.loads(chain_path(city, month, sid).read_text()) for sid in states}
    meta = {sid: {"ship": [], "flips": [], "drops": [], "metrics": []} for sid in states}
    records, n_rad = [], 0
    for k, slot in enumerate(day["slots"]):
        sun = v3.vfr.cond_to_sun(bench.condition(v3, slot)[0])
        row = []
        for sid in states:
            rec = docs[sid]["slots"][k]
            if rec["slot"] != slot["label"]:
                raise ValueError(f"{city} {month} {sid}: slot {k} is {rec['slot']}, "
                                 f"expected {slot['label']}")
            rad = verify.load_result(verify.run_key(rec["facade"], sun, rad_params))
            n_rad += rad is not None
            row.append((bits_from_hex(rec["facade"]), rec["lux_surrogate"], rad))
            meta[sid]["ship"].append(rec["ship"])
            meta[sid]["flips"].append(rec["moved"])
            meta[sid]["drops"].append(rec["drops"])
            meta[sid]["metrics"].append(report.metrics(sid, rec["lux_surrogate"], rad))
        records.append(row)

    out_dir = config.assert_writable(config.WEB_DATA / city)
    out_dir.mkdir(parents=True, exist_ok=True)
    city_index = list(config.CITIES).index(city)
    size = fmt.write_month(out_dir / f"{month:02d}.shades.bin", month, city_index, records)
    sidecar = {
        "schema": 1, "city": city, "month": month, "day": day["day"],
        "record_bytes": fmt.RECORD_BYTES, "states": states,
        "slots": [{k: s[k] for k in ("label", "hour", "alt", "az_true", "sun_room", "dni",
                                     "dhi", "sky")} for s in day["slots"]],
        "records": meta,
        "windows": docs[states[0]]["windows"],
        "frame": _bits_hex(load_baseline(v3)),
    }
    (out_dir / f"{month:02d}.shades.json").write_text(json.dumps(sidecar, separators=(",", ":")))
    return {"city": city, "month": month, "bytes": size, "slots": len(records),
            "states": len(states), "records": len(records) * len(states), "radiance": n_rad}


def write_index() -> dict:
    return bake_pack.write_index()
