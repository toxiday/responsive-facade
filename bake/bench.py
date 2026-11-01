"""python -m bake bench: measure what the bake costs on this machine, before sizing it.

1. Quality and time along real chains (Houston, December's median day, every slot): cold
   solves with the full and the short schedule, and warm refines (60 and 150 steps) chained
   from the previous slot. Every design is scored with v3's `seed_sweep.deployed_loss`, the
   exact objective, so cold and warm compare like for like.
2. Throughput with N solver processes sharing the GPU (cold short-schedule solves).
3. Radiance batch time, idle and while solver processes keep the GPU and CPU busy.

Writes bake/reports/bench.json and prints a summary.
"""

from __future__ import annotations

import contextlib
import io
import json
import multiprocessing as mp
import statistics
import time

import numpy as np

from . import config, radiance, room, slots

BENCH_STATES = ("couch_relax", "stand_020")
REFINE_STEPS = (60, 150)


# ---------------------------------------------------------------------------
# Solver helpers (also used by solve.py)
# ---------------------------------------------------------------------------

def make_solver():
    v3 = config.import_v3()
    import torch  # noqa: F401  (after apply_env, inside the worker)
    return v3, v3.live_solver.LiveSolver(weights_path=str(config.WEIGHTS), verbose=False)


def condition(v3, slot):
    return v3.opt.append_room(np.array([slot["cond5"]], dtype=np.float32),
                              config.ROOM_W, config.ROOM_D, config.ROOM_H)


def score(v3, solver, binary, cond, tgt):
    return float(v3.seed_sweep.deployed_loss(solver.opt, binary, cond, tgt, np.ones(1),
                                             config.GLARE_WEIGHT, config.GLARE_CAP))


def cold(v3, solver, cond, tgt, schedule=None, seed=0):
    import torch
    torch.manual_seed(seed)
    kw = {} if schedule is None else {"schedule": schedule}
    with contextlib.redirect_stdout(io.StringIO()):
        binary, _p, hist = solver.opt.optimize_coarse_to_fine(
            cond, tgt, facade_open=config.SIDES_OPEN, glare_weight=config.GLARE_WEIGHT,
            glare_cap=config.GLARE_CAP, eval_every=10, verbose=False, **kw)
    return binary, hist


def warm(v3, solver, X0, cond, tgt, steps):
    with contextlib.redirect_stdout(io.StringIO()):
        binary, X, _L, _conv = solver._refine(X0, cond, tgt, config.SIDES_OPEN, n_steps=steps)
    return binary, X


def seed_logits(v3, solver, binary):
    """Flat logits that reproduce a cold binary, as v3's live solver seeds its warm path."""
    import torch
    cap = v3.live_solver.WARM_LOGIT_CAP
    return torch.tensor(np.where(binary > 0, cap, -cap), dtype=torch.float32,
                        device=solver.opt.device)


def _timed(fn):
    t0 = time.perf_counter()
    out = fn()
    return out, time.perf_counter() - t0


# ---------------------------------------------------------------------------
# 1. Quality and time along chains
# ---------------------------------------------------------------------------

def chains(day_slots):
    v3, solver = make_solver()
    states = {s.id: s for s in room.states()}
    cold(v3, solver, condition(v3, day_slots[0]), room.target_and_owner(
        states[BENCH_STATES[0]])[0], schedule=v3.live_solver.SHORT_SCHEDULE)   # warm-up
    rows = []
    for sid in BENCH_STATES:
        tgt = room.target_and_owner(states[sid])[0]
        X = {n: None for n in REFINE_STEPS}
        for k, slot in enumerate(day_slots):
            cond = condition(v3, slot)
            (bf, _), t_full = _timed(lambda: cold(v3, solver, cond, tgt))
            (bs, _), t_short = _timed(lambda: cold(v3, solver, cond, tgt,
                                                   v3.live_solver.SHORT_SCHEDULE))
            row = {"state": sid, "slot": slot["label"], "t_full": t_full, "t_short": t_short,
                   "L_full": score(v3, solver, bf, cond, tgt),
                   "L_short": score(v3, solver, bs, cond, tgt)}
            for n in REFINE_STEPS:
                X0 = seed_logits(v3, solver, bf) if X[n] is None else X[n]
                (bw, Xw), t_w = _timed(lambda: warm(v3, solver, X0, cond, tgt, n))
                X[n] = Xw
                row[f"t_warm{n}"] = t_w
                row[f"L_warm{n}"] = score(v3, solver, bw, cond, tgt) if k else row["L_full"]
                row[f"flips_warm{n}"] = int((bw != bf).sum())
            rows.append(row)
            print(f"  {sid:12s} {slot['label']}  full {t_full:5.1f}s L={row['L_full']:.4f}  "
                  f"short {t_short:4.1f}s L={row['L_short']:.4f}  "
                  + "  ".join(f"warm{n} {row[f't_warm{n}']:4.1f}s L={row[f'L_warm{n}']:.4f}"
                              for n in REFINE_STEPS), flush=True)
    return rows


# ---------------------------------------------------------------------------
# 2. Throughput with N processes
# ---------------------------------------------------------------------------

