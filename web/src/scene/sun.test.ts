import { describe, expect, it } from 'vitest';
import { AMBIENT_LUX, displayValue } from './sun';

describe('display exposure', () => {
  it('shows white at the 200 lux ambient target as 50% grey', () => {
    expect(AMBIENT_LUX).toBe(200);
    expect(displayValue(200)).toBeCloseTo(0.5, 2);
  });

  it('is monotonic, black at 0 lux', () => {
    expect(displayValue(0)).toBe(0);
    expect(displayValue(100)).toBeLessThan(displayValue(200));
    expect(displayValue(200, 0.5)).toBeLessThan(displayValue(200));
  });
});
