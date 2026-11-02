// The occupant drawn as an architectural scale figure: a procedural low-poly mannequin
// (capsule limbs, rounded torso), 1.7 m tall, in a pale warm grey with the scene's linework,
// and a magenta ring at its feet while it stands or walks. Poses: stand, walk (a simple gait),
// and the activity poses from the manifest (sit, recline, read, sit_table, type, cook). Poses
// blend over a few tenths of a second.
//
// Local frame as the furniture builders: front +x, up +y, right hand +z; joints swing forward
// with a positive rotation about z.

import {
  CapsuleGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
  SphereGeometry,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { Pt } from './walk';
import { facingToRotY, roomToThree } from '../scene/frame';
import { PALETTE } from '../scene/materials';

const THIGH = 0.42;
const SHIN = 0.44;
const UPPER_ARM = 0.29;
const FOREARM = 0.27;
const HIP_Y = 0.92;

interface Pose {
  hipY: number;
  lean: number;
  hipL: number;
  hipR: number;
  kneeL: number;
  kneeR: number;
  shL: number;
  shR: number;
  elL: number;
  elR: number;
}

const STAND: Pose = {
  hipY: HIP_Y,
  lean: 0,
  hipL: 0,
  hipR: 0,
  kneeL: 0,
  kneeR: 0,
  shL: 0.05,
  shR: 0.05,
  elL: 0.12,
  elR: 0.12,
};

/** A seated pose on a seat `h` high; arms by activity. */
function seated(h: number, pose: string): Pose {
  const base: Pose = {
    ...STAND,
    hipY: h + 0.07,
    lean: 0.08,
    hipL: 1.45,
    hipR: 1.45,
    kneeL: -1.45,
    kneeR: -1.45,
    shL: 0.3,
    shR: 0.3,
    elL: 0.9,
    elR: 0.9,
  };
  switch (pose) {
    case 'recline':
      return { ...base, lean: 0.55, kneeL: -0.15, kneeR: -0.15, shL: 0.15, shR: 0.15 };
    case 'read':
      return { ...base, shL: 0.55, shR: 0.55, elL: 1.75, elR: 1.75 };
    case 'sit_table':
    case 'type':
      return { ...base, lean: 0, shL: 0.75, shR: 0.75, elL: 0.75, elR: 0.75 };
    default:
      return base;
  }
}

function walking(phase: number): Pose {
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  return {
    hipY: HIP_Y - 0.015 * Math.abs(c),
    lean: -0.04,
    hipL: 0.42 * s,
    hipR: -0.42 * s,
    kneeL: -0.65 * Math.max(0, c),
    kneeR: -0.65 * Math.max(0, -c),
    shL: -0.32 * s,
    shR: 0.32 * s,
    elL: 0.3,
    elR: 0.3,
  };
}

export class Figure {
  readonly group = new Group();
  private readonly body = new Group();
  private readonly pelvis = new Group();
  private readonly torso = new Group();
  private readonly joints: Record<
    'hipL' | 'hipR' | 'kneeL' | 'kneeR' | 'shL' | 'shR' | 'elL' | 'elR',
    Group
  >;
  private readonly ring: Mesh;
  private pose: Pose = { ...STAND };

  constructor() {
    const mat = new MeshStandardMaterial({ color: PALETTE.figure, roughness: 0.9 });
    const mesh = (geo: ConstructorParameters<typeof Mesh>[0], y = 0, x = 0) => {
      const m = new Mesh(geo, mat);
      m.position.set(x, y, 0);
      m.castShadow = true;
      m.receiveShadow = true;
      return m;
    };
    const limb = (len: number, r: number) =>
      mesh(new CapsuleGeometry(r, len - 2 * r, 4, 10), -len / 2);
    const joint = (parent: Group, x: number, y: number, z: number) => {
      const g = new Group();
      g.position.set(x, y, z);
      parent.add(g);
      return g;
    };

    this.pelvis.add(mesh(new RoundedBoxGeometry(0.2, 0.17, 0.32, 2, 0.05)));
    this.torso.position.y = 0.06;
    this.pelvis.add(this.torso);
    this.torso.add(mesh(new RoundedBoxGeometry(0.21, 0.44, 0.36, 2, 0.07), 0.22));
    this.torso.add(mesh(new SphereGeometry(0.105, 16, 12), 0.6));

    const hipL = joint(this.pelvis, 0, 0, -0.095);
    const hipR = joint(this.pelvis, 0, 0, 0.095);
    const kneeL = joint(hipL, 0, -THIGH, 0);
    const kneeR = joint(hipR, 0, -THIGH, 0);
    for (const [hip, knee] of [
      [hipL, kneeL],
      [hipR, kneeR],
    ] as const) {
      hip.add(limb(THIGH, 0.068));
      knee.add(limb(SHIN, 0.055));
      knee.add(mesh(new RoundedBoxGeometry(0.24, 0.07, 0.09, 2, 0.03), -SHIN - 0.03, 0.06));
    }
    const shL = joint(this.torso, 0, 0.41, -0.215);
    const shR = joint(this.torso, 0, 0.41, 0.215);
    const elL = joint(shL, 0, -UPPER_ARM, 0);
    const elR = joint(shR, 0, -UPPER_ARM, 0);
    for (const [sh, el] of [
      [shL, elL],
      [shR, elR],
    ] as const) {
      sh.add(limb(UPPER_ARM, 0.045));
      el.add(limb(FOREARM, 0.04));
    }
    this.joints = { hipL, hipR, kneeL, kneeR, shL, shR, elL, elR };

    this.body.add(this.pelvis);
    this.ring = new Mesh(
      new RingGeometry(0.24, 0.28, 40),
      new MeshBasicMaterial({ color: PALETTE.accent, transparent: true, depthWrite: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.004;
    this.ring.renderOrder = 3;
    this.group.name = 'occupant';
    this.group.add(this.body, this.ring);
    this.apply();
  }

  /**
   * Place and pose the figure. `seat` is the seat height and activity pose when seated (or
   * standing at a counter, height 0); `walked` drives the gait while walking. Returns true
   * while the pose is still blending.
   */
  update(
    dt: number,
    at: Pt,
    heading: number,
    mode: 'standing' | 'walking' | 'seated',
    seat: { height: number; pose: string } | null,
    walked: number,
  ): boolean {
    roomToThree(at.x, at.y, 0, this.group.position);
    this.body.rotation.y = facingToRotY(heading);
    let want: Pose;
    if (mode === 'walking') want = walking((walked / 1.3) * Math.PI * 1.8);
    else if (mode === 'seated' && seat && seat.height > 0) want = seated(seat.height, seat.pose);
    else if (mode === 'seated' && seat?.pose === 'cook')
      want = { ...STAND, shL: 0.7, shR: 0.7, elL: 0.9, elR: 0.9 };
    else want = STAND;
    // Walking follows the gait closely; other changes blend in.
    const k = mode === 'walking' ? 1 - Math.exp(-dt * 30) : 1 - Math.exp(-dt * 9);
    let left = 0;
    for (const key of Object.keys(want) as (keyof Pose)[]) {
      this.pose[key] += (want[key] - this.pose[key]) * k;
      left = Math.max(left, Math.abs(want[key] - this.pose[key]));
    }
    this.ring.visible = mode !== 'seated' || !seat || seat.height === 0;
    this.apply();
    return left > 1e-3;
  }

  private apply(): void {
    const p = this.pose;
    this.pelvis.position.y = p.hipY;
    this.torso.rotation.z = p.lean;
    for (const k of ['hipL', 'hipR', 'kneeL', 'kneeR', 'shL', 'shR', 'elL', 'elR'] as const)
      this.joints[k].rotation.z = p[k];
  }
}
