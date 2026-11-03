"""The schedule-specific facade (Tony, 2026-11-03): one fixed panel design per city, made by
v3's optimizer for the occupant's daily routine. Nothing moves; it is the facade a designer
would build once for that routine.

The design is optimised over every baked hour of the four seasons at once (`optimize_coarse_to_
fine` takes many conditions, each with its own target), each hour with the target of the
activity the daily routine has then: the app's own plan (web/src/app/day_plan.json, read by
schedule.ts), so the occupant in the app is where the facade was designed for them to be.
Every hour counts the same. The optimizer depends on its start, so it runs from SEEDS seeds and
the design with the lowest deployed loss over all the hours (v3's `seed_sweep.deployed_loss`,
glare weight 0.25 as in the bake) is kept.

    python -m bake.schedule_facade solve   bake/work/schedule/{city}.json
    python -m bake.schedule_facade verify  Radiance for the design at every hour (the bake's
                                           runner and result cache)
    python -m bake.schedule_facade pack    web/public/data/{city}/{MM}.schedule.bin and .json
    python -m bake.schedule_facade report  bake/reports/schedule_report.md

The site's files have the RFB1 layout of the month files (FORMAT.md) with one state,
"schedule": one record per hour, the same design in each. The sidecar adds "plan", the state
the routine has at each hour, and each record's metrics are the bake's for that state. The
index lists the city-months with files under "schedule" (bake/pack.py).
"""

from __future__ import annotations

import argparse
import json
import time

import numpy as np

from . import bench, config, radiance, report, room, slots, verify
from . import format as fmt
from . import pack as bake_pack
from .solve import _atomic_write, _bits_hex, bits_from_hex, chain_path

DAY_PLAN_JSON = config.WEB / "src" / "app" / "day_plan.json"
MONTHS = (3, 6, 9, 12)
SEEDS = (0, 1, 2, 3)
WORK = config.WORK / "schedule"
REPORT = config.REPORTS / "schedule_report.md"
KINDS = ("responsive", "shades", "schedule", "conventional")  # the report's columns


def day_plan() -> list[tuple[str, str]]:
    return [(at, sid) for at, sid in json.loads(DAY_PLAN_JSON.read_text(encoding="utf-8"))]


def planned_state(label: str, plan=None) -> str:
    """The routine's state at an hour: the entry at or before it, the first before the first
    (schedule.ts: plannedState)."""
    plan = plan or day_plan()
    state = plan[0][1]
    for at, sid in plan:
        if at <= label:
            state = sid
    return state


def hours(city: str, months=MONTHS) -> list[dict]:
    """Every baked hour of the city's months, with the routine's state then."""
    plan = day_plan()
    out = []
    for month in months:
        for slot in slots.load(city)["months"][month - 1]["slots"]:
            out.append({"month": month, "slot": slot, "state": planned_state(slot["label"], plan)})
    return out


def doc_path(city: str):
    return WORK / f"{city}.json"


# ---------------------------------------------------------------------------
# Solve
# ---------------------------------------------------------------------------

def solve(cities, force=False) -> list[dict]:
    config.check_venv()
    v3, solver = bench.make_solver()
    states = {s.id: s for s in room.states()}
    targets = {}
    out = []
    for city in cities:
        if doc_path(city).exists() and not force:
            print(f"schedule solve: {city} done", flush=True)
            continue
        hrs = hours(city)
        cond = np.vstack([bench.condition(v3, h["slot"]) for h in hrs])
        for h in hrs:
            if h["state"] not in targets:
                targets[h["state"]] = room.target_and_owner(states[h["state"]])[0]
        tgt = np.concatenate([targets[h["state"]] for h in hrs])
        w = np.ones(len(hrs))
        runs = []
        for seed in SEEDS:
            t0 = time.perf_counter()
            binary, _hist = bench.cold(v3, solver, cond, tgt, None, seed)
            loss = float(v3.seed_sweep.deployed_loss(solver.opt, binary, cond, tgt, w,
                                                     config.GLARE_WEIGHT, config.GLARE_CAP))
            runs.append({"seed": seed, "loss": loss, "seconds": round(time.perf_counter() - t0, 1),
                         "binary": binary})
            print(f"  {city} seed {seed}: loss {loss:.4f}, {runs[-1]['seconds']:.0f} s", flush=True)
        best = min(runs, key=lambda r: r["loss"])
        lux = solver.opt.predict_lux(best["binary"], cond)
        doc = {
            "city": city, "months": list(MONTHS), "plan": day_plan(),
            "settings": {"seeds": list(SEEDS), "schedule": "full",
                         "glare_weight": config.GLARE_WEIGHT, "glare_cap": config.GLARE_CAP},
            "seeds": [{k: r[k] for k in ("seed", "loss", "seconds")} for r in runs],
            "seed": best["seed"], "loss": best["loss"], "facade": _bits_hex(best["binary"]),
            "open_panels": int(best["binary"].sum()),
            "hours": [{"month": h["month"], "slot": h["slot"]["label"], "state": h["state"],
                       "lux_surrogate": np.rint(lux[i]).astype(int).reshape(-1).tolist()}
                      for i, h in enumerate(hrs)],
            "provenance": {k: v for k, v in config.provenance().items() if k != "pipeline"},
        }
        WORK.mkdir(parents=True, exist_ok=True)
        _atomic_write(config.assert_writable(doc_path(city)), json.dumps(doc))
        out.append({"city": city, "loss": best["loss"], "seed": best["seed"]})
    return out


