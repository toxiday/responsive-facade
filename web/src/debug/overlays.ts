// Line overlays shared by the debug views.

import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineSegments } from 'three';
import type { Room, Side } from '../data/manifest';
import { GRID_N } from '../data/grid';
import { roomToThree } from '../scene/frame';

/** Outline of the cells set in a 32×32 floor-grid mask, drawn at height z. */
export function maskOutline(room: Room, mask: ArrayLike<number>, z: number, color = 0xec008c) {
  const { width: W, depth: D } = room;
  const cw = W / GRID_N;
  const ch = D / GRID_N;
  const on = (r: number, c: number) =>
    r >= 0 && r < GRID_N && c >= 0 && c < GRID_N && mask[r * GRID_N + c]! > 0;
  const pts: number[] = [];
  const seg = (x0: number, y0: number, x1: number, y1: number) => {
    const a = roomToThree(x0, y0, z);
    const b = roomToThree(x1, y1, z);
    pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
  };
  for (let r = 0; r < GRID_N; r++)
    for (let c = 0; c < GRID_N; c++) {
      if (!on(r, c)) continue;
      const x0 = c * cw;
      const x1 = x0 + cw;
      const yTop = D - r * ch; // row r spans y from D-(r+1)ch to D-r*ch
      const yBot = yTop - ch;
      if (!on(r - 1, c)) seg(x0, yTop, x1, yTop);
      if (!on(r + 1, c)) seg(x0, yBot, x1, yBot);
      if (!on(r, c - 1)) seg(x0, yBot, x0, yTop);
      if (!on(r, c + 1)) seg(x1, yBot, x1, yTop);
    }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pts, 3));
  const lines = new LineSegments(geo, new LineBasicMaterial({ color, depthTest: false }));
  lines.renderOrder = 10;
  return lines;
}

/** Rectangles on wall planes: (wall, along-wall a0..a1, z0..z1), offset outward. */
export function wallRects(
  room: Room,
  rects: { wall: Side; a: number[]; z: number[] }[],
  offset = 0.06,
  color = 0xec008c,
) {
  const { width: W, depth: D } = room;
  const pts: number[] = [];
  const at = (wall: Side, a: number, z: number) => {
    const x = wall === 'S' || wall === 'N' ? a : wall === 'E' ? W + offset : -offset;
    const y = wall === 'S' ? -offset : wall === 'N' ? D + offset : a;
    return roomToThree(x, y, z);
  };
  for (const { wall, a, z } of rects) {
    const c = [
      at(wall, a[0]!, z[0]!),
      at(wall, a[1]!, z[0]!),
      at(wall, a[1]!, z[1]!),
      at(wall, a[0]!, z[1]!),
    ];
    for (let i = 0; i < 4; i++) {
      const p = c[i]!;
      const q = c[(i + 1) % 4]!;
      pts.push(p.x, p.y, p.z, q.x, q.y, q.z);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pts, 3));
  const lines = new LineSegments(geo, new LineBasicMaterial({ color, depthTest: false }));
  lines.renderOrder = 10;
  return lines;
}
