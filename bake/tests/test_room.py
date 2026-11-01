"""Room 501.6 furniture, states and zones."""

import numpy as np
import pytest

from bake import config, room


@pytest.fixture(scope="module")
def items():
    return room.furniture()


@pytest.fixture(scope="module")
def states():
    return {s.id: s for s in room.states()}


def overlap(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def test_furniture_inside_room(items):
    for i in items:
        x0, y0, x1, y1 = i.bbox
        assert -0.01 <= x0 < x1 <= config.ROOM_W + 0.01, i.id
        assert -0.01 <= y0 < y1 <= config.ROOM_D + 0.01, i.id
        assert 0 <= i.z0 < i.z1 <= config.ROOM_H + 1e-6, i.id


def test_added_desk_is_clear_of_surveyed_furniture(items):
    added = [i for i in items if i.added]
    assert {i.id for i in added} == {"desk", "desk_chair"}
    surveyed = [i for i in items if not i.added and i.obstacle]
    for a in added:
        for s in surveyed:
            assert not overlap(a.bbox, s.bbox), (a.id, s.id)


# Pieces that are meant to share floor area: chairs and stools tucked under tops, the sink
# set into the island, the TV standing on its console.
TUCKED = {("chair", "dining_table"), ("chair", "desk"), ("stool", "island"),
          ("sink", "island")}


def test_no_furniture_collides(items):
    obstacles = [i for i in items if i.obstacle]
    for n, a in enumerate(obstacles):
        for b in obstacles[n + 1:]:
            if (a.type, b.type) in TUCKED or (b.type, a.type) in TUCKED:
                continue
            if not (a.z0 < b.z1 - 1e-3 and b.z0 < a.z1 - 1e-3):
                continue          # stacked (TV on console, cabinet on fridge)
            for ra in a.footprint:
                for rb in b.footprint:
                    assert not overlap(ra, rb), (a.id, b.id)


def test_sofa_is_standard_depth_with_chaise_away_from_kitchen(items):
    by_id = {i.id: i for i in items}
    sofa = by_id["sofa"]
    main, chaise = sofa.footprint
    assert main[2] - main[0] == pytest.approx(room.SOFA["depth"], abs=1e-3)
    assert chaise[3] - chaise[1] == pytest.approx(room.SOFA["chaise_width"], abs=1e-3)
    assert chaise[2] == pytest.approx(sofa.bbox[2], abs=1e-3)   # runs forward to the bbox
    kitchen_y = by_id["island"].bbox[1]
    assert kitchen_y - chaise[1] > kitchen_y - main[3]          # chaise at the far (S) end
    sx, sy = room.sofa_seat(sofa)
    assert main[0] < sx < main[2] and chaise[3] < sy < main[3]  # seat on the main sofa


def test_window_armchairs_face_each_other(items):
    by_id = {i.id: i for i in items}
    w, e = by_id["armchair_w"], by_id["armchair_e"]
    assert w.facing == 0.0 and e.facing == 180.0
    assert w.bbox[2] < by_id["window_table"].bbox[0] < by_id["window_table"].bbox[2] < e.bbox[0]


def test_dining_chairs_are_square_and_even(items):
    by_id = {i.id: i for i in items}
    x0, y0, x1, y1 = by_id["dining_table"].bbox
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    chairs = [i for i in items if i.id.startswith("dining_chair_")]
    assert len(chairs) == 6
    for c in chairs:
        assert c.facing in (0.0, 90.0, 180.0, 270.0), c.id
        ccx, ccy = (c.bbox[0] + c.bbox[2]) / 2, (c.bbox[1] + c.bbox[3]) / 2
        a = np.radians(c.facing)
        assert np.cos(a) * (cx - ccx) + np.sin(a) * (cy - ccy) > 0, c.id   # faces the table
    south = sorted((c.bbox[0] + c.bbox[2]) / 2 for c in chairs if c.facing == 90.0)
    north = sorted((c.bbox[0] + c.bbox[2]) / 2 for c in chairs if c.facing == 270.0)
    assert south == pytest.approx(north) and len(south) == 2
    assert (south[0] + south[1]) / 2 == pytest.approx(cx, abs=1e-3)
    for c in chairs:
        if c.facing in (0.0, 180.0):
            assert (c.bbox[1] + c.bbox[3]) / 2 == pytest.approx(cy, abs=1e-3)
    for n, a in enumerate(chairs):
        for b in chairs[n + 1:]:
            assert not overlap(a.bbox, b.bbox), (a.id, b.id)


def test_stools_are_pulled_out_from_under_the_island(items):
    island = next(i for i in items if i.id == "island")
    base_y0 = island.bbox[1] + island.params["overhang"]
    stools = [i for i in items if i.type == "stool"]
    assert len(stools) == 3
    for s in stools:
        assert s.facing == 90.0
        assert s.bbox[3] == pytest.approx(island.bbox[1] + room.STOOL_TUCK, abs=1e-3)
        assert s.bbox[3] < base_y0                   # clear of the cabinets
        assert s.bbox[1] < island.bbox[1]            # sticks out past the counter edge


def test_dining_table_is_standard_width(items):
    t = next(i for i in items if i.id == "dining_table")
    assert t.bbox[3] - t.bbox[1] == pytest.approx(room.DINING_TABLE_WIDTH, abs=1e-3)


def test_desk_chair_is_a_dining_chair_tucked_under_the_desk(items):
    by_id = {i.id: i for i in items}
    chair, dining, desk = by_id["desk_chair"], by_id["dining_chair_4"], by_id["desk"]
    assert chair.type == dining.type == "chair"
    size = lambda i: sorted((i.bbox[2] - i.bbox[0], i.bbox[3] - i.bbox[1]))
    assert size(chair) == pytest.approx(size(dining), abs=1e-3)
    assert chair.z1 == dining.z1
    assert chair.facing == 180.0
    assert chair.bbox[0] == pytest.approx(desk.bbox[2] - room.DINING_TUCK, abs=1e-3)


def test_sink_is_cut_into_the_island(items):
    by_id = {i.id: i for i in items}
    island, sink = by_id["island"], by_id["sink"]
    cut = island.params["cutout"]
    assert cut == sink.params["basin"]
    base_y0 = island.bbox[1] + island.params["overhang"]
    assert island.bbox[0] < cut[0] < cut[2] < island.bbox[2]
    assert base_y0 < cut[1] < cut[3] < island.bbox[3]     # over the cabinets, not the overhang
    assert sink.bbox[0] <= cut[0] and cut[2] <= sink.bbox[2]
    assert sink.bbox[1] < cut[1]                          # faucet strip on the far (S) side


def test_upper_cabinets_hang_on_the_north_wall(items):
    hung = {i.id: i.wall for i in items if i.wall}
    assert hung == {"wall_cabinets": "N", "fridge_cabinet": "N"}
    for i in items:
        if i.wall == "N":
            assert config.ROOM_D - i.bbox[3] < 0.1


def test_every_seat_is_clickable_and_on_its_piece(items):
    seated = [i for i in items if i.seat]
    assert {i.type for i in seated} == {"sectional", "armchair", "chair", "stool"}
    assert len(seated) == 1 + 2 + 7 + 3
    acts = {a.id for a in room.activities()}
    for i in seated:
        assert i.click in acts, i.id
        x, y, _ = i.seat
        assert any(r[0] <= x <= r[2] and r[1] <= y <= r[3] for r in i.footprint), i.id


def test_both_armchairs_are_reading_spots(states, items):
    by_id = {i.id: i for i in items}
    for side in ("w", "e"):
        st = states[f"lounge_read_{side}"]
        seat = by_id[f"armchair_{side}"].seat
        assert (st.zones[0].x, st.zones[0].y) == pytest.approx(seat[:2], abs=1e-3)
        assert by_id[f"armchair_{side}"].click == f"lounge_read_{side}"


def test_standing_points_cover_the_open_floor(states, items):
    standing = [s for s in states.values() if s.kind == "standing"]
    points = room.standing_points(items)
    assert len(standing) == len(points) > 20
    rects = [r for i in items if i.obstacle for r in i.footprint]
    for p in points:
        assert room._standable(p, rects), p
    for s in standing:
        (z,) = s.zones
        assert z.target == room.STAND_LUX and z.radius == room.ZONE_RADIUS
    # Wherever a person can stand, a standing point is close by (fine probe, off the fill grid).
    gx, gy = np.meshgrid(np.arange(0.27, config.ROOM_W, 0.07), np.arange(0.27, config.ROOM_D, 0.07))
    for x, y in zip(gx.ravel(), gy.ravel()):
        if room._standable((x, y), rects):
            d = min(np.hypot(x - px, y - py) for px, py in points)
            assert d <= room.STAND_COVER + 0.05, (round(x, 2), round(y, 2), d)


def test_rug_and_wall_cabinets_are_not_obstacles(items):
    by_id = {i.id: i for i in items}
    assert not by_id["rug"].obstacle
    assert not by_id["wall_cabinets"].obstacle
    assert by_id["sofa"].obstacle and by_id["island"].obstacle


def test_seven_states_with_v3_activity_lux(states):
    v3 = config.import_v3()
    lux = dict(v3.live_solver.ACTIVITIES)
    assert [k for k, s in states.items() if s.kind != "standing"] == [
        "ambient", "couch_relax", "couch_tv", "lounge_read_w", "lounge_read_e", "dining",
        "counter", "cooking", "desk"]
    assert states["couch_relax"].zones[0].target == lux["Relaxing / TV"]
    assert states["lounge_read_w"].zones[0].target == lux["Reading"]
    assert states["lounge_read_e"].zones[0].target == lux["Reading"]
    assert states["counter"].zones[0].target == lux["Dining"]
    assert states["dining"].zones[0].target == lux["Dining"]
    assert states["cooking"].zones[0].target == lux["Cooking"]
    assert states["desk"].zones[0].target == lux["Desk work"]
    assert states["couch_tv"].zones[1].target == v3.live_solver.TARGET_LUX_MIN
    assert states["ambient"].zones[0].target == room.AMBIENT_LUX


def test_ambient_covers_the_whole_floor(states):
    tgt, owner = room.target_and_owner(states["ambient"])
    assert (owner == 0).all()
    assert np.allclose(tgt, room.AMBIENT_LUX)


def test_couch_tv_zones_are_disjoint(states):
    st = states["couch_tv"]
    a, b = st.zones
    assert np.hypot(a.x - b.x, a.y - b.y) > a.radius + b.radius
    _tgt, owner = room.target_and_owner(st)
    assert (owner == 0).sum() > 0 and (owner == 1).sum() > 0


def test_every_activity_state_paints_cells(states):
    for st in states.values():
        tgt, owner = room.target_and_owner(st)
        assert (owner >= 0).sum() > 20, st.id
        assert tgt.shape == (1, 32, 32)
