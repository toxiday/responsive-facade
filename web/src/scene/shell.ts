// The room box: floor and ceiling slabs, solid walls on the closed sides (interior walls),
// corner posts. Openable walls are made of facade panels instead (facade/facadeMesh.ts).
// All slabs sit OUTSIDE the room volume so the interior is exactly W × D × H, as in Radiance.
// Closed walls are cut around their openings (the entry door and the hall opening, from the
// floor 5 plan), with a header over each; the model stops at the room's footprint, so each
// opening shows a dark card at the wall's outer face. Each wall and corner also has a floor
// mark (a darker band with an outline, broken at openings, plus the door swing) that the
// cutaway shows while the wall above it is hidden, so a cut wall still reads on plan.

import {
  BoxGeometry,
  Group,
  type Material,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
} from 'three';
import type { Opening, Room, Side } from '../data/manifest';
import { floorLine, floorLoop } from './edges';
import { roomToThree } from './frame';
import { PALETTE, solid } from './materials';

/** Wall thickness, as drawn in the unit plans (interior walls and the facade). */
export const WALL_T = 0.15;

export interface Shell {
  group: Group;
  walls: Record<Side, Mesh[]>;
  ceiling: Mesh;
  floor: Mesh;
  corners: { mesh: Mesh; sides: [Side, Side] }[];
  /** Floor marks under each wall, and under each corner post with its two walls. */
  marks: Record<Side, Object3D[]>;
  cornerMarks: { obj: Object3D; sides: [Side, Side] }[];
}

export interface WallPiece {
  a0: number;
  a1: number;
  z0: number;
  z1: number;
}

/**
 * A wall of `length` × `height` cut around openings (along-wall a0..a1, from the floor up to
 * z1): full-height pieces between them and a header over each.
 */
export function wallPieces(
  length: number,
  height: number,
  openings: Pick<Opening, 'a0' | 'a1' | 'z1'>[],
): WallPiece[] {
  const out: WallPiece[] = [];
  let a = 0;
  for (const o of [...openings].sort((p, q) => p.a0 - q.a0)) {
    if (o.a0 > a) out.push({ a0: a, a1: o.a0, z0: 0, z1: height });
    if (o.z1 < height) out.push({ a0: o.a0, a1: o.a1, z0: o.z1, z1: height });
    a = Math.max(a, o.a1);
  }
  if (a < length) out.push({ a0: a, a1: length, z0: 0, z1: height });
  return out;
}

const MARK_Z = 0.002;
const POCHE = new MeshBasicMaterial({ color: PALETTE.poche });
/** Unlit dark card in an opening. A material per card: the cutaway hides by material. */
const voidMaterial = () => new MeshBasicMaterial({ color: PALETTE.void });
const PLUG = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
const PLUG_T = 0.03;

/** A darker floor band over a room-frame rect, outlined. */
function floorMark(x0: number, y0: number, x1: number, y1: number): Group {
  const g = new Group();
  // Unlit: a plan fill, the same tone in sun or shade.
  const band = new Mesh(new PlaneGeometry(x1 - x0, y1 - y0), POCHE);
  band.rotation.x = -Math.PI / 2;
  roomToThree((x0 + x1) / 2, (y0 + y1) / 2, MARK_Z, band.position);
  band.receiveShadow = true;
  const outline = floorLoop(
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    MARK_Z + 0.002,
  );
  g.add(band, outline);
  g.visible = false;
  return g;
}

