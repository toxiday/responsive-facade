"""Radiance runs through v3's own scene builder, with scratch kept inside the workspace.

This module must stay torch-free: on Windows the pool uses spawn, so every worker imports
it fresh. The generator (`generate_dataset_allsides_climate_pit.py`, stdlib only) is loaded
by path in each worker, exactly as `verify_facade_radiance._load_generator` does, and its
`write_scene` / `run_simulation` are used unchanged, so the Radiance settings are the
training set's. Conversions that need numpy/torch (design → scene facades, sensor order →
plan) are done by the caller with v3's `binary_to_scene_facades` and `sensors_to_plan`.
"""

from __future__ import annotations

import importlib.util
import multiprocessing as mp
import os
import shutil
import sys
import time
from pathlib import Path

_GEN = None
_ENV = None


def load_generator(gen_py: str):
    spec = importlib.util.spec_from_file_location("gen_pit_bake", gen_py)
    m = importlib.util.module_from_spec(spec)
    sys.modules["gen_pit_bake"] = m
    spec.loader.exec_module(m)
    return m


def init_worker(gen_py: str, tmp_root: str) -> None:
    os.environ["TEMP"] = os.environ["TMP"] = os.environ["TMPDIR"] = tmp_root
    sys.dont_write_bytecode = True
    global _GEN, _ENV
    _GEN = load_generator(gen_py)
    _ENV = _GEN.make_env()


def simulate(task: dict) -> dict:
    """One Radiance run. `task` keys: key, facades ({'S','N','E','W'} -> 512 floats, <0.5 =
    window), room (W, D, H), alt, az (room-frame azimuth, deg clockwise from room +Y), dni,
    dhi, work_dir. Returns {key, lux (1024 floats in sensor order) | None, seconds, error}."""
    work = Path(task["work_dir"])
    t0 = time.perf_counter()
    try:
        work.mkdir(parents=True, exist_ok=True)
        W, D, H = task["room"]
        oct_p, pts_p = _GEN.write_scene(work, task["facades"], W, D, H, task["alt"],
                                        task["az"], task["dni"], task["dhi"], _ENV)
        lux = _GEN.run_simulation(oct_p, pts_p, _ENV)
        if len(lux) != _GEN.N_SENSORS:
            return {"key": task["key"], "lux": None, "seconds": time.perf_counter() - t0,
                    "error": f"rtrace returned {len(lux)} values"}
        return {"key": task["key"], "lux": lux, "seconds": time.perf_counter() - t0,
                "error": None}
    except Exception as e:  # recorded per task; one failure must not stop a batch
        return {"key": task["key"], "lux": None, "seconds": time.perf_counter() - t0,
                "error": repr(e)}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def run_batch(tasks: list[dict], gen_py: str, tmp_root: str, workers: int) -> list[dict]:
    """Run tasks on a spawn pool (or in-process for a single task). Order is not kept."""
    if not tasks:
        return []
    if workers <= 1 or len(tasks) == 1:
        init_worker(gen_py, tmp_root)
        return [simulate(t) for t in tasks]
    ctx = mp.get_context("spawn")
    with ctx.Pool(min(workers, len(tasks)), initializer=init_worker,
                  initargs=(gen_py, tmp_root)) as pool:
        return list(pool.imap_unordered(simulate, tasks))
