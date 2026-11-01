"""Per-record metrics (shared with pack.py) and the bake report, bake/reports/bake_report.md.

Attainment uses v3's own `zone_stats` (the optimizer's comfort band, ZONE_MIN_RATIO to
ZONE_MAX_RATIO of each zone's target), so the report scores what the optimizer was scored on.
Surrogate-vs-Radiance agreement uses v3's `verify_facade_radiance.agreement`, in the state's
zones. Glare counts floor cells above the glare cap (3000 lux) anywhere on the floor: v3
penalises it inside zones (`zone_penalty_sum`) and outside them (`outside_glare_sum`).
"""

from __future__ import annotations

import json
import statistics
from collections import defaultdict

import numpy as np

from . import config, room, slots, verify
from .solve import chain_path

_CACHE: dict = {}


def _state_info(sid: str):
    if "states" not in _CACHE:
        _CACHE["states"] = {s.id: s for s in room.states()}
    if sid not in _CACHE:
        if sid == "baseline":
            # The baseline is judged against the ambient brief: 200 lux over the whole floor.
            st = _CACHE["states"]["ambient"]
        else:
            st = _CACHE["states"][sid]
        tgt, owner = room.target_and_owner(st)
        _CACHE[sid] = (room.occupants(st), owner, tgt)
    return _CACHE[sid]


def _above(ls, occs, owner, lux) -> list[float]:
    """Share of each zone above the comfort band (the rest of the miss is below it)."""
    return [round(float(np.mean(lux[owner == i] > o.target_lux * ls.ZONE_MAX_RATIO)) * 100, 1)
            for i, o in enumerate(occs)]


def metrics(sid: str, lux_sur, lux_rad) -> dict:
    """In-band and above-band % per zone (surrogate and Radiance), glare cells, in-zone MAE/bias."""
    ls = config.import_v3().live_solver
    occs, owner, _tgt = _state_info(sid)
    sur = np.asarray(lux_sur, dtype=np.float32).reshape(32, 32)
    out = {"in_band_sur": [round(z["in_band"], 1) for z in ls.zone_stats(occs, owner, sur)],
           "above_sur": _above(ls, occs, owner, sur),
           "glare_sur": int((sur > config.GLARE_CAP).sum())}
    if lux_rad is not None:
        rad = np.asarray(lux_rad, dtype=np.float32).reshape(32, 32)
        out["in_band_rad"] = [round(z["in_band"], 1) for z in ls.zone_stats(occs, owner, rad)]
        out["above_rad"] = _above(ls, occs, owner, rad)
        out["glare_rad"] = int((rad > config.GLARE_CAP).sum())
        zone = owner >= 0
        err = sur[zone] - rad[zone]
        out["zone_mae"] = round(float(np.abs(err).mean()), 1)
        out["zone_bias"] = round(float(err.mean()), 1)
    return out


def _fmt(v, nd=1):
    return "–" if v is None or v != v else f"{v:.{nd}f}"


def build(cities, months) -> dict:
    """Gather chains, Radiance results and metrics for the report."""
    v3 = config.import_v3()
    rad_params = verify._rad_params()
    rows = []
    for city in cities:
        for month in months:
            _tasks, keys = verify.collect(v3, city, month, rad_params)
            for sid in verify.month_states():
                doc = json.loads(chain_path(city, month, sid).read_text())
                for k, rec in enumerate(doc["slots"]):
                    rad = verify.load_result(keys[(sid, k)])
                    m = metrics(sid, rec["lux_surrogate"], rad)
                    rows.append({"city": city, "month": month, "state": sid, "slot": rec["slot"],
                                 "kind": ("baseline" if sid == "baseline" else
                                          "standing" if sid.startswith("stand_") else "activity"),
                                 **{f: rec.get(f) for f in ("ship", "L_cold", "L_warm", "L_ship",
                                                            "flips", "flips_cold_only",
                                                            "t_cold", "t_warm")},
                                 "rad_ok": rad is not None, **m})
    return {"rows": rows}


