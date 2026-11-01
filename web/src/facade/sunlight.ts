// Geometric direct-sun test, mirroring bake/m1.py: from a point in the room, does a ray towards
// the sun leave the box through a window panel? Used by the M1 orientation check.

import type { Side, Vec3 } from '../data/manifest';
import { GRID_N, cellCentre } from '../data/grid';
import { bitIndex, panelAt } from './geometry';

export function seesSun(
  p: Vec3,
  toSun: Vec3,
  facade: ArrayLike<number>,
  width: number,
  depth: number,
  height: number,
): boolean {
  const [x, y, z] = p;
  const [dx, dy, dz] = toSun;
  let best: { side: Side | 'ceiling'; t: number } | null = null;
  const consider = (side: Side | 'ceiling', t: number) => {
    if (best === null || t < best.t) best = { side, t };
  };
  if (dx < 0) consider('W', -x / dx);
  if (dx > 0) consider('E', (width - x) / dx);
  if (dy < 0) consider('S', -y / dy);
  if (dy > 0) consider('N', (depth - y) / dy);
  if (dz > 0) consider('ceiling', (height - z) / dz);
  if (best === null) return false;
  const { side, t } = best as { side: Side | 'ceiling'; t: number };
  if (side === 'ceiling') return false;
  const hz = z + t * dz;
  if (hz < 0 || hz > height) return false;
  const a = side === 'S' || side === 'N' ? x + t * dx : y + t * dy;
  const { row, col } = panelAt(side, a, hz, width, depth, height);
  return facade[bitIndex(side, row, col)] === 1;
}

/** 32×32 lit mask (floor-grid order) for sensors at height z; sunRoom points sun → room. */
export function litMask(
  facade: ArrayLike<number>,
  sunRoom: Vec3,
  width: number,
  depth: number,
  height: number,
  z = 0.6,
): Uint8Array {
  const toSun: Vec3 = [-sunRoom[0], -sunRoom[1], -sunRoom[2]];
  const out = new Uint8Array(GRID_N * GRID_N);
  for (let r = 0; r < GRID_N; r++)
    for (let c = 0; c < GRID_N; c++) {
      const { x, y } = cellCentre(r, c, width, depth);
      out[r * GRID_N + c] = seesSun([x, y, z], toSun, facade, width, depth, height) ? 1 : 0;
    }
  return out;
}

export function iou(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]! > 0;
    const q = b[i]! > 0;
    if (p && q) inter++;
    if (p || q) union++;
  }
  return union ? inter / union : 1;
}
