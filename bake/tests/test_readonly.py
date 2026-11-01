"""The bake must leave every read-only source untouched (guidelines §0).

Snapshots (path, size, mtime) of the read-only trees, exercises everything the bake does
with them (imports, a tiny cold solve, a warm refine, the binarised loss, loading the
Radiance scene generator), then asserts nothing was added, removed or modified. A new
`__pycache__` folder inside v3 is the usual way this fails.
"""

import os

import numpy as np
import pytest

from bake import config

SKIP_DIRS = {".venv", ".git"}


def snapshot(root):
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            p = os.path.join(dirpath, name)
            try:
                st = os.stat(p)
            except OSError:
                continue
            out[p] = (st.st_size, st.st_mtime_ns)
        out[dirpath] = ("dir",)
    return out


def diff(before, after):
    added = sorted(set(after) - set(before))
    removed = sorted(set(before) - set(after))
    changed = sorted(p for p in set(before) & set(after) if before[p] != after[p])
    return added, removed, changed


@pytest.mark.gpu
def test_bake_leaves_sources_untouched():
    torch = pytest.importorskip("torch")
    if not torch.cuda.is_available():
        pytest.skip("needs CUDA")

    roots = [config.V3, config.RENDERS_SCRIPTS, config.BMV2 / "Units"]
    before = {r: snapshot(r) for r in roots}

    v3 = config.import_v3()
    ls = v3.live_solver
    solver = ls.LiveSolver(verbose=False)
    cond5, info = ls.single_condition(config.wea_path("houston"), 12, 21, 12, config.NORTH_ANGLE)
    cond = v3.opt.append_room(cond5, config.ROOM_W, config.ROOM_D, config.ROOM_H)
    occ = [ls.Occupant(0, 2.94, 6.28, 300.0, 1.0, "Dining")]
    tgt = ls.target_grid(occ, config.ROOM_W, config.ROOM_D)

    torch.manual_seed(0)
    binary, _, _ = solver.opt.optimize_coarse_to_fine(
        cond, tgt, None, config.SIDES_OPEN, schedule=((2, 5), (4, 5)),
        glare_weight=config.GLARE_WEIGHT, glare_cap=config.GLARE_CAP, verbose=False)
    X0 = torch.tensor(np.where(binary > 0, ls.WARM_LOGIT_CAP, -ls.WARM_LOGIT_CAP),
                      dtype=torch.float32)
    solver._refine(X0, cond, tgt, config.SIDES_OPEN, n_steps=5)
    v3.seed_sweep.deployed_loss(solver.opt, binary, cond, tgt, np.ones(1, np.float32),
                                config.GLARE_WEIGHT, config.GLARE_CAP)
    gen = v3.vfr._load_generator()
    gen.make_env()

    for r in roots:
        added, removed, changed = diff(before[r], snapshot(r))
        assert not (added or removed or changed), (
            f"{r} was modified:\n added={added[:10]}\n removed={removed[:10]}\n"
            f" changed={changed[:10]}")
