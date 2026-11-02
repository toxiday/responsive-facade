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
/** Seats approached from the front; chairs and stools tuck under a table, so from behind. */
const FROM_FRONT = new Set(['sectional', 'armchair']);

export interface SeatTarget {
  kind: 'seat';
  item: FurnitureItem;
  seat: Seat;
  activity: Activity;
  at: Pt;
  /** The free point the occupant walks to before stepping onto the seat. */
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
  let approach: Pt | null = null;
  if (height === 0 && grid.isFree(at)) approach = at;
  else {
    const a = ((seat.facing + (FROM_FRONT.has(item.type) ? 0 : 180)) * Math.PI) / 180;
    for (let d = 0.2; d <= 1.6 && !approach; d += 0.05) {
      const p = { x: at.x + d * Math.cos(a), y: at.y + d * Math.sin(a) };
      if (grid.isFree(p)) approach = p;
    }
  }
  approach ??= grid.nearestFree(at)!;
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
