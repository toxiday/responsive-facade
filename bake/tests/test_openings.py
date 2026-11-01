"""The entry door and the hall opening match the floor 5 plan."""

import pytest

from bake import config, plan_ai, room

pytestmark = pytest.mark.skipif(not config.PLAN_501_AI.exists(), reason="floor 5 plan not found")


@pytest.fixture(scope="module")
def walls():
    return plan_ai.boxes_m(config.PLAN_501_AI, "Wall")


def gaps(walls, along, fixed_lo, fixed_hi, start, end):
    """Gaps between wall pieces lying in the band fixed_lo..fixed_hi across the wall."""
    i, j = (0, 2) if along == "x" else (1, 3)
    k, m = (1, 3) if along == "x" else (0, 2)
    pieces = sorted((max(b[i], start), min(b[j], end)) for b in walls
                    if b[k] >= fixed_lo - 0.01 and b[m] <= fixed_hi + 0.01 and b[j] - b[i] > 0.05
                    and b[j] > start and b[i] < end)
    out, pos = [], start
    for a0, a1 in pieces:
        if a0 > pos + 0.05:
            out.append((round(pos, 3), round(a0, 3)))
        pos = max(pos, a1)
    if end > pos + 0.05:
        out.append((round(pos, 3), round(end, 3)))
    return out


def test_entry_door_is_the_gap_in_the_north_wall(walls):
    d, w = config.ROOM_D, config.ROOM_W
    entry = next(o for o in room.openings() if o["id"] == "entry")
    found = gaps(walls, "x", d, d + 0.15, 0.15, w)
    assert found == [pytest.approx((entry["a0"], entry["a1"]), abs=0.01)]
    leaves = [b for b in plan_ai.boxes_m(config.PLAN_501_AI, "door")
              if abs(b[2] - entry["hinge"]) < 0.01 and b[3] > d]
    assert leaves, "door leaf at the hinge"


def test_hall_opening_is_the_gap_in_the_east_wall(walls):
    d, w = config.ROOM_D, config.ROOM_W
    hall = next(o for o in room.openings() if o["id"] == "hall")
    found = gaps(walls, "y", w, w + 0.15, 0.15, d)
    assert found == [pytest.approx((hall["a0"], hall["a1"]), abs=0.01)]
