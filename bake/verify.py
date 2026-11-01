"""Radiance verification of every shipped design (and the baseline), cached by content.

A run's cache key hashes the design bits, the sun and sky of the slot (as v3's `cond_to_sun`
reads them), the room, and v3's Radiance parameters, so identical designs run once and a
stopped verification resumes. Results land in bake/work/rad/results/{key}.json as plan-order
lux (v3's `sensors_to_plan`). A failed run is retried once, then recorded as failed.
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import numpy as np

from . import bench, config, radiance, room, slots
from .solve import bits_from_hex, chain_path

RESULTS = config.WORK / "rad" / "results"
SCRATCH = config.WORK / "rad" / "scratch"


def _rad_params() -> str:
    gen = radiance.load_generator(str(config.GEN_PY))
    return str(getattr(gen, "RAD_PARAMS", ""))


def run_key(bits_hex: str, sun: tuple, rad_params: str) -> str:
    room_dims = (config.ROOM_W, config.ROOM_D, config.ROOM_H)
    blob = json.dumps([bits_hex, [round(float(v), 6) for v in sun], room_dims, rad_params])
    return hashlib.sha1(blob.encode()).hexdigest()[:20]


def result_path(key: str) -> Path:
    return RESULTS / f"{key}.json"


def load_result(key: str):
    p = result_path(key)
    if not p.exists():
        return None
    d = json.loads(p.read_text())
    return None if d.get("lux") is None else np.array(d["lux"], dtype=np.float32)


def month_states() -> list[str]:
    return [s.id for s in room.states()] + ["baseline"]


def collect(v3, city: str, month: int, rad_params: str) -> tuple[list[dict], dict]:
    """(tasks still to run, {(state, slot index): key}) for one city-month."""
    day = slots.load(city)["months"][month - 1]
    keys, tasks, seen = {}, [], set()
    for sid in month_states():
        doc = json.loads(chain_path(city, month, sid).read_text())
        for k, (slot, rec) in enumerate(zip(day["slots"], doc["slots"])):
            cond = bench.condition(v3, slot)
            alt, az, dni, dhi = v3.vfr.cond_to_sun(cond[0])
            key = run_key(rec["facade"], (alt, az, dni, dhi), rad_params)
            keys[(sid, k)] = key
            if key in seen or load_result(key) is not None:
                continue
            seen.add(key)
            tasks.append({
                "key": key, "facades": v3.vfr.binary_to_scene_facades(bits_from_hex(rec["facade"])),
                "room": (config.ROOM_W, config.ROOM_D, config.ROOM_H),
                "alt": alt, "az": az, "dni": dni, "dhi": dhi,
                "work_dir": str(SCRATCH / key)})
    return tasks, keys


def run(cities, months, workers: int) -> dict:
    config.check_venv()
    v3 = config.import_v3()
    RESULTS.mkdir(parents=True, exist_ok=True)
    rad_params = _rad_params()
    tasks = []
    for c in cities:
        for m in months:
            tasks += collect(v3, c, m, rad_params)[0]
    total = len(tasks)
    print(f"verify: {total} Radiance run(s) on {workers} worker(s)", flush=True)
    failed, t0 = [], time.perf_counter()
    for attempt in (1, 2):
        errors = set()
        for i, res in enumerate(radiance.run_iter(tasks, str(config.GEN_PY), str(config.TMP),
                                                  workers), 1):
            if res["error"]:
                errors.add(res["key"])
                continue
            plan = v3.vfr.sensors_to_plan(res["lux"])
            result_path(res["key"]).write_text(json.dumps(
                {"lux": np.round(plan, 1).tolist(), "seconds": round(res["seconds"], 2)}))
            if i % 25 == 0 or i == len(tasks):
                print(f"  {i}/{len(tasks)} runs, {(time.perf_counter() - t0) / 60:.1f} min",
                      flush=True)
        tasks = [t for t in tasks if t["key"] in errors]
        if not tasks:
            break
        if attempt == 1:
            print(f"  retrying {len(tasks)} failed run(s)", flush=True)
    for t in tasks:                                  # failed twice
        failed.append(t["key"])
        result_path(t["key"]).write_text(json.dumps({"lux": None, "error": "failed twice"}))
    return {"runs": total, "failed": failed, "minutes": (time.perf_counter() - t0) / 60}