# ---------------------------------------------------------------------------
# Radiance
# ---------------------------------------------------------------------------

def _sun(v3, slot):
    return v3.vfr.cond_to_sun(bench.condition(v3, slot)[0])


def verify_runs(cities, workers: int) -> dict:
    config.check_venv()
    v3 = config.import_v3()
    verify.RESULTS.mkdir(parents=True, exist_ok=True)
    rad_params = verify._rad_params()
    tasks, seen = [], set()
    for city in cities:
        doc = json.loads(doc_path(city).read_text())
        for h in hours(city, doc["months"]):
            alt, az, dni, dhi = _sun(v3, h["slot"])
            key = verify.run_key(doc["facade"], (alt, az, dni, dhi), rad_params)
            if key in seen or verify.load_result(key) is not None:
                continue
            seen.add(key)
            tasks.append({"key": key,
                          "facades": v3.vfr.binary_to_scene_facades(bits_from_hex(doc["facade"])),
                          "room": (config.ROOM_W, config.ROOM_D, config.ROOM_H),
                          "alt": alt, "az": az, "dni": dni, "dhi": dhi,
                          "work_dir": str(verify.SCRATCH / key)})
    print(f"schedule verify: {len(tasks)} Radiance run(s) on {workers} worker(s)", flush=True)
    t0, failed = time.perf_counter(), []
    for i, res in enumerate(radiance.run_iter(tasks, str(config.GEN_PY), str(config.TMP),
                                              workers), 1):
        if res["error"]:
            failed.append(res["key"])
            continue
        plan = v3.vfr.sensors_to_plan(res["lux"])
        verify.result_path(res["key"]).write_text(json.dumps(
            {"lux": np.round(plan, 1).tolist(), "seconds": round(res["seconds"], 2)}))
        if i % 25 == 0 or i == len(tasks):
            print(f"  {i}/{len(tasks)} runs, {(time.perf_counter() - t0) / 60:.1f} min",
                  flush=True)
    return {"runs": len(tasks), "failed": failed, "minutes": (time.perf_counter() - t0) / 60}


# ---------------------------------------------------------------------------
# Pack
# ---------------------------------------------------------------------------

