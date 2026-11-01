// Abstract parametric furniture (docs/decisions.md): every piece is generated from its
// surveyed bounding box and height, nothing from the Dimensions.com models ships.
// Builders work in a local frame with the front facing +x, up +y, width along z (+z is the
// right hand of someone facing front); the group is placed at the bbox centre and turned to
// the item's facing angle. Shape parameters (sofa chaise, island overhang, sink cutout) come
// from the bake; room-frame rects in them are mapped into the local frame with `localRect`.
// Casework carries its door and drawer fronts from the survey; their division lines are drawn
// on the cabinet face.

import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Mesh,
  PlaneGeometry,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { FurnitureItem } from '../data/manifest';
import { LINE_COLOR, floorLoop } from './edges';
import { facingToRotY, roomToThree } from './frame';
import { PALETTE, solid } from './materials';

const MAT = {
  base: solid(PALETTE.furniture),
  upholstery: solid(PALETTE.olive, 1),
  cinnamon: solid(PALETTE.cinnamon, 0.8),
  sulphur: solid(PALETTE.sulphur, 0.7),
  slate: solid(PALETTE.slate, 0.5),
  kick: solid(PALETTE.kick),
  dark: solid(PALETTE.dark, 0.5),
  steel: solid(PALETTE.steel, 0.4),
  added: solid(PALETTE.added),
};

function place(g: Group, m: Mesh, x: number, y: number, z: number): Mesh {
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

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
  const geo = new BoxGeometry(Math.max(dx, 0.005), Math.max(dy, 0.005), Math.max(dz, 0.005));
  return place(g, new Mesh(geo, mat), x, y, z);
}

/** Upholstery: a box with rounded edges and corners. */
function soft(
  g: Group,
  mat: Material,
  dx: number,
  dy: number,
  dz: number,
  x = 0,
  y = dy / 2,
  z = 0,
  r = 0.06,
): Mesh {
  const rr = Math.max(0.002, Math.min(r, dx / 2, dy / 2, dz / 2) - 0.002);
  return place(g, new Mesh(new RoundedBoxGeometry(dx, dy, dz, 3, rr), mat), x, y, z);
}

function cyl(g: Group, mat: Material, r: number, h: number, x = 0, y = h / 2, z = 0): Mesh {
  return place(g, new Mesh(new CylinderGeometry(r, r, Math.max(h, 0.005), 24), mat), x, y, z);
}

function legs(g: Group, mat: Material, dx: number, dz: number, h: number, inset = 0.05) {
  const t = 0.04;
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      box(g, mat, t, h, t, sx * (dx / 2 - inset), h / 2, sz * (dz / 2 - inset));
}

/** Local rect: x0, z0, x1, z1. */
type Rect = [number, number, number, number];

/** Boxes covering a local rect minus an optional hole, from height y0 to y1. */
function slab(g: Group, mat: Material, r: Rect, hole: Rect | null, y0: number, y1: number) {
  const [x0, z0, x1, z1] = r;
  const add = (a0: number, b0: number, a1: number, b1: number) => {
    if (a1 - a0 > 1e-4 && b1 - b0 > 1e-4)
      box(g, mat, a1 - a0, y1 - y0, b1 - b0, (a0 + a1) / 2, (y0 + y1) / 2, (b0 + b1) / 2);
  };
  const hx0 = hole ? Math.max(x0, hole[0]) : 0;
  const hz0 = hole ? Math.max(z0, hole[1]) : 0;
  const hx1 = hole ? Math.min(x1, hole[2]) : 0;
  const hz1 = hole ? Math.min(z1, hole[3]) : 0;
  if (!hole || hx1 <= hx0 || hz1 <= hz0) return add(x0, z0, x1, z1);
  add(x0, z0, hx0, z1);
  add(hx1, z0, x1, z1);
  add(hx0, z0, hx1, hz0);
  add(hx0, hz1, hx1, z1);
}

type Params = Record<string, unknown>;

/** Door and drawer fronts on a cabinet face (bake/room.py `_fronts`). */
interface Fronts {
  axis: 'x' | 'y';
  plane: number;
  out: number;
  cells: [number, number, number, number][];
}

