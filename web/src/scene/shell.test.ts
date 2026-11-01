import { describe, expect, it } from 'vitest';
import manifestJson from '../../public/data/manifest.json';
import type { Manifest } from '../data/manifest';
import { wallPieces } from './shell';

describe('wallPieces', () => {
  it('is the whole wall without openings', () => {
    expect(wallPieces(5, 3, [])).toEqual([{ a0: 0, a1: 5, z0: 0, z1: 3 }]);
  });

  it('cuts a door with a header over it', () => {
    expect(wallPieces(5.372, 3, [{ a0: 4.547, a1: 5.297, z1: 2.1 }])).toEqual([
      { a0: 0, a1: 4.547, z0: 0, z1: 3 },
      { a0: 4.547, a1: 5.297, z0: 2.1, z1: 3 },
      { a0: 5.297, a1: 5.372, z0: 0, z1: 3 },
    ]);
  });

  it('leaves the opening empty up to its head, and covers the rest of the wall', () => {
    const room = (manifestJson as unknown as Manifest).room;
    for (const o of room.openings) {
      const length = o.wall === 'S' || o.wall === 'N' ? room.width : room.depth;
      const pieces = wallPieces(length, room.height, [o]);
      const mid = (o.a0 + o.a1) / 2;
      const over = pieces.filter((p) => p.a0 <= mid && mid <= p.a1);
      expect(over).toEqual([{ a0: o.a0, a1: o.a1, z0: o.z1, z1: room.height }]);
      const area = pieces.reduce((s, p) => s + (p.a1 - p.a0) * (p.z1 - p.z0), 0);
      expect(area).toBeCloseTo(length * room.height - (o.a1 - o.a0) * o.z1, 9);
    }
  });
});
