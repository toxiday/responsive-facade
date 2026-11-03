"""The shade optimizer: the best shade positions for one hour and state, on v3's surrogate and loss.

Every method scores whole-row designs with v3's own objective: the surrogate (`_lux`, on v3's
in-distribution `facade_in`) into the loss (`zone_penalty_sum` per occupied cell, plus
`outside_glare_sum` per unoccupied cell at glare_weight 0.25), as `seed_sweep.deployed_loss`
scores a finished design. The methods (`solve(..., method=)`):

  window    window by window: from each start (all up, half down, all down, and
            the previous hour's shades when there is one), each round tries every position of
            every shade, one batch of 56 designs, and takes the best single move, until none
            helps; the best of the starts.
  gradient  v3's optimizer with the shades' edges as its variables instead of panel logits:
            edge = rows * sigmoid(s), each window row's openness a sigmoid step at the edge, tau
            rows soft; Adam, tau annealed TAU0 to TAU1, the starts as one batch, the best binary
            design kept every EVAL_EVERY steps, then the window-by-window search from it.
  ga        a genetic algorithm: GA_POP random designs, tournament selection, uniform crossover,
            about one shade mutated per child, the best GA_ELITE kept, GA_GENS generations.
  ga_window (the default) the GA, and the window-by-window search from the GA's best design
            and from the usual starts; the better of the two. Never worse than the window search,
            which only moves one shade at a time; the GA, mixing designs, finds the two- and
            three-shade changes it can't.

Why ga_window (Tony, 2026-11-02, on 27 hours of Houston December: desk, couch_tv and
lounge_read_w, each from scratch; "best found" = within bfloat16 precision of the best any
method found):

  window             mean loss 0.262, best found 18 of 27, 2.2 s
  gradient + window  mean loss 0.276, best found 14 of 27, 4.2 s
  GA (three seeds)   mean loss 0.254-0.256, best found 21-23 of 27, 3.7 s
  GA + window        mean loss 0.254-0.255, best found 22-25 of 27, 5.8 s
  best of three GAs  mean loss 0.254, best found 26 of 27, 11 s

The window search fell short with the TV on (0.120 against the GA's 0.049 at 14:30); the GA
alone varied from seed to seed and once missed what the window search found.

The gradient method falls short because its soft shades let half a sun beam through where the
real design lets all or none, and its search ends at one design.

GPU memory: every surrogate call scores at most SCORE_CHUNK designs (a GA generation, a search
round), and each process caps its share of the GPU at GPU_FRACTION, so the optimizer fails
on its own rather than starving a bake that shares the GPU. (A test scoring 2048 designs a
call once did: the bake's workers ran out of memory, 2026-11-02.)

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

METHODS = ("window", "gradient", "ga", "ga_window")
METHOD = "ga_window"

SCORE_CHUNK = 64         # designs per surrogate call
GPU_FRACTION = 0.2       # of the GPU's memory, at most, per optimizer process
BF16_TOL = 0.005         # batched losses are within this (relative) of the exact ones
MAX_ROUNDS = 30          # window search rounds, at most

# The gradient method. Tuned on the 27 hours above: the final loss hardly depends on these
# (0.276-0.287), as the window search after it does most of the work.
TAU0, TAU1 = 1.0, 0.1    # edge softness, in rows, annealed over the steps
STEPS = 70
LR = 0.4
EVAL_EVERY = 10
EDGE_CLIP = 0.02         # starts at 0 or 1 sit just inside, where sigmoid(s) has a gradient

# The genetic algorithm.
GA_POP, GA_GENS, GA_ELITE, GA_TOURNAMENT, GA_CROSS = 64, 40, 2, 3, 0.9


@dataclass
class Result:
    drops: list[int]               # rows each shade is lowered, window by window
    loss: float                    # deployed loss (exact)
    method: str
    rounds: int                    # window search rounds, or GA generations
    scored: int                    # binary designs scored
    seconds: float
    gradient_loss: float | None = None  # gradient method: its best design before the search


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

    def _scorer(self, cond_t, tgt_t):
        """A cache of batched scores by design, and a function that fills it."""
        seen: dict[tuple, float] = {}

        def consider(designs) -> np.ndarray:
            keys = [tuple(int(v) for v in x) for x in designs]
            new = list(dict.fromkeys(k for k in keys if k not in seen))
            if new:
                for d, L in zip(new, self._score_t(cond_t, tgt_t, new)):
                    seen[d] = float(L)
            return np.array([seen[k] for k in keys])

        return seen, consider

    # -- the methods ----------------------------------------------------------------------

    def solve(self, cond, tgt, prev=None, method: str = METHOD, seed: int = 0) -> Result:
        if method not in METHODS:
            raise ValueError(f"unknown method {method!r}")
        t0 = time.perf_counter()
        cond_t, tgt_t = self._tensors(cond, tgt)
        seen, consider = self._scorer(cond_t, tgt_t)
        gradient_loss = None
        if method == "window":
            drops, rounds = self._window(cond_t, tgt_t, self._starts(prev), seen, consider)
        elif method == "gradient":
            best = self._gradient(cond_t, tgt_t, prev, seen, consider)
            gradient_loss = float(self._score_t(cond_t, tgt_t, [best], exact=True)[0])
            drops, rounds = self._window(cond_t, tgt_t, [best], seen, consider)
        elif method == "ga":
            drops, rounds = self._ga(seed, seen, consider)
        else:
            best, gens = self._ga(seed, seen, consider)
            drops, rounds = self._window(cond_t, tgt_t, [best] + self._starts(prev), seen,
                                         consider)
            rounds += gens
        loss = float(self._score_t(cond_t, tgt_t, [drops], exact=True)[0])
        return Result(drops=list(drops), loss=loss, method=method, rounds=rounds,
                      scored=len(seen), seconds=time.perf_counter() - t0,
                      gradient_loss=gradient_loss)

    def _starts(self, prev) -> list[list[int]]:
        n = len(self.windows)
        starts = [[0] * n, [int(r) // 2 for r in self.rows], [int(r) for r in self.rows]]
        if prev is not None and list(prev) not in starts:
            starts.append([int(v) for v in prev])
        return starts

    def _window(self, cond_t, tgt_t, starts, seen, consider):
        """Window by window from each start; the best design found, and the rounds taken."""
        best, best_L, total = None, float("inf"), 0
        for start, L0 in zip(starts, consider(starts)):
            drops, loss = list(start), float(L0)
            for _ in range(MAX_ROUNDS):
                total += 1
                cands = []
                for k, rows in enumerate(self.rows):
                    for v in range(rows + 1):
                        if v != drops[k]:
                            c = list(drops)
                            c[k] = v
                            cands.append(c)
                L = consider(cands)
                i = int(np.argmin(L))
                if L[i] >= loss:
                    break
                drops, loss = cands[i], float(L[i])
            if loss < best_L:
                best, best_L = drops, loss
        return best, total

    def _gradient(self, cond_t, tgt_t, prev, seen, consider) -> list[int]:
        """v3's gradient scheme on the shades' edges; its best binary design."""
        t = self.torch
        n = len(self.windows)
        fracs = [np.full(n, f) for f in (0.0, 0.5, 1.0)]
        exact = [[0] * n, [int(r) for r in self.rows]]
        if prev is not None:
            fracs.append(np.asarray(prev) / self.rows)
            exact.append([int(v) for v in prev])
        frac = np.clip(np.stack(fracs), EDGE_CLIP, 1 - EDGE_CLIP)
        S = t.logit(t.as_tensor(frac, dtype=t.float32, device=self.dev)).requires_grad_(True)
        adam = t.optim.Adam([S], lr=LR)
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
        return list(min(seen, key=seen.get))

    def _ga(self, seed, seen, consider):
        """A genetic algorithm over whole-row designs; the best design and the generations."""
        rng = np.random.default_rng(seed)
        n, levels = len(self.windows), self.rows + 1
        pop = rng.integers(0, levels, size=(GA_POP, n))
        fit = consider(pop)
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
            fit = consider(pop)
        return list(min(seen, key=seen.get)), GA_GENS

    # -- every combination, to check the optimizer ----------------------------------------

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
            L = self._loss(E, tgt_t, per_design=True)
            i = int(t.argmin(L))
            if float(L[i]) < best_L:
                best_L, best_code = float(L[i]), s + i
            if progress and (s // batch) % 2000 == 0:
                progress(s + len(codes), total, time.perf_counter() - t0)
        drops = [int(best_code // int(r) % int(v)) for r, v in zip(radix.cpu(), levels)]
        secs = round(time.perf_counter() - t0, 1)
        return {"drops": drops, "loss": float(self._score_t(cond_t, tgt_t, [drops], exact=True)[0]),
                "loss_batched": best_L, "designs": total, "seconds": secs}
