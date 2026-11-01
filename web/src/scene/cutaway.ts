// Cutaway (guidelines §3.1): the ceiling and the walls facing the camera are not drawn but
// still cast shadows, otherwise the sun would pour in through the missing ceiling.
// colorWrite = false hides the surface; depthWrite = false stops the invisible surface from
// hiding the interior behind it; castShadow stays on, so the shadow pass still sees it.
// Pieces hung on a wall (the upper kitchen cabinets) are hidden with it. While a wall is
// hidden, its floor mark is shown so the cut still reads on plan.

import type { Camera, Material, Mesh, Object3D, Vector3 } from 'three';
import { Vector3 as V3 } from 'three';
import type { Side } from '../data/manifest';
import { OUTWARD } from '../facade/geometry';
import { roomToThree } from './frame';

const HIDE_DOT = 0.12;

function setHidden(obj: Object3D, hidden: boolean) {
  obj.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.material) return;
    const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as Material[];
    for (const m of mats) {
      m.colorWrite = !hidden;
      m.depthWrite = !hidden && !m.transparent;
    }
    // Lines and glass never cast; for them hiding is enough.
  });
}

export interface CutawayMarks {
  sides: Record<Side, Object3D[]>;
  corners: { obj: Object3D; sides: [Side, Side] }[];
}

export class Cutaway {
  private readonly normals: Record<Side, V3>;
  private hidden: Record<Side, boolean> = { S: false, N: false, E: false, W: false };
  /** When false, every wall is drawn (debug views looking at the facade from outside). */
  walls = true;

  constructor(
    private readonly parts: Record<Side, Object3D[]>,
    ceiling: Object3D[],
    private readonly corners: { obj: Object3D; sides: [Side, Side] }[],
    private readonly marks: CutawayMarks = { sides: { S: [], N: [], E: [], W: [] }, corners: [] },
  ) {
    this.normals = {
      S: roomToThree(...OUTWARD.S),
      N: roomToThree(...OUTWARD.N),
      E: roomToThree(...OUTWARD.E),
      W: roomToThree(...OUTWARD.W),
    };
    for (const c of ceiling) setHidden(c, true);
  }

  /** Re-evaluate which walls face the camera. Returns true if anything changed. */
  update(camera: Camera, target: Vector3): boolean {
    const toCam = new V3().subVectors(camera.position, target).setY(0).normalize();
    let changed = false;
    for (const side of ['S', 'N', 'E', 'W'] as Side[]) {
      const hide = this.walls && this.normals[side].dot(toCam) > HIDE_DOT;
      if (hide !== this.hidden[side]) {
        this.hidden[side] = hide;
        for (const p of this.parts[side]) setHidden(p, hide);
        for (const m of this.marks.sides[side]) m.visible = hide;
        changed = true;
      }
    }
    if (changed) {
      const cut = (sides: [Side, Side]) => this.hidden[sides[0]] || this.hidden[sides[1]];
      for (const c of this.corners) setHidden(c.obj, cut(c.sides));
      for (const c of this.marks.corners) c.obj.visible = cut(c.sides);
    }
    return changed;
  }

  isHidden(side: Side): boolean {
    return this.hidden[side];
  }
}
