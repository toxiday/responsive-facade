// What a click asks for (docs/decisions.md, States and behaviour): a piece of furniture sends
// the occupant to its nearest seat (a piece without seats, such as the table or the fridge, to
// its activity's first seat); open floor sends them to that spot, which takes the nearest
// standing state. The TV is handled by the controller (it toggles TV on the sofa).

import type { Activity, FurnitureItem, Manifest, Seat } from '../data/manifest';
import type { Pt, WalkGrid } from './walk';

/** Seat heights from the furniture builders (scene/furniture.ts). */
const SEAT_HEIGHT: Record<string, number> = {
  sectional: 0.42,
  armchair: 0.42,
  chair: 0.47,
  stool: 0.65,
};
/**
 * Where the occupant stands before sitting, relative to the seat (front, left), in metres. In
 * front for the sofa and armchairs (so, for the sofa, between it and the coffee table); beside
 * the chaise, at its open side; behind chairs and stools, which tuck under a table. The nearest
 * free point to that spot is used.
 */
function stepSpot(type: string, pose: string): [number, number] {
  if (pose === 'recline') return [0.65, 0.45];
  if (type === 'sectional' || type === 'armchair') return [0.55, 0];
  return [-0.45, 0];
}

export interface SeatTarget {
  kind: 'seat';
  item: FurnitureItem;
  seat: Seat;
  activity: Activity;
  at: Pt;
  /** The free point the occupant walks to before sitting down onto the seat. */
  approach: Pt;
  facing: number;
  /** Seat height (m); 0 for the standing spots at the kitchen counters. */
  height: number;
  stateId: string;
}

export interface FloorTarget {
  kind: 'floor';
  at: Pt;
  stateId: string;
}

export type Target = SeatTarget | FloorTarget;

/** The standing state whose position is nearest to `p`. */
export function nearestStanding(manifest: Manifest, p: Pt): string {
  let best = '';
  let bestD = Infinity;
  for (const s of manifest.states) {
    if (s.kind !== 'standing') continue;
    const z = s.zones[0]!;
    const d = (z.x - p.x) ** 2 + (z.y - p.y) ** 2;
    if (d < bestD) [best, bestD] = [s.id, d];
  }
  return best;
}

export function seatTarget(
  manifest: Manifest,
  grid: WalkGrid,
  item: FurnitureItem,
  seat: Seat,
  tv = false,
): SeatTarget {
  const activity = manifest.activities.find((a) => a.id === seat.activity)!;
  const stateId = activity.states[tv && activity.states.length > 1 ? 1 : 0]!;
  const at = { x: seat.x, y: seat.y };
  const height = SEAT_HEIGHT[item.type] ?? 0;
  let approach: Pt;
  if (height === 0)
    approach = grid.nearestFree(at)!; // the kitchen spots are stood at
  else {
    const [front, left] = stepSpot(item.type, activity.pose);
    const a = (seat.facing * Math.PI) / 180;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    approach = grid.nearestFree({
      x: at.x + front * c - left * s,
      y: at.y + front * s + left * c,
    })!;
  }
  return { kind: 'seat', item, seat, activity, at, approach, facing: seat.facing, height, stateId };
}

export function floorTarget(manifest: Manifest, grid: WalkGrid, p: Pt): FloorTarget | null {
  const at = grid.nearestFree(p);
  return at ? { kind: 'floor', at, stateId: nearestStanding(manifest, at) } : null;
}

/** Every seat in the room with the piece it belongs to. */
function seats(manifest: Manifest): { item: FurnitureItem; seat: Seat }[] {
  return manifest.furniture.flatMap((item) => item.seats.map((seat) => ({ item, seat })));
}

/** The seat a click on `item` at room point `p` asks for, or null for a piece with no use. */
export function itemTarget(
  manifest: Manifest,
  grid: WalkGrid,
  item: FurnitureItem,
  p: Pt,
): SeatTarget | null {
  const own = item.seats.map((seat) => ({ item, seat }));
  let pool = own;
  if (!pool.length && item.click) {
    // No seats of its own: the activity's first seat (its spot).
    const act = manifest.activities.find((a) => a.id === item.click);
    if (!act) return null;
    pool = seats(manifest).filter(
      (s) => s.seat.activity === act.id && s.seat.x === act.spot[0] && s.seat.y === act.spot[1],
    );
  }
  if (!pool.length) return null;
  const pick = pool.reduce((a, b) =>
    (a.seat.x - p.x) ** 2 + (a.seat.y - p.y) ** 2 <= (b.seat.x - p.x) ** 2 + (b.seat.y - p.y) ** 2
      ? a
      : b,
  );
  return seatTarget(manifest, grid, pick.item, pick.seat);
}

/** Where a state is had: its activity's first seat, or its standing position; null for ambient. */
export function stateTarget(manifest: Manifest, grid: WalkGrid, stateId: string): Target | null {
  const st = manifest.states.find((s) => s.id === stateId);
  if (!st || st.kind === 'ambient') return null;
  if (st.kind === 'standing') return floorTarget(manifest, grid, st.zones[0]!);
  const act = manifest.activities.find((a) => a.states.includes(stateId));
  if (!act) return null;
  const s = seats(manifest).find(
    (x) => x.seat.activity === act.id && x.seat.x === act.spot[0] && x.seat.y === act.spot[1],
  );
  if (!s) return null;
  return seatTarget(manifest, grid, s.item, s.seat, act.states.indexOf(stateId) === 1);
}

/** The sofa seat for TV: the seat of the first activity that has a TV state. */
export function tvSeat(manifest: Manifest, grid: WalkGrid): SeatTarget | null {
  const act = manifest.activities.find((a) => a.states.length > 1);
  return act ? (stateTarget(manifest, grid, act.states[1]!) as SeatTarget | null) : null;
}
