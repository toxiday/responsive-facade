// M3 gate (guidelines §8): the numbers the site can show, recomputed in the browser's own
// code from the shipped data files and the manifest's owner grids, match the bake's metrics
// (bake/report.py, written into each month's sidecar). The bake computed them from float lux;
// the files hold lux rounded to whole numbers, so only a cell within half a lux of a band edge
// or of the glare threshold can count differently. Those cells are the whole tolerance.
//
// The same holds for the shade files (shade_optimizer/pack.py). Every responsive record has
// its Radiance run; a shade record is checked on Radiance where it has a run, otherwise on the
// surrogate.

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BAND, GLARE_LUX, stateFor } from '../app/record';
import type { Manifest } from './manifest';
import { ownerGrid } from './manifest';
import { MonthData, type MonthSidecar, type Variant } from './month';
import type { DataIndex } from './store';

const DATA = new URL('../../public/data/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', DATA), 'utf8')) as Manifest;
const index = JSON.parse(readFileSync(new URL('index.json', DATA), 'utf8')) as DataIndex;

function load(city: string, month: number, variant: Variant): MonthData {
  const suffix = variant === 'shades' ? '.shades' : '';
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
    const st = stateFor(manifest, sid)!;
    const owner = ownerGrid(st.owner);
    for (let s = 0; s < data.nSlots; s++) {
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
  it('index.json lists exactly the month and shade files on disk', () => {
    for (const city of manifest.cities.map((c) => c.id)) {
      expect(index.months[city] ?? []).toEqual(filesOnDisk(city, /^\d\d\.bin$/));
      expect(index.shades?.[city] ?? []).toEqual(filesOnDisk(city, /^\d\d\.shades\.bin$/));
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
});