def write(cities, months, extra: dict | None = None) -> str:
    data = build(cities, months)
    rows = data["rows"]
    solved = [r for r in rows if r["kind"] != "baseline"]
    chained = [r for r in solved if r["L_warm"] is not None]
    by_kind = defaultdict(list)
    for r in solved:
        by_kind[r["kind"]].append(r)
    mean = lambda xs: statistics.fmean(xs) if xs else float("nan")
    zone0 = lambda r, k: r[k][0] if r.get(k) else float("nan")
    lines = ["# Bake report", ""]
    days = sorted({(r["city"], r["month"]) for r in rows})
    lines += [f"Bake: {', '.join(f'{c} {m:02d}' for c, m in days)}, on each month's "
              f"median-GHI day. {len(solved)} solves "
              f"({len({(r['city'], r['month'], r['state']) for r in solved})} chains), "
              f"plus the baseline at every slot.", ""]
    if extra:
        lines += [f"- {k}: {v}" for k, v in extra.items()] + [""]

    lines += ["## Warm and cold", "",
              f"- Warm shipped at {sum(r['ship'] == 'warm' for r in chained)} of {len(chained)} "
              f"chained slots ({sum(r['ship'] == 'warm' for r in chained) / max(1, len(chained)) * 100:.0f}%).",
              f"- Panel flips between hours: {mean([r['flips'] for r in chained]):.0f} shipped on "
              f"average, against {mean([r['flips_cold_only'] for r in chained]):.0f} for a cold-only "
              f"bake.",
              f"- Loss of the shipped design relative to cold: "
              f"{mean([r['L_ship'] / r['L_cold'] for r in chained if r['L_cold']]):.3f} on average.",
              f"- Solve time: cold {mean([r['t_cold'] for r in solved]):.1f} s, warm "
              f"{mean([r['t_warm'] for r in chained]):.1f} s per slot.", ""]

    lines += ["## Attainment (share of each zone within v3's comfort band)", "",
              "| States | Records | In band, surrogate | In band, Radiance | Above band, Radiance | Glare cells, surrogate | Glare cells, Radiance |",
              "|---|---|---|---|---|---|---|"]
    base = [r for r in rows if r["kind"] == "baseline"]
    groups = [("activity", by_kind["activity"]), ("standing", by_kind["standing"]),
              ("ambient only", [r for r in solved if r["state"] == "ambient"]),
              ("baseline (vs the 200 lux ambient brief)", base)]
    for label, rs in groups:
        rr = [r for r in rs if r["rad_ok"]]
        lines.append(f"| {label} | {len(rs)} | {_fmt(mean([zone0(r, 'in_band_sur') for r in rs]))}% | "
                     f"{_fmt(mean([zone0(r, 'in_band_rad') for r in rr]))}% | "
                     f"{_fmt(mean([zone0(r, 'above_rad') for r in rr]))}% | "
                     f"{_fmt(mean([r['glare_sur'] for r in rs]))} | "
                     f"{_fmt(mean([r['glare_rad'] for r in rr]))} |")
    lines += ["", "Glare cells are floor cells above 3000 lux, of 1024. Zone shares are for the "
              "state's first zone (the occupant).", ""]

    lines += ["### Activity states", "",
              "| State | In band, surrogate | In band, Radiance | Zone MAE (lux) | Zone bias (lux, surrogate minus Radiance) | Warm shipped |",
              "|---|---|---|---|---|---|"]
    for sid in [s.id for s in room.states() if s.kind != "standing"]:
        rs = [r for r in solved if r["state"] == sid]
        ch = [r for r in rs if r["L_warm"] is not None]
        lines.append(f"| {sid} | {_fmt(mean([zone0(r, 'in_band_sur') for r in rs]))}% | "
                     f"{_fmt(mean([zone0(r, 'in_band_rad') for r in rs if r['rad_ok']]))}% | "
                     f"{_fmt(mean([r['zone_mae'] for r in rs if r['rad_ok']]), 0)} | "
                     f"{_fmt(mean([r['zone_bias'] for r in rs if r['rad_ok']]), 0)} | "
                     f"{sum(r['ship'] == 'warm' for r in ch)}/{len(ch)} |")
    lines.append("")

    radded = [r for r in solved if r["rad_ok"]]
    lines += ["## Surrogate against Radiance", "",
              f"- Radiance results for {sum(r['rad_ok'] for r in rows)} of {len(rows)} records "
              f"({len(rows) - sum(r['rad_ok'] for r in rows)} missing or failed).",
              f"- In the zones: MAE {mean([r['zone_mae'] for r in radded]):.0f} lux, bias "
              f"{mean([r['zone_bias'] for r in radded]):+.0f} lux (surrogate minus Radiance).",
              f"- Records where the surrogate is high in the zone: "
              f"{sum(r['zone_bias'] > 0 for r in radded)} of {len(radded)}.", ""]

    path = config.assert_writable(config.WS / "bake" / "reports" / "bake_report.md")
    path.write_text("\n".join(lines) + "\n")
    (path.parent / "bake_rows.json").write_text(json.dumps(rows))
    return str(path)
