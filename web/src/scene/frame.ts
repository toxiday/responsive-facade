// Room frame ↔ three.js frame. The room is z-up (x = from the W wall, y = from the S wall);
// three.js is y-up. roomToThree(x, y, z) = (x, z, -y) is a proper rotation (−90° about x).
// The room never rotates; north_angle only rotates the sun, which the bake has already
// applied to every stored sun vector.

import { Vector3 } from 'three';
import type { Vec3 } from '../data/manifest';

const DEG = Math.PI / 180;

export function roomToThree(x: number, y: number, z: number, out = new Vector3()): Vector3 {
  return out.set(x, z, -y);
}

/** Unit vector from the room towards the sun, in three.js coordinates. sunRoom points sun → room. */
export function towardSunThree(sunRoom: Vec3, out = new Vector3()): Vector3 {
  return out.set(-sunRoom[0], -sunRoom[2], sunRoom[1]).normalize();
}

/** Altitude and room-frame azimuth (deg, clockwise from room +y), inverting v3's cond_to_sun. */
export function sunAngles(sunRoom: Vec3): { alt: number; azRoom: number } {
  const [sx, sy, sz] = sunRoom;
  const alt = Math.asin(Math.max(-1, Math.min(1, -sz))) / DEG;
  const az = Math.atan2(-sx, -sy) / DEG;
  return { alt, azRoom: (az + 360) % 360 };
}

/** True north in three.js coordinates. north_angle: clockwise from room +y to true north. */
export function northThree(northAngle: number, out = new Vector3()): Vector3 {
  return out.set(Math.sin(northAngle * DEG), 0, -Math.cos(northAngle * DEG));
}

/** three.js rotation about +y for a room-frame facing angle (deg CCW from room +x). */
export function facingToRotY(facingDeg: number): number {
  return facingDeg * DEG;
}
