// Facade panel geometry, ported from v3's facade_panel_boxes (itself a port of the
// Radiance scene builder, the ground truth). Room-local metres, z up.
//   row 0 = top (z from H - H/16 to H), 16 rows, 32 cols
//   S (y=0) / N (y=D): col along x, col 0 at x=0
//   E (x=W) / W (x=0): col along y, col 0 at y=0
// Bit/pixel index: wall * 512 + row * 32 + col, walls in S, N, E, W order; 1 = window.

import type { Side, Vec3 } from '../data/manifest';

export const SIDES: readonly Side[] = ['S', 'N', 'E', 'W'];
export const ROWS = 16;
export const COLS = 32;
export const PANELS_PER_WALL = ROWS * COLS;
export const PANELS = 4 * PANELS_PER_WALL;

export const OUTWARD: Record<Side, Vec3> = {
  S: [0, -1, 0],
  N: [0, 1, 0],
  E: [1, 0, 0],
  W: [-1, 0, 0],
};

export interface PanelBox {
  side: Side;
  row: number;
  col: number;
  index: number;
  p0: Vec3;
  p1: Vec3;
  normal: Vec3;
}

export function bitIndex(side: Side, row: number, col: number): number {
  return SIDES.indexOf(side) * PANELS_PER_WALL + row * COLS + col;
}

/** Length of a wall along its column axis. */
export function wallSpan(side: Side, width: number, depth: number): number {
  return side === 'S' || side === 'N' ? width : depth;
}

export function panelBox(
  side: Side,
  row: number,
  col: number,
  width: number,
  depth: number,
  height: number,
): PanelBox {
  const ch = height / ROWS;
  const z0 = (ROWS - 1 - row) * ch;
  const z1 = z0 + ch;
  let p0: Vec3;
  let p1: Vec3;
  if (side === 'S' || side === 'N') {
    const cw = width / COLS;
    const y = side === 'S' ? 0 : depth;
    p0 = [col * cw, y, z0];
    p1 = [(col + 1) * cw, y, z1];
  } else {
    const cw = depth / COLS;
    const x = side === 'E' ? width : 0;
    p0 = [x, col * cw, z0];
    p1 = [x, (col + 1) * cw, z1];
  }
  return { side, row, col, index: row * COLS + col, p0, p1, normal: OUTWARD[side] };
}

export function allPanels(width: number, depth: number, height: number): PanelBox[] {
  const out: PanelBox[] = [];
  for (const side of SIDES)
    for (let row = 0; row < ROWS; row++)
      for (let col = 0; col < COLS; col++) out.push(panelBox(side, row, col, width, depth, height));
  return out;
}

/**
 * Outline of the window openings on one wall: the boundary between window and wall panels (and
 * the wall's edge where a window reaches it), merged into straight runs. Returns segment
 * endpoints in room coordinates, flat: [x0, y0, z0, x1, y1, z1, ...].
 */
export function windowOutline(
  bits: ArrayLike<number>,
  side: Side,
  width: number,
  depth: number,
  height: number,
): number[] {
  const span = wallSpan(side, width, depth);
  const cw = span / COLS;
  const ch = height / ROWS;
  const open = (row: number, col: number) =>
    row >= 0 && row < ROWS && col >= 0 && col < COLS && bits[bitIndex(side, row, col)] === 1;
  const fixed = side === 'S' ? 0 : side === 'N' ? depth : side === 'E' ? width : 0;
  const at = (a: number, z: number): Vec3 =>
    side === 'S' || side === 'N' ? [a, fixed, z] : [fixed, a, z];
  const out: number[] = [];
  const push = (a0: number, z0: number, a1: number, z1: number) =>
    out.push(...at(a0, z0), ...at(a1, z1));

  // Horizontal runs, on the line above row r (r = ROWS is the bottom edge).
  for (let r = 0; r <= ROWS; r++) {
    const z = height - r * ch;
    let start = -1;
    for (let c = 0; c <= COLS; c++) {
      const edge = c < COLS && open(r - 1, c) !== open(r, c);
      if (edge && start < 0) start = c;
      if (!edge && start >= 0) {
        push(start * cw, z, c * cw, z);
        start = -1;
      }
    }
  }
  // Vertical runs, on the line left of column c (c = COLS is the far end).
  for (let c = 0; c <= COLS; c++) {
    const a = c * cw;
    let start = -1;
    for (let r = 0; r <= ROWS; r++) {
      const edge = r < ROWS && open(r, c - 1) !== open(r, c);
      if (edge && start < 0) start = r;
      if (!edge && start >= 0) {
        push(a, height - start * ch, a, height - r * ch);
        start = -1;
      }
    }
  }
  return out;
}

/** (row, col) of the panel containing wall point (a = along-wall coordinate, z). */
export function panelAt(
  side: Side,
  a: number,
  z: number,
  width: number,
  depth: number,
  height: number,
): { row: number; col: number } {
  const span = wallSpan(side, width, depth);
  const col = Math.min(COLS - 1, Math.max(0, Math.floor(a / (span / COLS))));
  const row = ROWS - 1 - Math.min(ROWS - 1, Math.max(0, Math.floor(z / (height / ROWS))));
  return { row, col };
}
