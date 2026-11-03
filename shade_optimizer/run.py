"""Shade chains through a baked day, the exhaustive check, Radiance and the report.

A chain is one (city, month, state) through the day's baked hours, like the bake's. At each
hour the optimizer starts from all up, half, all down and the previous hour's shades. The
previous hour's shades stay put if their deployed loss is within KEEP_TOL of the best (the
bake's warm-vs-cold rule), so shades don't move for nothing. Each chain is written atomically
to shade_optimizer/work/solve/{city}/{MM}/{state}.json, with the conventional facade's loss
at each hour beside the shades' (all shades up is the conventional facade).

Radiance runs go through the bake's runner and share its result cache (bake/verify.py: keyed
by design and sun, so an all-up design reuses the conventional facade's run). The report puts
the conventional facade, the shades and the responsive facade side by side for each state,
with the bake's own metrics (bake/report.py: v3's zone_stats). `compare` runs the optimizer's
methods (optimize.py) on the same hours and writes reports/methods.md.
"""

from __future__ import annotations

import contextlib
import json
import multiprocessing as mp
import os
import statistics
import time
from pathlib import Path

import numpy as np

from bake import bench, config, radiance, room, slots
from bake import report as bake_report
from bake import solve as bake_solve
from bake import verify as bake_verify

from . import optimize
from .optimize import BF16_TOL, ShadeOptimizer

ROOT = config.WS / "shade_optimizer"
WORK = ROOT / "work"
REPORTS = ROOT / "reports"
KEEP_TOL = 0.05


def chain_path(city: str, month: int, state: str) -> Path:
    return WORK / "solve" / city / f"{month:02d}" / f"{state}.json"


def state_ids(spec: str) -> list[str]:
    """'activity' (the activity states and ambient), 'all', or a comma list of state ids."""
    sts = room.states()
    if spec == "activity":
        return [s.id for s in sts if s.kind in ("ambient", "activity")]
    if spec == "all":
        return [s.id for s in sts]
    ids = spec.split(",")
    known = {s.id for s in sts}
    if unknown := [i for i in ids if i not in known]:
        raise SystemExit(f"unknown state(s): {', '.join(unknown)}")
    return ids


def _settings() -> dict:
    return {"method": optimize.METHOD, "keep_tol": KEEP_TOL,
            "glare_weight": config.GLARE_WEIGHT, "glare_cap": config.GLARE_CAP}


# ---------------------------------------------------------------------------
# Chains
# ---------------------------------------------------------------------------

_W: dict = {}


def _init_worker():
    config.apply_env()
    bake_solve.LOG_DIR.mkdir(parents=True, exist_ok=True)
    log = open(bake_solve.LOG_DIR / f"shades_{os.getpid()}.log", "a", buffering=1)
    with contextlib.redirect_stdout(log):
        v3, solver = bench.make_solver()
    _W.update(v3=v3, solver=solver, so=ShadeOptimizer(v3, solver),
              states={s.id: s for s in room.states()})


def is_done(city, month, sid) -> bool:
    p = chain_path(city, month, sid)
    if not p.exists():
        return False
    try:
        return json.loads(p.read_text()).get("settings") == _settings()
    except (ValueError, OSError):
        return False


def solve_chain(task) -> dict:
    """task = (city, month, state): the shades through the day; writes the chain file."""
    city, month, sid = task
    v3, solver, so = _W["v3"], _W["solver"], _W["so"]
    day = slots.load(city)["months"][month - 1]
    tgt = room.target_and_owner(_W["states"][sid])[0]
    up = [0] * len(so.windows)
    prev, recs, t0 = None, [], time.perf_counter()
    for slot in day["slots"]:
        cond = bench.condition(v3, slot)
        r = so.solve(cond, tgt, prev)
        ship, loss, how = r.drops, r.loss, "solved"
        if prev is not None:
            L_prev = float(so.score(cond, tgt, [prev])[0])
            if L_prev <= (1 + KEEP_TOL) * r.loss:
                ship, loss, how = list(prev), L_prev, "kept"
        binary = so.facade(ship)
        lux = solver.opt.predict_lux(binary, cond)[0]
        recs.append({
            "slot": slot["label"], "drops": ship, "loss": loss, "ship": how,
            "loss_solved": r.loss,
            "loss_conventional": float(so.score(cond, tgt, [up])[0]),
            "rounds": r.rounds, "scored": r.scored,
            "seconds": round(r.seconds, 3),
            "moved": None if prev is None else int(np.sum(np.array(ship) != prev)),
            "facade": bake_solve._bits_hex(binary),
            "lux_surrogate": np.rint(lux).astype(int).reshape(-1).tolist()})
        prev = ship
    doc = {"city": city, "month": month, "day": day["day"], "state": sid,
           "windows": [w.__dict__ for w in so.windows], "settings": _settings(),
           "seconds": round(time.perf_counter() - t0, 2), "slots": recs}
    bake_solve._atomic_write(chain_path(city, month, sid), json.dumps(doc))
    return {"task": task, "seconds": doc["seconds"],
            "loss": statistics.mean(r["loss"] for r in recs),
            "conventional": statistics.mean(r["loss_conventional"] for r in recs)}


