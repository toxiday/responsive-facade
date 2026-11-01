"""Room 501.6: furniture, seats, activity spots and the occupant states.

Furniture comes from the Rhino survey (`unit501_furniture.json`). Unit 501's uv frame equals
the room frame for 501.6 (origin_uv = (0, 0), checked by `config.check_room`), so every bbox
below is in room metres: x from the W wall, y from the S wall. Named items map one to one;
casework arrives as fragments (carcasses, fronts, plinths) and is grouped by position.
The desk and its chair are not in the model; they are added for the demo (docs/decisions.md).

Some survey positions are restyled for the demo (Tony, 2026-11-01, in docs/decisions.md):
- the sofa is a standard-depth sofa with its chaise at the S end, away from the kitchen
  (the survey bbox spans the chaise);
- the window armchairs face each other across the round table;
- the dining table is widened to a standard width and the chairs are set square to it;
- the counter stools are pulled out from under the island overhang;
- the desk chair is the same chair as the dining chairs.

Every spot is occupiable (Tony, 2026-11-01). Each piece someone uses has `seats`: where they
sit or stand, which way they face, and which activity that is (the sofa has two, the main seat
and the chaise; the kitchen counters and the range have standing spots in the aisle). The open
floor is covered by a lattice of standing states, one zone per point, so the facade can follow
the occupant as they walk.

Openings in the interior walls come from the floor 5 plan (`config.PLAN_501_AI`, whose
coordinates are 501.6's room frame): the unit's entry door in the N wall, from the building
corridor, and a cased opening in the E wall into the hall to the bedrooms and baths.

Facing angles are in the room frame, degrees counter-clockwise from +x: 0 = towards the E wall,
90 = towards the N wall, 180 = towards the W wall, 270 = towards the S wall.

Target lux comes from the v3 activity table (`live_solver.ACTIVITIES`), except the 200 lux of
the ambient and standing states (Tony's general level) and the 50 lux screen proxy
(`live_solver.TARGET_LUX_MIN`).
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field

from . import config

OBSTACLE_MIN_Z = 0.05      # anything lower (the rug) can be walked over
OBSTACLE_MAX_Z0 = 1.2      # anything that starts higher (wall cabinets) is overhead
AMBIENT_LUX = 200.0
ZONE_RADIUS = 1.0
SCREEN_PROXY_RADIUS = 0.6

# Standing states: a lattice over the open floor. A point is kept if a person standing there
# (a disc of BODY_RADIUS) clears every obstacle footprint and the walls.
STAND_SPACING = 0.75
BODY_RADIUS = 0.25
STAND_LUX = AMBIENT_LUX

# Restyled pieces (metres). Shared with the web builders through Item.params.
SOFA = {"depth": 0.95, "back": 0.22, "arm": 0.20, "chaise_width": 0.80}
DINING_TUCK = 0.10         # chair fronts this far under the table (and desk) edge
STOOL_TUCK = 0.05          # stool fronts this far under the counter edge
DINING_TABLE_WIDTH = 0.95  # the survey table is 0.76 m wide
DINING_TABLE_CY = 6.10     # its centre line, between the rug and the island
SINK_BASIN = {"depth": 0.20, "faucet_strip": 0.08, "rim": 0.03}

# Openings in the closed walls, from the floor 5 plan (checked by test_openings_match_plan).
# `a0..a1` runs along the wall (x on S/N, y on E/W); `z1` is the head height, not in the plan.
DOOR_HEAD = 2.1
OPENINGS = (
    {"id": "entry", "wall": "N", "kind": "door", "a0": 4.547, "a1": 5.297, "z1": DOOR_HEAD,
     "hinge": 5.297, "label": "Entry from the corridor"},
    {"id": "hall", "wall": "E", "kind": "opening", "a0": 6.718, "a1": 7.848, "z1": DOOR_HEAD,
     "hinge": None, "label": "Hall to the bedrooms"},
)


@dataclass
class Item:
    id: str
    type: str
    label: str
    bbox: tuple[float, float, float, float]      # x0, y0, x1, y1
    z0: float
    z1: float
    facing: float | None = None
    click: str | None = None                      # activity id, or "tv"
    added: bool = False
    params: dict | None = None                    # shape parameters for the web builder
    seats: list = field(default_factory=list)     # where people use it; see _seat()
    wall: str | None = None                       # wall it hangs on; hidden with that wall
    obstacle: bool = field(init=False)
    footprint: list = field(init=False)           # floor rects; the bbox unless L-shaped

    def __post_init__(self):
        self.bbox = tuple(round(v, 4) for v in self.bbox)
        self.z0, self.z1 = round(self.z0, 4), round(self.z1, 4)
        self.seats = [{**st, "x": round(st["x"], 3), "y": round(st["y"], 3)} for st in self.seats]
        self.obstacle = self.z1 > OBSTACLE_MIN_Z and self.z0 < OBSTACLE_MAX_Z0
        self.footprint = [list(r) for r in _footprint(self)]


# Builders work in a local frame: +x = front (the facing direction), +z = the right hand of
# someone facing front. Depth and width follow the facing, as in web/src/scene/furniture.ts.

def _local_size(item):
    ex, ey = item.bbox[2] - item.bbox[0], item.bbox[3] - item.bbox[1]
    along = abs(math.cos(math.radians(item.facing or 0.0))) >= 0.5
    return (ex, ey) if along else (ey, ex)


def _to_room(item, lx, lz):
    """A local (x, z) point, relative to the bbox centre, in room coordinates."""
    cx, cy = _centre(item.bbox)
    a = math.radians(item.facing or 0.0)
    c, s = math.cos(a), math.sin(a)
    return (cx + lx * c + lz * s, cy + lx * s - lz * c)


def _local_rect_to_room(item, lx0, lz0, lx1, lz1):
    pts = [_to_room(item, lx, lz) for lx in (lx0, lx1) for lz in (lz0, lz1)]
    xs, ys = zip(*pts)
    return tuple(round(v, 4) for v in (min(xs), min(ys), max(xs), max(ys)))


def _sofa_parts(item):
    """(main, chaise) rects in the local frame: the sofa along the back, the chaise forward."""
    p = item.params
    dx, dz = _local_size(item)
    side = 1.0 if p["chaise"] == "right" else -1.0
    main = (-dx / 2, -dz / 2, -dx / 2 + p["depth"], dz / 2)
    z_in, z_out = side * (dz / 2 - p["chaise_width"]), side * dz / 2
    chaise = (-dx / 2 + p["depth"], min(z_in, z_out), dx / 2, max(z_in, z_out))
    return main, chaise


def _footprint(item):
    if item.type == "sectional" and item.params and item.params.get("chaise"):
        return [_local_rect_to_room(item, *r) for r in _sofa_parts(item)]
    return [item.bbox]


def sofa_seat(item):
    """Middle of the sofa's main seat: in front of the back, between the arm and the chaise."""
    p = item.params
    dx, dz = _local_size(item)
    side = 1.0 if p["chaise"] == "right" else -1.0
    lx = -dx / 2 + (p["back"] + p["depth"]) / 2
    lz = -side * (p["chaise_width"] - p["arm"]) / 2
    return tuple(round(v, 3) for v in _to_room(item, lx, lz))


