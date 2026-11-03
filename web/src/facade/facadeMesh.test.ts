import { readFileSync } from 'node:fs';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { Manifest } from '../data/manifest';
import { FacadeMesh } from './facadeMesh';
import { PANELS_PER_WALL, bitIndex } from './geometry';

const manifest = JSON.parse(
  readFileSync(new URL('../../public/data/manifest.json', import.meta.url), 'utf8'),
) as Manifest;

function matrixAt(f: FacadeMesh, i: number): Matrix4 {
  const m = new Matrix4();
  f.walls.get('S')!.solid.getMatrixAt(i, m);
  return m;
}
const isZero = (m: Matrix4) => m.elements.every((v, i) => (i === 15 ? v === 1 : v === 0));
/** Height and top edge (three +y) of a panel transform. */
const extent = (m: Matrix4) => {
  const p = new Vector3();
  const s = new Vector3();
  m.decompose(p, new Quaternion(), s);
  return { h: s.y, top: p.y + s.y / 2 };
};

describe('FacadeMesh.animateTo', () => {
  it('moves only the changed panels, like a curtain, and ends exactly at the new design', () => {
    const f = new FacadeMesh(manifest.room);
    const closed = new Uint8Array(4 * PANELS_PER_WALL);
    f.setBits(closed);
    const open = closed.slice();
    open[bitIndex('S', 5, 3)] = 1;
    const changed = 5 * 32 + 3;
    const untouched = 6 * 32 + 3;
    const before = matrixAt(f, untouched).clone();
    const full = extent(matrixAt(f, changed));

    f.animateTo(open, 0);
    let partway = false;
    for (let t = 0; t <= 1000; t += 10) {
      f.tick(t);
      const m = matrixAt(f, changed);
      if (!isZero(m)) {
        const e = extent(m);
        expect(e.top).toBeCloseTo(full.top, 6); // it rises into its top edge
        if (e.h > 0.1 * full.h && e.h < 0.9 * full.h) partway = true;
      }
      expect(matrixAt(f, untouched).equals(before)).toBe(true);
    }
    expect(partway).toBe(true);
    expect(f.tick(2000)).toBe(false); // finished on an earlier tick
    expect(isZero(matrixAt(f, changed))).toBe(true);

    const direct = new FacadeMesh(manifest.room);
    direct.setBits(open);
    for (let i = 0; i < PANELS_PER_WALL; i++)
      expect(matrixAt(f, i).equals(matrixAt(direct, i))).toBe(true);
    expect(Array.from(f.getBits())).toEqual(Array.from(open));
  });

  it('raises from the bottom row up and drops from the top row down', () => {
    const f = new FacadeMesh(manifest.room);
    const closed = new Uint8Array(4 * PANELS_PER_WALL);
    const open = closed.slice();
    for (const row of [2, 9]) open[bitIndex('S', row, 4)] = 1;
    const [upper, lower] = [2 * 32 + 4, 9 * 32 + 4];
    const h = (i: number) => (isZero(matrixAt(f, i)) ? 0 : extent(matrixAt(f, i)).h);

    f.setBits(closed);
    const full = h(upper);
    f.animateTo(open, 0);
    let t = 0;
    while (h(lower) > full * 0.99) f.tick((t += 5)); // the lower one starts rising first...
    expect(h(upper)).toBeCloseTo(full, 6); // ...while the upper one has not moved
    f.tick(5000);
    f.tick(5001);

    f.animateTo(closed, 0);
    t = 0;
    while (h(upper) === 0) f.tick((t += 5)); // closing, the upper one drops first
    expect(h(lower)).toBe(0);
  });

  it('moves a column as one curtain: at most one panel partway at a time', () => {
    const f = new FacadeMesh(manifest.room);
    const closed = new Uint8Array(4 * PANELS_PER_WALL);
    const open = closed.slice();
    for (let row = 0; row < 16; row++) open[bitIndex('W', row, 7)] = 1;
    const wall = f.walls.get('W')!.solid;
    f.setBits(closed);
    const full = (() => {
      const m = new Matrix4();
      wall.getMatrixAt(7, m);
      return extent(m).h;
    })();
    f.animateTo(open, 0);
    for (let t = 0; t <= 900; t += 15) {
      f.tick(t);
      let partway = 0;
      for (let row = 0; row < 16; row++) {
        const m = new Matrix4();
        wall.getMatrixAt(row * 32 + 7, m);
        const hh = isZero(m) ? 0 : extent(m).h;
        if (hh > 1e-6 && hh < full - 1e-6) partway++;
      }
      expect(partway).toBeLessThanOrEqual(1);
    }
  });

  it('a new change finishes the running one first', () => {
    const f = new FacadeMesh(manifest.room);
    const a = new Uint8Array(4 * PANELS_PER_WALL);
    const b = a.slice();
    b[bitIndex('W', 0, 0)] = 1;
    f.setBits(a);
    f.animateTo(b, 0);
    f.tick(100);
    f.animateTo(a, 100); // back again before the first finished
    f.tick(5000);
    f.tick(5001);
    const direct = new FacadeMesh(manifest.room);
    direct.setBits(a);
    const m = new Matrix4();
    const d = new Matrix4();
    f.walls.get('W')!.solid.getMatrixAt(0, m);
    direct.walls.get('W')!.solid.getMatrixAt(0, d);
    expect(m.equals(d)).toBe(true);
  });
});

