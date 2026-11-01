"""Read the floor plans in Building Model v2 (legacy PostScript Illustrator files written by
`renders/unit 501 views scripts/floor_plans.py`) as per-layer polylines in metres.

The plans are drawn at 1:100 in points. Coordinates are returned from the floor's outer
top-left corner, x to the right and y downward, which for unit 501 is the unit's uv frame, and
so 501.6's room frame (origin_uv = (0, 0); see `config.check_room`).
"""

from __future__ import annotations

import re
from pathlib import Path

PT_PER_M = 72 / 25.4 * 10          # 1:100
_NUM = re.compile(r"^-?\d*\.?\d+(?:[eE][-+]?\d+)?$")


def read_layers(path: Path) -> dict[str, list[list[tuple[float, float]]]]:
    """Polylines per layer, in AI points (y up). Curves keep their control points."""
    layers: dict[str, list] = {}
    layer = None
    cur: list = []
    for line in path.read_bytes().decode("latin-1").splitlines():
        if line.startswith("%AI5_BeginLayer"):
            layer = None
            continue
        m = re.match(r"^\((.*)\) Ln$", line)
        if m:
            layer = m.group(1)
            layers.setdefault(layer, [])
            continue
        toks = line.split()
        if layer is None or not toks or not all(_NUM.match(t) for t in toks[:-1]):
            continue
        op, v = toks[-1], [float(t) for t in toks[:-1]]
        if op == "m" and len(v) == 2:
            if len(cur) > 1:
                layers[layer].append(cur)
            cur = [tuple(v)]
        elif op in ("l", "L") and len(v) == 2:
            cur.append(tuple(v))
        elif op in ("c", "C") and len(v) == 6:
            cur += [(v[0], v[1]), (v[2], v[3]), (v[4], v[5])]
        elif op in ("v", "V", "y", "Y") and len(v) == 4:
            cur += [(v[0], v[1]), (v[2], v[3])]
        elif op in ("f", "F", "s", "S", "b", "B", "n", "N"):
            if len(cur) > 1:
                layers[layer].append(cur)
            cur = []
    return layers


def boxes_m(path: Path, layer: str) -> list[tuple[float, float, float, float]]:
    """Bounding boxes (x0, y0, x1, y1) of a layer's paths, in metres from the floor's outer
    top-left corner (x right, y down). The corner is taken from the Wall layer."""
    layers = read_layers(path)
    walls = layers["Wall"]
    x_min = min(x for p in walls for x, _ in p)
    y_max = max(y for p in walls for _, y in p)
    out = []
    for p in layers[layer]:
        xs, ys = zip(*p)
        out.append(((min(xs) - x_min) / PT_PER_M, (y_max - max(ys)) / PT_PER_M,
                    (max(xs) - x_min) / PT_PER_M, (y_max - min(ys)) / PT_PER_M))
    return out