def chaise_seat(item):
    """Someone on the chaise: back against the sofa back, between its arm and its inner edge,
    legs along the chaise."""
    p = item.params
    dx, dz = _local_size(item)
    side = 1.0 if p["chaise"] == "right" else -1.0
    lx = -dx / 2 + (p["back"] + p["depth"]) / 2
    lz = side * (dz / 2 - (p["chaise_width"] + p["arm"]) / 2)
    return tuple(round(v, 3) for v in _to_room(item, lx, lz))


def _seat(x, y, facing, activity):
    """Where a person using a piece sits or stands, facing (deg CCW from +x), doing what."""
    return {"x": x, "y": y, "facing": float(facing), "activity": activity}


def _survey():
    room = config.check_room()
    w, d = room["width"], room["depth"]
    items = json.loads(config.FURN_JSON.read_text())
    return [e for e in items
            if e["umin"] > -0.1 and e["umax"] < w + 0.1
            and e["vmin"] > -0.1 and e["vmax"] < d + 0.1]


def _bbox(e):
    return (e["umin"], e["vmin"], e["umax"], e["vmax"])


def _union(es):
    return (min(e["umin"] for e in es), min(e["vmin"] for e in es),
            max(e["umax"] for e in es), max(e["vmax"] for e in es))


def _centre(b):
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def _one(es, name):
    hits = [e for e in es if e["name"] == name]
    if len(hits) != 1:
        raise ValueError(f"expected one {name!r} in 501.6, found {len(hits)}")
    return hits[0]


