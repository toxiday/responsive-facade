"""The conventional facade's windows and the facades their shades make."""

import numpy as np
import pytest

from bake import config
from shade_optimizer import shades


@pytest.fixture(scope="module")
def base():
    return shades.load_baseline(config.import_v3())


@pytest.fixture(scope="module")
def windows(base):
    return shades.find_windows(base)


def test_seven_windows_on_the_open_walls(windows):
    assert [config.SIDES[w.wall] for w in windows] == ["S", "S", "W", "W", "W", "W", "W"]
    assert all((w.r0, w.r1, w.rows) == (5, 12, 8) for w in windows)
    assert [w.c0 for w in windows] == [7, 19, 2, 8, 14, 21, 27]


def test_all_up_is_the_conventional_facade_and_all_down_shuts_it(base, windows):
    assert (shades.facade(base, windows, [0] * 7) == base).all()
    assert shades.facade(base, windows, [w.rows for w in windows]).sum() == 0


def test_a_shade_closes_its_window_from_the_top(base, windows):
    f = shades.facade(base, windows, [3, 0, 0, 0, 0, 0, 0])
    w = windows[0]
    closed = base - f
    assert closed.sum() == 3 * (w.c1 - w.c0 + 1)
    assert closed[w.wall, w.r0:w.r0 + 3, w.c0:w.c1 + 1].all()  # rows 5-7, the top three
    with pytest.raises(ValueError):
        shades.facade(base, windows, [9, 0, 0, 0, 0, 0, 0])


def test_batched_facades_match(base, windows):
    panels = shades.Panels(base, windows)
    rng = np.random.default_rng(1)
    drops = rng.integers(0, 9, size=(20, 7))
    batch = panels.binary(drops)
    for d, b in zip(drops, batch):
        assert (b.reshape(4, 16, 32) == shades.facade(base, windows, d)).all()


def test_soft_shades_sharpen_to_the_binary_facade(base, windows):
    panels = shades.Panels(base, windows)
    edge = np.array([0.0, 2.0, 3.0, 4.0, 5.0, 8.0, 7.0])
    soft = 0.5 * (1 + np.tanh((panels.depth + 0.5 - edge[panels.win]) / 0.02))  # sigmoid(x / 0.01)
    hard = panels.binary(shades.covered(edge, panels.rows))[0][panels.idx]
    assert np.allclose(soft, hard, atol=1e-6)
    assert list(shades.covered(np.array([0.4, 0.6, 7.6, 9.0]), np.array([8, 8, 8, 8]))) == [
        0, 1, 8, 8]
