// Sun and sky light (guidelines §3.5). The direction always comes from the bake's sun vectors,
// never from a solar model here: at each baked hour it is exactly that hour's vector. While time
// runs, the display sun glides on between them (glidingSun; Tony, 2026-11-02), so the sun
// patches drift through the hour instead of jumping at the next; the numbers, the heatmap and
// the fill stay the baked hour's. One shadow map fitted tightly to the room.
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
import { roomToThree, sunAngles, towardSunThree } from './frame';
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
/** The display sun fades out over its last this many degrees above the horizon. */
export const HORIZON_DEG = 5;
const SUN_LOW = new Color('#ffb36b');
const SUN_HIGH = new Color('#fff6ea');
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

/** A baked hour's sun, as the month files store it. */
export interface BakedSun {
  sun_room: Vec3;
  alt: number;
  dni: number;
  dhi: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Along the great circle from unit vector `a` (t = 0) to `b` (t = 1), and on past it. */
function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const om = Math.acos(dot);
  if (om < 1e-9) return [...a];
  const wa = Math.sin((1 - t) * om) / Math.sin(om);
  const wb = Math.sin(t * om) / Math.sin(om);
  const v: Vec3 = [wa * a[0] + wb * b[0], wa * a[1] + wb * b[1], wa * a[2] + wb * b[2]];
  const len = Math.hypot(...v);
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * The display sun `at` hours into the baked day (hour k at `at` = k): exactly hour k's baked sun
 * there, then along the arc towards hour k + 1's, with DNI and DHI between the two. Through the
 * last hour it carries on along the arc from the hour before, setting, at the last hour's DNI
 * (SunLight fades it out at the horizon).
 */
export function glidingSun(slots: readonly BakedSun[], at: number): SunSlot {
  const n = slots.length;
  const k = Math.max(0, Math.min(Math.floor(at), n - 1));
  const u = at - k;
  const s = slots[k]!;
  if (u <= 0 || n < 2) return { sunRoom: s.sun_room, alt: s.alt, dni: s.dni, dhi: s.dhi };
  const [i, j, f] = k < n - 1 ? [k, k + 1, u] : [k - 1, k, 1 + u];
  const a = slots[i]!;
  const b = slots[j]!;
  const sunRoom = slerp(a.sun_room, b.sun_room, f);
  const g = Math.min(f, 1);
  return {
    sunRoom,
    alt: sunAngles(sunRoom).alt,
    dni: lerp(a.dni, b.dni, g),
    dhi: lerp(a.dhi, b.dhi, g),
  };
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

    // Display-only colour and strength from altitude and DNI (no sun patch without beam), fading
    // out at the horizon (baked hours are all above 5°; the gliding sun sets after the last).
    const a = Math.max(0, Math.min(1, (slot.alt - 5) / 40));
    this.light.color.lerpColors(SUN_LOW, SUN_HIGH, a);
    const horizon = Math.max(0, Math.min(1, slot.alt / HORIZON_DEG));
    this.sunIntensity = SUN_LUX * LUX * Math.min(1, slot.dni / 800) * horizon;
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
