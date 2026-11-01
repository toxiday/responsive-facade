"""Facade solves: one chain per (city, month, state), through the baked day's slots in order.

For every slot of a chain:
  * cold: a seeded `optimize_coarse_to_fine` with glare_weight 0.25 (v3's default is 0.0, so
    it is passed explicitly), schedule SETTINGS["cold_schedule"];
  * warm (from the second slot on): v3's `LiveSolver._refine`, started from the previous
    shipped design's logits (or, after a cold ship, from flat logits that reproduce its binary,
    as v3's live solver does);
  * both are scored with `seed_sweep.deployed_loss` and warm ships if
    L_warm <= (1 + warm_tol) * L_cold;
  * recorded: losses, which shipped, panel flips against the previous slot's shipped design,
    the flips a cold-only bake would have had, timings, and the surrogate lux of the shipped
    design.

Chains run on N worker processes, each with its own solver on the GPU. Each chain is written
atomically to bake/work/solve/{city}/{MM}/{state}.json, so a stopped bake resumes; a file
whose settings differ from SETTINGS is redone. v3's console output goes to per-worker logs.
"""

from __future__ import annotations

import contextlib
import json
import multiprocessing as mp
import os
import time
import zlib
from pathlib import Path

import numpy as np

from . import bench, config, room, slots

SETTINGS = {
    "cold_schedule": "full",       # "full" (v3 default) or "short" (live SHORT_SCHEDULE)
    "refine_steps": 150,           # bench: 60 steps fell well behind cold along the chain
    "warm_tol": 0.05,
    "glare_weight": config.GLARE_WEIGHT,
    "glare_cap": config.GLARE_CAP,
}

SOLVE_DIR = config.WORK / "solve"
LOG_DIR = config.WORK / "logs"


def chain_path(city: str, month: int, state: str) -> Path:
    return SOLVE_DIR / city / f"{month:02d}" / f"{state}.json"


def _seed(city, month, state, k) -> int:
    return zlib.crc32(f"{city}/{month}/{state}/{k}".encode()) & 0x7FFFFFFF


def _bits_hex(binary) -> str:
    return np.packbits(np.asarray(binary, dtype=np.uint8).reshape(-1) > 0,
                       bitorder="little").tobytes().hex()


def bits_from_hex(h: str) -> np.ndarray:
    return np.unpackbits(np.frombuffer(bytes.fromhex(h), dtype=np.uint8),
                         bitorder="little")[:2048].reshape(4, 16, 32).astype(np.int32)


def _atomic_write(path: Path, text: str) -> None:
    config.assert_writable(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(text)
    for attempt in range(10):                      # Google Drive may hold a brief lock
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.2 * (attempt + 1))
    os.replace(tmp, path)


def is_done(city, month, state, settings=SETTINGS) -> bool:
    p = chain_path(city, month, state)
    if not p.exists():
        return False
    try:
        return json.loads(p.read_text()).get("settings") == settings
    except (ValueError, OSError):
        return False


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------

_W = {}


def _init_worker(settings):
    config.apply_env()
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log = open(LOG_DIR / f"solve_{os.getpid()}.log", "a", buffering=1)
    _W["log"] = log
    with contextlib.redirect_stdout(log):
        v3, solver = bench.make_solver()
    _W.update(v3=v3, solver=solver, settings=settings,
              states={s.id: s for s in room.states()})


