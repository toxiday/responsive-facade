"""Write the site's per-month data: web/public/data/{city}/{MM}.bin and {MM}.json.

The binary layout is in format.py (and web/public/data/FORMAT.md). The sidecar lists the
slots (stamp, sun, sky), the state order of the records (the manifest's states, then
"baseline"), and per record the solve outcome and metrics (report.metrics), so the site and
its consistency test have the reference numbers.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from . import bench, config, format as fmt, report, slots, verify
from .solve import bits_from_hex, chain_path

SIZE_BUDGET = 20 * 2 ** 20      # guidelines: all data <= 20 MB (open question at 66 states)


def pack_month(city: str, month: int) -> dict:
    v3 = config.import_v3()
    rad_params = verify._rad_params()
    day = slots.load(city)["months"][month - 1]
    states = verify.month_states()
    docs = {sid: json.loads(chain_path(city, month, sid).read_text()) for sid in states}
    records, meta = [], {sid: {"ship": [], "flips": [], "metrics": []} for sid in states}
    for k, slot in enumerate(day["slots"]):
        sun = v3.vfr.cond_to_sun(bench.condition(v3, slot)[0])
        row = []
        for sid in states:
            rec = docs[sid]["slots"][k]
            if rec["slot"] != slot["label"]:
                raise ValueError(f"{city} {month} {sid}: slot {k} is {rec['slot']}, "
                                 f"expected {slot['label']}")
            rad = verify.load_result(verify.run_key(rec["facade"], sun, rad_params))
            row.append((bits_from_hex(rec["facade"]), rec["lux_surrogate"], rad))
            meta[sid]["ship"].append(rec["ship"])
            meta[sid]["flips"].append(rec.get("flips"))
            meta[sid]["metrics"].append(report.metrics(sid, rec["lux_surrogate"], rad))
        records.append(row)

    out_dir = config.assert_writable(config.WEB_DATA / city)
    out_dir.mkdir(parents=True, exist_ok=True)
    city_index = list(config.CITIES).index(city)
    size = fmt.write_month(out_dir / f"{month:02d}.bin", month, city_index, records)
    sidecar = {
        "schema": 1, "city": city, "month": month, "day": day["day"],
        "record_bytes": fmt.RECORD_BYTES, "states": states,
        "slots": [{k: s[k] for k in ("label", "hour", "alt", "az_true", "sun_room", "dni",
                                     "dhi", "sky")} for s in day["slots"]],
        "records": meta,
    }
    (out_dir / f"{month:02d}.json").write_text(json.dumps(sidecar, separators=(",", ":")))
    return {"city": city, "month": month, "bytes": size, "slots": len(records),
            "states": len(states)}


def data_size() -> int:
    return sum(p.stat().st_size for p in Path(config.WEB_DATA).rglob("*") if p.is_file())


def run(cities, months) -> list[dict]:
    out = [pack_month(c, m) for c in cities for m in months]
    total = data_size()
    for r in out:
        print(f"  {r['city']} {r['month']:02d}: {r['slots']} slots x {r['states']} states, "
              f"{r['bytes'] / 2 ** 20:.2f} MB")
    print(f"  data total {total / 2 ** 20:.2f} MB (budget {SIZE_BUDGET / 2 ** 20:.0f} MB)")
    return out
