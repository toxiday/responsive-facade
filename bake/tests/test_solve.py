"""The solve path scores what v3 optimises, with the glare term on (GPU)."""

import contextlib
import io

import numpy as np
import pytest

from bake import bench, config, room, slots

pytestmark = pytest.mark.gpu


@pytest.fixture(scope="module")
def setup():
    v3, solver = bench.make_solver()
    day = slots.load("houston")["months"][11]["slots"]
    st = {s.id: s for s in room.states()}["cooking_range"]
    return v3, solver, day, room.target_and_owner(st)[0]


def test_glare_weight_is_on():
    v3 = config.import_v3()
    assert config.GLARE_WEIGHT == v3.live_solver.GLARE_WEIGHT == 0.25
    assert config.GLARE_CAP == v3.opt.GLARE_LUX


def test_deployed_loss_is_the_refine_objective(setup):
    v3, solver, day, tgt = setup
    cond = bench.condition(v3, day[3])
    binary, _ = bench.cold(v3, solver, cond, tgt, schedule=((2, 5), (4, 5)))
    X0 = bench.seed_logits(v3, solver, binary)
    with contextlib.redirect_stdout(io.StringIO()):
        b, _X, best_L, _ = solver._refine(X0, cond, tgt, config.SIDES_OPEN, n_steps=11)
    assert bench.score(v3, solver, b, cond, tgt) == pytest.approx(best_L, rel=1e-5)


def test_warm_start_reproduces_the_cold_design(setup):
    v3, solver, day, tgt = setup
    cond = bench.condition(v3, day[4])
    binary, _ = bench.cold(v3, solver, cond, tgt, schedule=((2, 5), (4, 5)))
    X0 = bench.seed_logits(v3, solver, binary)
    assert (((X0 > 0).cpu().numpy()).astype(int) == binary).all()
    assert np.asarray(binary)[[1, 2]].sum() == 0          # N and E stay closed