describe('FacadeMesh shade mode', () => {
  // One S window, rows 5-12 by cols 7-12, as in the conventional facade.
  const frame = new Uint8Array(4 * PANELS_PER_WALL);
  for (let r = 5; r <= 12; r++) for (let c = 7; c <= 12; c++) frame[bitIndex('S', r, c)] = 1;
  /** The window with its shade down `n` rows. */
  const lowered = (n: number) => {
    const bits = frame.slice();
    for (let r = 5; r < 5 + n; r++) for (let c = 7; c <= 12; c++) bits[bitIndex('S', r, c)] = 0;
    return bits;
  };
  const shown = (f: FacadeMesh, mesh: 'solid' | 'glass' | 'shadow' | 'fabric', r: number) => {
    const m = new Matrix4();
    f.walls.get('S')![mesh].getMatrixAt(r * 32 + 9, m);
    return !isZero(m);
  };

  it('covers the top rows with shade fabric, keeps the glass and shades the floor', () => {
    const f = new FacadeMesh(manifest.room);
    expect(f.setFrame(frame)).toBe(true);
    expect(f.setFrame(frame)).toBe(false);
    f.setBits(lowered(3));
    for (const r of [5, 6, 7]) {
      expect([shown(f, 'fabric', r), shown(f, 'glass', r), shown(f, 'shadow', r)]).toEqual([
        true,
        true,
        true,
      ]);
      expect(shown(f, 'solid', r)).toBe(false);
    }
    for (const r of [8, 12]) {
      expect([shown(f, 'fabric', r), shown(f, 'glass', r), shown(f, 'shadow', r)]).toEqual([
        false,
        true,
        false,
      ]);
    }
    expect(shown(f, 'solid', 4)).toBe(true); // wall above the window head
    expect(shown(f, 'fabric', 4)).toBe(false);
  });

  it('rolls the shade up from its bottom edge, the glass staying, and back to panels', () => {
    const f = new FacadeMesh(manifest.room);
    f.setFrame(frame);
    f.setBits(lowered(3));
    f.animateTo(lowered(0), 0);
    const tops = new Set<number>();
    for (let t = 0; t <= 1000; t += 10) {
      f.tick(t);
      expect(shown(f, 'glass', 6)).toBe(true);
      const m = new Matrix4();
      f.walls.get('S')!.fabric.getMatrixAt(6 * 32 + 9, m);
      if (!isZero(m)) tops.add(Math.round(extent(m).top * 1e6));
    }
    expect(tops.size).toBe(1); // it shortens into its top edge
    expect([5, 6, 7].some((r) => shown(f, 'fabric', r))).toBe(false);
    expect(f.setFrame(null)).toBe(true);
    f.setBits(lowered(3));
    expect(shown(f, 'fabric', 5)).toBe(false);
    expect(shown(f, 'solid', 5)).toBe(true);
  });
});
