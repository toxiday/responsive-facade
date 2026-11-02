// The default day (Tony, 2026-11-01). Unless the visitor turns it off, the occupant follows a
// daily schedule, one activity per baked hour. Hours before the first entry take the first
// (the day starts at breakfast); hours after the last keep the last (TV into the evening, and
// through the night).
//
// An hour lasts only HOUR_S seconds, and most walks between activities take 3-8 s with sitting
// down and getting up. So the occupant sets off for the next hour's activity as late as lets
// them arrive as the hour turns, but no earlier than MIN_STAY_S into the hour; and if they are
// still walking when the hour ends, the clock waits at the line until they sit down
// (DayClock.holdAtEnd). Each hour thus shows its activity for at least MIN_STAY_S; hours with a
// long walk after them last a little longer.

import { HOUR_S } from './clock';

/** Seconds of each hour the occupant spends at that hour's activity, at least. */
export const MIN_STAY_S = HOUR_S / 2;

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

/** The state the schedule has for an hour (a slot label such as "09:30"). */
export function plannedState(label: string): string {
  let state = DAY_PLAN[0]![1];
  for (const [at, s] of DAY_PLAN) if (at <= label) state = s;
  return state;
}

/**
 * The state the schedule has after this hour: the next hour's, or after the night the first
 * hour's; null for the last hour of the day, which the night keeps.
 */
export function nextPlanned(labels: readonly string[], slot: number, night: boolean) {
  if (!night && slot >= labels.length - 1) return null;
  return plannedState(labels[night ? 0 : slot + 1]!);
}

/**
 * The state the occupant should be heading for: the current hour's, or the next hour's once the
 * time left in this hour (or the night) is no more than the walk there takes, capped at
 * `maxLead` seconds before the end.
 */
export function scheduleGoal(
  labels: readonly string[],
  slot: number,
  night: boolean,
  timeLeft: number,
  walkSeconds: (from: string, to: string) => number,
  maxLead = Infinity,
): string {
  const now = plannedState(labels[night ? labels.length - 1 : slot]!);
  const next = nextPlanned(labels, slot, night);
  if (next === null || next === now) return now;
  return timeLeft <= Math.min(maxLead, walkSeconds(now, next)) ? next : now;
}
