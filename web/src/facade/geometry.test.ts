import { describe, expect, it } from 'vitest';
import conventions from '../__fixtures__/conventions.json';
import type { Side } from '../data/manifest';
import { allPanels, bitIndex, COLS, panelAt, panelBox, ROWS, windowOutline } from './geometry';

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

describe('windowOutline', () => {
  const [W, D, H] = [5.372487, 10.498, 3.0];
  const segments = (pts: number[]) => {
    const out: [number, number, number, number, number, number][] = [];
    for (let i = 0; i < pts.length; i += 6) out.push(pts.slice(i, i + 6) as never);
    return out;
  };
  const length = (pts: number[]) =>
    segments(pts).reduce((s, [a, b, c, d, e, f]) => s + Math.hypot(d - a, e - b, f - c), 0);

  it('is empty without windows', () => {
    expect(windowOutline(new Uint8Array(2048), 'S', W, D, H)).toEqual([]);
  });

  it('outlines a block of windows with four merged edges in the wall plane', () => {
    const bits = new Uint8Array(2048);
    for (let row = 5; row < 7; row++)
      for (let col = 10; col < 13; col++) bits[bitIndex('S', row, col)] = 1;
    const pts = windowOutline(bits, 'S', W, D, H);
    expect(segments(pts)).toHaveLength(4);
    const [cw, ch] = [W / COLS, H / ROWS];
    expect(length(pts)).toBeCloseTo(2 * (3 * cw + 2 * ch), 6);
    for (let i = 1; i < pts.length; i += 3) expect(pts[i]).toBe(0); // S wall: y = 0
  });

  it('runs along y on the E and W walls and reaches the wall edge', () => {
    const bits = new Uint8Array(2048);
    for (let row = 0; row < ROWS; row++) bits[bitIndex('W', row, 0)] = 1; // full-height strip
    const pts = windowOutline(bits, 'W', W, D, H);
    expect(segments(pts)).toHaveLength(4);
    for (let i = 0; i < pts.length; i += 3) expect(pts[i]).toBe(0); // W wall: x = 0
    expect(Math.max(...pts.filter((_, i) => i % 3 === 2))).toBeCloseTo(H, 9);
  });
});
