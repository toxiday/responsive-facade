// The room box: floor and ceiling slabs, solid walls on the closed sides (interior walls),
// corner posts. Openable walls are made of facade panels instead (facade/facadeMesh.ts).
// All slabs sit OUTSIDE the room volume so the interior is exactly W × D × H, as in Radiance.
// Each wall and corner also has a floor mark (a darker band with an outline) that the cutaway
// shows while the wall above it is hidden, so a cut wall still reads on plan.

import { BoxGeometry, Group, Mesh, MeshBasicMaterial, type Object3D, PlaneGeometry } from 'three';
import type { Room, Side } from '../data/manifest';
import { floorLoop } from './edges';
import { roomToThree } from './frame';
import { PALETTE, solid } from './materials';

export const WALL_T = 0.12;

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

const MARK_Z = 0.002;
const POCHE = new MeshBasicMaterial({ color: PALETTE.poche });

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
  material = solid(PALETTE.wall),
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

  const walls: Record<Side, Mesh[]> = { S: [], N: [], E: [], W: [] };
  const marks: Record<Side, Object3D[]> = { S: [], N: [], E: [], W: [] };
  const spec: Record<Side, [number, number, number, number]> = {
    S: [0, -t, W, 0],
    N: [0, D, W, D + t],
    E: [W, 0, W + t, D],
    W: [-t, 0, 0, D],
  };
  room.sides.forEach((side, i) => {
    const [x0, y0, x1, y1] = spec[side];
    const mark = floorMark(x0, y0, x1, y1);
    marks[side].push(mark);
    group.add(mark);
    if (room.open[i]) return; // made of facade panels
    const wall = roomBox(x0, y0, 0, x1, y1, H, solid(PALETTE.wall));
    wall.name = `wall-${side}`;
    walls[side].push(wall);
    group.add(wall);
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
