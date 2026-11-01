// ?debug=spots — every place the occupant can be, for review: seats and the standing spots at
// the kitchen counters (magenta, with a tick for the facing), the standing lattice on the open
// floor (blue), and the activity zones (1 m circles). All of it comes from the manifest;
// nothing is computed here.

import {
  BufferGeometry,
  CircleGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
} from 'three';
import type { Manifest } from '../data/manifest';
import { roomToThree } from '../scene/frame';
import { Stage } from '../scene/stage';

const SEAT = new Color('#ec008c');
const STAND = new Color('#2b6cb0');
const MARK_Z = 1.05; // above seats and tables, below the wall cabinets

function overlay<T extends Mesh | LineSegments | LineLoop>(obj: T): T {
  const mat = obj.material as MeshBasicMaterial | LineBasicMaterial;
  mat.depthTest = false;
  mat.transparent = true;
  obj.renderOrder = 10;
  return obj;
}

function dot(x: number, y: number, z: number, r: number, color: Color): Mesh {
  const m = overlay(new Mesh(new CircleGeometry(r, 20), new MeshBasicMaterial({ color })));
  m.rotation.x = -Math.PI / 2;
  roomToThree(x, y, z, m.position);
  return m;
}

function circle(x: number, y: number, z: number, r: number, color: Color, opacity: number) {
  const pts: number[] = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    pts.push(x + r * Math.cos(a), z, -(y + r * Math.sin(a)));
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pts, 3));
  return overlay(new LineLoop(geo, new LineBasicMaterial({ color, opacity })));
}

export function runSpots(manifest: Manifest, host: HTMLElement): Stage {
  const stage = new Stage(manifest, host);
  stage.setSun(null);
  const g = new Group();
  g.name = 'spots';

  const ticks: number[] = [];
  for (const item of manifest.furniture)
    for (const { x, y, facing } of item.seats) {
      g.add(dot(x, y, MARK_Z, 0.07, SEAT));
      const a = (facing * Math.PI) / 180;
      ticks.push(x, MARK_Z, -y, x + 0.25 * Math.cos(a), MARK_Z, -(y + 0.25 * Math.sin(a)));
    }
  const tickGeo = new BufferGeometry();
  tickGeo.setAttribute('position', new Float32BufferAttribute(ticks, 3));
  g.add(overlay(new LineSegments(tickGeo, new LineBasicMaterial({ color: SEAT }))));

  for (const st of manifest.states) {
    if (st.kind === 'standing') {
      const z = st.zones[0]!;
      g.add(dot(z.x, z.y, 0.02, 0.05, STAND));
    } else if (st.kind === 'activity') {
      for (const z of st.zones) g.add(circle(z.x, z.y, 0.02, z.radius, SEAT, 0.45));
    }
  }
  stage.scene.add(g);
  stage.invalidate();
  return stage;
}
