// Sun and sky light (guidelines §3.5). The direction is ALWAYS the baked sun vector of the slot
// being shown; it is never recomputed here. Colour and intensity are display-only: warmer and
// weaker at low altitude, a sky term from DHI. One shadow map fitted tightly to the room.

import { Color, DirectionalLight, HemisphereLight, Matrix4, Vector3 } from 'three';
import type { Room, Vec3 } from '../data/manifest';
import { roomToThree, towardSunThree } from './frame';
import { WALL_T } from './shell';

const DISTANCE = 30;
// three's Lambert term divides by pi, so a sky light of intensity pi shows a surface at its own
// colour. Shaded tops therefore show the furniture palette nearly true (the sky tint is close
// to white); sunlit patches go brighter and the tone mapper rolls them off.
const SKY = Math.PI;

export interface SunSlot {
  sunRoom: Vec3;
  alt: number;
  dni: number;
  dhi: number;
}

export class SunLight {
  readonly light = new DirectionalLight(0xffffff, 3);
  readonly sky = new HemisphereLight(0xf8f9fb, 0xd6cec2, SKY);
  private readonly centre: Vector3;
  private readonly corners: Vector3[];

  constructor(room: Room, shadowSize: number) {
    const { width: W, depth: D, height: H } = room;
    const t = WALL_T + 0.05;
    this.centre = roomToThree(W / 2, D / 2, H / 2);
    this.corners = [];
    for (const x of [-t, W + t])
      for (const y of [-t, D + t])
        for (const z of [-t, H + t]) this.corners.push(roomToThree(x, y, z));
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(shadowSize, shadowSize);
    this.light.shadow.bias = -0.0004;
    this.light.shadow.normalBias = 0.015;
    this.light.target.position.copy(this.centre);
  }

  set(slot: SunSlot | null): void {
    if (!slot) {
      this.light.visible = false;
      this.sky.intensity = SKY + 0.3;
      return;
    }
    this.light.visible = true;
    const dir = towardSunThree(slot.sunRoom);
    this.light.position.copy(this.centre).addScaledVector(dir, DISTANCE);
    this.light.target.position.copy(this.centre);
    this.light.target.updateMatrixWorld();

    // Display-only colour/intensity from altitude and irradiance.
    const a = Math.max(0, Math.min(1, (slot.alt - 5) / 40));
    this.light.color.copy(new Color('#ffb36b')).lerp(new Color('#fff6ea'), a);
    this.light.intensity = 0.8 + 3.7 * Math.min(1, slot.dni / 800);
    this.sky.intensity = SKY + 0.4 * Math.min(1, slot.dhi / 300);
    this.fitShadow();
  }

  /** Fit the orthographic shadow camera to the room's corners as seen from the light. */
  private fitShadow(): void {
    const cam = this.light.shadow.camera;
    const view = new Matrix4().lookAt(this.light.position, this.centre, new Vector3(0, 1, 0));
    view.setPosition(this.light.position);
    const inv = view.clone().invert();
    let [minX, minY, minZ, maxX, maxY, maxZ] = [
      Infinity,
      Infinity,
      Infinity,
      -Infinity,
      -Infinity,
      -Infinity,
    ];
    for (const c of this.corners) {
      const p = c.clone().applyMatrix4(inv);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    cam.left = minX;
    cam.right = maxX;
    cam.bottom = minY;
    cam.top = maxY;
    cam.near = Math.max(0.1, -maxZ - 0.5);
    cam.far = -minZ + 0.5;
    cam.updateProjectionMatrix();
  }
}
