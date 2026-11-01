import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import m1 from '../__fixtures__/m1.json';
import type { Vec3 } from '../data/manifest';
import { facingToRotY, northThree, roomToThree, sunAngles, towardSunThree } from './frame';

const close = (a: Vector3, b: Vector3) => expect(a.distanceTo(b)).toBeLessThan(1e-9);

describe('room ↔ three.js frame', () => {
  it('maps room axes to three axes (z up → y up, +y room → −z three)', () => {
    close(roomToThree(1, 0, 0), new Vector3(1, 0, 0));
    close(roomToThree(0, 1, 0), new Vector3(0, 0, -1));
    close(roomToThree(0, 0, 1), new Vector3(0, 1, 0));
  });

  it('recovers the baked altitude and room azimuth from the sun vector', () => {
    for (const c of m1.cases) {
      const { alt, azRoom } = sunAngles(c.sun_room as Vec3);
      expect(alt).toBeCloseTo(c.alt, 3);
      expect(azRoom).toBeCloseTo(c.az_room, 2);
    }
  });

  it('points the light at a sun due south of the room (room az 180) towards three +z', () => {
    const alt = 30 * (Math.PI / 180);
    // sun_room points sun → room; a sun in the room's −y direction shines towards +y
    const sunRoom: Vec3 = [0, Math.cos(alt), -Math.sin(alt)];
    expect(sunAngles(sunRoom).azRoom).toBeCloseTo(180, 9);
    const d = towardSunThree(sunRoom);
    expect(d.z).toBeGreaterThan(0);
    expect(d.y).toBeCloseTo(Math.sin(alt), 9);
  });

  it('draws north clockwise from room +y by north_angle', () => {
    close(northThree(0), new Vector3(0, 0, -1));
    close(northThree(90), new Vector3(1, 0, -Math.cos(Math.PI / 2)));
  });

  it('turns a facing angle into a rotation that maps local +x onto the facing direction', () => {
    const v = new Vector3(1, 0, 0).applyAxisAngle(new Vector3(0, 1, 0), facingToRotY(90));
    close(v, roomToThree(0, 1, 0));
  });
});
