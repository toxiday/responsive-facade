"""The facade CSV convention matches the Rhino model (guidelines §5, M1).

`Units\\501\\output\\501.6\\facade_wide.csv` is the optimised design that `test 4.3dm` shows
on layer Facade-Pixel-Glazing. Every connected group of window panels in the CSV, placed
with v3's panel geometry, must coincide with one merged glazing Brep from the Rhino survey.
The W wall's upper block sits at the N end only, which pins the E/W column direction.
"""

import json
from collections import deque

import pytest

from bake import config

TOL = 0.08          # m; the Rhino breps are offset by the 75 mm wall thickness at corners


def window_groups(binary, wall):
    g = binary[config.SIDES.index(wall)]
    seen, groups = set(), []
    for r in range(16):
        for c in range(32):
            if g[r, c] > 0.5 and (r, c) not in seen:
                q, cells = deque([(r, c)]), []
                seen.add((r, c))
                while q:
                    a, b = q.popleft()
                    cells.append((a, b))
                    for na, nb in ((a + 1, b), (a - 1, b), (a, b + 1), (a, b - 1)):
                        if 0 <= na < 16 and 0 <= nb < 32 and g[na, nb] > 0.5 \
                                and (na, nb) not in seen:
                            seen.add((na, nb))
                            q.append((na, nb))
                groups.append(cells)
    return groups


def group_box(v3, wall, cells):
    """(a0, a1, z0, z1) of a panel group from v3's facade_panel_boxes."""
    boxes = {(s, r, c): (p0, p1) for s, r, c, _i, p0, p1, _n in
             v3.opt.facade_panel_boxes(config.ROOM_W, config.ROOM_D, config.ROOM_H)}
    axis = 0 if wall in ("S", "N") else 1
    pts = [boxes[(wall, r, c)] for r, c in cells]
    return (min(p0[axis] for p0, _ in pts), max(p1[axis] for _, p1 in pts),
            min(p0[2] for p0, _ in pts), max(p1[2] for _, p1 in pts))


def rhino_boxes(wall):
    survey = json.loads(config.SURVEY_JSON.read_text())
    out = []
    for e in survey["facade501"]["Facade-Pixel-Glazing"]:
        (u0, u1), (v0, v1), (z0, z1) = e["u"], e["v"], e["z"]
        if wall == "W" and abs(u0) < 1e-3 and abs(u1) < 1e-3:
            out.append((v0, v1, z0, z1))
        if wall == "S" and abs(v0) < 1e-3 and abs(v1) < 1e-3 and u1 <= config.ROOM_W + TOL:
            out.append((u0, u1, z0, z1))
    return out


@pytest.mark.parametrize("wall", ["S", "W"])
def test_csv_window_groups_match_rhino_glazing(wall):
    v3 = config.import_v3()
    binary = v3.vfr.load_binary_wide(config.OPT_501_6_CSV)
    ours = sorted(group_box(v3, wall, cells) for cells in window_groups(binary, wall))
    theirs = sorted(rhino_boxes(wall))
    assert len(ours) == len(theirs) > 0
    for a, b in zip(ours, theirs):
        assert all(abs(p - q) <= TOL for p, q in zip(a, b)), (wall, a, b)


def test_closed_walls_have_no_windows():
    v3 = config.import_v3()
    binary = v3.vfr.load_binary_wide(config.OPT_501_6_CSV)
    for wall, is_open in zip(config.SIDES, config.SIDES_OPEN):
        if not is_open:
            assert binary[config.SIDES.index(wall)].sum() == 0
