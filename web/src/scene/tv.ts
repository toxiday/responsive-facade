// The TV as a light when it is on (Tony, 2026-11-01). Three parts: the lit screen; a soft
// area light from the screen onto the room in front of it; and a halo in the plane of the set,
// so it reads as on even from behind (the default view sees the back of the TV). Display only:
// none of it is in the Radiance model, so the lux in the HUD and the bake report leave it out.
//
// The area light needs three's LTC tables (about 300 KB of source), loaded the first time a
// TV is switched on.

import {
  AdditiveBlending,
  DataTexture,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RectAreaLight,
  RGBAFormat,
  Vector3,
} from 'three';
import type { FurnitureItem } from '../data/manifest';
import { roomToThree } from './frame';
import { LUX } from './sun';

const SCREEN = 0xb4c4dc; // the picture, as one dim cool white
const LIGHT = 0xcbdcff; // the light it throws
/** Screen luminance in nits; the whole TV effect stays dimmer than the brightest sun patches. */
const SCREEN_NITS = 250;
const HALO_MARGIN = 0.45; // how far the halo reaches past the set (m)
const HALO_SIGMA = 0.24; // its falloff (m)
const HALO_STRENGTH = 0.16;
const SLAB = 0.04; // the TV builder's panel depth (furniture.ts)

/** Soft glow outside a w×h rectangle on a (w+2m)×(h+2m) card, as additive RGB. */
function haloTexture(w: number, h: number): DataTexture {
  const W = w + 2 * HALO_MARGIN;
  const H = h + 2 * HALO_MARGIN;
  const nx = 256;
  const ny = Math.round((nx * H) / W);
  const px = new Uint8Array(nx * ny * 4);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const x = Math.abs(((i + 0.5) / nx - 0.5) * W) - w / 2;
      const y = Math.abs(((j + 0.5) / ny - 0.5) * H) - h / 2;
      const out = Math.hypot(Math.max(x, 0), Math.max(y, 0));
      // Outside the set the glow falls off; none over the set itself, or the screen's edge would
      // be added to and outshine the sun patches.
      const g = out > 0 ? Math.exp(-((out / HALO_SIGMA) ** 2)) : 0;
      const v = Math.round(255 * HALO_STRENGTH * g);
      px.set([v, v, v, 255], (j * nx + i) * 4);
    }
  const tex = new DataTexture(px, nx, ny, RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

export class TvGlow {
  readonly group = new Group();
  private light: RectAreaLight | null = null;
  private readonly centre: Vector3;
  private readonly target: Vector3;
  private readonly width: number;
  private readonly height: number;

  constructor(item: FurnitureItem) {
    const [x0, y0, x1, y1] = item.bbox;
    const a = ((item.facing ?? 0) * Math.PI) / 180;
    const [dx, dy] = [Math.cos(a), Math.sin(a)];
    // Same width rule as the furniture builder: the set is wide across its facing.
    this.width = Math.abs(dx) >= Math.abs(dy) ? y1 - y0 : x1 - x0;
    this.height = item.z1 - item.z0;
    const zc = (item.z0 + item.z1) / 2;
    const front = (k: number) => roomToThree((x0 + x1) / 2 + k * dx, (y0 + y1) / 2 + k * dy, zc);
    this.centre = front(SLAB / 2 + 0.003);
    this.target = front(1);

    const bezel = 0.02;
    const screen = new Mesh(
      new PlaneGeometry(this.width - 2 * bezel, this.height - 2 * bezel),
      new MeshBasicMaterial({ color: SCREEN, toneMapped: false }),
    );
    screen.position.copy(this.centre);
    screen.lookAt(this.target);

    const halo = new Mesh(
      new PlaneGeometry(this.width + 2 * HALO_MARGIN, this.height + 2 * HALO_MARGIN),
      new MeshBasicMaterial({
        color: LIGHT,
        map: haloTexture(this.width, this.height),
        blending: AdditiveBlending,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        toneMapped: false,
      }),
    );
    halo.position.copy(front(SLAB / 2 + 0.03));
    halo.lookAt(this.target);
    halo.renderOrder = 6; // after the heatmap (5), which would otherwise paint over it

    this.group.name = 'tv-glow';
    this.group.add(screen, halo);
    this.group.visible = false;
  }

  get on(): boolean {
    return this.group.visible;
  }

  async setOn(on: boolean): Promise<void> {
    if (on && !this.light) {
      const { RectAreaLightUniformsLib } =
        await import('three/addons/lights/RectAreaLightUniformsLib.js');
      RectAreaLightUniformsLib.init();
      this.light = new RectAreaLight(LIGHT, SCREEN_NITS * LUX, this.width, this.height);
      this.light.position.copy(this.centre);
      this.light.lookAt(this.target);
      this.group.add(this.light);
    }
    this.group.visible = on;
  }
}
