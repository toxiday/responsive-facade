import { describe, expect, it } from 'vitest';
import { GRID_N, cellCentre, cellIndex, cellOf } from './grid';

const W = 5.372487;
const D = 10.498;

describe('floor grid convention', () => {
  it('puts row 0 on the N edge (y = D) and col 0 on the W edge (x = 0)', () => {
    const c = cellCentre(0, 0, W, D);
    expect(c.x).toBeCloseTo(W / 64, 9);
    expect(c.y).toBeCloseTo(D - D / 64, 9);
    const last = cellCentre(31, 31, W, D);
    expect(last.x).toBeCloseTo(W - W / 64, 9);
    expect(last.y).toBeCloseTo(D / 64, 9);
  });

  it('round-trips every cell centre', () => {
    for (let row = 0; row < GRID_N; row++) {
      for (let col = 0; col < GRID_N; col++) {
        const { x, y } = cellCentre(row, col, W, D);
        expect(cellOf(x, y, W, D)).toEqual({ row, col });
      }
    }
  });

  it('clamps points outside the room and indexes row-major', () => {
    expect(cellOf(-1, D + 1, W, D)).toEqual({ row: 0, col: 0 });
    expect(cellOf(W + 1, -1, W, D)).toEqual({ row: 31, col: 31 });
    expect(cellIndex({ row: 2, col: 5 })).toBe(69);
  });
});
