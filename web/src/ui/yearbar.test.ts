import { describe, expect, it } from 'vitest';
import { dayAt, yearPosition } from './yearbar';

describe('the year bar', () => {
  it('runs from March 1 to February 28', () => {
    expect(yearPosition({ month: 3, day: 1 })).toBeCloseTo(0.5 / 365, 9);
    expect(yearPosition({ month: 2, day: 28 })).toBeCloseTo(364.5 / 365, 9);
    expect(yearPosition({ month: 6, day: 1 })).toBeCloseTo(92.5 / 365, 9);
    expect(yearPosition({ month: 12, day: 22 })).toBeCloseTo(296.5 / 365, 9);
  });

  it('puts the seasons in order along it', () => {
    const at = [3, 6, 9, 12, 1].map((month) => yearPosition({ month, day: 15 }));
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('reads back every day of the year, wrapping round past its end', () => {
    for (let m = 1; m <= 12; m++) {
      for (const day of [1, 15, 28]) {
        const p = yearPosition({ month: m, day });
        expect(dayAt(p)).toEqual({ month: m, day });
        expect(dayAt(p + 1)).toEqual({ month: m, day });
      }
    }
  });
});