def _many(es, name, n):
    hits = sorted((e for e in es if e["name"] == name), key=lambda e: (e["v"], e["u"]))
    if len(hits) != n:
        raise ValueError(f"expected {n} x {name!r} in 501.6, found {len(hits)}")
    return hits


def _group(es, pred, what):
    hits = [e for e in es if e["name"] == "casework" and pred(e)]
    if not hits:
        raise ValueError(f"no casework found for {what}")
    return hits


def _chair_size(survey):
    """(width, depth) of the dining chair, from the survey."""
    sizes = [sorted((e["umax"] - e["umin"], e["vmax"] - e["vmin"])) for e in survey]
    return max(s[0] for s in sizes), max(s[1] for s in sizes)


def _dining_chairs(table, size):
    """Six chairs set square to the table: two per long side at the quarter points, one at
    each end, fronts tucked DINING_TUCK under the edge.
    Order: S side W to E, N side W to E, W end, E end."""
    w, d = size
    x0, y0, x1, y1 = table
    t = DINING_TUCK
    if x1 - x0 < y1 - y0:
        raise ValueError("dining table is expected to run W-E")
    out = []
    for y_a, y_b, facing in ((y0 + t - d, y0 + t, 90.0), (y1 - t, y1 - t + d, 270.0)):
        for q in (0.25, 0.75):
            cx = x0 + q * (x1 - x0)
            out.append(((cx - w / 2, y_a, cx + w / 2, y_b), facing))
    cy = (y0 + y1) / 2
    out.append(((x0 + t - d, cy - w / 2, x0 + t, cy + w / 2), 0.0))
    out.append(((x1 - t, cy - w / 2, x1 - t + d, cy + w / 2), 180.0))
    return out


def _sink_basin(sink):
    """The basin opening in room coordinates: the sink bbox less the faucet strip on its far
    (S) side and a rim on the others. The sink faces S; the cook stands on the N side."""
    x0, y0, x1, y1 = _bbox(sink)
    r, f = SINK_BASIN["rim"], SINK_BASIN["faucet_strip"]
    return [round(v, 4) for v in (x0 + r, y0 + f, x1 - r, y1 - r)]


FRONT_T = 0.04      # cabinet fronts are the casework pieces thinner than this
PLINTH_H = 0.10     # base cabinets stand on a recessed plinth (survey: plinth tops at 0.1)


def _fronts(es, bbox, z_range, floor):
    """Cabinet fronts on a casework piece, for the division lines between doors and drawers.

    The survey gives each front's footprint and top but not its bottom, so a front starts
    where the one below it in its column ends, and the lowest at `floor` (the plinth top, or
    the cabinet's bottom). Columns meet at the middle of the gap between them. Returned on the
    piece's drawn face: {"axis": the room axis the face is normal to, "plane": its coordinate,
    "out": +1/-1 the outward direction, "cells": [[a0, a1, z0, z1], ...]} with `a` along the
    face (x for an axis-y face, y for an axis-x face) and z in room metres."""
    x0, y0, x1, y1 = bbox
    near = [e for e in es if e["name"] == "casework"
            and min(e["umax"] - e["umin"], e["vmax"] - e["vmin"]) < FRONT_T
            and e["umin"] > x0 - 0.03 and e["umax"] < x1 + 0.03
            and e["vmin"] > y0 - 0.03 and e["vmax"] < y1 + 0.03
            and z_range[0] < e["ztop"] <= z_range[1] + 1e-3]
    if not near:
        return None
    thin_y = near[0]["vmax"] - near[0]["vmin"] < FRONT_T
    if thin_y:
        lo, hi, centre, a_key = y0, y1, (y0 + y1) / 2, ("umin", "umax")
        side = (near[0]["vmin"] + near[0]["vmax"]) / 2
    else:
        lo, hi, centre, a_key = x0, x1, (x0 + x1) / 2, ("vmin", "vmax")
        side = (near[0]["umin"] + near[0]["umax"]) / 2
    out = 1 if side > centre else -1
    columns: dict = {}
    for e in near:
        columns.setdefault((round(e[a_key[0]], 3), round(e[a_key[1]], 3)), []).append(e["ztop"])
    spans = sorted(columns)
    cells = []
    for i, (a0, a1) in enumerate(spans):
        if i > 0 and a0 - spans[i - 1][1] < 0.01:
            a0 = (a0 + spans[i - 1][1]) / 2
        if i + 1 < len(spans) and spans[i + 1][0] - a1 < 0.01:
            a1 = (a1 + spans[i + 1][0]) / 2
        bottom = floor
        for top in sorted(columns[spans[i]]):
            cells.append([round(a0, 4), round(a1, 4), round(bottom, 4), round(top, 4)])
            bottom = top
    return {"axis": "y" if thin_y else "x", "plane": round(hi if out > 0 else lo, 4),
            "out": out, "cells": cells}


