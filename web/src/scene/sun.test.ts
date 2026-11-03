import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Manifest } from '../data/manifest';
import type { SlotMeta } from '../data/month';
import { sunAngles } from './frame';
import { AMBIENT_LUX, displayValue, glidingSun, HORIZON_DEG, LUX, SunLight } from './sun';

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(`../../public/data/${path}`, import.meta.url), 'utf8'));
const manifest = read('manifest.json') as Manifest;
const slots = (read('houston/12.json') as { slots: SlotMeta[] }).slots;
/** Degrees between two directions (the baked vectors are unit to about 1e-6). */
const angle = (a: number[], b: number[]) => {
  const dot = (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / Math.hypot(...a) / Math.hypot(...b);
  return (Math.acos(Math.min(1, dot)) * 180) / Math.PI;
};

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

describe('gliding sun', () => {
  const n = slots.length;

  it('is exactly the baked sun at each baked hour', () => {
    for (let k = 0; k < n; k++) {
      const s = glidingSun(slots, k);
      expect(s.sunRoom).toEqual(slots[k]!.sun_room);
      expect([s.alt, s.dni, s.dhi]).toEqual([slots[k]!.alt, slots[k]!.dni, slots[k]!.dhi]);
      expect(sunAngles(slots[k]!.sun_room).alt).toBeCloseTo(slots[k]!.alt, 2);
    }
  });

  it('moves on steadily through the hour and meets the next hour without a jump', () => {
    for (let k = 0; k < n - 1; k++) {
      const a = slots[k]!.sun_room;
      const b = slots[k + 1]!.sun_room;
      const step = angle(a, b);
      let last = 0;
      for (const u of [0.25, 0.5, 0.75]) {
        const at = angle(a, glidingSun(slots, k + u).sunRoom);
        expect(at).toBeCloseTo(step * u, 3);
        expect(at).toBeGreaterThan(last);
        last = at;
      }
      expect(angle(glidingSun(slots, k + 1 - 1e-6).sunRoom, b)).toBeLessThan(0.01);
      const mid = glidingSun(slots, k + 0.5);
      expect(mid.dni).toBeCloseTo((slots[k]!.dni + slots[k + 1]!.dni) / 2, 6);
    }
  });

  it("sets through the last hour, at the last hour's DNI", () => {
    const last = slots[n - 1]!;
    let alt = last.alt;
    for (const u of [0.25, 0.5, 0.75, 1]) {
      const s = glidingSun(slots, n - 1 + u);
      expect(s.alt).toBeLessThan(alt);
      expect(s.dni).toBe(last.dni);
      alt = s.alt;
    }
    expect(glidingSun(slots, n).alt).toBeLessThan(HORIZON_DEG); // Houston, Dec: 17:30 is dusk
  });

  it('fades the display sun out at the horizon', () => {
    const light = new SunLight(manifest.room, 256);
    const s = glidingSun(slots, 0);
    light.set(s);
    const full = light.light.intensity;
    expect(full).toBeCloseTo(2000 * LUX * Math.min(1, s.dni / 800), 9);
    light.set({ ...s, alt: HORIZON_DEG / 2 });
    expect(light.light.intensity).toBeCloseTo(full / 2, 9);
    light.set({ ...s, alt: -1 });
    expect(light.light.intensity).toBe(0);
  });
});
