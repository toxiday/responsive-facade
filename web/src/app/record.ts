// Puts one baked record on the stage: the facade (panels turning, or at once), the sun, the
// daylight fill, the heatmap layer, the TV and the occupant's zone. Shared by the app and the
// ?debug=bake review view. A shade file's record (data/month.ts) puts the facade in shade
// mode, the conventional windows with their shades; a change between modes shows at once. A
// schedule file has one record an hour, the same fixed design whatever the occupant does: the
// zone, the TV and the numbers are the occupant's state's, computed here from the hour's lux
// (as the consistency test checks the bake's).

import { ownerGrid, type Manifest, type OccupantState } from '../data/manifest';
import { cellIndex, cellOf } from '../data/grid';
import { bitsFromHex, type MonthData, type RecordMetrics, type SlotMeta } from '../data/month';
import { SIDES } from '../facade/geometry';
import { litMask } from '../facade/sunlight';
import { indirectLux } from '../scene/indirect';
import type { Stage } from '../scene/stage';

export type Layer = 'radiance' | 'surrogate' | 'none';

/** v3's comfort band (ZONE_MIN_RATIO, ZONE_MAX_RATIO) and glare threshold. */
export const BAND: [number, number] = [0.75, 1.25];
export const GLARE_LUX = 3000;

/** The shades of a shade record: rows lowered, and each window's height and wall. */
export interface ShadeView {
  drops: number[];
  rows: number[];
  walls: string[];
}

export interface RecordView {
  stateId: string;
  /** The manifest state; for the baseline, ambient's (it is judged against that brief). */
  state: OccupantState | undefined;
  slot: SlotMeta;
  fill: 'radiance' | 'surrogate';
  tvOn: boolean;
  ship: string;
  flips: number | null;
  /** Shade records only. */
  shades: ShadeView | null;
  metrics: RecordMetrics;
  luxRadiance: Float32Array | null;
  luxSurrogate: Float32Array;
}

/** The one state of a schedule file (bake/schedule_facade.py). */
export const FIXED = 'schedule';

/** The share of each zone in v3's band and above it (%, to 0.1), and the glare cells, as the
 * bake's metrics (bake/report.py) count them. */
export function zoneMetrics(
  state: OccupantState,
  rad: Float32Array | null,
  sur: Float32Array,
): RecordMetrics {
  const owner = ownerGrid(state.owner);
  const count = (lux: Float32Array) => {
    const inBand: number[] = [];
    const above: number[] = [];
    state.zones.forEach((z, zi) => {
      const [lo, hi] = [z.target * BAND[0], z.target * BAND[1]];
      let n = 0;
      let a = 0;
      let b = 0;
      for (let i = 0; i < owner.length; i++) {
        if (owner[i] !== zi) continue;
        n++;
        if (lux[i]! >= lo && lux[i]! <= hi) a++;
        else if (lux[i]! > hi) b++;
      }
      inBand.push(Math.round((1000 * a) / Math.max(1, n)) / 10);
      above.push(Math.round((1000 * b) / Math.max(1, n)) / 10);
    });
    return { inBand, above, glare: lux.reduce((c, v) => c + (v > GLARE_LUX ? 1 : 0), 0) };
  };
  const s = count(sur);
  const out: RecordMetrics = { in_band_sur: s.inBand, above_sur: s.above, glare_sur: s.glare };
  if (rad) {
    const r = count(rad);
    Object.assign(out, { in_band_rad: r.inBand, above_rad: r.above, glare_rad: r.glare });
  }
  return out;
}

export function stateFor(manifest: Manifest, stateId: string): OccupantState | undefined {
  return manifest.states.find((x) => x.id === (stateId === 'baseline' ? 'ambient' : stateId));
}