def _seat_at(b, facing, activity):
    c = _centre(b)
    return _seat(c[0], c[1], facing, activity)


def furniture() -> list[Item]:
    es = _survey()
    out: list[Item] = []

    # The sofa faces the TV (E); the chaise is at the S end, which is the sitter's right.
    sofa = _one(es, "Sectional Burrow Nomad Chaise")
    s = Item("sofa", "sectional", "Sofa", _bbox(sofa), 0, sofa["ztop"], 0.0, "couch",
             params={**SOFA, "chaise": "right"})
    s.seats = [_seat(*sofa_seat(s), 0.0, "couch"), _seat(*chaise_seat(s), 0.0, "lounger")]
    s.__post_init__()
    out.append(s)
    ct = _one(es, "Coffee Table Plinth")
    out.append(Item("coffee_table", "coffee_table", "Coffee table", _bbox(ct), 0, ct["ztop"]))
    st = _one(es, "Side Table Saarinen")
    out.append(Item("side_table", "round_table", "Side table", _bbox(st), 0, st["ztop"]))

    rug = _group(es, lambda e: e["ztop"] < OBSTACLE_MIN_Z, "rug")
    out.append(Item("rug", "rug", "Rug", _union(rug), 0, max(e["ztop"] for e in rug)))

    console = _group(es, lambda e: e["umin"] > 4.7 and e["vmin"] >= 1.9 and e["vmax"] <= 4.5,
                     "media console")
    cz = max(e["ztop"] for e in console)
    out.append(Item("media_console", "console", "Media console", _union(console), 0, cz, 180.0,
                    "tv", params={"fronts": _fronts(es, _union(console), (0, cz), 0.0)}))
    tv = _one(es, "TV 77in LG C9")
    out.append(Item("tv", "tv", "TV", _bbox(tv), max(e["ztop"] for e in console), tv["ztop"],
                    180.0, "tv"))

    # The two window armchairs face each other across the round table; both are reading seats.
    chairs = _many(es, "Armchair Divina", 2)
    west, east = sorted(chairs, key=lambda e: e["u"])
    out.append(Item("armchair_w", "armchair", "Armchair", _bbox(west), 0, west["ztop"], 0.0,
                    "lounge_read_w", seats=[_seat_at(_bbox(west), 0.0, "lounge_read_w")]))
    out.append(Item("armchair_e", "armchair", "Armchair", _bbox(east), 0, east["ztop"], 180.0,
                    "lounge_read_e", seats=[_seat_at(_bbox(east), 180.0, "lounge_read_e")]))
    rt = _one(es, "Coffee Table Flume Round")
    out.append(Item("window_table", "round_table", "Round table", _bbox(rt), 0, rt["ztop"]))

    # Dining table: the survey length, widened about DINING_TABLE_CY.
    table = _one(es, "Dining Table Keeps")
    half = DINING_TABLE_WIDTH / 2
    tb = (table["umin"], DINING_TABLE_CY - half, table["umax"], DINING_TABLE_CY + half)
    out.append(Item("dining_table", "dining_table", "Dining table", tb, 0, table["ztop"], None,
                    "dining"))
    survey_chairs = _many(es, "Dining Chair Cesca", 6)
    chair_size = _chair_size(survey_chairs)
    chair_h = max(c["ztop"] for c in survey_chairs)
    for i, (b, facing) in enumerate(_dining_chairs(tb, chair_size)):
        out.append(Item(f"dining_chair_{i}", "chair", "Dining chair", b, 0, chair_h, facing,
                        "dining", seats=[_seat_at(b, facing, "dining")]))

    # The island top overhangs its base on the S side, where the stools are. The survey has
    # the stools pushed fully under it; they are pulled out to sitting position. The sink is
    # cut into the top.
    island = _group(es, lambda e: e["vmin"] >= 7.6 and e["vmax"] <= 8.62, "island")
    top = max(island, key=lambda e: e["ztop"])
    overhang = min(e["vmin"] for e in island if e is not top) - top["vmin"]
    sink = _one(es, "Kitchen Sink Norrsjon + Faucet")
    basin = _sink_basin(sink)
    ib = _union(island)
    out.append(Item("island", "island", "Kitchen island", ib, 0, top["ztop"],
                    270.0, "cooking_range",
                    params={"overhang": round(overhang, 3), "cutout": basin,
                            "cutout_depth": SINK_BASIN["depth"],
                            "fronts": _fronts(es, ib, (0, top["ztop"]), PLINTH_H)}))
    out.append(Item("sink", "sink", "Sink", _bbox(sink), 0, sink["ztop"], 270.0, "cooking_range",
                    params={"basin": basin, "depth": SINK_BASIN["depth"],
                            "counter": top["ztop"]}))
    for i, e in enumerate(sorted(_many(es, "Counter Stool Onda", 3), key=lambda e: e["u"])):
        x0, y0, x1, y1 = _bbox(e)
        dy = y1 - (top["vmin"] + STOOL_TUCK)
        b = (x0, y0 - dy, x1, y1 - dy)
        out.append(Item(f"stool_{i}", "stool", "Counter stool", b, 0, e["ztop"], 90.0,
                        "counter", seats=[_seat_at(b, 90.0, "counter")]))

    # Kitchen run on the N wall: base counters either side of the range, the range, the
    # fridge with its tall cabinet above, and the wall cabinets. Three standing spots in the
    # aisle (Tony): the W counter by the window, the range (with the sink behind), the E
    # counter. All stand midway between the island and the range front, facing the wall.
    rng = _one(es, "Range GE Slide-In 30in")
    aisle_y = (_union(island)[3] + rng["vmin"]) / 2
    kitchen = ("cooking_w", "cooking_e")
    bases = _group(es, lambda e: e["vmin"] >= 9.8 and e["vmax"] > 10.3 and 0.89 <= e["ztop"] <= 0.91,
                   "base counters")
    for i, b in enumerate(sorted(bases, key=lambda e: e["umin"])):
        x = (b["umin"] + b["umax"]) / 2
        out.append(Item(f"counter_{i}", "counter", "Counter", _bbox(b), 0, b["ztop"], 270.0,
                        kitchen[i], seats=[_seat(x, aisle_y, 90.0, kitchen[i])],
                        params={"fronts": _fronts(es, _bbox(b), (0, b["ztop"]), PLINTH_H)}))
    x = (rng["umin"] + rng["umax"]) / 2
    out.append(Item("range", "range", "Range", _bbox(rng), 0, rng["ztop"], 270.0,
                    "cooking_range", seats=[_seat(x, aisle_y, 90.0, "cooking_range")]))
    fridge = _one(es, "Fridge Whirlpool French Door")
    out.append(Item("fridge", "fridge", "Fridge", _bbox(fridge), 0, fridge["ztop"], 270.0,
                    "cooking_e"))
    tall = _group(es, lambda e: e["umin"] > 3.4 and e["vmin"] >= 9.8 and e["vmax"] > 10.3
                  and e["ztop"] >= 2.99, "fridge cabinet")
    out.append(Item("fridge_cabinet", "cabinet", "Cabinet", _union(tall), fridge["ztop"], 3.0,
                    270.0, wall="N",
                    params={"fronts": _fronts(es, _union(tall), (fridge["ztop"], 3.0),
                                              fridge["ztop"])}))
    uppers = _group(es, lambda e: e["umax"] < 3.42 and e["vmin"] >= 10.07 and e["vmax"] > 10.4
                    and e["ztop"] >= 2.99, "wall cabinets")
    hood = _group(es, lambda e: e["vmin"] >= 10.07 and e["vmax"] > 10.4
                  and 1.6 < e["ztop"] < 1.8, "hood")
    up_z0 = max(e["ztop"] for e in hood)
    out.append(Item("wall_cabinets", "cabinet", "Wall cabinets", _union(uppers), up_z0, 3.0,
                    270.0, wall="N",
                    params={"fronts": _fronts(es, _union(uppers), (up_z0, 3.0), up_z0)}))

    # Added for the demo: 501.6 has no desk (docs/decisions.md). Its chair is a dining chair,
    # tucked under the desk like the dining chairs.
    desk = (0.05, 4.9, 0.65, 6.1)
    out.append(Item("desk", "desk", "Desk (added)", desk, 0, 0.75, 0.0, "desk", added=True))
    w, d = chair_size
    dy = _centre(desk)[1]
    b = (desk[2] - DINING_TUCK, dy - w / 2, desk[2] - DINING_TUCK + d, dy + w / 2)
    out.append(Item("desk_chair", "chair", "Desk chair (added)", b, 0, chair_h, 180.0, "desk",
                    added=True, seats=[_seat_at(b, 180.0, "desk")]))

    # The entry door, drawn open into the room against the E wall, as in the plan.
    door = next(o for o in OPENINGS if o["id"] == "entry")
    leaf = door["a1"] - door["a0"]
    d = config.ROOM_D
    out.append(Item("entry_door", "door", "Entry door", (door["hinge"] - 0.04, d - leaf,
                                                           door["hinge"], d),
                    0, door["z1"], 180.0))
    return out


