// The facade, generated from the grid definition (guidelines §3.4), not from Rhino, so the
// geometry is exactly the solver's. Per openable wall, three InstancedMeshes:
//   - wall panels drawn at the full wall thickness (WALL_T, as thick as the interior walls),
//     outward from the wall plane; they do not cast shadows;
//   - shadow panels: thin, at the wall plane, invisible, and the only facade geometry that
//     casts shadows. v3's Radiance model has zero-thickness walls, so the rendered sun patch
//     comes from the same plane Radiance simulates, not from the drawn reveals;
//   - glass: a thin pane mid-wall, no shadow (in Radiance the glass transmits direct sun; a
//     binary shadow map can only pass it or block it).
// Panels are full size so no light leaks between them; a line grid draws the panel joints.
// Hidden instances are scaled to zero. Each wall also has a dashed magenta outline of its window openings (the presentation
// accent), which the cutaway shows while the wall itself is hidden.
//
// animateTo changes design with only the changed panels moving (guidelines §3.4): each pivots
// on its vertical axis, a panel that opens turning edge-on and going, one that closes coming in
// edge-on and turning flat. The turns sweep along each wall with a little fixed jitter and are
// all done within FLIP_MS + SWEEP_MS + JITTER_MS. Glass and the shadow switch halfway through
// each turn.

import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  FrontSide,
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
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { Room, Side } from '../data/manifest';
import { roomToThree } from '../scene/frame';
import { PALETTE } from '../scene/materials';
import { WALL_T } from '../scene/shell';
import {
  COLS,
  OUTWARD,
  PANELS_PER_WALL,
  ROWS,
  SIDES,
  bitIndex,
  panelBox,
  wallSpan,
  windowOutline,
} from './geometry';

/** Thickness of the invisible shadow-casting panels at the wall plane. */
export const PANEL_T = 0.03;
const GLASS_T = 0.02;
const OVERLAP = 0.001;
/** Window outline width in CSS pixels: twice the black linework (scene/edges.ts). */
const OUTLINE_WIDTH = 1.5;

interface WallMeshes {
  side: Side;
  group: Group;
  solid: InstancedMesh;
  glass: InstancedMesh;
  /** Invisible thin panels at the wall plane: the facade's shadow. */
  shadow: InstancedMesh;
  /** Outline of the window openings, for when the wall is cut away. */
  ghost: LineSegments2;
  /** Per panel: [wall panel, glass pane, shadow panel] transforms. */
  layers: [Matrix4, Matrix4, Matrix4][];
}

const ZERO = new Matrix4().makeScale(0, 0, 0);

const FLIP_MS = 350;
const SWEEP_MS = 400;
const JITTER_MS = 200;

/** One panel turning between wall and window (animateTo). */
interface Flip {
  w: WallMeshes;
  i: number;
  toWindow: boolean;
  start: number;
}

