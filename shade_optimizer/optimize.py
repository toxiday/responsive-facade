"""v3's facade optimizer, on shades: the same surrogate, loss and optimiser, other variables.

v3's `optimize_coarse_to_fine` adjusts one logit per panel. Its openness, sigmoid(X / tau), goes
through the surrogate (`_lux`, on v3's in-distribution `facade_in`) into the loss
(`zone_penalty_sum` per occupied cell, plus `outside_glare_sum` per unoccupied cell at
glare_weight 0.25); Adam steps the logits while tau anneals, so the soft facade sharpens to a
binary one, and the binary designs are judged by the deployed loss (`seed_sweep.deployed_loss`).

Here the variables are the shades instead, one per window: edge = rows * sigmoid(s), and each
window row's openness is a sigmoid step at the edge, tau rows soft (shades.py). Everything else
is v3's: the model call, both loss terms and their normalisation, Adam, tau annealed (here
geometrically, TAU0 to TAU1 rows). v3's coarse-to-fine stages and smoothness term are left
out: there are seven variables, and a shade's closed rows are one block anyway.

Several starts run as one batch: all up, half down, all down, and the previous hour's shades
when there is one. Every EVAL_EVERY steps their binary designs are scored with the deployed
loss and the best kept, as v3 keeps its best binary across stages. The best is then polished
on whole rows: each round tries every position of every shade (one batch) and takes the best
single move, until none helps. The polish works on the deployed loss, so it can only improve
on what the gradient found.

Per-design losses come from v3's loss functions in one call: they weight each condition's
penalty by w before summing, so with the designs in the batch as the conditions, the gradient
of the sum with respect to w = 1 is each design's own penalty. Scored one at a time this is
`deployed_loss` to 1e-7. In a batch the surrogate's bfloat16 arithmetic (v3 runs it under AMP)
shifts the loss by up to about 0.5%, so the search scores in batches and every loss it
reports or compares is scored again one design at a time (`exact`).
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import numpy as np

from bake import config

from . import shades

# Tuned on Houston December, 27 hours of three states (2026-11-02): the final loss hardly
# depends on these (0.276-0.287), as the polish does most of the work; 70 steps at 0.4 gave
# the lowest, in two-thirds of the time of 120 steps.
TAU0, TAU1 = 1.0, 0.1    # edge softness, in rows, annealed over the steps
STEPS = 70
LR = 0.4
EVAL_EVERY = 10
START_FRACTIONS = (0.0, 0.5, 1.0)
EDGE_CLIP = 0.02         # starts at 0 or 1 sit just inside, where sigmoid(s) has a gradient
MAX_POLISH_ROUNDS = 30
SCORE_CHUNK = 512        # designs per surrogate call when scoring
BF16_TOL = 0.005         # batched losses are within this (relative) of the exact ones


@dataclass
class Result:
    drops: list[int]       # rows each shade is lowered, window by window
    loss: float            # deployed loss (exact)
    gradient_loss: float   # deployed loss of the gradient's best binary design, before the polish
    polish_rounds: int
    scored: int            # binary designs scored
    seconds: float


class ShadeOptimizer:
    def __init__(self, v3, solver, base: np.ndarray | None = None):
        import torch

        self.torch = torch
        self.v3 = v3
        self.opt = solver.opt
        self.dev = self.opt.device
        self.base = shades.load_baseline(v3) if base is None else base
        self.windows = shades.find_windows(self.base)
        self.panels = shades.Panels(self.base, self.windows)
        self.rows = self.panels.rows
        self._idx = torch.as_tensor(self.panels.idx, device=self.dev)
        self._win = torch.as_tensor(self.panels.win, device=self.dev)
        self._depth = torch.as_tensor(self.panels.depth, dtype=torch.float32, device=self.dev)
        self._rows = torch.as_tensor(self.rows, dtype=torch.float32, device=self.dev)

    # -- facades and the surrogate -------------------------------------------------------

    def facade(self, drops) -> np.ndarray:
        return shades.facade(self.base, self.windows, list(drops))

    def _facades(self, vals):
        """(B, 4, 16, 32) window openness from the window panels' values (B, n_panels)."""
        P = self.torch.zeros(vals.shape[0], 4 * shades.ROWS * shades.COLS, device=self.dev)
        P[:, self._idx] = vals
        return P.view(-1, 4, shades.ROWS, shades.COLS)

    def _binary(self, drops_t):
        return self._facades((self._depth[None, :] >= drops_t[:, self._win]).float())

    def _lux(self, cond_t, P):
        cond = cond_t.expand(P.shape[0], -1).contiguous()
        return self.opt._lux(cond, self.v3.opt.facade_in(P))

    def _tensors(self, cond, tgt):
        t = self.torch
        cond_t = t.as_tensor(np.asarray(cond), dtype=t.float32, device=self.dev).view(1, -1)
        tgt_t = t.as_tensor(np.asarray(tgt), dtype=t.float32, device=self.dev).view(1, 32, 32)
        return cond_t, tgt_t

    def _loss(self, E, tgt_t, per_design: bool):
        """v3's objective for each design in E (B, 32, 32): the sum over the batch, or with
        per_design, each design's own (B,)."""
        t, o = self.torch, self.v3.opt
        tg = tgt_t.expand(E.shape[0], -1, -1)
        n_occ = (tgt_t > 0).float().sum().clamp(min=1.0)
        n_un = (tgt_t <= 0).float().sum().clamp(min=1.0)
        if not per_design:
            L = o.zone_penalty_sum(E, tg) / n_occ
            return L + config.GLARE_WEIGHT * o.outside_glare_sum(E, tg, config.GLARE_CAP) / n_un
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
            out.append(self._loss(E, tgt_t, per_design=True).cpu().numpy())
        return np.concatenate(out).astype(np.float64)

    def score(self, cond, tgt, drops, exact=True) -> np.ndarray:
        """The deployed loss of each set of drops (B, n_windows) at one condition: exact (one
        design at a time, as `deployed_loss` scores), or batched (faster, within BF16_TOL)."""
        return self._score_t(*self._tensors(cond, tgt), drops, exact)

    # -- the optimizer --------------------------------------------------------------------

    def solve(self, cond, tgt, prev=None) -> Result:
        t = self.torch
        t0 = time.perf_counter()
        cond_t, tgt_t = self._tensors(cond, tgt)
        n = len(self.windows)
        fracs = [np.full(n, f) for f in START_FRACTIONS]
        exact = [np.zeros(n, int), self.rows.copy()]          # all up (conventional), all down
        if prev is not None:
            fracs.append(np.asarray(prev) / self.rows)
            exact.append(np.asarray(prev, dtype=int))
        frac = np.clip(np.stack(fracs), EDGE_CLIP, 1 - EDGE_CLIP)
        S = t.logit(t.as_tensor(frac, dtype=t.float32, device=self.dev)).requires_grad_(True)
        adam = t.optim.Adam([S], lr=LR)

        seen: dict[tuple, float] = {}

        def consider(designs):
            new = [d for d in {tuple(int(v) for v in x) for x in designs} if d not in seen]
            if new:
                for d, L in zip(new, self._score_t(cond_t, tgt_t, new)):
                    seen[d] = float(L)

        consider(exact)
        for step in range(STEPS):
            tau = TAU0 * (TAU1 / TAU0) ** (step / (STEPS - 1))
            edge = self._rows * t.sigmoid(S)                        # (starts, windows)
            vals = t.sigmoid((self._depth + 0.5 - edge[:, self._win]) / tau)
            L = self._loss(self._lux(cond_t, self._facades(vals)), tgt_t, per_design=False)
            adam.zero_grad()
            L.backward()
            adam.step()
            if step % EVAL_EVERY == EVAL_EVERY - 1 or step == STEPS - 1:
                with t.no_grad():
                    e = (self._rows * t.sigmoid(S)).cpu().numpy()
                consider(shades.covered(e, self.rows))

        best = min(seen, key=seen.get)
        drops, _L, rounds = self._polish(cond_t, tgt_t, list(best), seen[best], seen)
        loss, gradient_loss = self._score_t(cond_t, tgt_t, [drops, list(best)], exact=True)
        return Result(drops=drops, loss=float(loss), gradient_loss=float(gradient_loss),
                      polish_rounds=rounds, scored=len(seen),
                      seconds=time.perf_counter() - t0)

    def _polish(self, cond_t, tgt_t, drops, loss, seen):
        """Best single-shade moves over whole rows until none lowers the deployed loss."""
        for rounds in range(1, MAX_POLISH_ROUNDS + 1):
            cands = []
            for k, rows in enumerate(self.rows):
                for v in range(rows + 1):
                    if v != drops[k]:
                        c = list(drops)
                        c[k] = v
                        cands.append(c)
            L = self._score_t(cond_t, tgt_t, cands)
            for c, v in zip(cands, L):
                seen.setdefault(tuple(c), float(v))
            i = int(np.argmin(L))
            if L[i] >= loss:
                return drops, loss, rounds
            drops, loss = cands[i], float(L[i])
        return drops, loss, MAX_POLISH_ROUNDS

    # -- every combination, to check the optimizer ----------------------------------------

    def exhaustive(self, cond, tgt, batch: int = 2048, progress=None) -> dict:
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
            L = self._loss(E, tgt_t, per_design=True)
            i = int(t.argmin(L))
            if float(L[i]) < best_L:
                best_L, best_code = float(L[i]), s + i
            if progress and (s // batch) % 200 == 0:
                progress(s + len(codes), total, time.perf_counter() - t0)
        drops = [int(best_code // int(r) % int(v)) for r, v in zip(radix.cpu(), levels)]
        secs = round(time.perf_counter() - t0, 1)
        return {"drops": drops, "loss": float(self._score_t(cond_t, tgt_t, [drops], exact=True)[0]),
                "loss_batched": best_L, "designs": total, "seconds": secs}
