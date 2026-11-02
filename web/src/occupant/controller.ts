// The occupant's behaviour (docs/decisions.md, States and behaviour), without any drawing:
//   - a target (targets.ts) sends them walking along a free path; from a seat they first step
//     back out to its approach point;
//   - while walking, the facade chases them: whenever `canChase()` allows (the app says yes once
//     the previous curtain has finished), the state becomes the standing state nearest to them;
//   - on arrival at a seat the state is the seat's activity; on open floor, the nearest standing
//     state;
//   - seated on the sofa or the chaise, the TV toggles between the relax and TV states.
// Ambient is only the state on first load (Claude's proposal, pending Tony): nothing returns
// to it, because an idle rule would undo the chase.

import type { Manifest } from '../data/manifest';
import { nearestStanding, type SeatTarget, type Target } from './targets';
import { pathLength, type Pt, type WalkGrid } from './walk';

export const WALK_SPEED = 1.3; // m/s
const TURN_RATE = 540; // deg/s

export type Mode = 'standing' | 'walking' | 'seated';

/** Shortest signed difference b − a in degrees, in (−180, 180]. */
export function angleDelta(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

export class OccupantController {
  pos: Pt;
  heading: number;
  mode: Mode = 'standing';
  stateId: string;
  seatedOn: SeatTarget | null = null;
  /** Metres walked; drives the walk cycle. */
  walked = 0;
  onState: (stateId: string) => void = () => {};
  /** Called on arrival (also when the state stays the same, e.g. another chair at the table). */
  onArrive: () => void = () => {};
  canChase: () => boolean = () => true;
  private target: Target | null = null;
  private path: Pt[] = [];
  private leg = 0;

  constructor(
    private readonly manifest: Manifest,
    private readonly grid: WalkGrid,
    start: Pt,
    stateId: string,
    heading = 270,
  ) {
    this.pos = { ...start };
    this.stateId = stateId;
    this.heading = heading;
  }

  get destination(): Target | null {
    return this.target;
  }

  /** Put the occupant at a target at once (a linked view), seated or standing there. */
  placeAt(t: Target): void {
    this.target = null;
    this.path = [];
    this.arrive(t, false);
  }

  /** Walk to a target. Returns false if no free path reaches it. */
  goTo(t: Target): boolean {
    let from = this.mode === 'seated' && this.seatedOn ? this.seatedOn.approach : this.pos;
    if (!this.grid.isFree(from)) from = this.grid.nearestFree(from) ?? from;
    const end = t.kind === 'seat' ? t.approach : t.at;
    const route = this.grid.path(from, end);
    if (!route) return false;
    const pts: Pt[] = [];
    // Start where they are: off a seat (stepping out), or wherever a walk was interrupted.
    if (Math.hypot(this.pos.x - route[0]!.x, this.pos.y - route[0]!.y) > 1e-6)
      pts.push({ ...this.pos });
    pts.push(...route);
    if (t.kind === 'seat') pts.push(t.at); // and onto the seat at the end
    this.path = pts;
    this.leg = 1;
    this.pos = { ...pts[0]! };
    this.target = t;
    this.seatedOn = null;
    this.mode = 'walking';
    return true;
  }

  /** On the sofa or chaise, switch between the relax and TV states. True if it switched. */
  toggleTv(): boolean {
    const s = this.seatedOn;
    if (this.mode !== 'seated' || !s || s.activity.states.length < 2) return false;
    const [relax, tv] = s.activity.states as [string, string];
    this.setState(this.stateId === tv ? relax : tv);
    return true;
  }

  /** Advance by dt seconds; true while the occupant is still moving or turning. */
  update(dt: number): boolean {
    if (this.mode !== 'walking') return this.turnTo(this.restingHeading(), dt);
    let step = WALK_SPEED * dt;
    while (step > 0 && this.leg < this.path.length) {
      const goal = this.path[this.leg]!;
      const dx = goal.x - this.pos.x;
      const dy = goal.y - this.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > 1e-6) {
        const want = (Math.atan2(dy, dx) * 180) / Math.PI;
        this.turnTo(want, dt);
      }
      if (d <= step) {
        this.pos = { ...goal };
        this.walked += d;
        step -= d;
        this.leg++;
      } else {
        this.pos = { x: this.pos.x + (dx / d) * step, y: this.pos.y + (dy / d) * step };
        this.walked += step;
        step = 0;
      }
    }
    if (this.leg >= this.path.length) {
      const t = this.target!;
      this.target = null;
      this.arrive(t, true);
      this.onArrive();
      return true;
    }
    // The facade chases the occupant while they walk.
    const near = nearestStanding(this.manifest, this.pos);
    if (near !== this.stateId && this.canChase()) this.setState(near);
    return true;
  }

  /** Remaining walk, in metres (for tests and the readout). */
  remaining(): number {
    if (this.mode !== 'walking') return 0;
    return pathLength([this.pos, ...this.path.slice(this.leg)]);
  }

  private arrive(t: Target, notify: boolean): void {
    this.pos = { ...t.at };
    if (t.kind === 'seat') {
      this.mode = 'seated';
      this.seatedOn = t;
      if (notify) this.setState(t.stateId);
      else this.stateId = t.stateId;
      if (!notify) this.heading = t.facing;
    } else {
      this.mode = 'standing';
      this.seatedOn = null;
      const s = nearestStanding(this.manifest, t.at);
      if (notify) this.setState(s);
      else this.stateId = s;
    }
  }

  private restingHeading(): number {
    return this.mode === 'seated' && this.seatedOn ? this.seatedOn.facing : this.heading;
  }

  private turnTo(want: number, dt: number): boolean {
    const d = angleDelta(this.heading, want);
    if (Math.abs(d) < 0.5) {
      this.heading = want;
      return false;
    }
    this.heading += Math.sign(d) * Math.min(Math.abs(d), TURN_RATE * dt);
    return true;
  }

  private setState(id: string): void {
    if (id === this.stateId) return;
    this.stateId = id;
    this.onState(id);
  }
}
