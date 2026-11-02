// The occupant's zone on the work plane: the cells the optimizer scored (the state's owner
// grid) outlined in the presentation magenta, and a dot at the occupant. Drawn over the
// heatmap. Nothing for the whole-floor ambient state.

import { CircleGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import type { OccupantState, Room } from '../data/manifest';
import { ownerGrid } from '../data/manifest';
import { maskOutline } from '../debug/overlays';
import { roomToThree } from './frame';
import { PALETTE } from './materials';

export class ZoneMarks {
  readonly group = new Group();
  /** The occupant dot; off once a figure stands there instead (the app). */
  showDot = true;
  private readonly dot: Mesh;

  constructor(private readonly room: Room) {
    this.group.name = 'zones';
    this.dot = new Mesh(
      new CircleGeometry(0.09, 24),
      new MeshBasicMaterial({ color: PALETTE.accent, depthTest: false, transparent: true }),
    );
    this.dot.rotation.x = -Math.PI / 2;
    this.dot.renderOrder = 11;
  }

  set(state: OccupantState | null): void {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      if (c !== this.dot) (c as Mesh).geometry.dispose();
    }
    if (!state || state.kind === 'ambient') return;
    const z = this.room.sensor_height;
    const mask = Array.from(ownerGrid(state.owner), (v) => (v >= 0 ? 1 : 0));
    this.group.add(maskOutline(this.room, mask, z + 0.004));
    const occ = state.zones[0]!;
    roomToThree(occ.x, occ.y, z + 0.006, this.dot.position);
    if (this.showDot) this.group.add(this.dot);
  }
}
