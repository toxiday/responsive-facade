// ?debug=bake — one baked record in the scene, for reviewing the bake ahead of M3.
//   ?debug=bake&city=houston&month=12&state=couch_relax&slot=12:30&layer=radiance|surrogate|none
// The facade, the sun and the heatmap all come from the packed month file. The magenta
// outline is the state's zone cells (the owner grid the optimizer scored), the dot the
// occupant. `state=baseline` is the conventional L05 facade at the same hour.
// The room is lit by the record's Radiance lux without its direct sun (scene/indirect.ts).

import { CircleGeometry, Mesh, MeshBasicMaterial } from 'three';
import type { Manifest, OccupantState } from '../data/manifest';
import { ownerGrid } from '../data/manifest';
import { loadMonth } from '../data/month';
import { litMask } from '../facade/sunlight';
import { indirectLux } from '../scene/indirect';
import type { RecordMetrics, SlotMeta } from '../data/month';
import { roomToThree } from '../scene/frame';
import { Stage } from '../scene/stage';
import { maskOutline } from './overlays';

export interface BakeView {
  stage: Stage;
  stateId: string;
  state: OccupantState | undefined;
  slot: SlotMeta;
  slots: SlotMeta[];
  day: number;
  layer: string;
  fill: 'radiance' | 'surrogate';
  ship: string;
  flips: number | null;
  metrics: RecordMetrics;
}

export async function runBake(
  manifest: Manifest,
  host: HTMLElement,
  params: URLSearchParams,
): Promise<BakeView> {
  const city = params.get('city') ?? manifest.cities[0]!.id;
  const month = Number(params.get('month') ?? 12);
  const data = await loadMonth(city, month);
  const stateId = params.get('state') ?? 'couch_relax';
  const k = data.meta.states.indexOf(stateId);
  if (k < 0) throw new Error(`no baked state ${stateId}`);
  const s = Math.max(
    0,
    data.meta.slots.findIndex((x) => x.label === (params.get('slot') ?? '12:30')),
  );
  const slot = data.meta.slots[s]!;
  const layer = params.get('layer') ?? 'radiance';
  const { room } = manifest;

  const stage = new Stage(manifest, host);
  const bits = data.facade(s, k);
  stage.facade.setBits(bits);
  stage.setSun({ sunRoom: slot.sun_room, alt: slot.alt, dni: slot.dni, dhi: slot.dhi });
  const rad = data.lux(s, k, 'radiance');
  // No beam to remove when DNI is negligible (the display sun is off then too).
  const lit =
    slot.dni >= 20
      ? litMask(bits, slot.sun_room, room.width, room.depth, room.height, room.sensor_height)
      : null;
  stage.fill.set(indirectLux(rad ?? data.lux(s, k, 'surrogate')!, lit));
  const fill: BakeView['fill'] = rad ? 'radiance' : 'surrogate';
  if (layer === 'radiance' || layer === 'surrogate') {
    const lux = data.lux(s, k, layer);
    if (lux) {
      stage.heatmap.set(lux);
      stage.heatmap.mesh.visible = true;
    }
  }

  const state = manifest.states.find((x) => x.id === stateId);
  if (state && state.kind !== 'ambient') {
    const mask = Array.from(ownerGrid(state.owner), (v) => (v >= 0 ? 1 : 0));
    stage.scene.add(maskOutline(room, mask, room.sensor_height + 0.004));
    const z = state.zones[0]!;
    const dot = new Mesh(
      new CircleGeometry(0.09, 24),
      new MeshBasicMaterial({ color: 0xec008c, depthTest: false, transparent: true }),
    );
    dot.rotation.x = -Math.PI / 2;
    dot.renderOrder = 11;
    roomToThree(z.x, z.y, room.sensor_height + 0.006, dot.position);
    stage.scene.add(dot);
  }
  stage.invalidate();

  const rec = data.meta.records[stateId]!;
  return {
    stage,
    stateId,
    state,
    slot,
    slots: data.meta.slots,
    day: data.meta.day,
    layer,
    fill,
    ship: rec.ship[s]!,
    flips: rec.flips[s] ?? null,
    metrics: rec.metrics[s]!,
  };
}
