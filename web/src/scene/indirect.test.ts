import { describe, expect, it } from 'vitest';
import { GRID_N } from '../data/grid';
import { indirectLux } from './indirect';

const N = GRID_N * GRID_N;
const at = (r: number, c: number) => r * GRID_N + c;

describe('indirectLux', () => {
  it('only blurs without a lit mask: uniform fields and ramps keep, noise drops', () => {
    expect(indirectLux(new Float32Array(N).fill(80), null)[at(5, 5)]).toBeCloseTo(80, 4);
    const ramp = Float32Array.from({ length: N }, (_, i) => 3 * (i % GRID_N));
    expect(indirectLux(ramp, null)[at(7, 9)]).toBeCloseTo(27, 4);
    const noisy = Float32Array.from({ length: N }, (_, i) => ((i + (i >> 5)) % 2 ? 90 : 110));
    expect(indirectLux(noisy, null)[at(9, 9)]).toBeCloseTo(100, 4);
  });

  it('removes a sun patch from a uniform field, including its edge cells', () => {
    const lux = new Float32Array(N).fill(100);
    const lit = new Uint8Array(N);
    for (const [r, c] of [
      [10, 10],
      [10, 11],
    ] as const) {
      lit[at(r, c)] = 1;
      lux[at(r, c)] = 20000;
    }
    lux[at(9, 10)] = 6000; // a partly lit neighbour, outside the mask
    const out = indirectLux(lux, lit);
    for (let i = 0; i < N; i++) expect(out[i]).toBeCloseTo(100, 0);
  });

  it('fills a hole smoothly from a gradient around it', () => {
    const lux = Float32Array.from({ length: N }, (_, i) => 50 + 10 * (i % GRID_N));
    const lit = new Uint8Array(N);
    for (let r = 12; r < 18; r++) for (let c = 12; c < 18; c++) lit[at(r, c)] = 1;
    const out = indirectLux(lux, lit);
    for (let r = 11; r < 19; r++)
      for (let c = 11; c < 19; c++) expect(out[at(r, c)]).toBeCloseTo(50 + 10 * c, 0);
  });

  it('leaves the lux alone when the sun reaches every cell', () => {
    const lux = new Float32Array(N).fill(5000);
    expect(indirectLux(lux, new Uint8Array(N).fill(1))[0]).toBe(5000);
  });
});