/** Box from room-frame min/max corners (x0,y0,z0)-(x1,y1,z1). */
export function roomBox(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  material: Material = solid(PALETTE.wall),
): Mesh {
  const mesh = new Mesh(new BoxGeometry(x1 - x0, z1 - z0, y1 - y0), material);
  roomToThree((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, mesh.position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function createShell(room: Room): Shell {
  const { width: W, depth: D, height: H } = room;
  const t = WALL_T;
  const group = new Group();
  group.name = 'shell';

  const floor = roomBox(-t, -t, -t, W + t, D + t, 0, solid(PALETTE.floor));
  const ceiling = roomBox(-t, -t, H, W + t, D + t, H + t, solid(PALETTE.ceiling));
  group.add(floor, ceiling);

  // Room-frame point for a wall: `a` along it, `c` outward from its plane (negative inside).
  const at = (side: Side, a: number, c: number): [number, number] =>
    side === 'S' ? [a, -c] : side === 'N' ? [a, D + c] : side === 'E' ? [W + c, a] : [-c, a];
  const rect = (side: Side, a0: number, a1: number, c0: number, c1: number) => {
    const [px, py] = at(side, a0, c0);
    const [qx, qy] = at(side, a1, c1);
    return [Math.min(px, qx), Math.min(py, qy), Math.max(px, qx), Math.max(py, qy)] as const;
  };

  const walls: Record<Side, Mesh[]> = { S: [], N: [], E: [], W: [] };
  const marks: Record<Side, Object3D[]> = { S: [], N: [], E: [], W: [] };
  room.sides.forEach((side, i) => {
    const length = side === 'S' || side === 'N' ? W : D;
    // Openings are cut in interior walls only (debug views may draw every wall as facade).
    const openings = room.open[i] ? [] : room.openings.filter((o) => o.wall === side);
    const pieces = room.open[i]
      ? [{ a0: 0, a1: length, z0: 0, z1: H }]
      : wallPieces(length, H, openings);
    for (const p of pieces) {
      const [x0, y0, x1, y1] = rect(side, p.a0, p.a1, 0, t);
      if (p.z0 === 0) {
        const mark = floorMark(x0, y0, x1, y1);
        marks[side].push(mark);
        group.add(mark);
      }
      if (room.open[i]) continue; // made of facade panels
      const wall = roomBox(x0, y0, p.z0, x1, y1, p.z1, solid(PALETTE.wall));
      wall.name = `wall-${side}`;
      walls[side].push(wall);
      group.add(wall);
    }
    for (const o of openings) {
      // Radiance models this wall closed, so no sun may come through: an invisible plug in
      // the opening casts the shadow the wall would. Kept out of `walls`, so the cutaway never
      // touches it.
      const [px0, py0, px1, py1] = rect(side, o.a0, o.a1, 0, PLUG_T);
      const plug = roomBox(px0, py0, 0, px1, py1, o.z1, PLUG);
      plug.receiveShadow = false;
      group.add(plug);
      // A dark card at the wall's outer face, facing the room: the opening reads as leading
      // into the unlit hall or corridor without modelling past the footprint. One-sided, so it
      // is never seen from outside. Hidden with its wall.
      const card = new Mesh(new PlaneGeometry(o.a1 - o.a0, o.z1), voidMaterial());
      roomToThree(...at(side, (o.a0 + o.a1) / 2, t), o.z1 / 2, card.position);
      const [rx, ry] = at(side, (o.a0 + o.a1) / 2, -1);
      card.lookAt(roomToThree(rx, ry, o.z1 / 2));
      walls[side].push(card);
      group.add(card);
      if (o.kind !== 'door' || o.hinge === null) continue;
      // Door swing, plan style: leaf open into the room, arc back to the far jamb.
      const r = o.a1 - o.a0;
      const toJamb = o.hinge === o.a1 ? -1 : 1;
      const pts: [number, number][] = [at(side, o.hinge, 0), at(side, o.hinge, -r)];
      for (let k = 0; k <= 24; k++) {
        const th = (Math.PI / 2) * (1 - k / 24);
        pts.push(at(side, o.hinge + toJamb * r * Math.cos(th), -r * Math.sin(th)));
      }
      const swing = floorLine(pts, MARK_Z + 0.004);
      swing.visible = false;
      marks[side].push(swing);
      group.add(swing);
    }
  });

  const corners: Shell['corners'] = [];
  const cornerMarks: Shell['cornerMarks'] = [];
  const cornerSpec: [number, number, Side, Side][] = [
    [-t, -t, 'S', 'W'],
    [W, -t, 'S', 'E'],
    [W, D, 'N', 'E'],
    [-t, D, 'N', 'W'],
  ];
  for (const [x, y, a, b] of cornerSpec) {
    const mesh = roomBox(x, y, 0, x + t, y + t, H, solid(PALETTE.wall));
    corners.push({ mesh, sides: [a, b] });
    const mark = floorMark(x, y, x + t, y + t);
    cornerMarks.push({ obj: mark, sides: [a, b] });
    group.add(mesh, mark);
  }
  return { group, walls, ceiling, floor, corners, marks, cornerMarks };
}
