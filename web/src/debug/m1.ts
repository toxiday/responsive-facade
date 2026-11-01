// M1 shadow check (guidelines §5): the rendered sun patch must coincide with the Radiance
// high-lux region. Uses the fixture from `python -m bake m1`.
//   ?debug=m1&case=A|B&layer=radiance|surrogate|shadow&view=top|axo
// The magenta outline is the Radiance mask. `layer=shadow` shows the three.js shadow on a
// white plane at the 0.6 m sensor height. The page also measures it: an offscreen top-down
// render of that plane is sampled at the 1024 sensor points, and IoU against the Radiance mask
// is published on window.__rf.m1.

import {
  Mesh,
  MeshLambertMaterial,
  OrthographicCamera,
  PlaneGeometry,
  WebGLRenderTarget,
} from 'three';
import type { Manifest, Vec3 } from '../data/manifest';
import { GRID_N } from '../data/grid';
import { iou } from '../facade/sunlight';
import { roomToThree } from '../scene/frame';
import { Stage } from '../scene/stage';
import { maskOutline } from './overlays';

const MEASURE_LAYER = 1;

export interface M1Result {
  case: string;
  iou_render: number;
  lit_render: number;
  lit_radiance: number;
  mask_render: number[];
}

export async function runM1(manifest: Manifest, host: HTMLElement, params: URLSearchParams) {
  const fixture = (await import('../__fixtures__/m1.json')).default;
  const c = fixture.cases.find((k) => k.id === (params.get('case') ?? 'A')) ?? fixture.cases[0]!;
  const layer = params.get('layer') ?? 'shadow';
  const stage = new Stage(manifest, host);
  const { room } = manifest;
  const z = fixture.sensor_z;

  stage.furniture.visible = false; // the Radiance model is an empty room
  stage.facade.setBits(c.facade);
  stage.setSun({ sunRoom: c.sun_room as Vec3, alt: c.alt, dni: c.dni, dhi: c.dhi });
  if (layer === 'radiance' || layer === 'surrogate') {
    stage.heatmap.set(layer === 'radiance' ? c.lux_radiance : c.lux_surrogate);
    stage.heatmap.mesh.visible = true;
  }
  const outline = maskOutline(room, c.mask_radiance, z + 0.004);
  stage.scene.add(outline);

  const receiver = new Mesh(
    new PlaneGeometry(room.width, room.depth),
    new MeshLambertMaterial({ color: 0xffffff }),
  );
  receiver.rotation.x = -Math.PI / 2;
  roomToThree(room.width / 2, room.depth / 2, z, receiver.position);
  receiver.receiveShadow = true;
  receiver.layers.set(MEASURE_LAYER);
  if (layer === 'shadow') receiver.layers.enable(0);
  stage.scene.add(receiver);
  stage.sun.light.layers.enable(MEASURE_LAYER);
  stage.sun.sky.layers.enable(MEASURE_LAYER);
  if (params.get('view') === 'top') stage.rig.setView('top');

  const result = await new Promise<M1Result>((resolve) => {
    stage.onFrame = () => {
      if (stage.frameCount < 3) return stage.invalidate();
      stage.onFrame = null;
      resolve(measure(stage, c.id, c.mask_radiance, z, [outline]));
    };
    stage.invalidate();
  });
  return { stage, result, fixtureCase: c };
}

function measure(
  stage: Stage,
  id: string,
  radMask: number[],
  z: number,
  hide: { visible: boolean }[],
): M1Result {
  const { room } = stage.manifest;
  const w = 256;
  const h = Math.round((w * room.depth) / room.width);
  const cam = new OrthographicCamera(
    -room.width / 2,
    room.width / 2,
    room.depth / 2,
    -room.depth / 2,
    0.1,
    20,
  );
  // Look straight down with room north (three −z) at the top of the image.
  roomToThree(room.width / 2, room.depth / 2, z + 5, cam.position);
  cam.up.set(0, 0, -1);
  cam.lookAt(roomToThree(room.width / 2, room.depth / 2, z));
  cam.layers.enable(MEASURE_LAYER); // layer 0 too: shadow casters must be visible to it
  cam.updateProjectionMatrix();

  const saved = [stage.heatmap.mesh.visible, ...hide.map((o) => o.visible)];
  stage.heatmap.mesh.visible = false;
  for (const o of hide) o.visible = false;
  const rt = new WebGLRenderTarget(w, h);
  const r = stage.renderer;
  r.setRenderTarget(rt);
  r.render(stage.scene, cam);
  const px = new Uint8Array(w * h * 4);
  r.readRenderTargetPixels(rt, 0, 0, w, h, px);
  r.setRenderTarget(null);
  rt.dispose();
  stage.heatmap.mesh.visible = saved[0]!;
  hide.forEach((o, i) => (o.visible = saved[i + 1]!));
  stage.invalidate();

  const lum: number[] = [];
  for (let row = 0; row < GRID_N; row++)
    for (let col = 0; col < GRID_N; col++) {
      const x = Math.floor(((col + 0.5) / GRID_N) * w);
      const yTop = Math.floor(((row + 0.5) / GRID_N) * h);
      const i = ((h - 1 - yTop) * w + x) * 4;
      lum.push(0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!);
    }
  const lo = Math.min(...lum);
  const hi = Math.max(...lum);
  const thr = (lo + hi) / 2;
  const mask: number[] = lum.map((v) => (hi - lo > 20 && v > thr ? 1 : 0));
  return {
    case: id,
    iou_render: iou(mask, radMask),
    lit_render: mask.reduce((s, v) => s + v, 0),
    lit_radiance: radMask.reduce((s, v) => s + v, 0),
    mask_render: mask,
  };
}
