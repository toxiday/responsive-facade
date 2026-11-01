"""web/public/data/manifest.json: everything the site needs that is not per-slot data.

The room, conventions, furniture, activities, the occupant states (with zone grids painted by
v3's `occupant_owner_grid`, so the browser never re-implements zone painting), the legend
colour ramp sampled from v3's `facade_viz.LUX_CMAP`, and the city/day list. Per-slot
facades and lux are added by `pack.py` (M2).
"""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime, timezone

from . import config, room, slots

SCHEMA = 1
CITY_LABELS = {"houston": "Houston, TX", "boston": "Boston, MA", "seattle": "Seattle, WA"}


def owner_string(owner) -> str:
    """A 32x32 owner grid as 1024 characters, row-major: '.' = unowned, '0'..'9' = zone."""
    flat = owner.reshape(-1).astype(int).tolist()
    if len(flat) != 1024 or max(flat) > 9:
        raise ValueError("owner grid must be 32x32 with at most 10 zones")
    return "".join("." if v < 0 else str(v) for v in flat)


def legend() -> dict:
    v3 = config.import_v3()
    import facade_viz  # v3 module; MPLBACKEND=Agg is set by config.apply_env

    lut = [[int(round(c * 255)) for c in facade_viz.LUX_CMAP(i / 255)[:3]] for i in range(256)]
    glare = float(v3.opt.GLARE_LUX)
    return {"vmin": 0.0, "vmax": glare, "usable": [300.0, glare], "glare": glare, "lut": lut}


def build() -> dict:
    v3 = config.import_v3()
    rm = config.check_room()
    states = []
    for st in room.states():
        tgt, owner = room.target_and_owner(st)
        states.append({**asdict(st), "owner": owner_string(owner),
                       "occupied_cells": int((owner >= 0).sum())})
    cities = []
    for city in config.CITIES:
        d = slots.load(city)
        cities.append({
            "id": city, "label": CITY_LABELS[city], "wea": d["wea"],
            "lat": d["lat"], "lon": d["lon"], "tz": d["tz"],
            "months": [{"month": m["month"], "day": m["day"], "ghi_wh": m["ghi_wh"],
                        "ghi_median_wh": m["ghi_median_wh"], "n_slots": len(m["slots"])}
                       for m in d["months"]],
        })
    return {
        "schema": SCHEMA,
        "built_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        # Ships publicly: keep identifiers (commit, checksum), drop local filesystem paths.
        "provenance": {k: v for k, v in config.provenance().items() if k != "pipeline"},
        "room": {
            "id": config.ROOM_ID, "width": config.ROOM_W, "depth": config.ROOM_D,
            "height": config.ROOM_H, "north_angle": config.NORTH_ANGLE,
            "sides": list(config.SIDES), "open": list(config.SIDES_OPEN),
            "wall_azimuth_deg": v3.opt.wall_azimuths(config.NORTH_ANGLE),
            "sensor_height": 0.6, "site_city": "houston",
            "rhino_origin_mm": config.rhino_origin_mm(), "rhino_rot_deg": config.RHINO_ROT_DEG,
            "openings": room.openings(),
        },
        "conventions": {
            "walls": "S = y0, N = y=D, E = x=W, W = x0 (room-local)",
            "floor": "32x32, row 0 = N edge (y=D), col 0 = W edge (x=0), index row*32+col",
            "facade": "4 walls (S,N,E,W) x 16 rows x 32 cols, row 0 = ceiling, "
                      "S/N col 0 at x=0, E/W col 0 at y=0, 1 = window",
            "sun_room": "unit vector from the sun into the room, room frame (north_angle applied)",
            "time": "TMYx local standard time, mid-hour stamps",
        },
        "furniture": [asdict(i) for i in room.furniture()],
        "activities": [asdict(a) for a in room.activities()],
        "states": states,
        "legend": legend(),
        "sky_labels": [list(x) for x in slots.SKY_LABELS],
        "cities": cities,
    }


def write() -> str:
    path = config.assert_writable(config.WEB_DATA / "manifest.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(build(), separators=(",", ":")))
    return str(path)