def solve(cities, months, states, procs=1, force=False) -> list[dict]:
    """Shade chains on `procs` processes, each with its own solver on the GPU; finished
    chains (same settings) are skipped, so a stopped run resumes."""
    config.check_venv()
    todo = [(c, m, s) for c in cities for m in months for s in states
            if force or not is_done(c, m, s)]
    print(f"shades: {len(todo)} chain(s) to do on {procs} process(es)", flush=True)
    if not todo:
        return []
    done, t0 = [], time.perf_counter()
    with mp.get_context("spawn").Pool(procs, initializer=_init_worker) as pool:
        for i, r in enumerate(pool.imap_unordered(solve_chain, todo), 1):
            done.append(r)
            el = time.perf_counter() - t0
            print(f"  [{i}/{len(todo)}] {'/'.join(map(str, r['task']))}: {r['seconds']:.0f}s, "
                  f"loss {r['loss']:.4f} (conventional {r['conventional']:.4f})  | "
                  f"{el / 60:.1f} min elapsed, ~{el / i * (len(todo) - i) / 60:.0f} min left",
                  flush=True)
    return done


# ---------------------------------------------------------------------------
# Exhaustive check
# ---------------------------------------------------------------------------

def exhaustive(city: str, month: int, cases: list[str], batch: int) -> list[dict]:
    """For each case 'state@HH:MM': every shade combination against the optimizer."""
    v3, solver = bench.make_solver()
    so = ShadeOptimizer(v3, solver)
    sts = {s.id: s for s in room.states()}
    out_path = REPORTS / "exhaustive.json"
    results = json.loads(out_path.read_text()) if out_path.exists() else []
    for case in cases:
        sid, label = case.split("@")
        _m, slot = slots.find_slot(city, month, label)
        cond = bench.condition(v3, slot)
        tgt = room.target_and_owner(sts[sid])[0]
        r = so.solve(cond, tgt)

        def progress(i, total, secs):
            print(f"    {i:,}/{total:,} designs, {secs:.0f} s", flush=True)

        ex = so.exhaustive(cond, tgt, batch=batch, progress=progress)
        row = {"city": city, "month": month, "state": sid, "slot": label,
               "optimizer": {"drops": r.drops, "loss": r.loss, "seconds": round(r.seconds, 2),
                             "scored": r.scored},
               "exhaustive": ex,
               # The exhaustive search ranks in batches (bfloat16), so a design within BF16_TOL
               # of its best is as good as the arithmetic can tell.
               "found_best": r.drops == ex["drops"] or r.loss <= ex["loss"] * (1 + BF16_TOL)}
        print(f"  {case}: optimizer {r.loss:.5f} in {r.seconds:.1f} s ({r.scored} designs), "
              f"best of all {ex['designs']:,} {ex['loss']:.5f} in {ex['seconds']:.0f} s"
              f" -> {'found it' if row['found_best'] else 'missed it'}", flush=True)
        results = [x for x in results if (x["city"], x["month"], x["state"], x["slot"])
                   != (city, month, sid, label)] + [row]
        config.assert_writable(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(results, indent=1))
    return results


# ---------------------------------------------------------------------------
# Radiance
# ---------------------------------------------------------------------------

def verify(cities, months, states, workers: int) -> dict:
    config.check_venv()
    v3 = config.import_v3()
    bake_verify.RESULTS.mkdir(parents=True, exist_ok=True)
    rad_params = bake_verify._rad_params()
    tasks, seen = [], set()
    for city in cities:
        for month in months:
            day = slots.load(city)["months"][month - 1]
            for sid in states:
                path = chain_path(city, month, sid)
                if not path.exists():
                    continue
                for slot, rec in zip(day["slots"], json.loads(path.read_text())["slots"]):
                    alt, az, dni, dhi = v3.vfr.cond_to_sun(bench.condition(v3, slot)[0])
                    key = bake_verify.run_key(rec["facade"], (alt, az, dni, dhi), rad_params)
                    if key in seen or bake_verify.load_result(key) is not None:
                        continue
                    seen.add(key)
                    tasks.append({
                        "key": key, "facades": v3.vfr.binary_to_scene_facades(
                            bake_solve.bits_from_hex(rec["facade"])),
                        "room": (config.ROOM_W, config.ROOM_D, config.ROOM_H),
                        "alt": alt, "az": az, "dni": dni, "dhi": dhi,
                        "work_dir": str(bake_verify.SCRATCH / key)})
    print(f"shade verify: {len(tasks)} Radiance run(s) on {workers} worker(s)", flush=True)
    t0, failed = time.perf_counter(), []
    for i, res in enumerate(radiance.run_iter(tasks, str(config.GEN_PY), str(config.TMP),
                                              workers), 1):
        if res["error"]:
            failed.append(res["key"])
            continue
        plan = v3.vfr.sensors_to_plan(res["lux"])
        bake_verify.result_path(res["key"]).write_text(json.dumps(
            {"lux": np.round(plan, 1).tolist(), "seconds": round(res["seconds"], 2)}))
        if i % 25 == 0 or i == len(tasks):
            print(f"  {i}/{len(tasks)} runs, {(time.perf_counter() - t0) / 60:.1f} min",
                  flush=True)
    return {"runs": len(tasks), "failed": failed, "minutes": (time.perf_counter() - t0) / 60}


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def _mean(xs):
    xs = [x for x in xs if x is not None and x == x]
    return statistics.mean(xs) if xs else None


