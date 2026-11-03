"""The shade optimizer: the best shade positions for one hour and state, by a genetic algorithm
on v3's surrogate and loss.

Designs are whole rows: how far each of the seven shades is lowered (0 to 8 rows). Each is
scored with v3's own objective: the surrogate (`_lux`, on v3's in-distribution `facade_in`) into
the loss (`zone_penalty_sum` per occupied cell, plus `outside_glare_sum` per unoccupied cell at
glare_weight 0.25), as `seed_sweep.deployed_loss` scores a finished design.

The genetic algorithm (Tony, 2026-11-02: one method, the GA): a population of GA_POP designs,
the first generation random apart from all up (the conventional facade), all down and the
previous hour's shades; each next generation keeps the best GA_ELITE, and fills up with
children of two parents, each the best of GA_TOURNAMENT drawn at random, mixed shade by shade
(GA_CROSS of the time) and with about one shade moved to a random position. GA_GENS
generations. As the best designs carry over, the result is never worse than the conventional
facade, all shades down or the previous hour's shades.

Chosen over three other methods on 27 hours of Houston December (desk, couch_tv and
lounge_read_w): the GA had a mean loss of 0.254-0.256 over three seeds, against 0.262 for a
window-by-window search and 0.276 for v3's gradient scheme on the shades' edges; mixing designs,
it finds the two- and three-shade changes the TV states need.

GPU memory: a generation is one surrogate call of at most GA_POP designs, and each process caps
its share of the GPU at GPU_FRACTION, so the optimizer fails on its own rather than starving a
bake that shares the GPU. (A test scoring 2048 designs a call once did: the bake's workers ran
out of memory, 2026-11-02.)

Per-design losses come from v3's loss functions in one call: they weight each condition's
penalty by w before summing, so with the designs in the batch as the conditions, the gradient
of the sum with respect to w = 1 is each design's own penalty. Scored one at a time this is
`deployed_loss` to 1e-7. In a batch the surrogate's bfloat16 arithmetic (v3 runs it under AMP)
shifts the loss by up to about 0.5%, so the GA scores in batches and every loss it reports or
compares is scored again one design at a time (`exact`).
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import numpy as np

from bake import config

from . import shades

GA_POP, GA_GENS, GA_ELITE, GA_TOURNAMENT, GA_CROSS = 64, 40, 2, 3, 0.9
SCORE_CHUNK = 64         # designs per surrogate call
GPU_FRACTION = 0.2       # of the GPU's memory, at most, per optimizer process
BF16_TOL = 0.005         # batched losses are within this (relative) of the exact ones


@dataclass
class Result:
    drops: list[int]       # rows each shade is lowered, window by window
    loss: float            # deployed loss (exact)
    scored: int            # distinct designs scored
    seconds: float


class ShadeOptimizer:
    def __init__(self, v3, solver, base: np.ndarray | None = None):
        import torch

        self.torch = torch
        self.v3 = v3
        self.opt = solver.opt
        self.dev = self.opt.device
        dev = torch.device(self.dev)
        if dev.type == "cuda":
            index = dev.index if dev.index is not None else torch.cuda.current_device()
            torch.cuda.set_per_process_memory_fraction(GPU_FRACTION, index)
        self.base = shades.load_baseline(v3) if base is None else base
        self.windows = shades.find_windows(self.base)
        self.panels = shades.Panels(self.base, self.windows)
        self.rows = self.panels.rows
        self._idx = torch.as_tensor(self.panels.idx, device=self.dev)
        self._win = torch.as_tensor(self.panels.win, device=self.dev)
        self._depth = torch.as_tensor(self.panels.depth, dtype=torch.float32, device=self.dev)

    # -- facades and the surrogate -------------------------------------------------------

    def facade(self, drops) -> np.ndarray:
        return shades.facade(self.base, self.windows, list(drops))

    def _binary(self, drops_t):
        """(B, 4, 16, 32) facades for drops (B, n_windows): a panel is open below its shade."""
        vals = (self._depth[None, :] >= drops_t[:, self._win]).float()
        P = self.torch.zeros(vals.shape[0], 4 * shades.ROWS * shades.COLS, device=self.dev)
        P[:, self._idx] = vals
        return P.view(-1, 4, shades.ROWS, shades.COLS)

    def _lux(self, cond_t, P):
        cond = cond_t.expand(P.shape[0], -1).contiguous()
        return self.opt._lux(cond, self.v3.opt.facade_in(P))

    def _tensors(self, cond, tgt):
        t = self.torch
        cond_t = t.as_tensor(np.asarray(cond), dtype=t.float32, device=self.dev).view(1, -1)
        tgt_t = t.as_tensor(np.asarray(tgt), dtype=t.float32, device=self.dev).view(1, 32, 32)
        return cond_t, tgt_t

    def _loss(self, E, tgt_t):
        """v3's objective for each design in E (B, 32, 32), (B,)."""
        t, o = self.torch, self.v3.opt
        tg = tgt_t.expand(E.shape[0], -1, -1)
        n_occ = (tgt_t > 0).float().sum().clamp(min=1.0)
        n_un = (tgt_t <= 0).float().sum().clamp(min=1.0)
        with t.enable_grad():
            w = t.ones(E.shape[0], device=self.dev, requires_grad=True)
            E = E.detach()
            L = (o.zone_penalty_sum(E, tg, w) / n_occ
                 + config.GLARE_WEIGHT * o.outside_glare_sum(E, tg, config.GLARE_CAP, w) / n_un)
            (g,) = t.autograd.grad(L, w)
        return g

    def _score_t(self, cond_t, tgt_t, drops, exact=False) -> np.ndarray:
        t = self.torch
        drops = np.atleast_2d(np.asarray(drops, dtype=np.int64))
        chunk = 1 if exact else SCORE_CHUNK
        out = []
        for s in range(0, len(drops), chunk):
            d = t.as_tensor(drops[s:s + chunk], device=self.dev)
            with t.no_grad():
                E = self._lux(cond_t, self._binary(d))
            out.append(self._loss(E, tgt_t).cpu().numpy())
        return np.concatenate(out).astype(np.float64)

    def score(self, cond, tgt, drops, exact=True) -> np.ndarray:
        """The deployed loss of each set of drops (B, n_windows) at one condition: exact (one
        design at a time, as `deployed_loss` scores), or batched (faster, within BF16_TOL)."""
        return self._score_t(*self._tensors(cond, tgt), drops, exact)

    # -- the genetic algorithm ------------------------------------------------------------

    def solve(self, cond, tgt, prev=None, seed: int = 0) -> Result:
        t0 = time.perf_counter()
        cond_t, tgt_t = self._tensors(cond, tgt)
        rng = np.random.default_rng(seed)
        n, levels = len(self.windows), self.rows + 1
        seen: dict[tuple, float] = {}

        def fitness(pop) -> np.ndarray:
            keys = [tuple(int(v) for v in x) for x in pop]
            new = list(dict.fromkeys(k for k in keys if k not in seen))
            if new:
                for d, L in zip(new, self._score_t(cond_t, tgt_t, new)):
                    seen[d] = float(L)
            return np.array([seen[k] for k in keys])

        pop = rng.integers(0, levels, size=(GA_POP, n))
        pop[0], pop[1] = 0, self.rows                    # all up (conventional), all down
        if prev is not None:
            pop[2] = prev
        fit = fitness(pop)
        for _ in range(GA_GENS):
            children = [pop[i].copy() for i in np.argsort(fit)[:GA_ELITE]]
            while len(children) < GA_POP:
                a, b = (pop[min(rng.choice(GA_POP, GA_TOURNAMENT, replace=False),
                                key=lambda i: fit[i])] for _ in range(2))
                child = np.where(rng.random(n) < 0.5, a, b) if rng.random() < GA_CROSS else a.copy()
                mut = rng.random(n) < 1 / n
                child[mut] = rng.integers(0, levels[mut])
                children.append(child)
            pop = np.array(children)
            fit = fitness(pop)
        drops = list(min(seen, key=seen.get))
        loss = float(self._score_t(cond_t, tgt_t, [drops], exact=True)[0])
        return Result(drops=drops, loss=loss, scored=len(seen),
                      seconds=time.perf_counter() - t0)

    # -- every combination, to check the GA -----------------------------------------------

    def exhaustive(self, cond, tgt, batch: int = 256, progress=None) -> dict:
        """Score every combination of whole-row shade positions; the best and the time."""
        t = self.torch
        t0 = time.perf_counter()
        cond_t, tgt_t = self._tensors(cond, tgt)
        levels = self.rows + 1
        radix = t.as_tensor(np.concatenate([np.cumprod(levels[::-1])[::-1][1:], [1]]),
                            device=self.dev)
        lev = t.as_tensor(levels, device=self.dev)
        total = int(np.prod(levels))
        best_L, best_code = float("inf"), -1
        for s in range(0, total, batch):
            codes = t.arange(s, min(s + batch, total), device=self.dev)
            drops = (codes[:, None] // radix[None, :]) % lev[None, :]
            with t.no_grad():
                E = self._lux(cond_t, self._binary(drops))
            L = self._loss(E, tgt_t)
            i = int(t.argmin(L))
            if float(L[i]) < best_L:
                best_L, best_code = float(L[i]), s + i
            if progress and (s // batch) % 2000 == 0:
                progress(s + len(codes), total, time.perf_counter() - t0)
        drops = [int(best_code // int(r) % int(v)) for r, v in zip(radix.cpu(), levels)]
        secs = round(time.perf_counter() - t0, 1)
        return {"drops": drops, "loss": float(self._score_t(cond_t, tgt_t, [drops], exact=True)[0]),
                "loss_batched": best_L, "designs": total, "seconds": secs}
