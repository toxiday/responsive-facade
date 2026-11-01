"""Python ground truth for the TypeScript tests (web/src/__fixtures__/conventions.json).

The browser re-creates the facade panels and floor cells itself (guidelines §3.4). These
fixtures come straight from v3's `facade_panel_boxes`, `cell_centres` and `wall_azimuths`,
so a vitest run proves the TypeScript geometry is the solver's geometry. Two rooms are used:
501.6 and a deliberately lopsided one, so a swapped width/depth cannot pass by accident.
"""

from __future__ import annotations

import json

from . import config

ROOMS = [
    {"name": "501.6", "width": config.ROOM_W, "depth": config.ROOM_D, "height": config.ROOM_H},
    {"name": "lopsided", "width": 3.0, "depth": 7.0, "height": 2.7},
]


def build() -> dict:
    v3 = config.import_v3()
    rooms = []
    for r in ROOMS:
        W, D, H = r["width"], r["depth"], r["height"]
        X, Y = v3.live_solver.cell_centres(W, D)
        panels = [[s, row, col, idx, [round(v, 6) for v in p0], [round(v, 6) for v in p1],
                   list(n)]
                  for s, row, col, idx, p0, p1, n in v3.opt.facade_panel_boxes(W, D, H)]
        rooms.append({**r,
                      "cell_x": [round(float(v), 6) for v in X.reshape(-1)],
                      "cell_y": [round(float(v), 6) for v in Y.reshape(-1)],
                      "panels": panels})
    azimuths = {str(a): v3.opt.wall_azimuths(a) for a in (0.0, config.NORTH_ANGLE, 100.0)}

    # The optimised 501.6 facade and the Rhino glazing it should line up with (debug=rhino).
    survey = json.loads(config.SURVEY_JSON.read_text())
    glazing = []
    for e in survey["facade501"]["Facade-Pixel-Glazing"]:
        (u0, u1), (v0, v1), (z0, z1) = e["u"], e["v"], e["z"]
        if abs(u0) < 1e-3 and abs(u1) < 1e-3:
            glazing.append({"wall": "W", "a": [v0, v1], "z": [z0, z1]})
        elif abs(v0) < 1e-3 and abs(v1) < 1e-3 and u1 <= config.ROOM_W + 0.08:
            glazing.append({"wall": "S", "a": [u0, u1], "z": [z0, z1]})
    rhino = {
        "facade": v3.vfr.load_binary_wide(config.OPT_501_6_CSV).astype(int).reshape(-1).tolist(),
        "glazing": glazing,
    }
    return {"rooms": rooms, "wall_azimuths": azimuths, "rhino_501_6": rhino}


def write() -> str:
    path = config.assert_writable(config.WEB_FIXTURES / "conventions.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(build(), separators=(",", ":")))
    return str(path)