def solve_chain(task) -> dict:
    """task = (city, month, state). Writes the chain file; returns a short summary."""
    city, month, sid = task
    v3, solver, st = _W["v3"], _W["solver"], _W["settings"]
    day = slots.load(city)["months"][month - 1]
    tgt = room.target_and_owner(_W["states"][sid])[0]
    schedule = None if st["cold_schedule"] == "full" else v3.live_solver.SHORT_SCHEDULE
    t_chain = time.perf_counter()
    out_slots = []
    prev_ship = prev_cold = prev_X = None
    with contextlib.redirect_stdout(_W["log"]):
        for k, slot in enumerate(day["slots"]):
            cond = bench.condition(v3, slot)
            t0 = time.perf_counter()
            b_cold, _ = bench.cold(v3, solver, cond, tgt, schedule, _seed(city, month, sid, k))
            t_cold = time.perf_counter() - t0
            L_cold = bench.score(v3, solver, b_cold, cond, tgt)
            rec = {"slot": slot["label"], "L_cold": L_cold, "t_cold": round(t_cold, 3)}
            ship, X_ship = b_cold, None
            if prev_ship is not None:
                X0 = prev_X if prev_X is not None else bench.seed_logits(v3, solver, prev_ship)
                t0 = time.perf_counter()
                b_warm, X_warm = bench.warm(v3, solver, X0, cond, tgt, st["refine_steps"])
                rec["t_warm"] = round(time.perf_counter() - t0, 3)
                rec["L_warm"] = bench.score(v3, solver, b_warm, cond, tgt)
                if rec["L_warm"] <= (1 + st["warm_tol"]) * L_cold:
                    ship, X_ship = b_warm, X_warm
                rec["flips"] = int((ship != prev_ship).sum())
                rec["flips_cold_only"] = int((b_cold != prev_cold).sum())
            rec["ship"] = "warm" if X_ship is not None else "cold"
            rec["L_ship"] = rec["L_warm"] if X_ship is not None else L_cold
            rec["facade"] = _bits_hex(ship)
            lux = solver.opt.predict_lux(ship, cond)[0]
            rec["lux_surrogate"] = np.rint(lux).astype(int).reshape(-1).tolist()
            out_slots.append(rec)
            prev_ship, prev_cold, prev_X = ship, b_cold, X_ship
    doc = {"city": city, "month": month, "day": day["day"], "state": sid,
           "settings": st, "seconds": round(time.perf_counter() - t_chain, 2),
           "provenance": {k: v for k, v in config.provenance().items() if k != "pipeline"},
           "slots": out_slots}
    _atomic_write(chain_path(city, month, sid), json.dumps(doc))
    warm = sum(r["ship"] == "warm" for r in out_slots)
    return {"task": task, "seconds": doc["seconds"], "warm": warm, "slots": len(out_slots)}


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def tasks_for(cities, months, states=None) -> list[tuple]:
    sids = states or [s.id for s in room.states()]
    return [(c, m, s) for c in cities for m in months for s in sids]


def run(cities, months, states=None, procs=3, settings=SETTINGS, force=False) -> list[dict]:
    config.check_venv()
    todo = [t for t in tasks_for(cities, months, states) if force or not is_done(*t, settings)]
    print(f"solve: {len(todo)} chain(s) to do on {procs} process(es)", flush=True)
    if not todo:
        return []
    ctx = mp.get_context("spawn")
    done, t0 = [], time.perf_counter()
    with ctx.Pool(procs, initializer=_init_worker, initargs=(settings,)) as pool:
        for i, r in enumerate(pool.imap_unordered(solve_chain, todo), 1):
            done.append(r)
            el = time.perf_counter() - t0
            print(f"  [{i}/{len(todo)}] {'/'.join(map(str, r['task']))}: {r['seconds']:.0f}s, "
                  f"{r['warm']}/{r['slots']} warm  | {el / 60:.1f} min elapsed, "
                  f"~{el / i * (len(todo) - i) / 60:.0f} min left", flush=True)
    return done


def run_baseline(cities, months, force=False) -> int:
    """The conventional L05 facade (`config.BASELINE_CSV`, fixed) at every slot, with its
    surrogate lux, written like a chain (state "baseline", ship "baseline")."""
    v3, solver = bench.make_solver()
    binary = (v3.vfr.load_binary_wide(config.BASELINE_CSV) > 0.5).astype(np.int32)
    n = 0
    for city in cities:
        for month in months:
            path = chain_path(city, month, "baseline")
            if path.exists() and not force:
                continue
            day = slots.load(city)["months"][month - 1]
            recs = []
            for slot in day["slots"]:
                lux = solver.opt.predict_lux(binary, bench.condition(v3, slot))[0]
                recs.append({"slot": slot["label"], "ship": "baseline", "facade": _bits_hex(binary),
                             "lux_surrogate": np.rint(lux).astype(int).reshape(-1).tolist()})
            doc = {"city": city, "month": month, "day": day["day"], "state": "baseline",
                   "source": "Building Model v2/Units/conventional L05/501.6/facade_wide.csv",
                   "provenance": {k: v for k, v in config.provenance().items()
                                  if k != "pipeline"},
                   "slots": recs}
            _atomic_write(path, json.dumps(doc))
            n += 1
    return n