def openings() -> list[dict]:
    return [dict(o) for o in OPENINGS]


# ---------------------------------------------------------------------------
# Activities and states
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Zone:
    x: float
    y: float
    target: float
    radius: float
    role: str          # "activity" | "screen_proxy" | "ambient" | "standing"


@dataclass(frozen=True)
class State:
    id: str
    label: str
    kind: str          # "ambient" | "activity" | "standing"
    zones: tuple[Zone, ...]


@dataclass(frozen=True)
class Activity:
    id: str
    label: str
    states: tuple[str, ...]          # the sofa's two have TV off / TV on
    spot: tuple[float, float]        # its first seat: for clicks on pieces without seats
    facing: float
    pose: str


def _activity_lux():
    v3 = config.import_v3()
    return dict(v3.live_solver.ACTIVITIES), v3.live_solver.TARGET_LUX_MIN


def _clearance(p, rect):
    """Distance from point p to an axis-aligned rect (0 inside)."""
    dx = max(rect[0] - p[0], 0.0, p[0] - rect[2])
    dy = max(rect[1] - p[1], 0.0, p[1] - rect[3])
    return math.hypot(dx, dy)


STAND_COVER = STAND_SPACING / math.sqrt(2) + 0.05   # no open floor farther than this
STAND_FILL_STEP = 0.05