def _fmt(v, nd=1):
    return "–" if v is None else f"{v:.{nd}f}"


def report(cities, months, states) -> Path:
    v3 = config.import_v3()
    rad_params = bake_verify._rad_params()
    rows, all_recs = [], []

    def rad_of(slot, facade_hex):
        alt, az, dni, dhi = v3.vfr.cond_to_sun(bench.condition(v3, slot)[0])
        return bake_verify.load_result(bake_verify.run_key(facade_hex, (alt, az, dni, dhi),
                                                           rad_params))

    for city in cities:
        for month in months:
            day = slots.load(city)["months"][month - 1]
            base_path = bake_solve.chain_path(city, month, "baseline")
            base = json.loads(base_path.read_text())["slots"] if base_path.exists() else None
            for sid in states:
                path = chain_path(city, month, sid)
                if not path.exists():
                    continue
                recs = json.loads(path.read_text())["slots"]
                all_recs += recs
                resp_path = bake_solve.chain_path(city, month, sid)
                resp = json.loads(resp_path.read_text())["slots"] if resp_path.exists() else None
                m = {"conventional": [], "shades": [], "responsive": []}
                for k, (slot, rec) in enumerate(zip(day["slots"], recs)):
                    designs = {"shades": rec}
                    if base:
                        designs["conventional"] = base[k]
                    if resp:
                        designs["responsive"] = resp[k]
                    for name, d in designs.items():
                        rad = rad_of(slot, d["facade"])
                        m[name].append(bake_report.metrics(sid, d["lux_surrogate"], rad))
                rows.append({"where": f"{city} {month:02d}", "state": sid, "metrics": m,
                             "loss": {"conventional": _mean(r["loss_conventional"] for r in recs),
                                      "shades": _mean(r["loss"] for r in recs),
                                      "responsive": _mean(r.get("L_ship") for r in resp)
                                      if resp else None}})

    def zone0(ms, key):
        return _mean(x[key][0] for x in ms if key in x)

    def rad_cell(ms):
        """Radiance in band, with how many of the hours it covers when not all."""
        have = sum("in_band_rad" in x for x in ms)
        if not have:
            return "–"
        v = f"{zone0(ms, 'in_band_rad'):.1f}%"
        return v if have == len(ms) else f"{v} ({have}/{len(ms)} h)"

    names = ("conventional", "shades", "responsive")
    lines = ["# Shade optimizer report", "",
             f"Cities {', '.join(cities)}; months {', '.join(map(str, months))}. "
             "Conventional = the L05 facade, shades all up. Shades = the same windows with a "
             "top-down blackout shade each, optimised per hour. Responsive = the bake's panel "
             "facade.", "",
             "## Time in band (the occupant's zone, v3's comfort band)", "",
             "| Where | State | Conventional, surrogate | Shades, surrogate | Responsive, surrogate "
             "| Conventional, Radiance | Shades, Radiance | Responsive, Radiance |",
             "|---|---|---|---|---|---|---|---|"]
    for r in rows:
        ms = r["metrics"]
        lines.append(f"| {r['where']} | {r['state']} | "
                     + " | ".join(_fmt(zone0(ms[n], "in_band_sur")) + "%" for n in names) + " | "
                     + " | ".join(rad_cell(ms[n]) for n in names) + " |")
    lines += ["", "## Loss and glare", "",
              "Mean deployed loss (v3's objective, lower is better) and glare cells (floor cells "
              "above 3000 lux of 1024, surrogate).", "",
              "| Where | State | Loss: conventional | shades | responsive "
              "| Glare: conventional | shades | responsive |",
              "|---|---|---|---|---|---|---|---|"]
    for r in rows:
        ms = r["metrics"]
        lines.append(f"| {r['where']} | {r['state']} | "
                     + " | ".join(_fmt(r["loss"][n], 4) for n in names) + " | "
                     + " | ".join(_fmt(_mean(x["glare_sur"] for x in ms[n])) for n in names)
                     + " |")
    if all_recs:
        secs = [r["seconds"] for r in all_recs]
        moved = [r["moved"] for r in all_recs if r["moved"] is not None]
        lines += ["", "## The optimizer", "",
                  f"- Method: {optimize.METHOD} (optimize.py). {len(all_recs)} solves, "
                  f"{statistics.mean(secs):.2f} s each on average (max {max(secs):.2f} s), "
                  f"{_mean(r['scored'] for r in all_recs):.0f} designs scored per solve.",
                  f"- Shades kept from the hour before: "
                  f"{sum(r['ship'] == 'kept' for r in all_recs)} of "
                  f"{sum(r['moved'] is not None for r in all_recs)} hours; "
                  f"{_mean(moved):.1f} shades moved an hour on average."]
    ex_path = REPORTS / "exhaustive.json"
    if ex_path.exists():
        ex = json.loads(ex_path.read_text())
        lines += ["", "## Exhaustive check", "",
                  "| Case | Optimizer loss | Best of all designs | Found it | Optimizer time "
                  "| Exhaustive time |", "|---|---|---|---|---|---|"]
        for x in ex:
            lines.append(f"| {x['city']} {x['month']:02d} {x['state']} {x['slot']} | "
                         f"{x['optimizer']['loss']:.5f} | {x['exhaustive']['loss']:.5f} | "
                         f"{'yes' if x['found_best'] else 'no'} | {x['optimizer']['seconds']} s | "
                         f"{x['exhaustive']['seconds']} s |")
    path = REPORTS / "report.md"
    config.assert_writable(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# The methods, side by side
# ---------------------------------------------------------------------------

COMPARE_STATES = ("desk", "couch_tv", "lounge_read_w")
GA_SEEDS = (1, 2, 3)


def compare(city: str, month: int, states=COMPARE_STATES) -> Path:
    """Every method (optimize.METHODS; the GA with GA_SEEDS) on every hour of the day for
    `states`, from scratch (no previous hour), and reports/methods.md."""
    v3, solver = bench.make_solver()
    so = ShadeOptimizer(v3, solver)
    sts = {s.id: s for s in room.states()}
    day = slots.load(city)["months"][month - 1]["slots"]
    runs = [(m, 0) for m in optimize.METHODS if m != "ga"] + [("ga", s) for s in GA_SEEDS]
    so.solve(bench.condition(v3, day[0]), room.target_and_owner(sts[states[0]])[0])  # warm-up
    rows = []
    for sid in states:
        tgt = room.target_and_owner(sts[sid])[0]
        for slot in day:
            cond = bench.condition(v3, slot)
            res = {f"{m}{s or ''}": so.solve(cond, tgt, method=m, seed=s) for m, s in runs}
            rows.append({"state": sid, "slot": slot["label"],
                         **{k: {"loss": r.loss, "seconds": round(r.seconds, 3),
                                "scored": r.scored, "drops": r.drops} for k, r in res.items()}})
            print(f"  {sid} {slot['label']}: " + "  ".join(
                f"{k} {r.loss:.4f} ({r.seconds:.1f}s)" for k, r in res.items()), flush=True)

    names = [f"{m}{s or ''}" for m, s in runs]
    best = [min(r[k]["loss"] for k in names) for r in rows]

    def found(k):  # within bfloat16 precision of the best any method found
        return sum(r[k]["loss"] <= b * (1 + BF16_TOL) + 1e-9 for r, b in zip(rows, best))

    label = {"window": "Window by window", "gradient": "Gradient, then window by window"}
    lines = ["# Shade optimizer: methods", "",
             f"{city} {month:02d}, {', '.join(states)}: every hour, {len(rows)} cases, each solved "
             "from scratch. Deployed loss (v3's objective, lower is better), scored exactly. "
             f"The GA: population {optimize.GA_POP}, {optimize.GA_GENS} generations, seeds "
             f"{', '.join(map(str, GA_SEEDS))}. \"Best found\" counts the cases where a method is "
             "within bfloat16 precision of the best any method found.", "",
             "| Method | Mean loss | Best found | Mean time | Designs scored |",
             "|---|---|---|---|---|"]
    for k in names:
        lines.append(f"| {label.get(k, 'GA, seed ' + k[2:] if k.startswith('ga') else k)} | "
                     f"{statistics.mean(r[k]['loss'] for r in rows):.4f} | "
                     f"{found(k)} of {len(rows)} | "
                     f"{statistics.mean(r[k]['seconds'] for r in rows):.2f} s | "
                     f"{statistics.mean(r[k]['scored'] for r in rows):.0f} |")
    path = REPORTS / "methods.md"
    config.assert_writable(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    (REPORTS / "methods.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
    return path
