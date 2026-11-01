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


def test_rug_and_wall_cabinets_are_not_obstacles(items):
    by_id = {i.id: i for i in items}
    assert not by_id["rug"].obstacle
    assert not by_id["wall_cabinets"].obstacle
    assert by_id["sofa"].obstacle and by_id["island"].obstacle


def test_seven_states_with_v3_activity_lux(states):
    v3 = config.import_v3()
    lux = dict(v3.live_solver.ACTIVITIES)
    assert list(states) == ["ambient", "couch_relax", "couch_tv", "lounge_read", "dining",
                            "cooking", "desk"]
    assert states["couch_relax"].zones[0].target == lux["Relaxing / TV"]
    assert states["lounge_read"].zones[0].target == lux["Reading"]
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
