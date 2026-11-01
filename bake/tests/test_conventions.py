"""The conventions in guidelines §5 hold in the v3 code the bake calls."""

import shutil

import numpy as np
import pytest

from bake import config, radiance

W, D, H = config.ROOM_W, config.ROOM_D, config.ROOM_H


@pytest.fixture(scope="module")
def v3():
    return config.import_v3()


def test_panel_boxes(v3):
    boxes = {(s, r, c): (p0, p1, n)
             for s, r, c, _i, p0, p1, n in v3.opt.facade_panel_boxes(W, D, H)}
    assert len(boxes) == 4 * 16 * 32
    # row 0 = ceiling band; S/N col 0 at x=0; E/W col 0 at y=0
    (x0, y0, z0), (x1, y1, z1), n = boxes[("S", 0, 0)]
    assert (y0, y1, n) == (0.0, 0.0, (0.0, -1.0, 0.0))
    assert x0 == pytest.approx(0) and x1 == pytest.approx(W / 32)
    assert z0 == pytest.approx(H - H / 16) and z1 == pytest.approx(H)
    (x0, y0, _), (x1, y1, _), _ = boxes[("N", 15, 31)]
    assert y0 == y1 == pytest.approx(D) and x1 == pytest.approx(W)
    for side, x in (("E", W), ("W", 0.0)):
        (x0, y0, z0), (x1, y1, _), _ = boxes[(side, 15, 0)]
        assert x0 == x1 == pytest.approx(x)
        assert y0 == pytest.approx(0) and y1 == pytest.approx(D / 32) and z0 == pytest.approx(0)


def test_cell_centres(v3):
    X, Y = v3.live_solver.cell_centres(W, D)
    assert X[0, 0] == pytest.approx(W / 64) and Y[0, 0] == pytest.approx(D - D / 64)
    assert X[31, 31] == pytest.approx(W - W / 64) and Y[31, 31] == pytest.approx(D / 64)


def test_sun_vector_is_room_frame(v3):
    """single_condition rotates the sun by north_angle: room az = true az + north_angle."""
    cond5, info = v3.live_solver.single_condition(config.wea_path("houston"), 3, 21, 16,
                                                  config.NORTH_ANGLE)
    cond = v3.opt.append_room(cond5, W, D, H)
    _alt, az_room, _dni, _dhi = v3.vfr.cond_to_sun(cond[0])
    assert az_room == pytest.approx((info["az"] + config.NORTH_ANGLE) % 360, abs=1e-3)


@pytest.mark.radiance
def test_sensor_order_maps_to_floor_grid(v3):
    """Radiance sensors, reordered by v3's sensors_to_plan, land on the floor-grid cells."""
    gen = radiance.load_generator(str(config.GEN_PY))
    work = config.assert_writable(config.TMP / "test_sensor_order")
    work.mkdir(parents=True, exist_ok=True)
    try:
        solid = {s: [1.0] * 512 for s in config.SIDES}
        _oct, pts = gen.write_scene(work, solid, W, D, H, 45.0, 180.0, 500.0, 100.0,
                                    gen.make_env())
        xyz = np.array([[float(v) for v in line.split()[:3]]
                        for line in pts.read_text().splitlines()])
    finally:
        shutil.rmtree(work, ignore_errors=True)
    px = v3.vfr.sensors_to_plan(xyz[:, 0])
    py = v3.vfr.sensors_to_plan(xyz[:, 1])
    X, Y = v3.live_solver.cell_centres(W, D)
    np.testing.assert_allclose(px, X, atol=1e-5)
    np.testing.assert_allclose(py, Y, atol=1e-5)
    assert np.allclose(xyz[:, 2], 0.6)