def _tput_worker(barrier, queue, jobs):
    config.apply_env()
    v3, solver = make_solver()
    states = {s.id: s for s in room.states()}
    prepared = [(condition(v3, slot), room.target_and_owner(states[sid])[0])
                for sid, slot in jobs]
    cold(v3, solver, *prepared[0], schedule=v3.live_solver.SHORT_SCHEDULE)  # warm-up
    barrier.wait()
    t0 = time.perf_counter()
    for cond, tgt in prepared:
        cold(v3, solver, cond, tgt, schedule=v3.live_solver.SHORT_SCHEDULE)
    queue.put(time.perf_counter() - t0)


def throughput(day_slots, n_procs, per_proc=6):
    ctx = mp.get_context("spawn")
    barrier, queue = ctx.Barrier(n_procs), ctx.Queue()
    sids = [s.id for s in room.states()][:per_proc * n_procs]
    jobs = [(sids[i % len(sids)], day_slots[i % len(day_slots)])
            for i in range(per_proc * n_procs)]
    procs = [ctx.Process(target=_tput_worker,
                         args=(barrier, queue, jobs[i::n_procs])) for i in range(n_procs)]
    for p in procs:
        p.start()
    times = [queue.get() for _ in procs]
    for p in procs:
        p.join()
    return {"procs": n_procs, "solves": per_proc * n_procs, "wall_s": max(times),
            "solves_per_s": per_proc * n_procs / max(times),
            "s_per_solve_each": statistics.mean(times) / per_proc}


# ---------------------------------------------------------------------------
# 3. Radiance, idle and under load
# ---------------------------------------------------------------------------

def _load_worker(stop, day_slots):
    config.apply_env()
    v3, solver = make_solver()
    states = [s for s in room.states()]
    i = 0
    while not stop.is_set():
        slot, st = day_slots[i % len(day_slots)], states[i % len(states)]
        cold(v3, solver, condition(v3, slot), room.target_and_owner(st)[0],
             schedule=v3.live_solver.SHORT_SCHEDULE)
        i += 1


def radiance_batch(day_slots, n_runs, workers, tag):
    v3 = config.import_v3()
    rng = np.random.default_rng(0)
    tasks = []
    for i in range(n_runs):
        slot = day_slots[i % len(day_slots)]
        binary = (rng.random((4, 16, 32)) < 0.3).astype(np.int32)
        binary[[1, 2]] = 0                                       # N and E stay closed
        cond = condition(v3, slot)
        alt, az, dni, dhi = v3.vfr.cond_to_sun(cond[0])
        tasks.append({"key": f"{tag}{i}", "facades": v3.vfr.binary_to_scene_facades(binary),
                      "room": (config.ROOM_W, config.ROOM_D, config.ROOM_H), "alt": alt,
                      "az": az, "dni": dni, "dhi": dhi,
                      "work_dir": str(config.WORK / "rad" / "scratch" / f"bench_{tag}{i}")})
    t0 = time.perf_counter()
    res = radiance.run_batch(tasks, str(config.GEN_PY), str(config.TMP), workers)
    wall = time.perf_counter() - t0
    errors = [r["error"] for r in res if r["error"]]
    return {"runs": n_runs, "workers": workers, "wall_s": wall,
            "mean_run_s": statistics.mean(r["seconds"] for r in res), "errors": errors}


def run(procs=(1, 2, 3, 4), rad_runs=22) -> dict:
    config.check_venv()
    day = slots.load("houston")["months"][11]
    day_slots = day["slots"]
    out = {"provenance": {k: v for k, v in config.provenance().items() if k != "pipeline"},
           "day": f"houston 12/{day['day']}", "slots": len(day_slots)}

    print("1. chains (cold full / cold short / warm refines)", flush=True)
    out["chains"] = chains(day_slots)

    print("2. throughput (cold short, N processes)", flush=True)
    out["throughput"] = []
    for n in procs:
        r = throughput(day_slots, n)
        out["throughput"].append(r)
        print(f"  N={n}: {r['solves_per_s']:.2f} solves/s ({r['s_per_solve_each']:.1f} s each)",
              flush=True)

    print("3. radiance (idle, then with 3 solver processes busy)", flush=True)
    workers = max(1, (mp.cpu_count() or 4) - 2)
    out["radiance_idle"] = radiance_batch(day_slots, rad_runs, workers, "idle")
    print(f"  idle: {out['radiance_idle']}", flush=True)
    ctx = mp.get_context("spawn")
    stop = ctx.Event()
    load = [ctx.Process(target=_load_worker, args=(stop, day_slots)) for _ in range(3)]
    for p in load:
        p.start()
    time.sleep(20)                                   # let them load the model and get going
    out["radiance_loaded"] = radiance_batch(day_slots, rad_runs, workers - 3, "load")
    stop.set()
    for p in load:
        p.join()
    print(f"  loaded: {out['radiance_loaded']}", flush=True)

    path = config.assert_writable(config.WS / "bake" / "reports" / "bench.json")
    path.write_text(json.dumps(out, indent=1))
    print(f"wrote {path}")
    return out
