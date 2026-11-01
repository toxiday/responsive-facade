// ?debug=bake — one baked record in the scene, for reviewing the bake.
//   ?debug=bake&city=houston&month=12&state=couch_relax&slot=12:30&layer=radiance|surrogate|none
// The same record display as the app (app/record.ts), with a HUD of the raw solve outcome.

import type { Manifest } from '../data/manifest';
import { loadMonth, type SlotMeta } from '../data/month';
import { showRecord, type Layer, type RecordView } from '../app/record';
import { Stage } from '../scene/stage';

export interface BakeView extends RecordView {
  stage: Stage;
  slots: SlotMeta[];
  day: number;
  layer: Layer;
}

export async function runBake(
  manifest: Manifest,
  host: HTMLElement,
  params: URLSearchParams,
): Promise<BakeView> {
  const city = params.get('city') ?? manifest.cities[0]!.id;
  const data = await loadMonth(city, Number(params.get('month') ?? 12));
  const s = Math.max(
    0,
    data.meta.slots.findIndex((x) => x.label === (params.get('slot') ?? '12:30')),
  );
  const layer = (params.get('layer') ?? 'radiance') as Layer;
  const stage = new Stage(manifest, host);
  const view = showRecord(
    stage,
    manifest,
    data,
    s,
    params.get('state') ?? 'couch_relax',
    layer,
    false,
  );
  if (view.tvOn) await stage.tv?.setOn(true); // the area light loads on first use
  return { ...view, stage, slots: data.meta.slots, day: data.meta.day, layer };
}
