// Where the occupant can walk (guidelines §3.6): a 5 cm grid over the room. A cell is free if
// a body disc centred there clears the walls and every obstacle's footprint: BODY_R (the same
// 0.25 m the bake used to place the standing positions) from walls and tall fixed pieces;
// LOW_R from the low, soft ones (sofa, armchairs, coffee and side tables), which you brush past
// at knee height; and MOVABLE_R from chairs and stools, which people push aside. At 0.25 m all
// round, the chairs around the dining table, the desk chair and the stools seal off the
// counter, the desk and five standing positions (gaps of 0.37–0.40 m), and there is no way in
// between the sofa and the coffee table (0.42 m), so the occupant would sit down from the far
// side of the table. Paths are A* on the grid (8-connected,
// octile distance), then pulled straight wherever the line between two points stays free.

import type { FurnitureItem, Room } from '../data/manifest';

export const CELL = 0.05;
export const BODY_R = 0.25;
export const LOW_R = 0.15;
export const MOVABLE_R = 0.12;
const LOW = new Set(['sectional', 'armchair', 'coffee_table', 'round_table']);
const MOVABLE = new Set(['chair', 'stool']);
const clearance = (type: string) =>
  MOVABLE.has(type) ? MOVABLE_R : LOW.has(type) ? LOW_R : BODY_R;

export interface Pt {
  x: number;
  y: number;
}

type Rect = [number, number, number, number];

function rectDistance([x0, y0, x1, y1]: Rect, x: number, y: number): number {
  const dx = Math.max(x0 - x, 0, x - x1);
  const dy = Math.max(y0 - y, 0, y - y1);
  return Math.hypot(dx, dy);
}

/** A tiny binary min-heap of cell indices keyed by f-score. */
class Heap {
  private readonly items: number[] = [];
  constructor(private readonly key: Float64Array) {}
  get size(): number {
    return this.items.length;
  }
  push(i: number): void {
    const a = this.items;
    a.push(i);
    let c = a.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.key[a[p]!]! <= this.key[a[c]!]!) break;
      [a[p], a[c]] = [a[c]!, a[p]!];
      c = p;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1;
        const r = l + 1;
        let m = p;
        if (l < a.length && this.key[a[l]!]! < this.key[a[m]!]!) m = l;
        if (r < a.length && this.key[a[r]!]! < this.key[a[m]!]!) m = r;
        if (m === p) break;
        [a[p], a[m]] = [a[m]!, a[p]!];
        p = m;
      }
    }
    return top;
  }
}

export class WalkGrid {
  readonly nx: number;
  readonly ny: number;
  readonly free: Uint8Array;

  constructor(
    readonly room: Room,
    furniture: FurnitureItem[],
  ) {
    const { width: W, depth: D } = room;
    this.nx = Math.floor(W / CELL);
    this.ny = Math.floor(D / CELL);
    this.free = new Uint8Array(this.nx * this.ny);
    const rects: [Rect, number][] = furniture
      .filter((f) => f.obstacle)
      .flatMap((f) =>
        (f.footprint.length ? f.footprint : [f.bbox]).map(
          (r) => [r, clearance(f.type)] as [Rect, number],
        ),
      );
    for (let j = 0; j < this.ny; j++)
      for (let i = 0; i < this.nx; i++) {
        const { x, y } = this.centre(i, j);
        if (x < BODY_R || y < BODY_R || x > W - BODY_R || y > D - BODY_R) continue;
        if (rects.every(([r, d]) => rectDistance(r, x, y) >= d)) this.free[j * this.nx + i] = 1;
      }
  }

  centre(i: number, j: number): Pt {
    return { x: (i + 0.5) * CELL, y: (j + 0.5) * CELL };
  }

  private index(p: Pt): number {
    const i = Math.min(this.nx - 1, Math.max(0, Math.floor(p.x / CELL)));
    const j = Math.min(this.ny - 1, Math.max(0, Math.floor(p.y / CELL)));
    return j * this.nx + i;
  }

  isFree(p: Pt): boolean {
    if (p.x < 0 || p.y < 0 || p.x > this.room.width || p.y > this.room.depth) return false;
    return this.free[this.index(p)] === 1;
  }

  /** The free cell centre nearest to `p` (by straight distance), or null if none. */
  nearestFree(p: Pt): Pt | null {
    if (this.isFree(p)) return { ...p };
    let best: Pt | null = null;
    let bestD = Infinity;
    for (let j = 0; j < this.ny; j++)
      for (let i = 0; i < this.nx; i++) {
        if (!this.free[j * this.nx + i]) continue;
        const c = this.centre(i, j);
        const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
        if (d < bestD) [best, bestD] = [c, d];
      }
    return best;
  }

  /** True if every point on the segment a–b is free (sampled at a quarter cell). */
  lineFree(a: Pt, b: Pt): boolean {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (CELL / 4)));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      if (!this.isFree({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) return false;
    }
    return true;
  }

  /** A free path from a to b (both must be free), straightened; null if there is none. */
  path(a: Pt, b: Pt): Pt[] | null {
    if (!this.isFree(a) || !this.isFree(b)) return null;
    if (this.lineFree(a, b)) return [a, b];
    const n = this.nx * this.ny;
    const g = new Float64Array(n).fill(Infinity);
    const f = new Float64Array(n).fill(Infinity);
    const from = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const start = this.index(a);
    const goal = this.index(b);
    const gi = goal % this.nx;
    const gj = Math.floor(goal / this.nx);
    const h = (i: number, j: number) => {
      const dx = Math.abs(i - gi);
      const dy = Math.abs(j - gj);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    const heap = new Heap(f);
    g[start] = 0;
    f[start] = h(start % this.nx, Math.floor(start / this.nx));
    heap.push(start);
    while (heap.size) {
      const c = heap.pop();
      if (c === goal) break;
      if (closed[c]) continue;
      closed[c] = 1;
      const ci = c % this.nx;
      const cj = Math.floor(c / this.nx);
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) continue;
          const k = j * this.nx + i;
          if (!this.free[k] || closed[k]) continue;
          // No cutting corners past an obstacle.
          if (di && dj && (!this.free[cj * this.nx + i] || !this.free[j * this.nx + ci])) continue;
          const cost = g[c]! + (di && dj ? Math.SQRT2 : 1);
          if (cost < g[k]!) {
            g[k] = cost;
            f[k] = cost + h(i, j);
            from[k] = c;
            heap.push(k);
          }
        }
    }
    if (from[goal] === -1) return null;
    const cells: Pt[] = [];
    for (let c = goal; c !== start; c = from[c]!)
      cells.push(this.centre(c % this.nx, Math.floor(c / this.nx)));
    cells.reverse();
    const raw = [a, ...cells.slice(0, -1), b];
    // Pull the path straight: from each kept point, jump to the farthest point in sight.
    const out: Pt[] = [raw[0]!];
    let k = 0;
    while (k < raw.length - 1) {
      let far = k + 1;
      for (let m = raw.length - 1; m > k + 1; m--)
        if (this.lineFree(raw[k]!, raw[m]!)) {
          far = m;
          break;
        }
      out.push(raw[far]!);
      k = far;
    }
    return out;
  }
}

export function pathLength(path: Pt[]): number {
  let s = 0;
  for (let k = 1; k < path.length; k++)
    s += Math.hypot(path[k]!.x - path[k - 1]!.x, path[k]!.y - path[k - 1]!.y);
  return s;
}
