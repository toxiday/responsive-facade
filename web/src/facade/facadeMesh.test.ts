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
const turn = (m: Matrix4) => {
  const q = new Quaternion();
  m.decompose(new Vector3(), q, new Vector3());
  return 2 * Math.acos(Math.min(1, Math.abs(q.w)));
};

describe('FacadeMesh.animateTo', () => {
  it('turns only the changed panels and ends exactly at the new design', () => {
    const f = new FacadeMesh(manifest.room);
    const closed = new Uint8Array(4 * PANELS_PER_WALL);
    f.setBits(closed);
    const open = closed.slice();
    open[bitIndex('S', 5, 3)] = 1;
    const changed = 5 * 32 + 3;
    const untouched = 6 * 32 + 3;
    const before = matrixAt(f, untouched).clone();

    f.animateTo(open, 0);
    let turned = false;
    for (let t = 0; t <= 1000; t += 10) {
      f.tick(t);
      const a = turn(matrixAt(f, changed));
      if (a > 0.1 && a < Math.PI / 2 - 0.1) turned = true;
      expect(matrixAt(f, untouched).equals(before)).toBe(true);
    }
    expect(turned).toBe(true);
    expect(f.tick(2000)).toBe(false); // finished on an earlier tick
    expect(isZero(matrixAt(f, changed))).toBe(true);

    const direct = new FacadeMesh(manifest.room);
    direct.setBits(open);
    for (let i = 0; i < PANELS_PER_WALL; i++)
      expect(matrixAt(f, i).equals(matrixAt(direct, i))).toBe(true);
    expect(Array.from(f.getBits())).toEqual(Array.from(open));
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
