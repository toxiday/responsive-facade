"""The conventional facade's windows, and the roller shade on each.

The conventional L05 facade (`config.BASELINE_CSV`) is v3's 4 x 16 x 32 grid (walls S, N, E, W;
row 0 = ceiling; 1 = window). Each window is a solid rectangle of window panels. A shade
lowered by n rows closes its window's top n rows: 0 is fully up, the window's height fully
down.

In the optimizer a shade's edge moves continuously, `edge` rows below the window's top. A
window row is open where its centre is below the edge; softly, its openness is a sigmoid step
at the edge, `tau` rows wide, which sharpens to the binary facade as tau -> 0. The binary
facade for an edge closes the nearest whole number of rows (`covered`).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from bake import config

ROWS, COLS = 16, 32


@dataclass(frozen=True)
class Window:
    wall: int  # index into config.SIDES
    r0: int    # top row (row 0 = ceiling)
    r1: int    # bottom row, inclusive
    c0: int
    c1: int

    @property
    def rows(self) -> int:
        return self.r1 - self.r0 + 1

    @property
    def name(self) -> str:
        return f"{config.SIDES[self.wall]} cols {self.c0}-{self.c1}"


def load_baseline(v3) -> np.ndarray:
    """The conventional facade, (4, 16, 32) int, 1 = window."""
    return (v3.vfr.load_binary_wide(config.BASELINE_CSV) > 0.5).astype(np.int32)


def find_windows(base: np.ndarray) -> list[Window]:
    """The windows of a facade, wall by wall (S, N, E, W), then left to right. Each must be a
    solid rectangle of window panels, or one shade could not cover it."""
    seen = np.zeros(base.shape, dtype=bool)
    out = []
    for w, r, c in zip(*np.nonzero(base)):
        if seen[w, r, c]:
            continue
        stack, cells = [(r, c)], []
        while stack:
            a, b = stack.pop()
            if 0 <= a < ROWS and 0 <= b < COLS and base[w, a, b] and not seen[w, a, b]:
                seen[w, a, b] = True
                cells.append((a, b))
                stack += [(a + 1, b), (a - 1, b), (a, b + 1), (a, b - 1)]
        rs, cs = zip(*cells)
        win = Window(int(w), int(min(rs)), int(max(rs)), int(min(cs)), int(max(cs)))
        if len(cells) != win.rows * (win.c1 - win.c0 + 1):
            raise ValueError(f"the window at {win} is not a rectangle")
        out.append(win)
    return sorted(out, key=lambda x: (x.wall, x.c0))


def facade(base: np.ndarray, windows: list[Window], drops) -> np.ndarray:
    """The facade with each window's shade lowered by drops[i] whole rows."""
    out = base.copy()
    for win, n in zip(windows, drops, strict=True):
        if not 0 <= n <= win.rows:
            raise ValueError(f"{win.name}: a drop of {n} rows is outside 0..{win.rows}")
        out[win.wall, win.r0:win.r0 + n, win.c0:win.c1 + 1] = 0
    return out


def covered(edge, rows):
    """Whole rows closed by shade edges `edge` (rows below each window's top)."""
    return np.clip(np.rint(edge), 0, rows).astype(np.int64)


class Panels:
    """Every window panel as a flat facade index (wall * 512 + row * 32 + col), with its window
    and its depth (rows below the window's top), to build batches of facades at once."""

    def __init__(self, base: np.ndarray, windows: list[Window]):
        idx, win, depth = [], [], []
        for k, w in enumerate(windows):
            for r in range(w.r0, w.r1 + 1):
                for c in range(w.c0, w.c1 + 1):
                    idx.append(w.wall * ROWS * COLS + r * COLS + c)
                    win.append(k)
                    depth.append(r - w.r0)
        if len(idx) != int(base.sum()):
            raise ValueError("every window panel must belong to a window")
        self.idx = np.array(idx)
        self.win = np.array(win)
        self.depth = np.array(depth)
        self.rows = np.array([w.rows for w in windows])

    def binary(self, drops: np.ndarray) -> np.ndarray:
        """(B, 2048) 0/1 facades for drops (B, n_windows): a panel is open below the shade."""
        drops = np.atleast_2d(drops)
        out = np.zeros((len(drops), 4 * ROWS * COLS), dtype=np.float32)
        out[:, self.idx] = self.depth[None, :] >= drops[:, self.win]
        return out
