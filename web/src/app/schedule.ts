// What the occupant does on their own, hour by hour (Tony, 2026-11-01). Two routines, or none:
//   - daily (the default): the schedule below, one activity per baked hour. Hours before the
//     first entry take the first (the day starts at breakfast); hours after the last keep the
//     last (TV into the evening, and through the night);
//   - random: every RANDOM_HOURS hours, a different place (the sofa, the chaise, each armchair,
//     the table, the counter, each cooking spot, the desk), and one of its states (TV on or off
//     on the sofa and chaise); drawn from a seed and the day, so a visit is one fixed tour that
//     changes from day to day.
//
// An hour lasts only HOUR_S seconds, and most walks between activities take 3-8 s with sitting
// down and getting up. So the occupant sets off for the next hour's activity as late as lets
// them arrive as the hour turns, but no earlier than MIN_STAY_S into the hour; and if they are
// still walking when the hour ends, the clock waits at the line until they sit down
// (DayClock.holdAtEnd). Each hour thus shows its activity for at least MIN_STAY_S; hours with a
// long walk after them last a little longer.

import { HOUR_S } from './clock';

export type Routine = 'daily' | 'random' | 'off';
export const ROUTINES: readonly Routine[] = ['daily', 'random', 'off'];

/** The state a routine has for slot `slot` of day `day` (days count from the page load). */
export type Plan = (slot: number, day: number) => string;

/** Seconds of each hour the occupant spends at that hour's activity, at least. */
export const MIN_STAY_S = HOUR_S / 2;
/** The random routine moves on every this many hours. */
export const RANDOM_HOURS = 2;

/** Hour (slot label) and state; each entry holds until the next. */
export const DAY_PLAN: readonly (readonly [string, string])[] = [
  ['08:30', 'dining'], // breakfast at the dining table
  ['09:30', 'lounge_read_w'], // a book in one of the lounge chairs
  ['10:30', 'desk'],
  ['11:30', 'desk'],
  ['12:30', 'counter'], // lunch at the bar counter
  ['13:30', 'lounger_relax'], // relaxing on the chaise
  ['14:30', 'desk'],
  ['15:30', 'cooking_w'], // cooking at the counter (the W one, in view from the default camera)
  ['16:30', 'couch_tv'], // TV on the sofa
];

/** The state the daily schedule has for an hour (a slot label such as "09:30"). */
export function plannedState(label: string): string {
  let state = DAY_PLAN[0]![1];
  for (const [at, s] of DAY_PLAN) if (at <= label) state = s;
  return state;
}

/** The daily schedule over a day's baked hours. */
export function dailyPlan(labels: readonly string[]): Plan {
  return (slot) => plannedState(labels[slot]!);
}

/** A 32-bit hash of a few integers (FNV-1a with a final mix). */
function hash(...xs: number[]): number {
  let h = 0x811c9dc5;
  for (const x of xs) {
    h = Math.imul(h ^ (x | 0), 0x01000193);
    h ^= h >>> 15;
  }
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return (h ^ (h >>> 15)) >>> 0;
}

/**
 * The random routine over `places` (each a list of the states had there): every RANDOM_HOURS a
 * new place, never the one they are at, and one of its states.
 */
export function randomPlan(places: readonly (readonly string[])[], seed: number): Plan {
  const n = places.length;
  return (slot, day) => {
    const block = Math.floor(slot / RANDOM_HOURS);
    let pick = hash(seed, day, 0) % n;
    for (let b = 1; b <= block; b++) pick = (pick + 1 + (hash(seed, day, b) % (n - 1))) % n;
    const states = places[pick]!;
    return states[hash(seed, day, block, 1) % states.length]!;
  };
}

/**
 * The state the routine has after this hour: the next hour's, or after the night the first
 * hour of the next day; null for the last hour of the day, which the night keeps.
 */
export function nextPlanned(
  plan: Plan,
  nSlots: number,
  slot: number,
  day: number,
  night: boolean,
): string | null {
  if (night) return plan(0, day + 1);
  return slot >= nSlots - 1 ? null : plan(slot + 1, day);
}

/**
 * The state the occupant should be heading for: the current hour's, or the next hour's once the
 * time left in this hour (or the night) is no more than the walk there takes, capped at
 * `maxLead` seconds before the end.
 */
export function scheduleGoal(
  plan: Plan,
  nSlots: number,
  slot: number,
  day: number,
  night: boolean,
  timeLeft: number,
  walkSeconds: (from: string, to: string) => number,
  maxLead = Infinity,
): string {
  const now = plan(night ? nSlots - 1 : slot, day);
  const next = nextPlanned(plan, nSlots, slot, day, night);
  if (next === null || next === now) return now;
  return timeLeft <= Math.min(maxLead, walkSeconds(now, next)) ? next : now;
}
