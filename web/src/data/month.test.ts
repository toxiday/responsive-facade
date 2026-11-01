// The month decoder against a file written by bake/format.py (python -m bake fixtures).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MonthData, type MonthSidecar } from './month';

const bin = readFileSync(new URL('../__fixtures__/month.bin', import.meta.url));
const expected = JSON.parse(
  readFileSync(new URL('../__fixtures__/month.json', import.meta.url), 'utf8'),
) as {
  n_slots: number;
  n_states: number;
  records: {
    slot: number;
    state: number;
    bits: number[];
    sur: Record<string, number>;
    rad: Record<string, number> | null;
  }[];
};

const meta = {
  states: ['a', 'b', 'c'],
  slots: [{}, {}],
} as unknown as MonthSidecar;
const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
const data = new MonthData(buf, meta);

describe('MonthData', () => {
  it('reads the header', () => {
    expect(data.nSlots).toBe(expected.n_slots);
    expect(data.nStates).toBe(expected.n_states);
    expect(data.hasRadiance).toBe(true);
  });

  it('reads every record as Python wrote it', () => {
    for (const r of expected.records) {
      const bits = data.facade(r.slot, r.state);
      const on = [...bits.keys()].filter((i) => bits[i] === 1);
      expect(on).toEqual(r.bits);
      const sur = data.lux(r.slot, r.state, 'surrogate')!;
      for (const [i, v] of Object.entries(r.sur)) expect(sur[Number(i)]).toBe(v);
      const rad = data.lux(r.slot, r.state, 'radiance');
      if (r.rad === null) expect(rad).toBeNull();
      else for (const [i, v] of Object.entries(r.rad)) expect(rad![Number(i)]).toBe(v);
    }
  });

  it('rejects a damaged file', () => {
    expect(() => new MonthData(buf.slice(0, buf.byteLength - 1), meta)).toThrow();
    const bad = new Uint8Array(buf.slice(0));
    bad[0] = 0x58;
    expect(() => new MonthData(bad.buffer, meta)).toThrow();
  });
});