interface Ctx {
  dx: number;
  dz: number;
  h: number;
  p: Params;
  /** A room-frame rect [x0, y0, x1, y1] in this item's local frame. */
  localRect(r: number[]): Rect;
}

type Builder = (g: Group, c: Ctx) => void;

/** A base cabinet's recessed plinth, from the bake; returns the height the body starts at. */
function toeKick(g: Group, c: Ctx): number {
  const plinth = rect(c.p, 'plinth');
  const ph = num(c.p, 'plinth_h', 0);
  if (!plinth || ph <= 0) return 0;
  slab(g, MAT.kick, c.localRect(plinth), null, 0, ph);
  return ph;
}

const num = (p: Params, key: string, fallback: number): number => {
  const v = p[key];
  return typeof v === 'number' ? v : fallback;
};

const rect = (p: Params, key: string): number[] | null => {
  const v = p[key];
  return Array.isArray(v) && v.length === 4 ? (v as number[]) : null;
};

/**
 * Division lines between a cabinet's fronts: each front's outline on the face, a few mm proud
 * of it. Neighbouring fronts share edges, so each division is one line. Points are room-frame;
 * `toLocal` maps them into the item's group.
 */
function frontLines(
  f: Fronts,
  toLocal: (x: number, y: number, z: number) => [number, number, number],
): LineSegments {
  const c = f.plane + f.out * 0.003;
  const pt = (a: number, z: number) => (f.axis === 'y' ? toLocal(a, c, z) : toLocal(c, a, z));
  const pos: number[] = [];
  for (const [a0, a1, z0, z1] of f.cells) {
    const corners = [pt(a0, z0), pt(a1, z0), pt(a1, z1), pt(a0, z1)];
    for (let i = 0; i < 4; i++) pos.push(...corners[i]!, ...corners[(i + 1) % 4]!);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  // A material per piece: wall-hung cabinets are hidden with their wall by material.
  return new LineSegments(geo, new LineBasicMaterial({ color: LINE_COLOR }));
}

const BUILDERS: Record<string, Builder> = {
  sectional(g, { dx, dz, h, p }) {
    // A sofa of standard depth along the back; an optional chaise runs forward at one end.
    const seat = 0.42;
    const depth = num(p, 'depth', dx);
    const back = num(p, 'back', 0.22);
    const arm = num(p, 'arm', 0.2);
    const side = p.chaise === 'right' ? 1 : p.chaise === 'left' ? -1 : 0;
    const x0 = -dx / 2;
    soft(g, MAT.upholstery, depth, seat, dz, x0 + depth / 2);
    soft(g, MAT.upholstery, back, h, dz, x0 + back / 2, h / 2, 0, 0.09);
    if (side) {
      const cw = num(p, 'chaise_width', 0.8);
      const len = dx - depth + 0.06; // overlaps the seat so the rounding leaves no gap
      const z = side * (dz / 2 - cw / 2);
      soft(g, MAT.upholstery, len, seat - 0.03, cw, dx / 2 - len / 2, (seat - 0.03) / 2, z);
    }
    // Arms at both ends, sofa depth; the chaise runs out past its arm.
    for (const s of [-1, 1])
      soft(g, MAT.upholstery, depth, 0.6, arm, x0 + depth / 2, 0.3, s * (dz / 2 - arm / 2), 0.08);
  },
  armchair(g, { dx, dz, h }) {
    soft(g, MAT.upholstery, dx, 0.42, dz);
    soft(g, MAT.upholstery, 0.2, h, dz, -dx / 2 + 0.1, h / 2, 0, 0.08);
    for (const s of [-1, 1]) soft(g, MAT.upholstery, dx, 0.6, 0.14, 0, 0.3, s * (dz / 2 - 0.07));
  },
  chair(g, { dx, dz, h }) {
    const s = Math.min(dx, dz) * 0.85;
    box(g, MAT.cinnamon, s, 0.04, s, 0, 0.45);
    box(g, MAT.cinnamon, 0.04, h - 0.45, s, -s / 2 + 0.02, 0.45 + (h - 0.45) / 2);
    legs(g, MAT.steel, s, s, 0.43, 0.03);
  },
  stool(g, { dx, dz, h }) {
    // Counter stool: seat at counter-stool height with a low back up to the surveyed top.
    const r = (Math.min(dx, dz) / 2) * 0.85;
    const seatH = h > 0.75 ? 0.65 : h;
    cyl(g, MAT.cinnamon, r, 0.04, 0, seatH - 0.02);
    const s = r * 1.5;
    legs(g, MAT.steel, s, s, seatH - 0.04, 0.02);
    for (const side of [-1, 1])
      box(g, MAT.steel, s - 0.04, 0.02, 0.02, 0, 0.25, side * (s / 2 - 0.02));
    if (h - seatH > 0.08)
      box(g, MAT.cinnamon, 0.03, h - seatH, r * 1.5, -r + 0.02, (h + seatH) / 2);
  },
  coffee_table(g, { dx, dz, h }) {
    box(g, MAT.cinnamon, dx, h, dz);
  },
  round_table(g, { dx, dz, h }) {
    const r = Math.min(dx, dz) / 2;
    cyl(g, MAT.cinnamon, r, 0.03, 0, h - 0.015);
    cyl(g, MAT.steel, 0.03, h - 0.03, 0, (h - 0.03) / 2);
    cyl(g, MAT.steel, r * 0.6, 0.02, 0, 0.01);
  },
  dining_table(g, { dx, dz, h }) {
    box(g, MAT.sulphur, dx, 0.04, dz, 0, h - 0.02);
    legs(g, MAT.sulphur, dx, dz, h - 0.04, 0.08);
  },
  desk(g, { dx, dz, h }) {
    box(g, MAT.added, dx, 0.03, dz, 0, h - 0.015);
    legs(g, MAT.steel, dx, dz, h - 0.03, 0.04);
  },
  console(g, { dx, dz, h }) {
    box(g, MAT.sulphur, dx, h, dz);
  },
  tv(g, { dz, h }) {
    box(g, MAT.slate, 0.04, h, dz, 0, h / 2);
  },
  island(g, c) {
    // The top overhangs the base at the front (the stool side) so the stools tuck under it.
    // The base stands on a recessed toe kick; the sink basin is cut through the top and the
    // top of the base.
    const { dx, dz, h, p } = c;
    const over = num(p, 'overhang', 0.04);
    const cut = rect(p, 'cutout');
    const hole = cut ? c.localRect(cut) : null;
    const t = 0.04;
    const fallback: Rect = [-dx / 2 + 0.02, -dz / 2 + 0.02, dx / 2 - over, dz / 2 - 0.02];
    const z0 = toeKick(g, c);
    const base = rect(p, 'body') ? c.localRect(rect(p, 'body')!) : fallback;
    const yHole = hole ? h - num(p, 'cutout_depth', 0.2) : h - t;
    slab(g, MAT.base, base, null, z0, yHole);
    if (hole) slab(g, MAT.base, base, hole, yHole, h - t);
    slab(g, MAT.sulphur, [-dx / 2, -dz / 2, dx / 2, dz / 2], hole, h - t, h);
  },
  counter(g, c) {
    // Base cabinet: recessed toe kick, body (carcass and fronts), and the counter top.
    const { dx, dz, h, p } = c;
    const t = 0.04;
    const z0 = toeKick(g, c);
    const body = rect(p, 'body');
    const full: Rect = [-dx / 2, -dz / 2, dx / 2, dz / 2];
    slab(g, MAT.base, body ? c.localRect(body) : full, null, z0, h - t);
    slab(g, MAT.sulphur, full, null, h - t, h);
  },
  range(g, { dx, dz, h }) {
    box(g, MAT.slate, dx, h - 0.03, dz);
    box(g, MAT.slate, dx, 0.03, dz, 0, h - 0.015);
  },
  fridge(g, { dx, dz, h }) {
    box(g, MAT.slate, dx, h, dz);
  },
  cabinet(g, { dx, dz, h }) {
    box(g, MAT.base, dx, h, dz);
  },
  door(g, { dx, dz, h }) {
    box(g, MAT.base, dx, h, dz);
  },
  sink(g, c) {
    // A steel basin lining the island's cutout, a drain, and the faucet on the far side.
    const { dx, h, p } = c;
    const b = rect(p, 'basin');
    if (!b) return;
    const [x0, z0, x1, z1] = c.localRect(b);
    const depth = num(p, 'depth', 0.2);
    const top = num(p, 'counter', 0.9);
    const yb = top - depth;
    const t = 0.006;
    const [w, l, cx, cz] = [x1 - x0, z1 - z0, (x0 + x1) / 2, (z0 + z1) / 2];
    box(g, MAT.steel, w, 0.01, l, cx, yb + 0.005, cz);
    box(g, MAT.steel, t, depth, l, x0 + t / 2, yb + depth / 2, cz);
    box(g, MAT.steel, t, depth, l, x1 - t / 2, yb + depth / 2, cz);
    box(g, MAT.steel, w, depth, t, cx, yb + depth / 2, z0 + t / 2);
    box(g, MAT.steel, w, depth, t, cx, yb + depth / 2, z1 - t / 2);
    cyl(g, MAT.dark, 0.035, 0.004, cx, yb + 0.012, cz);
    const fx = (x1 + dx / 2) / 2;
    const fh = h - top;
    cyl(g, MAT.steel, 0.016, fh, fx, top + fh / 2, cz);
    box(g, MAT.steel, 0.22, 0.025, 0.025, fx - 0.11, h - 0.0125, cz);
  },
};

function rug(item: FurnitureItem): Group {
  const [x0, y0, x1, y1] = item.bbox;
  const g = new Group();
  g.name = `furniture-${item.id}`;
  g.userData.item = item;
  const m = new Mesh(new PlaneGeometry(x1 - x0, y1 - y0), solid(PALETTE.sulphur, 1));
  m.rotation.x = -Math.PI / 2;
  roomToThree((x0 + x1) / 2, (y0 + y1) / 2, 0.004, m.position);
  m.receiveShadow = true;
  const outline = floorLoop(
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    0.006,
  );
  g.add(m, outline);
  return g;
}

export function buildItem(item: FurnitureItem): Group {
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
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const a = facing * (Math.PI / 180);
  const [c, s] = [Math.cos(a), Math.sin(a)];
  // Inverse of the placement below: room (x, y) to local (x, z).
  const local = (x: number, y: number): [number, number] => [
    (x - cx) * c + (y - cy) * s,
    (x - cx) * s - (y - cy) * c,
  ];
  const localRect = (r: number[]): Rect => {
    const [ax, az] = local(r[0]!, r[1]!);
    const [bx, bz] = local(r[2]!, r[3]!);
    return [Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz)];
  };
  const g = new Group();
  g.name = `furniture-${item.id}`;
  g.userData.item = item;
  const build = BUILDERS[item.type] ?? BUILDERS.cabinet!;
  build(g, { dx, dz, h: item.z1 - item.z0, p: item.params ?? {}, localRect });
  const fronts = item.params?.fronts as Fronts | null | undefined;
  if (fronts?.cells?.length)
    g.add(
      frontLines(fronts, (x, y, z) => {
        const [lx, lz] = local(x, y);
        return [lx, z - item.z0, lz];
      }),
    );
  // Wall-hung pieces are hidden with their wall, so they need materials of their own.
  if (item.wall)
    g.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) mesh.material = (mesh.material as Material).clone();
    });
  roomToThree(cx, cy, item.z0, g.position);
  g.rotation.y = facingToRotY(facing);
  return g;
}

export interface Furniture {
  group: Group;
  /** Wall-hung pieces per wall, for the cutaway. */
  onWall: Record<string, Group[]>;
}

export function buildFurniture(items: FurnitureItem[]): Furniture {
  const group = new Group();
  group.name = 'furniture';
  const onWall: Record<string, Group[]> = {};
  for (const item of items) {
    const g = buildItem(item);
    group.add(g);
    if (item.wall) (onWall[item.wall] ??= []).push(g);
  }
  return { group, onWall };
}
