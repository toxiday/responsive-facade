"""M1 shadow check: the geometric sun patch coincides with the Radiance high-lux patch.

Reads the fixture written by `python -m bake m1` (skips if it has not been run). The
negative controls prove the comparison is sensitive: mirroring the facade columns or
using the sun without the north-angle rotation must break the match.
"""

import json
import math

import numpy as np
import pytest

from bake import config, m1

FIXTURE = config.WEB_FIXTURES / "m1.json"
W, D, H = config.ROOM_W, config.ROOM_D, config.ROOM_H


@pytest.fixture(scope="module")
def cases():
    if not FIXTURE.exists():
        pytest.skip("run `python -m bake m1` first")
    return json.loads(FIXTURE.read_text())["cases"]


def arrays(case):
    facade = np.array(case["facade"]).reshape(4, 16, 32)
    rad = np.array(case["mask_radiance"], dtype=bool).reshape(32, 32)
    return facade, rad


def test_geometric_patch_matches_radiance(cases):
    for case in cases:
        facade, rad = arrays(case)
        geo = m1.geometric_mask(facade, case["sun_room"], W, D, H)
        assert rad.sum() > 20, f"case {case['id']}: no sun patch to compare"
        assert m1.iou(geo, rad) >= m1.IOU_MIN, case["id"]


def test_mirrored_columns_break_the_match(cases):
    for case in cases:
        facade, rad = arrays(case)
        geo = m1.geometric_mask(facade[:, :, ::-1], case["sun_room"], W, D, H)
        assert m1.iou(geo, rad) < 0.5, case["id"]


def test_unrotated_sun_breaks_the_match(cases):
    """Undo the north-angle rotation (sun in true-north frame): the patch must move."""
    th = math.radians(config.NORTH_ANGLE)
    for case in cases:
        facade, rad = arrays(case)
        sx, sy, sz = case["sun_room"]
        true = (sx * math.cos(th) - sy * math.sin(th), sx * math.sin(th) + sy * math.cos(th), sz)
        geo = m1.geometric_mask(facade, true, W, D, H)
        assert m1.iou(geo, rad) < 0.8, case["id"]
