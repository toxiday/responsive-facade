import { describe, expect, it } from 'vitest';
import conventions from '../__fixtures__/conventions.json';
import type { Side } from '../data/manifest';
import { allPanels, bitIndex, panelAt, panelBox } from './geometry';

describe('facade panels match v3 facade_panel_boxes', () => {
  for (const room of conventions.rooms) {
    it(`room ${room.name}: all 2048 panels`, () => {
      const ours = allPanels(room.width, room.depth, room.height);
      expect(ours.length).toBe(room.panels.length);
      room.panels.forEach((ref, i) => {
        const [side, row, col, idx, p0, p1, n] = ref as [
          Side,
          number,
          number,
          number,
          number[],
          number[],
          number[],
        ];
        const p = ours[i]!;
        expect([p.side, p.row, p.col, p.index]).toEqual([side, row, col, idx]);
        p.p0.forEach((v, k) => expect(v).toBeCloseTo(p0[k]!, 5));
        p.p1.forEach((v, k) => expect(v).toBeCloseTo(p1[k]!, 5));
        expect(p.normal).toEqual(n);
      });
    });
  }

  it('maps a wall point back to its panel', () => {
    const [W, D, H] = [5.372487, 10.498, 3.0];
    for (const side of ['S', 'N', 'E', 'W'] as Side[])
      for (const [row, col] of [
        [0, 0],
        [15, 31],
        [7, 20],
      ] as const) {
        const b = panelBox(side, row, col, W, D, H);
        const axis = side === 'S' || side === 'N' ? 0 : 1;
        const a = (b.p0[axis] + b.p1[axis]) / 2;
        const z = (b.p0[2] + b.p1[2]) / 2;
        expect(panelAt(side, a, z, W, D, H)).toEqual({ row, col });
      }
  });

  it('indexes bits wall-major in S, N, E, W order', () => {
    expect(bitIndex('S', 0, 0)).toBe(0);
    expect(bitIndex('N', 0, 0)).toBe(512);
    expect(bitIndex('W', 15, 31)).toBe(2047);
  });
});
