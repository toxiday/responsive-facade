// Abstract parametric furniture (docs/decisions.md): every piece is generated from its
// surveyed bounding box and height, nothing from the Dimensions.com models ships.
// Builders work in a local frame with the front facing +x, up +y, width along z (+z is the
// right hand of someone facing front); the group is placed at the bbox centre and turned to
// the item's facing angle. Shape parameters (sofa chaise, island overhang) come from the bake.

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  type Material,
  Mesh,
  type MeshStandardMaterial,
  PlaneGeometry,
} from 'three';
import type { FurnitureItem } from '../data/manifest';
import { facingToRotY, roomToThree } from './frame';
import { PALETTE, solid } from './materials';

const MAT = {
  base: solid(PALETTE.furniture),
  fabric: solid(PALETTE.fabric, 1),
  wood: solid(PALETTE.wood, 0.8),
  dark: solid(PALETTE.dark, 0.5),
  steel: solid(PALETTE.steel, 0.4),
  added: solid(PALETTE.added),
};

function box(
  g: Group,
  mat: Material,
  dx: number,
  dy: number,
  dz: number,
  x = 0,
  y = dy / 2,
  z = 0,
): Mesh {
  const m = new Mesh(
    new BoxGeometry(Math.max(dx, 0.005), Math.max(dy, 0.005), Math.max(dz, 0.005)),
    mat,
  );
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

function cyl(g: Group, mat: Material, r: number, h: number, x = 0, y = h / 2, z = 0): Mesh {
  const m = new Mesh(new CylinderGeometry(r, r, Math.max(h, 0.005), 24), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

function legs(g: Group, mat: Material, dx: number, dz: number, h: number, inset = 0.05) {
  const t = 0.04;
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      box(g, mat, t, h, t, sx * (dx / 2 - inset), h / 2, sz * (dz / 2 - inset));
}

type Params = Record<string, number | string>;
type Builder = (
  g: Group,
  dx: number,
  dz: number,
  h: number,
  mat: MeshStandardMaterial,
  p: Params,
) => void;

const num = (p: Params, key: string, fallback: number): number => {
  const v = p[key];
  return typeof v === 'number' ? v : fallback;
};

const BUILDERS: Record<string, Builder> = {
  sectional(g, dx, dz, h, _mat, p) {
    // A sofa of standard depth along the back; an optional chaise runs forward at one end.
    const seat = 0.42;
    const depth = num(p, 'depth', dx);
    const back = num(p, 'back', 0.22);
    const arm = num(p, 'arm', 0.2);
    const side = p.chaise === 'right' ? 1 : p.chaise === 'left' ? -1 : 0;
    const x0 = -dx / 2;
    box(g, MAT.fabric, depth, seat, dz, x0 + depth / 2);
    box(g, MAT.fabric, back, h, dz, x0 + back / 2);
    if (side) {
      const cw = num(p, 'chaise_width', 0.8);
      const len = dx - depth;
      const z = side * (dz / 2 - cw / 2);
      box(g, MAT.fabric, len, seat - 0.03, cw, x0 + depth + len / 2, (seat - 0.03) / 2, z);
      // Arms: full length on the chaise's outer side, sofa depth at the other end.
      box(g, MAT.fabric, dx, 0.6, arm, 0, 0.3, side * (dz / 2 - arm / 2));
      box(g, MAT.fabric, depth, 0.6, arm, x0 + depth / 2, 0.3, -side * (dz / 2 - arm / 2));
    } else {
      for (const s of [-1, 1])
        box(g, MAT.fabric, depth, 0.6, arm, x0 + depth / 2, 0.3, s * (dz / 2 - arm / 2));
    }
  },
  armchair(g, dx, dz, h) {
    box(g, MAT.fabric, dx, 0.42, dz);
    box(g, MAT.fabric, 0.2, h, dz, -dx / 2 + 0.1);
    for (const s of [-1, 1]) box(g, MAT.fabric, dx, 0.6, 0.14, 0, 0.3, s * (dz / 2 - 0.07));
  },
  chair(g, dx, dz, h) {
    const s = Math.min(dx, dz) * 0.85;
    box(g, MAT.base, s, 0.04, s, 0, 0.45);
    box(g, MAT.base, 0.04, h - 0.45, s, -s / 2 + 0.02, 0.45 + (h - 0.45) / 2);
    legs(g, MAT.steel, s, s, 0.43, 0.03);
  },
  task_chair(g, dx, dz, h) {
    const s = Math.min(dx, dz) * 0.8;
    box(g, MAT.added, s, 0.08, s, 0, 0.47);
    box(g, MAT.added, 0.06, h - 0.5, s * 0.9, -s / 2 + 0.03, 0.5 + (h - 0.5) / 2);
    cyl(g, MAT.steel, 0.03, 0.43, 0, 0.215);
    cyl(g, MAT.steel, s * 0.45, 0.03, 0, 0.015);
  },
  stool(g, dx, dz, h) {
    // Counter stool: seat at counter-stool height with a low back up to the surveyed top.
    const r = (Math.min(dx, dz) / 2) * 0.85;
    const seatH = h > 0.75 ? 0.65 : h;
    cyl(g, MAT.wood, r, 0.04, 0, seatH - 0.02);
    const s = r * 1.5;
    legs(g, MAT.steel, s, s, seatH - 0.04, 0.02);
    for (const side of [-1, 1])
      box(g, MAT.steel, s - 0.04, 0.02, 0.02, 0, 0.25, side * (s / 2 - 0.02));
    if (h - seatH > 0.08) box(g, MAT.wood, 0.03, h - seatH, r * 1.5, -r + 0.02, (h + seatH) / 2);
  },
  coffee_table(g, dx, dz, h) {
    box(g, MAT.wood, dx, h, dz);
  },
  round_table(g, dx, dz, h) {
    const r = Math.min(dx, dz) / 2;
    cyl(g, MAT.wood, r, 0.03, 0, h - 0.015);
    cyl(g, MAT.steel, 0.03, h - 0.03, 0, (h - 0.03) / 2);
    cyl(g, MAT.steel, r * 0.6, 0.02, 0, 0.01);
  },
  dining_table(g, dx, dz, h) {
    box(g, MAT.wood, dx, 0.04, dz, 0, h - 0.02);
    legs(g, MAT.wood, dx, dz, h - 0.04, 0.08);
  },
  desk(g, dx, dz, h) {
    box(g, MAT.added, dx, 0.03, dz, 0, h - 0.015);
    legs(g, MAT.steel, dx, dz, h - 0.03, 0.04);
  },
  console(g, dx, dz, h) {
    box(g, MAT.base, dx, h, dz);
  },
  tv(g, _dx, dz, h) {
    box(g, MAT.dark, 0.04, h, dz, 0, h / 2);
  },
  island(g, dx, dz, h, _mat, p) {
    // The top overhangs the base at the front (the stool side) so the stools tuck under it.
    const over = num(p, 'overhang', 0.04);
    const base = dx - over - 0.02;
    box(g, MAT.base, base, h - 0.04, dz - 0.04, -dx / 2 + 0.02 + base / 2);
    box(g, MAT.steel, dx, 0.04, dz, 0, h - 0.02);
  },
  counter(g, dx, dz, h) {
    box(g, MAT.base, dx, h - 0.04, dz);
    box(g, MAT.steel, dx, 0.04, dz, 0, h - 0.02);
  },
  range(g, dx, dz, h) {
    box(g, MAT.steel, dx, h - 0.03, dz);
    box(g, MAT.dark, dx, 0.03, dz, 0, h - 0.015);
  },
  fridge(g, dx, dz, h) {
    box(g, MAT.steel, dx, h, dz);
  },
  cabinet(g, dx, dz, h) {
    box(g, MAT.base, dx, h, dz);
  },
  sink(g, dx, dz, h) {
    // Basin recessed in the island top; the faucet is the tall part of the survey bbox.
    box(g, MAT.dark, dx * 0.8, 0.02, dz * 0.8, 0, 0.905);
    cyl(g, MAT.steel, 0.015, h - 0.9, dx * 0.35, 0.9 + (h - 0.9) / 2);
  },
};

function rug(item: FurnitureItem): Mesh {
  const [x0, y0, x1, y1] = item.bbox;
  const m = new Mesh(new PlaneGeometry(x1 - x0, y1 - y0), solid(PALETTE.rug, 1));
  m.rotation.x = -Math.PI / 2;
  roomToThree((x0 + x1) / 2, (y0 + y1) / 2, 0.004, m.position);
  m.receiveShadow = true;
  return m;
}

export function buildItem(item: FurnitureItem): Group | Mesh {
  if (item.type === 'rug') return rug(item);
  const [x0, y0, x1, y1] = item.bbox;
  const facing = item.facing ?? 0;
  const ex = x1 - x0;
  const ey = y1 - y0;
  // Local depth (front-back) and width for the facing direction.
  const along = Math.abs(Math.cos(facing * (Math.PI / 180))) >= 0.5;
  let dx = along ? ex : ey;
  let dz = along ? ey : ex;
  const diag = Math.abs(Math.sin(2 * facing * (Math.PI / 180))) > 0.5;
  if (diag) dx = dz = Math.min(ex, ey);
  const g = new Group();
  g.name = `furniture-${item.id}`;
  g.userData.item = item;
  const build = BUILDERS[item.type] ?? BUILDERS.console!;
  const h = item.z1 - item.z0;
  build(g, dx, dz, h, MAT.base, item.params ?? {});
  roomToThree((x0 + x1) / 2, (y0 + y1) / 2, item.z0, g.position);
  g.rotation.y = facingToRotY(facing);
  return g;
}

export function buildFurniture(items: FurnitureItem[]): Group {
  const group = new Group();
  group.name = 'furniture';
  for (const item of items) group.add(buildItem(item));
  return group;
}