/** Deterministic 0–1 jitter per panel, so a given change always plays the same way. */
function jitter(n: number): number {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

const UP = new Vector3(0, 1, 0);
const _p = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();
const _m = new Matrix4();

/** A panel transform turned by `angle` about its own vertical axis. */
function turned(panel: Matrix4, angle: number): Matrix4 {
  panel.decompose(_p, _q, _s);
  return _m.compose(_p, _q.setFromAxisAngle(UP, angle), _s);
}

export class FacadeMesh {
  readonly group = new Group();
  readonly walls = new Map<Side, WallMeshes>();
  private bits: Uint8Array = new Uint8Array(4 * PANELS_PER_WALL);
  private flips: Flip[] = [];
  // Screen-space width, so it needs the viewport size (setLineResolution).
  private readonly outline = new LineMaterial({
    color: PALETTE.accent,
    linewidth: OUTLINE_WIDTH,
    dashed: true,
    dashSize: 0.07, // metres, along the line
    gapSize: 0.05,
  });

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
    solid.castShadow = false;
    solid.receiveShadow = true;
    solid.instanceMatrix.setUsage(DynamicDrawUsage);
    const shadow = new InstancedMesh(
      box,
      // Cast from the sun-facing faces: by default three casts from back faces, which for
      // this thin plane sit flush with the wall corners and leak a sliver of sun there.
      new MeshStandardMaterial({ colorWrite: false, depthWrite: false, shadowSide: FrontSide }),
      PANELS_PER_WALL,
    );
    shadow.name = `facade-${side}-shadow`;
    shadow.castShadow = true;
    shadow.receiveShadow = false;
    shadow.instanceMatrix.setUsage(DynamicDrawUsage);
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
    const q = new Quaternion();
    const layers: WallMeshes['layers'] = [];
    for (let row = 0; row < ROWS; row++)
      for (let col = 0; col < COLS; col++) {
        const b = panelBox(side, row, col, W, D, H);
        const mid = roomToThree(
          (b.p0[0] + b.p1[0]) / 2,
          (b.p0[1] + b.p1[1]) / 2,
          (b.p0[2] + b.p1[2]) / 2,
        );
        // Wall panels overlap by OVERLAP so no hairline cracks open between instances (the
        // linework pass would outline them); 1 mm is far below a floor cell.
        const along = side === 'S' || side === 'N' ? b.p1[0] - b.p0[0] : b.p1[1] - b.p0[1];
        const h = b.p1[2] - b.p0[2];
        // A slab `thick` deep, its inner face `inset` out from the wall plane. three axes:
        // S/N walls run along x, E/W walls along z (room y).
        const slab = (inset: number, thick: number, grow: number) =>
          new Matrix4().compose(
            mid.clone().addScaledVector(outward, inset + thick / 2),
            q,
            side === 'S' || side === 'N'
              ? new Vector3(along + grow, h + grow, thick)
              : new Vector3(thick, h + grow, along + grow),
          );
        layers.push([
          slab(0, WALL_T, OVERLAP),
          slab((WALL_T - GLASS_T) / 2, GLASS_T, 0),
          slab(0, PANEL_T, OVERLAP), // overlapped too: a crack would leak sun
        ]);
      }
    for (let i = 0; i < PANELS_PER_WALL; i++) solid.setColorAt(i, PALETTE.panel);

    const group = new Group();
    group.name = `facade-${side}`;
    group.add(solid, glass, this.jointLines(side, outward));
    const ghost = new LineSegments2(new LineSegmentsGeometry(), this.outline);
    ghost.name = `facade-${side}-windows`;
    ghost.visible = false;
    ghost.frustumCulled = false;
    // The shadow panels stay outside the cutaway's group: never drawn, always casting.
    this.group.add(group, shadow, ghost);
    return { side, group, solid, glass, shadow, ghost, layers };
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
    for (const off of [-0.002, WALL_T + 0.002]) {
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

  /** Show a design at once: 2048 values, wall-major S,N,E,W, row 0 = ceiling, 1 = window. */
  setBits(bits: ArrayLike<number>): void {
    this.flips = [];
    this.bits = Uint8Array.from(bits, (v) => (v ? 1 : 0));
    this.applyAll();
  }

  /** Change to a design with the changed panels turning (see the header); `now` in ms. */
  animateTo(bits: ArrayLike<number>, now: number): void {
    if (this.flips.length) this.applyAll(); // a change still running jumps to its end
    const next = Uint8Array.from(bits, (v) => (v ? 1 : 0));
    const flips: Flip[] = [];
    for (const [side, w] of this.walls)
      for (let i = 0; i < PANELS_PER_WALL; i++) {
        const col = i % COLS;
        const b = bitIndex(side, Math.floor(i / COLS), col);
        if (next[b] === this.bits[b]) continue;
        const delay = (col / (COLS - 1)) * SWEEP_MS + jitter(b) * JITTER_MS;
        flips.push({ w, i, toWindow: next[b] === 1, start: now + delay });
      }
    this.bits = next;
    for (const w of this.walls.values()) this.updateGhost(w);
    this.flips = flips;
  }

  /** Advance the turning panels to `now` (ms); true while the facade still needs frames. */
  tick(now: number): boolean {
    if (!this.flips.length) return false;
    let running = false;
    for (const f of this.flips) {
      const p = (now - f.start) / FLIP_MS;
      if (p < 1) running = true;
      if (p < 0) continue; // not started: still showing the old state
      const [panel, pane, shade] = f.w.layers[f.i]!;
      const angle = (f.toWindow ? p : 1 - p) * (Math.PI / 2);
      const half = p >= 0.5;
      f.w.solid.setMatrixAt(f.i, f.toWindow && p >= 1 ? ZERO : turned(panel, angle));
      f.w.glass.setMatrixAt(f.i, f.toWindow === half ? pane : ZERO);
      f.w.shadow.setMatrixAt(f.i, f.toWindow === half ? ZERO : shade);
    }
    for (const w of this.walls.values())
      for (const mesh of [w.solid, w.glass, w.shadow]) mesh.instanceMatrix.needsUpdate = true;
    if (!running) {
      this.flips = [];
      this.applyAll();
    }
    return true; // the last step still has to be drawn
  }

  private applyAll(): void {
    for (const [side, w] of this.walls) {
      for (let i = 0; i < PANELS_PER_WALL; i++) {
        const row = Math.floor(i / COLS);
        const col = i % COLS;
        const isWindow = this.bits[bitIndex(side, row, col)] === 1;
        const [panel, pane, shade] = w.layers[i]!;
        w.solid.setMatrixAt(i, isWindow ? ZERO : panel);
        w.glass.setMatrixAt(i, isWindow ? pane : ZERO);
        w.shadow.setMatrixAt(i, isWindow ? ZERO : shade);
      }
      for (const mesh of [w.solid, w.glass, w.shadow]) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
      }
      this.updateGhost(w);
    }
  }

  private updateGhost(w: WallMeshes): void {
    const { width: W, depth: D, height: H } = this.room;
    const room = windowOutline(this.bits, w.side, W, D, H);
    const pos: number[] = [];
    for (let i = 0; i < room.length; i += 3) pos.push(room[i]!, room[i + 2]!, -room[i + 1]!);
    // A fresh geometry each time: setPositions on the old one would leave its buffers behind.
    const geo = new LineSegmentsGeometry();
    if (pos.length) geo.setPositions(pos);
    geo.instanceCount = pos.length / 6;
    w.ghost.geometry.dispose();
    w.ghost.geometry = geo;
    if (pos.length) w.ghost.computeLineDistances(); // for the dashes
  }

  /** Viewport size in CSS pixels, for the outline's screen-space width. */
  setLineResolution(width: number, height: number): void {
    this.outline.resolution.set(width, height);
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

  /** Per-side window outlines, shown by the cutaway while their wall is hidden. */
  ghosts(): Record<Side, Object3D[]> {
    const out: Record<Side, Object3D[]> = { S: [], N: [], E: [], W: [] };
    for (const [side, w] of this.walls) out[side].push(w.ghost);
    return out;
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
