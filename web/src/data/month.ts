// Baked month files: public/data/{city}/{MM}.bin and the {MM}.json sidecar. The binary layout
// is documented in public/data/FORMAT.md (written by bake/format.py).

import type { Vec3 } from './manifest';
import { GRID_N } from './grid';

const MAGIC = 'RFB1';
const VERSION = 1;
const HEADER_BYTES = 32;
const FACADE_BYTES = 256;
const RECORD_BYTES = 4352;
const CELLS = GRID_N * GRID_N;
export const MISSING = 65535;

export interface SlotMeta {
  label: string;
  hour: number;
  alt: number;
  az_true: number;
  sun_room: Vec3;
  dni: number;
  dhi: number;
  sky: string;
}

export interface RecordMetrics {
  in_band_sur: number[];
  above_sur: number[];
  glare_sur: number;
  in_band_rad?: number[];
  above_rad?: number[];
  glare_rad?: number;
  zone_mae?: number;
  zone_bias?: number;
}

export interface StateRecords {
  ship: string[];
  flips: (number | null)[];
  metrics: RecordMetrics[];
}

export interface MonthSidecar {
  schema: number;
  city: string;
  month: number;
  day: number;
  record_bytes: number;
  states: string[];
  slots: SlotMeta[];
  records: Record<string, StateRecords>;
}

export class MonthData {
  readonly nSlots: number;
  readonly nStates: number;
  readonly hasRadiance: boolean;
  private readonly view: DataView;

  constructor(
    buf: ArrayBuffer,
    readonly meta: MonthSidecar,
  ) {
    const v = new DataView(buf);
    const magic = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));
    if (magic !== MAGIC || v.getUint16(4, true) !== VERSION)
      throw new Error('not an RFB1 v1 month file');
    if (v.getUint32(12, true) !== RECORD_BYTES) throw new Error('unexpected record size');
    this.hasRadiance = (v.getUint16(6, true) & 1) === 1;
    this.nSlots = v.getUint16(8, true);
    this.nStates = v.getUint16(10, true);
    if (buf.byteLength !== HEADER_BYTES + this.nSlots * this.nStates * RECORD_BYTES)
      throw new Error('month file size does not match its header');
    if (this.nSlots !== meta.slots.length || this.nStates !== meta.states.length)
      throw new Error('month file and sidecar disagree');
    this.view = v;
  }

  private offset(slot: number, state: number): number {
    if (slot < 0 || slot >= this.nSlots || state < 0 || state >= this.nStates)
      throw new RangeError(`no record (${slot}, ${state})`);
    return HEADER_BYTES + (slot * this.nStates + state) * RECORD_BYTES;
  }

  /** 2048 panel flags (1 = window), bit i = wall*512 + row*32 + col, walls S, N, E, W. */
  facade(slot: number, state: number): Uint8Array {
    const o = this.offset(slot, state);
    const bits = new Uint8Array(FACADE_BYTES * 8);
    for (let b = 0; b < FACADE_BYTES; b++) {
      const byte = this.view.getUint8(o + b);
      for (let k = 0; k < 8; k++) bits[b * 8 + k] = (byte >> k) & 1;
    }
    return bits;
  }

  /** 1024 lux values in floor-grid order; null if the record has no Radiance result. */
  lux(slot: number, state: number, source: 'surrogate' | 'radiance'): Float32Array | null {
    const o = this.offset(slot, state) + FACADE_BYTES + (source === 'radiance' ? 2 * CELLS : 0);
    const out = new Float32Array(CELLS);
    for (let i = 0; i < CELLS; i++) {
      const v = this.view.getUint16(o + 2 * i, true);
      if (v === MISSING) return null;
      out[i] = v;
    }
    return out;
  }
}

export async function loadMonth(city: string, month: number): Promise<MonthData> {
  const base = `${import.meta.env.BASE_URL}data/${city}/${String(month).padStart(2, '0')}`;
  const [bin, meta] = await Promise.all([
    fetch(`${base}.bin`).then((r) => {
      if (!r.ok) throw new Error(`${base}.bin: ${r.status}`);
      return r.arrayBuffer();
    }),
    fetch(`${base}.json`).then((r) => {
      if (!r.ok) throw new Error(`${base}.json: ${r.status}`);
      return r.json() as Promise<MonthSidecar>;
    }),
  ]);
  return new MonthData(bin, meta);
}
