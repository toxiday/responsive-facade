// The occupant's behaviour (docs/decisions.md, States and behaviour), without any drawing:
//   - a target (targets.ts) sends them walking along a free path. To a seat, they walk to its
//     approach point (for the sofa, between it and the coffee table), turn and sit down onto
//     it ('sitting'); from a seat they first stand up back to that point ('rising');
//   - while walking, the facade chases them: whenever `canChase()` allows (the app says yes once
//     the previous curtain has finished, and never while the visitor holds the facade until
//     arrival), the state becomes the standing state nearest to them;
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
const SIT_S = 0.7; // turning round and lowering onto a seat
const RISE_S = 0.5;

export type Mode = 'standing' | 'walking' | 'sitting' | 'seated' | 'rising';

/** Shortest signed difference b − a in degrees, in (−180, 180]. */
export function angleDelta(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

const ease = (t: number) => t * t * (3 - 2 * t);

/** Sitting down onto, or standing up from, a seat: a short glide between seat and approach. */
interface Transfer {
  seat: SeatTarget;
  from: Pt;
  to: Pt;
  t: number;
  duration: number;
}

export class OccupantController {
  pos: Pt;
  heading: number;
  mode: Mode = 'standing';
  stateId: string;
  /** The seat they are on, or sitting down onto, or standing up from. */
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
  private transfer: Transfer | null = null;

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

  /** True while walking, sitting down or standing up. */
  get moving(): boolean {
    return this.mode === 'walking' || this.mode === 'sitting' || this.mode === 'rising';
  }

  /** Put the occupant at a target at once (a linked view), seated or standing there. */
  placeAt(t: Target): void {
    this.target = null;
    this.path = [];
    this.transfer = null;
    this.arrive(t, false);
    if (t.kind === 'seat') this.heading = t.facing;
  }

  /** Walk to a target. Returns false if no free path reaches it. */
  goTo(t: Target): boolean {
    const seated = this.mode === 'seated' || this.mode === 'sitting';
    const leaving = seated && this.seatedOn ? this.seatedOn : null;
    let from = leaving ? leaving.approach : this.pos;
    if (!this.grid.isFree(from)) from = this.grid.nearestFree(from) ?? from;
    const end = t.kind === 'seat' ? t.approach : t.at;
    const route = this.grid.path(from, end);
    if (!route) return false;
    const pts: Pt[] = [];
    // Start where they are, wherever a walk was interrupted.
    if (!leaving && Math.hypot(this.pos.x - route[0]!.x, this.pos.y - route[0]!.y) > 1e-6)
      pts.push({ ...this.pos });
    pts.push(...route);
    this.path = pts;
    this.leg = 1;
    this.target = t;
    if (leaving) {
      // Stand up first, back to the approach point; the walk starts from there.
      this.transfer = {
        seat: leaving,
        from: { ...this.pos },
        to: leaving.approach,
        t: 0,
        duration: RISE_S,
      };
      this.mode = 'rising';
    } else {
      this.transfer = null;
      this.seatedOn = null;
      this.pos = { ...pts[0]! };
      this.mode = 'walking';
    }
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
    if (this.mode === 'sitting' || this.mode === 'rising') return this.stepTransfer(dt);
    if (this.mode !== 'walking') return this.turnTo(this.restingHeading(), dt);
    let step = WALK_SPEED * dt;
    while (step > 0 && this.leg < this.path.length) {
      const goal = this.path[this.leg]!;
      const dx = goal.x - this.pos.x;
      const dy = goal.y - this.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > 1e-6) this.turnTo((Math.atan2(dy, dx) * 180) / Math.PI, dt);
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
      if (t.kind === 'seat') {
        // At the approach point: turn round and sit down onto the seat.
        this.seatedOn = t;
        this.transfer = { seat: t, from: { ...this.pos }, to: t.at, t: 0, duration: SIT_S };
        this.mode = 'sitting';
        return true;
      }
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

  private stepTransfer(dt: number): boolean {
    const tr = this.transfer!;
    tr.t = Math.min(1, tr.t + dt / tr.duration);
    // Sitting: face the seat's way at once and lower back onto it. Rising: stand up forward.
    if (this.mode === 'sitting') this.turnTo(tr.seat.facing, dt * 2);
    const e = ease(tr.t);
    this.pos = {
      x: tr.from.x + (tr.to.x - tr.from.x) * e,
      y: tr.from.y + (tr.to.y - tr.from.y) * e,
    };
    if (tr.t < 1) return true;
    this.transfer = null;
    if (this.mode === 'sitting') {
      const t = this.target!;
      this.target = null;
      this.arrive(t, true);
      this.onArrive();
    } else {
      this.seatedOn = null;
      this.mode = 'walking';
    }
    return true;
  }

  private arrive(t: Target, notify: boolean): void {
    this.pos = { ...t.at };
    if (t.kind === 'seat') {
      this.mode = 'seated';
      this.seatedOn = t;
      if (notify) this.setState(t.stateId);
      else this.stateId = t.stateId;
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
