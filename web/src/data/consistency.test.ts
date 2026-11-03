// M3 gate (guidelines §8): the numbers the site can show, recomputed in the browser's own
// code from the shipped data files and the manifest's owner grids, match the bake's metrics
// (bake/report.py, written into each month's sidecar). The bake computed them from float lux;
// the files hold lux rounded to whole numbers, so only a cell within half a lux of a band edge
// or of the glare threshold can count differently. Those cells are the whole tolerance.
//
// The same holds for the shade files (shade_optimizer/pack.py). Every responsive record has
// its Radiance run; a shade record is checked on Radiance where it has a run, otherwise on the
// surrogate. The schedule-specific facade's files (bake/schedule_facade.py) have one record an
// hour, judged against the daily routine's state then ("plan"); there the app computes the
// numbers itself (record.ts: zoneMetrics), so that is checked against the bake's too.

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BAND, FIXED, GLARE_LUX, stateFor, zoneMetrics } from '../app/record';
import { DAY_PLAN } from '../app/schedule';
import type { Manifest } from './manifest';
import { ownerGrid } from './manifest';
import { MonthData, type MonthSidecar, type Variant } from './month';
import type { DataIndex } from './store';

const DATA = new URL('../../public/data/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', DATA), 'utf8')) as Manifest;
const index = JSON.parse(readFileSync(new URL('index.json', DATA), 'utf8')) as DataIndex;

function load(city: string, month: number, variant: Variant): MonthData {
  const suffix = variant === 'panels' ? '' : `.${variant}`;
  const base = new URL(`${city}/${String(month).padStart(2, '0')}${suffix}`, DATA);
  const bin = readFileSync(new URL(`${base.href}.bin`));
  const meta = JSON.parse(readFileSync(new URL(`${base.href}.json`), 'utf8')) as MonthSidecar;
  return new MonthData(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), meta);
}

function filesOnDisk(city: string, pattern: RegExp): number[] {
  let files: string[] = [];
  try {
    files = readdirSync(new URL(`${city}/`, DATA));
  } catch {
    // no folder: no data for this city
  }
  return files
    .filter((f) => pattern.test(f))
    .map((f) => Number(f.slice(0, 2)))
    .sort((a, b) => a - b);
}

function checkMonth(data: MonthData, needRadiance: boolean): void {
  let checked = 0;
  for (const [k, sid] of data.meta.states.entries()) {
    for (let s = 0; s < data.nSlots; s++) {
      // A schedule file's record is judged against the routine's state at that hour.
      const st = stateFor(manifest, sid === FIXED ? data.meta.plan![s]! : sid)!;
      const owner = ownerGrid(st.owner);
      const m = data.meta.records[sid]!.metrics[s]!;
      const rad = data.lux(s, k, 'radiance');
      if (needRadiance) expect(rad, `${sid} ${s} has Radiance`).not.toBeNull();
      const lux = rad ?? data.lux(s, k, 'surrogate')!;
      const inBandOf = rad ? m.in_band_rad! : m.in_band_sur;
      st.zones.forEach((z, zi) => {
        const [lo, hi] = [z.target * BAND[0], z.target * BAND[1]];
        let n = 0;
        let inBand = 0;
        let edge = 0;
        for (let i = 0; i < owner.length; i++) {
          if (owner[i] !== zi) continue;
          n++;
          const v = lux[i]!;
          if (v >= lo && v <= hi) inBand++;
          if (Math.abs(v - lo) <= 0.5 || Math.abs(v - hi) <= 0.5) edge++;
        }
        const tol = (edge / n) * 100 + 0.05; // plus the report's rounding to 0.1%
        expect(Math.abs((inBand / n) * 100 - inBandOf[zi]!)).toBeLessThanOrEqual(tol);
        if (sid === FIXED) {
          const app = zoneMetrics(st, rad, data.lux(s, k, 'surrogate')!);
          const appInBand = rad ? app.in_band_rad! : app.in_band_sur;
          expect(Math.abs(appInBand[zi]! - (inBand / n) * 100)).toBeLessThanOrEqual(0.05);
        }
      });
      const glare = lux.reduce((c, v) => c + (v > GLARE_LUX ? 1 : 0), 0);
      const near = lux.reduce((c, v) => c + (Math.abs(v - GLARE_LUX) <= 0.5 ? 1 : 0), 0);
      expect(Math.abs(glare - (rad ? m.glare_rad! : m.glare_sur))).toBeLessThanOrEqual(near);
      checked++;
    }
  }
  expect(checked).toBe(data.nSlots * data.nStates);
}

describe('baked data', () => {
  it('index.json lists exactly the month, shade and schedule files on disk', () => {
    for (const city of manifest.cities.map((c) => c.id)) {
      expect(index.months[city] ?? []).toEqual(filesOnDisk(city, /^\d\d\.bin$/));
      expect(index.shades?.[city] ?? []).toEqual(filesOnDisk(city, /^\d\d\.shades\.bin$/));
      expect(index.schedule?.[city] ?? []).toEqual(filesOnDisk(city, /^\d\d\.schedule\.bin$/));
    }
  });

  for (const [city, months] of Object.entries(index.months))
    for (const month of months)
      it(`${city} ${month}: in-band shares and glare cells match the bake`, () => {
        checkMonth(load(city, month, 'panels'), true);
      });

  for (const [city, months] of Object.entries(index.shades ?? {}))
    for (const month of months)
      it(`${city} ${month} shades: in-band shares and glare cells match, for every state`, () => {
        const data = load(city, month, 'shades');
        expect([...data.meta.states].sort()).toEqual(manifest.states.map((s) => s.id).sort());
        expect(data.meta.frame).toBeTruthy();
        checkMonth(data, false);
      });

  const fixedDesigns = new Map<string, string>();
  for (const [city, months] of Object.entries(index.schedule ?? {}))
    for (const month of months)
      it(`${city} ${month} schedule: one design all year, judged against the routine`, () => {
        const data = load(city, month, 'schedule');
        const panels = load(city, month, 'panels');
        expect(data.meta.states).toEqual([FIXED]);
        expect(data.meta.slots.map((s) => s.label)).toEqual(panels.meta.slots.map((s) => s.label));
        const planned = new Set(DAY_PLAN.map(([, id]) => id));
        expect(data.meta.plan!.length).toBe(data.nSlots);
        for (const id of data.meta.plan!) expect(planned.has(id), id).toBe(true);
        // The same design at every hour, and in every season of the city.
        const design = Array.from(data.facade(0, 0)).join('');
        for (let s = 1; s < data.nSlots; s++)
          expect(Array.from(data.facade(s, 0)).join('')).toBe(design);
        expect(fixedDesigns.get(city) ?? design).toBe(design);
        fixedDesigns.set(city, design);
        checkMonth(data, true);
      });
});
