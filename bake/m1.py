"""M1 acceptance data: does sunlight land where Radiance says it does? (guidelines §5)

Two asymmetric single-wall test facades, each at a real .wea hour with strong direct sun
(the day in the month with the highest DNI at that hour; the baked median days can be
overcast, which would leave no sun patch to compare). For each case:
- Radiance lux through v3's scene builder (bake.radiance);
- surrogate lux from the v3 model;
- a geometric lit mask: from every floor sensor point (cell centre, 0.6 m) cast a ray
  towards the sun and see whether it leaves the room through a window panel.

A wrong wall, mirrored columns, flipped rows or a mis-rotated sun all move the geometric
patch away from the Radiance patch, so IoU between them checks the whole chain of
conventions. The web app repeats the geometric test in TypeScript and overlays the rendered
shadow on the Radiance patch, using the fixture written here.
"""

from __future__ import annotations

import json
import time

import numpy as np

from . import config, radiance, slots

SENSOR_Z = 0.6
IOU_MIN = 0.85

CASES = [
    {
        "id": "A",
        "label": "S wall, L-shaped opening; Houston winter noon",
        "city": "houston", "month": 12, "hour": 12, "wall": "S",
        # (row0, row1, col0, col1) inclusive; the foot of the L runs towards +x (east end)
        "openings": [(4, 11, 4, 9), (9, 11, 10, 20)],
    },
    {
        "id": "B",
        "label": "W wall, two openings; Houston March afternoon",
        "city": "houston", "month": 3, "hour": 16, "wall": "W",
        "openings": [(6, 10, 2, 8), (3, 5, 20, 22)],
    },
]

WALL_INDEX = {s: i for i, s in enumerate(config.SIDES)}


def facade_for(case) -> np.ndarray:
    b = np.zeros((4, 16, 32), dtype=np.int32)
    w = WALL_INDEX[case["wall"]]
    for r0, r1, c0, c1 in case["openings"]:
        b[w, r0:r1 + 1, c0:c1 + 1] = 1
    return b


def panel_at(side: str, a: float, z: float, W: float, D: float, H: float):
    """(row, col) of the panel containing wall point (a = along-wall coordinate, z)."""
    span = W if side in ("S", "N") else D
    col = min(31, max(0, int(a / (span / 32))))
    row = 15 - min(15, max(0, int(z / (H / 16))))
    return row, col


def sees_sun(p, to_sun, binary, W, D, H) -> bool:
    """Does a ray from p towards the sun leave the box through a window panel?"""
    x, y, z = p
    dx, dy, dz = to_sun
    hits = []
    if dx < 0: hits.append(("W", -x / dx))
    if dx > 0: hits.append(("E", (W - x) / dx))
    if dy < 0: hits.append(("S", -y / dy))
    if dy > 0: hits.append(("N", (D - y) / dy))
    if dz > 0: hits.append(("ceiling", (H - z) / dz))
    side, t = min(hits, key=lambda h: h[1])
    if side == "ceiling":
        return False
    hx, hy, hz = x + t * dx, y + t * dy, z + t * dz
    if hz < 0 or hz > H:
        return False
    a = hx if side in ("S", "N") else hy
    row, col = panel_at(side, a, hz, W, D, H)
    return bool(binary[WALL_INDEX[side], row, col])


def geometric_mask(binary, sun_room, W, D, H, z=SENSOR_Z) -> np.ndarray:
    """(32,32) bool, floor-grid convention: row 0 = N edge, col 0 = W edge."""
    to_sun = -np.asarray(sun_room, dtype=float)       # sun_room points sun -> room
    out = np.zeros((32, 32), dtype=bool)
    for r in range(32):
        for c in range(32):
            p = ((c + 0.5) * W / 32, (31.5 - r) * D / 32, z)
            out[r, c] = sees_sun(p, to_sun, binary, W, D, H)
    return out


def radiance_mask(lux: np.ndarray) -> tuple[np.ndarray, float]:
    thr = max(3000.0, 0.25 * float(np.percentile(lux, 99)))
    return lux > thr, thr


def iou(a: np.ndarray, b: np.ndarray) -> float:
    union = np.logical_or(a, b).sum()
    return float(np.logical_and(a, b).sum() / union) if union else 1.0


