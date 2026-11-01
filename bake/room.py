"""Room 501.6: furniture, activity spots and the seven occupant states.

Furniture comes from the Rhino survey (`unit501_furniture.json`). Unit 501's uv frame equals
the room frame for 501.6 (origin_uv = (0, 0), checked by `config.check_room`), so every bbox
below is in room metres: x from the W wall, y from the S wall. Named items map one to one;
casework arrives as fragments (carcasses, fronts, plinths) and is grouped by position.
The desk and its chair are not in the model; they are added for the demo (docs/decisions.md).

Some survey positions are restyled for the demo (Tony, 2026-11-01, in docs/decisions.md):
- the sofa is a standard-depth sofa with its chaise at the S end, away from the kitchen
  (the survey bbox spans the chaise);
- the window armchairs face each other across the round table;
- the dining chairs are set square to the table;
- the counter stools are pulled out from under the island overhang.

Facing angles are in the room frame, degrees counter-clockwise from +x: 0 = towards the E wall,
90 = towards the N wall, 180 = towards the W wall, 270 = towards the S wall.

Target lux comes from the v3 activity table (`live_solver.ACTIVITIES`), except the ambient
200 lux (Tony's decision) and the 50 lux screen proxy (`live_solver.TARGET_LUX_MIN`).
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

# Restyled pieces (metres). Shared with the web builders through Item.params.
SOFA = {"depth": 0.95, "back": 0.22, "arm": 0.20, "chaise_width": 0.80}
DINING_TUCK = 0.10         # chair fronts this far under the table edge
STOOL_TUCK = 0.05          # stool fronts this far under the counter edge


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
    obstacle: bool = field(init=False)
    footprint: list = field(init=False)           # floor rects; the bbox unless L-shaped

    def __post_init__(self):
        self.bbox = tuple(round(v, 4) for v in self.bbox)
        self.z0, self.z1 = round(self.z0, 4), round(self.z1, 4)
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


def _dining_chairs(table, survey):
    """Six chairs set square to the table: two per long side at the quarter points, one at
    each end, fronts tucked DINING_TUCK under the edge. Chair size from the survey.
    Order: S side W to E, N side W to E, W end, E end."""
    sizes = [sorted((e["umax"] - e["umin"], e["vmax"] - e["vmin"])) for e in survey]
    w, d = max(s[0] for s in sizes), max(s[1] for s in sizes)
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


def furniture() -> list[Item]:
    es = _survey()
    out: list[Item] = []

    # The sofa faces the TV (E); the chaise is at the S end, which is the sitter's right.
    sofa = _one(es, "Sectional Burrow Nomad Chaise")
    out.append(Item("sofa", "sectional", "Sofa", _bbox(sofa), 0, sofa["ztop"], 0.0, "couch",
                    params={**SOFA, "chaise": "right"}))
    ct = _one(es, "Coffee Table Plinth")
    out.append(Item("coffee_table", "coffee_table", "Coffee table", _bbox(ct), 0, ct["ztop"]))
    st = _one(es, "Side Table Saarinen")
    out.append(Item("side_table", "round_table", "Side table", _bbox(st), 0, st["ztop"]))

    rug = _group(es, lambda e: e["ztop"] < OBSTACLE_MIN_Z, "rug")
    out.append(Item("rug", "rug", "Rug", _union(rug), 0, max(e["ztop"] for e in rug)))

    console = _group(es, lambda e: e["umin"] > 4.7 and e["vmin"] >= 1.9 and e["vmax"] <= 4.5,
                     "media console")
    out.append(Item("media_console", "console", "Media console", _union(console), 0,
                    max(e["ztop"] for e in console), 180.0, "tv"))
    tv = _one(es, "TV 77in LG C9")
    out.append(Item("tv", "tv", "TV", _bbox(tv), max(e["ztop"] for e in console), tv["ztop"],
                    180.0, "tv"))

    # The two window armchairs face each other across the round table.
    chairs = _many(es, "Armchair Divina", 2)
    west, east = sorted(chairs, key=lambda e: e["u"])
    out.append(Item("armchair_w", "armchair", "Armchair", _bbox(west), 0, west["ztop"], 0.0,
                    "lounge_read"))
    out.append(Item("armchair_e", "armchair", "Armchair", _bbox(east), 0, east["ztop"], 180.0))
    rt = _one(es, "Coffee Table Flume Round")
    out.append(Item("window_table", "round_table", "Round table", _bbox(rt), 0, rt["ztop"]))

    table = _one(es, "Dining Table Keeps")
    out.append(Item("dining_table", "dining_table", "Dining table", _bbox(table), 0,
                    table["ztop"], None, "dining"))
    survey_chairs = _many(es, "Dining Chair Cesca", 6)
    chair_h = max(c["ztop"] for c in survey_chairs)
    for i, (b, facing) in enumerate(_dining_chairs(_bbox(table), survey_chairs)):
        out.append(Item(f"dining_chair_{i}", "chair", "Dining chair", b, 0, chair_h, facing,
                        "dining"))

    # The island top overhangs its base on the S side, where the stools are. The survey has
    # the stools pushed fully under it; they are pulled out to sitting position.
    island = _group(es, lambda e: e["vmin"] >= 7.6 and e["vmax"] <= 8.62, "island")
    top = max(island, key=lambda e: e["ztop"])
    overhang = min(e["vmin"] for e in island if e is not top) - top["vmin"]
    out.append(Item("island", "island", "Kitchen island", _union(island), 0, top["ztop"],
                    270.0, "cooking", params={"overhang": round(overhang, 3)}))
    sink = _one(es, "Kitchen Sink Norrsjon + Faucet")
    out.append(Item("sink", "sink", "Sink", _bbox(sink), 0, sink["ztop"], 270.0, "cooking"))
    for i, s in enumerate(sorted(_many(es, "Counter Stool Onda", 3), key=lambda e: e["u"])):
        x0, y0, x1, y1 = _bbox(s)
        dy = y1 - (top["vmin"] + STOOL_TUCK)
        out.append(Item(f"stool_{i}", "stool", "Counter stool", (x0, y0 - dy, x1, y1 - dy), 0,
                        s["ztop"], 90.0, "cooking"))

    # Kitchen run on the N wall: base counters either side of the range, the range, the
    # fridge with its tall cabinet above, and the wall cabinets.
    bases = _group(es, lambda e: e["vmin"] >= 9.8 and e["vmax"] > 10.3 and 0.89 <= e["ztop"] <= 0.91,
                   "base counters")
    for i, b in enumerate(sorted(bases, key=lambda e: e["umin"])):
        out.append(Item(f"counter_{i}", "counter", "Counter", _bbox(b), 0, b["ztop"], 270.0,
                        "cooking"))
    rng = _one(es, "Range GE Slide-In 30in")
    out.append(Item("range", "range", "Range", _bbox(rng), 0, rng["ztop"], 270.0, "cooking"))
    fridge = _one(es, "Fridge Whirlpool French Door")
    out.append(Item("fridge", "fridge", "Fridge", _bbox(fridge), 0, fridge["ztop"], 270.0,
                    "cooking"))
    tall = _group(es, lambda e: e["umin"] > 3.4 and e["vmin"] >= 9.8 and e["vmax"] > 10.3
                  and e["ztop"] >= 2.99, "fridge cabinet")
    out.append(Item("fridge_cabinet", "cabinet", "Cabinet", _union(tall), fridge["ztop"], 3.0,
                    270.0))
    uppers = _group(es, lambda e: e["umax"] < 3.42 and e["vmin"] >= 10.07 and e["vmax"] > 10.4
                    and e["ztop"] >= 2.99, "wall cabinets")
    hood = _group(es, lambda e: e["vmin"] >= 10.07 and e["vmax"] > 10.4
                  and 1.6 < e["ztop"] < 1.8, "hood")
    out.append(Item("wall_cabinets", "cabinet", "Wall cabinets", _union(uppers),
                    max(e["ztop"] for e in hood), 3.0, 270.0))

    # Added for the demo: 501.6 has no desk (docs/decisions.md).
    out.append(Item("desk", "desk", "Desk (added)", (0.05, 4.9, 0.65, 6.1), 0, 0.75, 0.0,
                    "desk", added=True))
    out.append(Item("desk_chair", "task_chair", "Desk chair (added)", (0.66, 5.2, 1.24, 5.8),
                    0, 0.95, 180.0, "desk", added=True))
    return out


# ---------------------------------------------------------------------------
# Activities and states
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Zone:
    x: float
    y: float
    target: float
    radius: float
    role: str          # "activity" | "screen_proxy" | "ambient"


@dataclass(frozen=True)
class State:
    id: str
    label: str
    zones: tuple[Zone, ...]


@dataclass(frozen=True)
class Activity:
    id: str
    label: str
    states: tuple[str, ...]          # couch has two: TV off / TV on
    spot: tuple[float, float]        # where the occupant ends up (seat or standing point)
    facing: float
    pose: str


def _activity_lux():
    v3 = config.import_v3()
    return dict(v3.live_solver.ACTIVITIES), v3.live_solver.TARGET_LUX_MIN


def states() -> list[State]:
    lux, lux_min = _activity_lux()
    w, d = config.ROOM_W, config.ROOM_D
    f = {i.id: i for i in furniture()}
    sofa = sofa_seat(f["sofa"])
    tv = _centre(f["tv"].bbox)
    armchair = _centre(f["armchair_w"].bbox)
    table = _centre(f["dining_table"].bbox)
    rng = f["range"].bbox
    island = f["island"].bbox
    desk = _centre(f["desk"].bbox)
    # Cooking: the aisle between the island and the range, in front of the range.
    cook = ((rng[0] + rng[2]) / 2, (island[3] + rng[1]) / 2)
    # Screen proxy: in front of the TV, between it and the coffee table, clear of the sofa zone.
    proxy = (tv[0] - 0.8, tv[1])

    def z(p, target, radius=ZONE_RADIUS, role="activity"):
        return Zone(round(p[0], 3), round(p[1], 3), float(target), float(radius), role)

    couch = z(sofa, lux["Relaxing / TV"])
    return [
        State("ambient", "Ambient",
              (z((w / 2, d / 2), AMBIENT_LUX, math.hypot(w, d) / 2 + 0.01, "ambient"),)),
        State("couch_relax", "Relaxing on the sofa", (couch,)),
        State("couch_tv", "Watching TV",
              (couch, z(proxy, lux_min, SCREEN_PROXY_RADIUS, "screen_proxy"))),
        State("lounge_read", "Reading by the window", (z(armchair, lux["Reading"]),)),
        State("dining", "Dining", (z(table, lux["Dining"]),)),
        State("cooking", "Cooking", (z(cook, lux["Cooking"]),)),
        State("desk", "Desk work", (z(desk, lux["Desk work"]),)),
    ]


def activities() -> list[Activity]:
    f = {i.id: i for i in furniture()}
    dining = f["dining_chair_0"]          # S side, facing N
    st = {s.id: s for s in states()}
    cook = st["cooking"].zones[0]
    return [
        Activity("couch", "Sofa", ("couch_relax", "couch_tv"), sofa_seat(f["sofa"]),
                 f["sofa"].facing, "sit"),
        Activity("lounge_read", "Reading chair", ("lounge_read",),
                 tuple(round(v, 3) for v in _centre(f["armchair_w"].bbox)),
                 f["armchair_w"].facing, "read"),
        Activity("dining", "Dining table", ("dining",),
                 tuple(round(v, 3) for v in _centre(dining.bbox)), dining.facing, "sit_table"),
        Activity("cooking", "Kitchen", ("cooking",), (cook.x, cook.y), 90.0, "cook"),
        Activity("desk", "Desk", ("desk",),
                 tuple(round(v, 3) for v in _centre(f["desk_chair"].bbox)), 180.0, "type"),
    ]


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
