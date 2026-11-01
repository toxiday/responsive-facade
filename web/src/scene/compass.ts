// North arrow on the ground beside the room (guidelines §3.1). True north is clockwise from
// room +y by north_angle; the room stays put, so the arrow is fixed in the scene.

import {
  CanvasTexture,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RingGeometry,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
} from 'three';
import type { Room } from '../data/manifest';
import { northThree, roomToThree } from './frame';
import { PALETTE } from './materials';

function label(text: string): Mesh {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = `#${PALETTE.dark.getHexString()}`;
  ctx.font = 'bold 96px Helvetica, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 70);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return new Mesh(
    new PlaneGeometry(0.42, 0.42),
    new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
}

export function createCompass(room: Room): Group {
  const g = new Group();
  g.name = 'compass';
  const ink = new MeshBasicMaterial({ color: PALETTE.dark, side: DoubleSide });
  const ring = new Mesh(new RingGeometry(0.5, 0.53, 64), ink);
  const arrow = new Shape();
  arrow.moveTo(0, 0.5);
  arrow.lineTo(0.13, -0.3);
  arrow.lineTo(0, -0.18);
  arrow.lineTo(-0.13, -0.3);
  arrow.closePath();
  const needle = new Mesh(new ShapeGeometry(arrow), ink);
  const n = label('N');
  n.position.set(0, 0.78, 0);

  // Built in the xy plane pointing +y; lay it flat and turn it to true north.
  const flat = new Group();
  flat.add(ring, needle, n);
  flat.rotation.x = -Math.PI / 2;
  const north = northThree(room.north_angle);
  const spin = new Group();
  spin.add(flat);
  spin.rotation.y = Math.atan2(-north.x, -north.z);
  g.add(spin);
  roomToThree(room.width + 1.3, room.depth + 0.6, 0.0, g.position);
  return g;
}