export function showRecord(
  stage: Stage,
  manifest: Manifest,
  data: MonthData,
  s: number,
  stateId: string,
  layer: Layer,
  animate: boolean,
): RecordView {
  const fixed = data.meta.states.length === 1 && data.meta.states[0] === FIXED;
  const k = fixed ? 0 : data.meta.states.indexOf(stateId);
  if (k < 0) throw new Error(`no baked state ${stateId}`);
  const slot = data.meta.slots[s]!;
  const { room } = manifest;

  const frame = data.meta.frame ? bitsFromHex(data.meta.frame) : null;
  if (stage.facade.setFrame(frame)) animate = false;
  const bits = data.facade(s, k);
  if (animate) stage.facade.animateTo(bits, stage.now());
  else stage.facade.setBits(bits);
  stage.setSun({ sunRoom: slot.sun_room, alt: slot.alt, dni: slot.dni, dhi: slot.dhi });

  const rad = data.lux(s, k, 'radiance');
  const sur = data.lux(s, k, 'surrogate')!;
  // No beam to remove when DNI is negligible (the display sun is off then too).
  const lit =
    slot.dni >= 20
      ? litMask(bits, slot.sun_room, room.width, room.depth, room.height, room.sensor_height)
      : null;
  stage.fill.set(indirectLux(rad ?? sur, lit));

  const shown = layer === 'radiance' ? (rad ?? sur) : layer === 'surrogate' ? sur : null;
  if (shown) stage.heatmap.set(shown);
  stage.heatmap.mesh.visible = shown !== null;

  const state = stateFor(manifest, stateId);
  stage.zones.set(stateId === 'baseline' ? null : (state ?? null));
  // The TV is on in the states that keep a screen zone dim (watching TV).
  const tvOn = state?.zones.some((z) => z.role === 'screen_proxy') ?? false;
  void stage.tv?.setOn(tvOn).then(() => stage.invalidate());
  stage.invalidate();

  const rec = data.meta.records[fixed ? FIXED : stateId]!;
  const windows = data.meta.windows;
  const drops = rec.drops?.[s];
  return {
    stateId,
    state,
    slot,
    fill: rad ? 'radiance' : 'surrogate',
    tvOn,
    ship: rec.ship[s]!,
    flips: rec.flips[s] ?? null,
    shades:
      windows && drops
        ? {
            drops,
            rows: windows.map((w) => w.r1 - w.r0 + 1),
            walls: windows.map((w) => SIDES[w.wall]!),
          }
        : null,
    metrics: fixed && state ? zoneMetrics(state, rad, sur) : rec.metrics[s]!,
    luxRadiance: rad,
    luxSurrogate: sur,
  };
}

export type Status = 'in band' | 'too dark' | 'too bright' | 'glare';

export interface Reading {
  /** Where the number is taken: the occupant's cell, or the floor median for ambient. */
  where: 'occupant' | 'floor';
  radiance: number | null;
  surrogate: number;
  target: number;
  status: Status;
}

function median(values: ArrayLike<number>, cells: number[]): number {
  const v = cells.map((i) => values[i]!).sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

/** The HUD's numbers for a record: Radiance first, the surrogate beside it. */
export function reading(manifest: Manifest, view: RecordView): Reading | null {
  const st = view.state;
  if (!st) return null;
  const occ = st.zones[0]!;
  const { width: W, depth: D } = manifest.room;
  let where: Reading['where'];
  let pick: (lux: ArrayLike<number>) => number;
  if (st.kind === 'ambient') {
    where = 'floor';
    const all = Array.from({ length: view.luxSurrogate.length }, (_, i) => i);
    pick = (lux) => median(lux, all);
  } else {
    where = 'occupant';
    const i = cellIndex(cellOf(occ.x, occ.y, W, D));
    pick = (lux) => lux[i]!;
  }
  const radiance = view.luxRadiance ? pick(view.luxRadiance) : null;
  const surrogate = pick(view.luxSurrogate);
  const v = radiance ?? surrogate;
  const status: Status =
    v > GLARE_LUX
      ? 'glare'
      : v < occ.target * BAND[0]
        ? 'too dark'
        : v > occ.target * BAND[1]
          ? 'too bright'
          : 'in band';
  return { where, radiance, surrogate, target: occ.target, status };
}
