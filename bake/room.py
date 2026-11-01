"""Room 501.6: furniture, activity spots and the seven occupant states.

Furniture comes from the Rhino survey (`unit501_furniture.json`). Unit 501's uv frame equals
the room frame for 501.6 (origin_uv = (0, 0), checked by `config.check_room`), so every bbox
below is in room metres: x from the W wall, y from the S wall. Named items map one to one;
casework arrives as fragments (carcasses, fronts, plinths) and is grouped by position.
The desk and its chair are not in the model; they are added for the demo (docs/decisions.md).

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
    obstacle: bool = field(init=False)

    def __post_init__(self):
        self.bbox = tuple(round(v, 4) for v in self.bbox)
        self.z0, self.z1 = round(self.z0, 4), round(self.z1, 4)
        self.obstacle = self.z1 > OBSTACLE_MIN_Z and self.z0 < OBSTACLE_MAX_Z0


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


def _facing_towards(src, dst):
    return round(math.degrees(math.atan2(dst[1] - src[1], dst[0] - src[0])) % 360.0, 1)


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


def furniture() -> list[Item]:
    es = _survey()
    out: list[Item] = []

    sofa = _one(es, "Sectional Burrow Nomad Chaise")
    out.append(Item("sofa", "sectional", "Sofa", _bbox(sofa), 0, sofa["ztop"], 0.0, "couch"))
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

    chairs = _many(es, "Armchair Divina", 2)
    west, east = sorted(chairs, key=lambda e: e["u"])
    out.append(Item("armchair_w", "armchair", "Armchair", _bbox(west), 0, west["ztop"], 90.0,
                    "lounge_read"))
    out.append(Item("armchair_e", "armchair", "Armchair", _bbox(east), 0, east["ztop"], 90.0))
    rt = _one(es, "Coffee Table Flume Round")
    out.append(Item("window_table", "round_table", "Round table", _bbox(rt), 0, rt["ztop"]))

    table = _one(es, "Dining Table Keeps")
    tc = _centre(_bbox(table))
    out.append(Item("dining_table", "dining_table", "Dining table", _bbox(table), 0,
                    table["ztop"], None, "dining"))
    for i, c in enumerate(_many(es, "Dining Chair Cesca", 6)):
        b = _bbox(c)
        out.append(Item(f"dining_chair_{i}", "chair", "Dining chair", b, 0, c["ztop"],
                        _facing_towards(_centre(b), tc), "dining"))

    island = _group(es, lambda e: e["vmin"] >= 7.6 and e["vmax"] <= 8.62, "island")
    out.append(Item("island", "island", "Kitchen island", _union(island), 0,
                    max(e["ztop"] for e in island), 270.0, "cooking"))
    sink = _one(es, "Kitchen Sink Norrsjon + Faucet")
    out.append(Item("sink", "sink", "Sink", _bbox(sink), 0, sink["ztop"], 270.0, "cooking"))
    for i, s in enumerate(sorted(_many(es, "Counter Stool Onda", 3), key=lambda e: e["u"])):
        out.append(Item(f"stool_{i}", "stool", "Counter stool", _bbox(s), 0, s["ztop"], 90.0,
                        "cooking"))

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
    sofa = _centre(f["sofa"].bbox)
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
    dining_seat = _centre(f["dining_chair_1"].bbox)
    st = {s.id: s for s in states()}
    cook = st["cooking"].zones[0]
    return [
        Activity("couch", "Sofa", ("couch_relax", "couch_tv"),
                 (round(_centre(f["sofa"].bbox)[0] - 0.1, 3), round(_centre(f["sofa"].bbox)[1], 3)),
                 0.0, "sit"),
        Activity("lounge_read", "Reading chair", ("lounge_read",),
                 tuple(round(v, 3) for v in _centre(f["armchair_w"].bbox)), 90.0, "read"),
        Activity("dining", "Dining table", ("dining",),
                 tuple(round(v, 3) for v in dining_seat), f["dining_chair_1"].facing, "sit_table"),
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
