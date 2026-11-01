import { describe, expect, it } from 'vitest';
import m1 from '../__fixtures__/m1.json';
import type { Vec3 } from '../data/manifest';
import { iou, litMask } from './sunlight';

const { width: W, depth: D, height: H } = m1.room;

describe('M1: geometric sun patch vs Radiance (guidelines §5)', () => {
  for (const c of m1.cases) {
    it(`case ${c.id} (${c.label}): matches the Python geometry exactly`, () => {
      const mask = litMask(c.facade, c.sun_room as Vec3, W, D, H, m1.sensor_z);
      expect(Array.from(mask)).toEqual(c.mask_geometric);
    });

    it(`case ${c.id}: coincides with the Radiance high-lux patch`, () => {
      const mask = litMask(c.facade, c.sun_room as Vec3, W, D, H, m1.sensor_z);
      expect(c.mask_radiance.reduce((s, v) => s + v, 0)).toBeGreaterThan(20);
      expect(iou(mask, c.mask_radiance)).toBeGreaterThanOrEqual(m1.iou_min);
    });

    it(`case ${c.id}: mirrored facade columns break the match`, () => {
      const mirrored = c.facade.map((_, i) => {
        const col = i % 32;
        return c.facade[i - col + (31 - col)]!;
      });
      const mask = litMask(mirrored, c.sun_room as Vec3, W, D, H, m1.sensor_z);
      expect(iou(mask, c.mask_radiance)).toBeLessThan(0.5);
    });
  }
});
