// The facade, generated from the grid definition (guidelines §3.4), not from Rhino, so the
// geometry is exactly the solver's. Per openable wall: one InstancedMesh of opaque wall panels
// (they cast shadows) and one of glass panels (they do not: in Radiance the glass transmits
// direct sun, a binary shadow map can only pass it or block it). Panels are full size so no
// light leaks between them; a line grid draws the panel joints. Hidden instances are scaled
// to zero.

import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import type { Room, Side } from '../data/manifest';
import { roomToThree } from '../scene/frame';
import { PALETTE } from '../scene/materials';
import {
  COLS,
  OUTWARD,
  PANELS_PER_WALL,
  ROWS,
  SIDES,
  bitIndex,
  panelBox,
  wallSpan,
} from './geometry';

export const PANEL_T = 0.03;
const OVERLAP = 0.001;

interface WallMeshes {
  side: Side;
  group: Group;
  solid: InstancedMesh;
  glass: InstancedMesh;
  centres: Vector3[];
  sizes: Vector3[];
}

const ZERO = new Matrix4().makeScale(0, 0, 0);

export class FacadeMesh {
  readonly group = new Group();
  readonly walls = new Map<Side, WallMeshes>();
  private bits: Uint8Array = new Uint8Array(4 * PANELS_PER_WALL);

  constructor(
    private readonly room: Room,
    sides: Side[] = room.sides.filter((_, i) => room.open[i]),
  ) {
    this.group.name = 'facade';
    for (const side of sides) this.walls.set(side, this.buildWall(side));
    // Start closed; until set, every instance would sit at the identity matrix (a 1 m box at
    // the origin).
    this.setBits(this.bits);
  }

  private buildWall(side: Side): WallMeshes {
    const { width: W, depth: D, height: H } = this.room;
    const box = new BoxGeometry(1, 1, 1);
    const solid = new InstancedMesh(
      box,
      new MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }),
      PANELS_PER_WALL,
    );
    solid.castShadow = true;
    solid.receiveShadow = true;
    solid.instanceMatrix.setUsage(DynamicDrawUsage);
    const glass = new InstancedMesh(
      box,
      new MeshStandardMaterial({
        color: PALETTE.glass,
        roughness: 0.1,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      }),
      PANELS_PER_WALL,
    );
    glass.castShadow = false;
    glass.receiveShadow = false;
    glass.instanceMatrix.setUsage(DynamicDrawUsage);
    glass.renderOrder = 2;

    const out = OUTWARD[side];
    const outward = roomToThree(out[0], out[1], out[2]);
    const centres: Vector3[] = [];
    const sizes: Vector3[] = [];
    for (let row = 0; row < ROWS; row++)
      for (let col = 0; col < COLS; col++) {
        const b = panelBox(side, row, col, W, D, H);
        const c = roomToThree(
          (b.p0[0] + b.p1[0]) / 2,
          (b.p0[1] + b.p1[1]) / 2,
          (b.p0[2] + b.p1[2]) / 2,
        ).addScaledVector(outward, PANEL_T / 2);
        // Panels overlap by OVERLAP so no hairline cracks open between instances (the
        // linework pass would outline them); 1 mm is far below a floor cell.
        const along =
          (side === 'S' || side === 'N' ? b.p1[0] - b.p0[0] : b.p1[1] - b.p0[1]) + OVERLAP;
        const h = b.p1[2] - b.p0[2] + OVERLAP;
        // three axes: S/N walls run along x; E/W walls run along z (room y)
        sizes.push(
          side === 'S' || side === 'N'
            ? new Vector3(along, h, PANEL_T)
            : new Vector3(PANEL_T, h, along),
        );
        centres.push(c);
      }
    for (let i = 0; i < PANELS_PER_WALL; i++) solid.setColorAt(i, PALETTE.panel);

    const group = new Group();
    group.name = `facade-${side}`;
    group.add(solid, glass, this.jointLines(side, outward));
    this.group.add(group);
    return { side, group, solid, glass, centres, sizes };
  }

  /** Panel joints on both faces of the wall (display only, no shadow). */
  private jointLines(side: Side, outward: Vector3): LineSegments {
    const { width: W, depth: D, height: H } = this.room;
    const span = wallSpan(side, W, D);
    const pts: number[] = [];
    const push = (a: number, z: number, off: number) => {
      const x = side === 'S' || side === 'N' ? a : side === 'E' ? W : 0;
      const y = side === 'S' ? 0 : side === 'N' ? D : a;
      const p = roomToThree(x, y, z).addScaledVector(outward, off);
      pts.push(p.x, p.y, p.z);
    };
    for (const off of [-0.002, PANEL_T + 0.002]) {
      for (let c = 0; c <= COLS; c++) {
        push((c * span) / COLS, 0, off);
        push((c * span) / COLS, H, off);
      }
      for (let r = 0; r <= ROWS; r++) {
        push(0, (r * H) / ROWS, off);
        push(span, (r * H) / ROWS, off);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pts, 3));
    const lines = new LineSegments(
      geo,
      new LineBasicMaterial({ color: PALETTE.mullion, transparent: true, opacity: 0.35 }),
    );
    lines.castShadow = false;
    return lines;
  }

  /** Show a design: 2048 values, wall-major S,N,E,W, row 0 = ceiling, 1 = window. */
  setBits(bits: ArrayLike<number>): void {
    this.bits = Uint8Array.from(bits, (v) => (v ? 1 : 0));
    const m = new Matrix4();
    const q = new Quaternion();
    for (const [side, w] of this.walls) {
      for (let i = 0; i < PANELS_PER_WALL; i++) {
        const row = Math.floor(i / COLS);
        const col = i % COLS;
        const isWindow = this.bits[bitIndex(side, row, col)] === 1;
        m.compose(w.centres[i]!, q, w.sizes[i]!);
        w.solid.setMatrixAt(i, isWindow ? ZERO : m);
        w.glass.setMatrixAt(i, isWindow ? m : ZERO);
      }
      w.solid.instanceMatrix.needsUpdate = true;
      w.glass.instanceMatrix.needsUpdate = true;
      w.solid.computeBoundingSphere();
      w.glass.computeBoundingSphere();
    }
  }

  getBits(): Uint8Array {
    return this.bits;
  }

  /** Tint one wall panel (debug views). */
  tint(side: Side, row: number, col: number, color: Color): void {
    const w = this.walls.get(side);
    if (!w) return;
    w.solid.setColorAt(row * COLS + col, color);
    if (w.solid.instanceColor) w.solid.instanceColor.needsUpdate = true;
  }

  /** Per-side objects for the cutaway. */
  parts(): Record<Side, Object3D[]> {
    const out: Record<Side, Object3D[]> = { S: [], N: [], E: [], W: [] };
    for (const side of SIDES) {
      const w = this.walls.get(side);
      if (w) out[side].push(w.group);
    }
    return out;
  }
}
