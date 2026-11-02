import { describe, expect, it } from 'vitest';
import { DayClock, FADE_S, HOUR_S, NIGHT_S } from './clock';

/** Run the clock for `seconds` in 60 Hz steps from `slot`; returns the slot it ends on. */
function run(c: DayClock, seconds: number, slot: number, n: number): number {
  for (let i = 0; i < Math.round(seconds * 60); i++) slot = c.update(1 / 60, slot, n) ?? slot;
  return slot;
}

describe('day clock', () => {
  it('moves on one baked hour every HOUR_S seconds', () => {
    const c = new DayClock();
    expect(run(c, HOUR_S - 0.1, 2, 5)).toBe(2);
    expect(run(c, 0.2, 2, 5)).toBe(3);
    expect(run(c, HOUR_S, 3, 5)).toBe(4);
  });

  it('after the last hour goes dark for the night, then starts the day again', () => {
    const c = new DayClock();
    let slot = run(c, HOUR_S + 0.1, 4, 5);
    expect([slot, c.night]).toEqual([4, true]);
    slot = run(c, FADE_S, slot, 5);
    expect(c.daylight).toBe(0);
    slot = run(c, NIGHT_S - FADE_S - 0.2, slot, 5);
    expect([slot, c.night, c.daylight]).toEqual([4, true, 0]);
    slot = run(c, 0.2, slot, 5);
    expect([slot, c.night]).toEqual([0, false]);
    run(c, FADE_S / 2, slot, 5);
    expect(c.daylight).toBeGreaterThan(0);
    expect(c.daylight).toBeLessThan(1);
    run(c, FADE_S / 2, slot, 5);
    expect(c.daylight).toBe(1);
  });

  it('stands still while frozen', () => {
    const c = new DayClock();
    c.running = false;
    expect(run(c, 5 * HOUR_S, 1, 5)).toBe(1);
    expect(c.daylight).toBe(1);
  });

  it('picking an hour ends the night and restarts the hour', () => {
    const c = new DayClock();
    run(c, HOUR_S + 2, 4, 5);
    expect(c.night).toBe(true);
    c.restart();
    expect(c.night).toBe(false);
    expect(run(c, HOUR_S - 0.1, 1, 5)).toBe(1);
    expect(c.daylight).toBe(1);
  });
});
