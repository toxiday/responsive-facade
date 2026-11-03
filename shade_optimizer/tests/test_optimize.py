"""The shade optimizer scores what v3 optimises, and its GA is sound (GPU)."""

import numpy as np
import pytest

from bake import bench, room, slots
from shade_optimizer.optimize import BF16_TOL, GA_GENS, GA_POP, ShadeOptimizer

pytestmark = pytest.mark.gpu


@pytest.fixture(scope="module")
def setup():
    v3, solver = bench.make_solver()
    so = ShadeOptimizer(v3, solver)
    day = slots.load("houston")["months"][11]["slots"]
    st = {s.id: s for s in room.states()}["desk"]
    return v3, solver, so, bench.condition(v3, day[4]), room.target_and_owner(st)[0]


def test_scores_are_the_deployed_loss(setup):
    v3, solver, so, cond, tgt = setup
    rng = np.random.default_rng(3)
    drops = np.vstack([np.zeros(7, int), so.rows, rng.integers(0, 9, size=(6, 7))])
    deployed = [bench.score(v3, solver, so.facade(d), cond, tgt) for d in drops]
    assert np.allclose(so.score(cond, tgt, drops), deployed, rtol=1e-6, atol=1e-9)
    # In a batch, the surrogate's bfloat16 arithmetic moves the loss a little.
    assert np.allclose(so.score(cond, tgt, drops, exact=False), deployed, rtol=BF16_TOL)


def test_the_ga_never_does_worse_than_its_seeded_designs(setup):
    _v3, _solver, so, cond, tgt = setup
    prev = [3, 0, 8, 1, 5, 0, 2]
    r = so.solve(cond, tgt, prev=prev, seed=7)
    up, down, before = so.score(cond, tgt, [np.zeros(7, int), so.rows, prev])
    assert r.loss <= min(up, down, before) * (1 + BF16_TOL)
    assert r.loss == pytest.approx(so.score(cond, tgt, [r.drops])[0], rel=1e-9)
    assert r.scored <= GA_POP * (GA_GENS + 1)


def test_the_ga_repeats_with_its_seed(setup):
    _v3, _solver, so, cond, tgt = setup
    a, b = so.solve(cond, tgt, seed=11), so.solve(cond, tgt, seed=11)
    assert a.drops == b.drops and a.loss == b.loss


def test_exhaustive_agrees_with_scoring_on_a_small_facade(setup):
    _v3, _solver, so, cond, tgt = setup
    # Two windows only (the S pair), so every combination is 81 designs.
    base = so.base.copy()
    base[3] = 0
    small = ShadeOptimizer(so.v3, type("S", (), {"opt": so.opt})(), base=base)
    ex = small.exhaustive(cond, tgt, batch=32)
    grid = np.array([[a, b] for a in range(9) for b in range(9)])
    L = small.score(cond, tgt, grid, exact=False)
    assert ex["designs"] == 81
    assert ex["loss_batched"] == pytest.approx(L.min(), rel=BF16_TOL)
    assert ex["loss"] <= L.min() * (1 + 2 * BF16_TOL)
