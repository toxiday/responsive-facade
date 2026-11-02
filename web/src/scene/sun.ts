// Sun and sky light (guidelines §3.5). The direction is ALWAYS the baked sun vector of the slot
// being shown; it is never recomputed here. One shadow map fitted tightly to the room.
//
// Display exposure (Tony, 2026-11-01): light levels are given in lux, and a white surface at
// the ambient target, 200 lux, reads as 50% grey (sRGB 128). The sky light holds the room at
// that ambient level. The sun is display-only: warmer at low altitude, scaled by DNI, and capped
// well below real beam illuminance so sunlit colours keep their hue instead of washing to white.
//
// Night (the day's clock, app/clock.ts): a daylight level from 1 to 0 fades the sun out and the
// sky down to a dim, cool NIGHT_LUX, so the room stays just legible.

import { Color, DirectionalLight, HemisphereLight, Matrix4, Vector3 } from 'three';
import type { Room, Vec3 } from '../data/manifest';
import { roomToThree, towardSunThree } from './frame';
import { WALL_T } from './shell';

const DISTANCE = 30;
const GREY_50 = 0.214; // sRGB 0.5 in linear light
/** three.js light intensity per lux. Lambert divides by pi, so white at 200 lux is GREY_50. */
export const LUX = (GREY_50 * Math.PI) / 200;
/** Sky light: the illuminance on an upward face, held at the ambient target. */
export const AMBIENT_LUX = 200;
/** Display sun at normal incidence for DNI of 800 W/m² or more. */
export const SUN_LUX = 2000;
/** Sky light at night (display only). */
export const NIGHT_LUX = 35;
const SKY = { day: new Color(0xffffff), night: new Color('#8ea2c8') };
const GROUND = { day: new Color(0xcdc5b9), night: new Color('#4a4e5c') };

/** Display value (sRGB 0-1, before the highlight roll-off) of a matte surface under `lux`. */
export function displayValue(lux: number, albedo = 1): number {
  const linear = (albedo * lux * LUX) / Math.PI;
  return linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
}

export interface SunSlot {
  sunRoom: Vec3;
  alt: number;
  dni: number;
  dhi: number;
}

export class SunLight {
  readonly light = new DirectionalLight(0xffffff, SUN_LUX * LUX);
  // White from above (so the 200 lux calibration holds on upward faces); a warm floor bounce
  // from below, so walls and the sides of furniture sit a little darker than tops.
  readonly sky = new HemisphereLight(0xffffff, 0xcdc5b9, AMBIENT_LUX * LUX);
  private readonly centre: Vector3;
  private readonly corners: Vector3[];
  /** The slot's sun intensity, before the daylight level. */
  private sunIntensity = SUN_LUX * LUX;
  private daylight = 1;

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
      return;
    }
    this.light.visible = true;
    const dir = towardSunThree(slot.sunRoom);
    this.light.position.copy(this.centre).addScaledVector(dir, DISTANCE);
    this.light.target.position.copy(this.centre);
    this.light.target.updateMatrixWorld();

    // Display-only colour and strength from altitude and DNI (no sun patch without beam).
    const a = Math.max(0, Math.min(1, (slot.alt - 5) / 40));
    this.light.color.copy(new Color('#ffb36b')).lerp(new Color('#fff6ea'), a);
    this.sunIntensity = SUN_LUX * LUX * Math.min(1, slot.dni / 800);
    this.light.intensity = this.sunIntensity * this.daylight;
    this.fitShadow();
  }

  /** Daylight level: 1 by day, 0 at night (the sun out, the sky at NIGHT_LUX). */
  setDaylight(k: number): void {
    this.daylight = k;
    this.light.intensity = this.sunIntensity * k;
    this.sky.intensity = (NIGHT_LUX + (AMBIENT_LUX - NIGHT_LUX) * k) * LUX;
    this.sky.color.lerpColors(SKY.night, SKY.day, k);
    this.sky.groundColor.lerpColors(GROUND.night, GROUND.day, k);
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
