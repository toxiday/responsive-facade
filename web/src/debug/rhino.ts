// The real 501.6 optimised facade with the Rhino model's merged glazing outlined in magenta
// (guidelines §5: orientation must match Rhino). ?debug=rhino

import type { Manifest, Side } from '../data/manifest';
import { Stage } from '../scene/stage';
import { wallRects } from './overlays';

export async function runRhino(manifest: Manifest, host: HTMLElement): Promise<Stage> {
  const fx = (await import('../__fixtures__/conventions.json')).default.rhino_501_6;
  const stage = new Stage(manifest, host);
  stage.facade.setBits(fx.facade);
  stage.scene.add(
    wallRects(
      manifest.room,
      fx.glazing.map((g) => ({ wall: g.wall as Side, a: g.a, z: g.z })),
    ),
  );
  stage.setSun(null);
  return stage;
}