def pack(cities) -> list[dict]:
    v3 = config.import_v3()
    rad_params = verify._rad_params()
    out = []
    for city in cities:
        doc = json.loads(doc_path(city).read_text())
        binary = bits_from_hex(doc["facade"])
        by_month: dict[int, list] = {}
        for h, rec in zip(hours(city, doc["months"]), doc["hours"]):
            if (h["month"], h["slot"]["label"], h["state"]) != (rec["month"], rec["slot"],
                                                                 rec["state"]):
                raise ValueError(f"{city}: the hours changed since the solve; solve again")
            rad = verify.load_result(verify.run_key(doc["facade"], _sun(v3, h["slot"]),
                                                    rad_params))
            by_month.setdefault(h["month"], []).append((h, rec, rad))
        out_dir = config.assert_writable(config.WEB_DATA / city)
        out_dir.mkdir(parents=True, exist_ok=True)
        city_index = list(config.CITIES).index(city)
        for month, rows in by_month.items():
            day = slots.load(city)["months"][month - 1]
            records = [[(binary, rec["lux_surrogate"], rad)] for _h, rec, rad in rows]
            size = fmt.write_month(out_dir / f"{month:02d}.schedule.bin", month, city_index,
                                   records)
            sidecar = {
                "schema": 1, "city": city, "month": month, "day": day["day"],
                "record_bytes": fmt.RECORD_BYTES, "states": ["schedule"],
                "slots": [{k: s[k] for k in ("label", "hour", "alt", "az_true", "sun_room",
                                             "dni", "dhi", "sky")} for s in day["slots"]],
                "plan": [h["state"] for h, _rec, _rad in rows],
                "records": {"schedule": {
                    "ship": ["fixed"] * len(rows), "flips": [None] * len(rows),
                    "metrics": [report.metrics(h["state"], rec["lux_surrogate"], rad)
                                for h, rec, rad in rows]}},
            }
            (out_dir / f"{month:02d}.schedule.json").write_text(
                json.dumps(sidecar, separators=(",", ":")))
            n_rad = sum(rad is not None for _h, _rec, rad in rows)
            print(f"  {city} {month:02d}: {len(rows)} hours, {size / 1024:.0f} KB, "
                  f"Radiance for {n_rad} of {len(rows)}", flush=True)
            out.append({"city": city, "month": month, "bytes": size, "radiance": n_rad})
    index = bake_pack.write_index()
    print(f"  index: {index}")
    return out


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def build_report(cities) -> str:
    """Along the routine, hour by hour: the share of the occupant's zone in v3's band
    (Radiance) with the schedule-specific facade, the responsive facade (its design for that
    hour's state), the operable shades (shade_optimizer/, the same) and the conventional
    windows."""
    from shade_optimizer.run import chain_path as shade_chain_path  # it imports bake

    v3 = config.import_v3()
    rad_params = verify._rad_params()

    def in_band(sid, facade_hex, sur, slot):
        rad = verify.load_result(verify.run_key(facade_hex, _sun(v3, slot), rad_params))
        m = report.metrics(sid, sur, rad)
        return (m["in_band_rad"] if rad is not None else m["in_band_sur"])[0], rad is not None

    lines = ["# Schedule-specific facade", "",
             "One fixed design per city, optimised by v3's coarse-to-fine optimizer over every "
             "baked hour of March, June, September and December, each hour with the target of "
             "the daily routine's activity then (web/src/app/day_plan.json). Best of "
             f"{len(SEEDS)} seeds by deployed loss.", "",
             "## The designs", "",
             "| City | Hours | Loss (best seed) | Seeds | Open panels |", "|---|---|---|---|---|"]
    rows = []
    for city in cities:
        doc = json.loads(doc_path(city).read_text())
        seeds = ", ".join(f"{s['loss']:.4f}" for s in doc["seeds"])
        lines.append(f"| {city} | {len(doc['hours'])} | {doc['loss']:.4f} (seed {doc['seed']}) | "
                     f"{seeds} | {doc['open_panels']} of 1024 (S and W walls) |")
        for h, rec in zip(hours(city, doc["months"]), doc["hours"]):
            sid, slot, month = h["state"], h["slot"], h["month"]
            fixed = in_band(sid, doc["facade"], rec["lux_surrogate"], slot)
            k = [s["label"] for s in slots.load(city)["months"][month - 1]["slots"]].index(
                slot["label"])
            resp = json.loads(chain_path(city, month, sid).read_text())["slots"][k]
            base = json.loads(chain_path(city, month, "baseline").read_text())["slots"][k]
            shade = json.loads(shade_chain_path(city, month, sid).read_text())["slots"][k]
            rows.append({"city": city, "month": month, "state": sid,
                         "schedule": fixed,
                         "responsive": in_band(sid, resp["facade"], resp["lux_surrogate"], slot),
                         "shades": in_band(sid, shade["facade"], shade["lux_surrogate"], slot),
                         "conventional": in_band(sid, base["facade"], base["lux_surrogate"],
                                                 slot)})
    lines += ["", "## Time in band along the routine", "",
              "Share of the occupant's zone within v3's comfort band at each hour of the "
              "routine, averaged over the hours (Radiance; the surrogate where a run is "
              "missing).", "",
              "| City | Season | Hours | Responsive | Operable shades | Schedule-specific | "
              "Conventional |", "|---|---|---|---|---|---|---|"]

    def mean(rs, key):
        return sum(r[key][0] for r in rs) / len(rs)

    def cells(rs):
        return " | ".join(f"{mean(rs, k):.1f}%" for k in KINDS) + " |"

    for city in cities:
        for month in MONTHS:
            rs = [r for r in rows if r["city"] == city and r["month"] == month]
            if rs:
                lines.append(f"| {city} | {month:02d} | {len(rs)} | " + cells(rs))
    lines.append(f"| all | | {len(rows)} | " + cells(rows))
    missing = sum(not r[k][1] for r in rows for k in KINDS)
    lines += ["", f"Radiance missing for {missing} of {len(KINDS) * len(rows)} hour-designs.",
              "", "## By activity", "", "| Activity | Hours | Responsive | Operable shades | "
              "Schedule-specific | Conventional |", "|---|---|---|---|---|---|"]
    for sid in dict.fromkeys(r["state"] for r in rows):
        rs = [r for r in rows if r["state"] == sid]
        lines.append(f"| {sid} | {len(rs)} | " + cells(rs))
    return "\n".join(lines) + "\n"


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m bake.schedule_facade")
    p.add_argument("cmd", choices=("solve", "verify", "pack", "report"))
    p.add_argument("--city", default=",".join(config.CITIES))
    p.add_argument("--workers", type=int, default=20)
    p.add_argument("--force", action="store_true")
    a = p.parse_args(argv)
    cities = a.city.split(",")
    if a.cmd == "solve":
        print(solve(cities, a.force))
    elif a.cmd == "verify":
        r = verify_runs(cities, a.workers)
        print(f"schedule verify: {r['runs']} run(s) in {r['minutes']:.1f} min, "
              f"{len(r['failed'])} failed")
        return 1 if r["failed"] else 0
    elif a.cmd == "pack":
        pack(cities)
    elif a.cmd == "report":
        REPORT.parent.mkdir(parents=True, exist_ok=True)
        config.assert_writable(REPORT).write_text(build_report(cities), encoding="utf-8")
        print(REPORT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