def sunniest_slot(v3, case) -> dict:
    """The case's hour on the day of its month with the highest DNI, as a slot record."""
    ls = v3.live_solver
    wea = config.wea_path(case["city"])
    _lat, _lon, _tz, rows = ls._wea_rows(wea)
    day = max((d for (m, d, h) in rows if m == case["month"] and h == case["hour"]),
              key=lambda d: (rows[(case["month"], d, case["hour"])][1], -d))
    cond5, info = ls.single_condition(wea, case["month"], day, case["hour"], config.NORTH_ANGLE)
    assert info["ok"], (case, info)
    return {
        "day": day, "hour": info["hour"], "label": slots.hhmm(info["hour"]),
        "alt": round(info["alt"], 4), "az_true": round(info["az"], 4),
        "sun_room": [round(float(v), 6) for v in cond5[0, :3]],
        "dni": info["dni"], "dhi": info["dhi"], "cond5": [float(v) for v in cond5[0]],
    }


def run(force: bool = False) -> dict:
    config.check_venv()
    v3 = config.import_v3()
    W, D, H = config.ROOM_W, config.ROOM_D, config.ROOM_H
    cache_dir = config.assert_writable(config.WORK / "m1")
    cache_dir.mkdir(parents=True, exist_ok=True)

    prepared, tasks = [], []
    for case in CASES:
        slot = sunniest_slot(v3, case)
        binary = facade_for(case)
        cond = v3.opt.append_room(np.array([slot["cond5"]], dtype=np.float32), W, D, H)
        alt, az_room, dni, dhi = v3.vfr.cond_to_sun(cond[0])
        cache = cache_dir / f"radiance_{case['id']}.json"
        prepared.append((case, slot, binary, cond, cache, az_room))
        if force or not cache.exists():
            tasks.append({
                "key": case["id"], "facades": v3.vfr.binary_to_scene_facades(binary),
                "room": (W, D, H), "alt": alt, "az": az_room, "dni": dni, "dhi": dhi,
                "work_dir": str(config.WORK / "rad" / "scratch" / f"m1_{case['id']}"),
            })

    if tasks:
        t0 = time.perf_counter()
        results = radiance.run_batch(tasks, str(config.GEN_PY), str(config.TMP), len(tasks))
        print(f"Radiance: {len(tasks)} run(s) in {time.perf_counter() - t0:.1f} s")
        for res in results:
            if res["error"]:
                raise RuntimeError(f"Radiance case {res['key']} failed: {res['error']}")
            plan = v3.vfr.sensors_to_plan(res["lux"])
            (cache_dir / f"radiance_{res['key']}.json").write_text(json.dumps(
                {"lux": plan.round(2).tolist(), "seconds": res["seconds"]}))

    opt = v3.opt.FacadeOptimizerAllSidesClimate()
    out_cases, summary = [], []
    for case, slot, binary, cond, cache, az_room in prepared:
        rad = np.array(json.loads(cache.read_text())["lux"], dtype=np.float32)
        sur = opt.predict_lux(binary, cond)[0]
        geo = geometric_mask(binary, slot["sun_room"], W, D, H)
        rmask, thr = radiance_mask(rad)
        smask = sur > thr
        row = {
            "id": case["id"], "label": case["label"], "city": case["city"],
            "month": case["month"], "day": slot["day"], "slot": slot["label"],
            "hour": slot["hour"], "alt": slot["alt"], "az_true": slot["az_true"],
            "az_room": round(az_room, 4), "sun_room": slot["sun_room"],
            "dni": slot["dni"], "dhi": slot["dhi"], "wall": case["wall"],
            "openings": case["openings"],
            "facade": binary.reshape(-1).tolist(),
            "lux_radiance": np.rint(rad).astype(int).reshape(-1).tolist(),
            "lux_surrogate": np.rint(sur).astype(int).reshape(-1).tolist(),
            "threshold": round(thr, 1),
            "mask_radiance": rmask.astype(int).reshape(-1).tolist(),
            "mask_geometric": geo.astype(int).reshape(-1).tolist(),
            "iou_geometric_vs_radiance": round(iou(geo, rmask), 4),
            "iou_surrogate_vs_radiance": round(iou(smask, rmask), 4),
            "lit_cells": {"radiance": int(rmask.sum()), "geometric": int(geo.sum()),
                          "surrogate": int(smask.sum())},
        }
        out_cases.append(row)
        summary.append({k: row[k] for k in ("id", "slot", "day", "alt", "az_room", "threshold",
                                            "iou_geometric_vs_radiance",
                                            "iou_surrogate_vs_radiance", "lit_cells")})

    fixture = {
        "room": {"width": W, "depth": D, "height": H, "north_angle": config.NORTH_ANGLE},
        "sensor_z": SENSOR_Z, "iou_min": IOU_MIN, "cases": out_cases,
    }
    path = config.assert_writable(config.WEB_FIXTURES / "m1.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fixture, separators=(",", ":")))
    (cache_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
    return {"cases": summary, "fixture": str(path)}