def _standable(p, rects):
    w, d = config.ROOM_W, config.ROOM_D
    return (BODY_RADIUS <= p[0] <= w - BODY_RADIUS and BODY_RADIUS <= p[1] <= d - BODY_RADIUS
            and all(_clearance(p, r) >= BODY_RADIUS for r in rects))


def standing_points(items=None) -> list[tuple[float, float]]:
    """Standing positions on the open floor: a lattice centred on the room (S to N, then W to
    E), then fill points wherever open floor is more than STAND_COVER from every point, which
    happens in passages narrower than the lattice (between the dining chairs and the island)."""
    items = items if items is not None else furniture()
    w, d = config.ROOM_W, config.ROOM_D
    rects = [r for i in items if i.obstacle for r in i.footprint]

    def axis(length):
        n = int((length / 2 - BODY_RADIUS) // STAND_SPACING)
        return [length / 2 + k * STAND_SPACING for k in range(-n, n + 1)]

    pts = [(x, y) for y in axis(d) for x in axis(w) if _standable((x, y), rects)]
    step = STAND_FILL_STEP
    for j in range(int(d / step) + 1):
        for i in range(int(w / step) + 1):
            p = (i * step, j * step)
            if _standable(p, rects) and all(math.dist(p, q) > STAND_COVER for q in pts):
                pts.append(p)
    return [(round(x, 3), round(y, 3)) for x, y in pts]


def states() -> list[State]:
    lux, lux_min = _activity_lux()
    w, d = config.ROOM_W, config.ROOM_D
    items = furniture()
    seat = {}
    for i in items:
        for st in i.seats:
            seat.setdefault(st["activity"], (st["x"], st["y"]))
    f = {i.id: i for i in items}
    tv = _centre(f["tv"].bbox)
    table = _centre(f["dining_table"].bbox)
    stools = [st for i in items if i.type == "stool" for st in i.seats]
    counter = (sum(s["x"] for s in stools) / len(stools), sum(s["y"] for s in stools) / len(stools))
    desk = _centre(f["desk"].bbox)

    def z(p, target, radius=ZONE_RADIUS, role="activity"):
        return Zone(round(p[0], 3), round(p[1], 3), float(target), float(radius), role)

    relax = lux["Relaxing / TV"]
    # Screen proxy: in front of the TV, between it and the coffee table, clear of the sofa zones.
    screen = z((tv[0] - 0.8, tv[1]), lux_min, SCREEN_PROXY_RADIUS, "screen_proxy")
    cook = lux["Cooking"]
    out = [
        State("ambient", "Ambient", "ambient",
              (z((w / 2, d / 2), AMBIENT_LUX, math.hypot(w, d) / 2 + 0.01, "ambient"),)),
        State("couch_relax", "Relaxing on the sofa", "activity", (z(seat["couch"], relax),)),
        State("couch_tv", "Watching TV", "activity", (z(seat["couch"], relax), screen)),
        State("lounger_relax", "Relaxing on the chaise", "activity",
              (z(seat["lounger"], relax),)),
        State("lounger_tv", "Watching TV from the chaise", "activity",
              (z(seat["lounger"], relax), screen)),
        State("lounge_read_w", "Reading by the window", "activity",
              (z(seat["lounge_read_w"], lux["Reading"]),)),
        State("lounge_read_e", "Reading by the window", "activity",
              (z(seat["lounge_read_e"], lux["Reading"]),)),
        State("dining", "Dining", "activity", (z(table, lux["Dining"]),)),
        State("counter", "At the counter", "activity", (z(counter, lux["Dining"]),)),
        State("cooking_w", "Cooking", "activity", (z(seat["cooking_w"], cook),)),
        State("cooking_range", "Cooking", "activity", (z(seat["cooking_range"], cook),)),
        State("cooking_e", "Cooking", "activity", (z(seat["cooking_e"], cook),)),
        State("desk", "Desk work", "activity", (z(desk, lux["Desk work"]),)),
    ]
    for k, p in enumerate(standing_points(items)):
        out.append(State(f"stand_{k:03d}", "Standing", "standing",
                         (z(p, STAND_LUX, role="standing"),)))
    return out


ACTIVITY_LIST = (
    # id, label, states, pose
    ("couch", "Sofa", ("couch_relax", "couch_tv"), "sit"),
    ("lounger", "Chaise", ("lounger_relax", "lounger_tv"), "recline"),
    ("lounge_read_w", "Reading chair", ("lounge_read_w",), "read"),
    ("lounge_read_e", "Reading chair", ("lounge_read_e",), "read"),
    ("dining", "Dining table", ("dining",), "sit_table"),
    ("counter", "Counter", ("counter",), "sit_table"),
    ("cooking_w", "Kitchen counter", ("cooking_w",), "cook"),
    ("cooking_range", "Range", ("cooking_range",), "cook"),
    ("cooking_e", "Kitchen counter", ("cooking_e",), "cook"),
    ("desk", "Desk", ("desk",), "type"),
)


def activities() -> list[Activity]:
    """Each activity's default spot is its first seat (for clicks on pieces without seats,
    such as the dining table or the island)."""
    first = {}
    for i in furniture():
        for st in i.seats:
            first.setdefault(st["activity"], st)
    return [Activity(a, label, states_, (first[a]["x"], first[a]["y"]), first[a]["facing"], pose)
            for a, label, states_, pose in ACTIVITY_LIST]


def occupants(state: State):
    """The state's zones as v3 `Occupant`s, for `target_grid` / `occupant_owner_grid`."""
    ls = config.import_v3().live_solver
    return [ls.Occupant(i, zn.x, zn.y, zn.target, zn.radius, zn.role)
            for i, zn in enumerate(state.zones)]


def target_and_owner(state: State):
    """(target (1,32,32) float32, owner (32,32) int32) painted by v3's own functions."""
    ls = config.import_v3().live_solver
    occ = occupants(state)
    owner = ls.occupant_owner_grid(occ, config.ROOM_W, config.ROOM_D)
    return ls.target_grid(occ, config.ROOM_W, config.ROOM_D, owner=owner), owner


def to_json():
    return {
        "furniture": [asdict(i) for i in furniture()],
        "states": [asdict(s) for s in states()],
        "activities": [asdict(a) for a in activities()],
    }
