import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Manifest } from '../data/manifest';
import { stateTarget } from '../occupant/targets';
import { WalkGrid } from '../occupant/walk';
import { HOUR_S } from './clock';
import {
  dailyPlan,
  DAY_PLAN,
  MIN_STAY_S,
  nextPlanned,
  plannedState,
  RANDOM_HOURS,
  randomPlan,
  scheduleGoal,
  type Plan,
} from './schedule';

const manifest = JSON.parse(
  readFileSync(new URL('../../public/data/manifest.json', import.meta.url), 'utf8'),
) as Manifest;
const activities = manifest.states.filter((s) => s.kind === 'activity').map((s) => s.id);
const places = manifest.activities.map((a) => a.states);
const placeOf = (state: string) => places.findIndex((p) => p.includes(state));

describe('daily schedule', () => {
  it("is Tony's day, hour by hour", () => {
    const at = (h: string) => plannedState(h);
    expect(at('08:30')).toBe('dining');
    expect(at('09:30')).toBe('lounge_read_w');
    expect([at('10:30'), at('11:30'), at('14:30')]).toEqual(['desk', 'desk', 'desk']);
    expect(at('12:30')).toBe('counter');
    expect(at('13:30')).toBe('lounger_relax');
    expect(at('15:30')).toBe('cooking_w');
    expect(at('16:30')).toBe('couch_tv');
  });

  it('starts the day at breakfast and keeps the TV on into the evening', () => {
    expect(plannedState('06:30')).toBe('dining');
    expect(plannedState('19:30')).toBe('couch_tv');
  });

  it('names states the occupant can walk to', () => {
    const grid = new WalkGrid(manifest.room, manifest.furniture);
    for (const [, id] of DAY_PLAN) expect(stateTarget(manifest, grid, id), id).not.toBeNull();
  });

  it("sets off for the next hour's activity just in time to arrive as the hour turns", () => {
    const plan = dailyPlan(['08:30', '09:30', '10:30', '11:30']);
    const walk = () => 3; // seconds from anything to anything
    expect(scheduleGoal(plan, 4, 0, 0, false, 4, walk)).toBe('dining');
    expect(scheduleGoal(plan, 4, 0, 0, false, 3, walk)).toBe('lounge_read_w');
    // Desk to desk: nothing to walk to.
    expect(scheduleGoal(plan, 4, 2, 0, false, 0.5, walk)).toBe('desk');
  });

  it('stays at least MIN_STAY_S at each activity, however long the walk on', () => {
    const plan = dailyPlan(['08:30', '09:30']);
    const lead = HOUR_S - MIN_STAY_S;
    const long = () => 7;
    expect(scheduleGoal(plan, 2, 0, 0, false, lead + 0.1, long, lead)).toBe('dining');
    expect(scheduleGoal(plan, 2, 0, 0, false, lead, long, lead)).toBe('lounge_read_w');
    expect(nextPlanned(plan, 2, 0, 0, false)).toBe('lounge_read_w');
    expect(nextPlanned(plan, 2, 1, 0, false)).toBeNull(); // the night keeps the last hour
    expect(nextPlanned(plan, 2, 1, 0, true)).toBe('dining');
  });

  it('keeps the last hour through the night, then heads for breakfast before morning', () => {
    const plan = dailyPlan(['14:30', '15:30', '16:30']);
    const walk = () => 4;
    expect(scheduleGoal(plan, 3, 2, 0, false, 0.1, walk)).toBe('couch_tv');
    expect(scheduleGoal(plan, 3, 2, 0, true, 8, walk)).toBe('couch_tv');
    expect(scheduleGoal(plan, 3, 2, 0, true, 4, walk)).toBe('desk');
  });
});

describe('random routine', () => {
  const tour = (plan: Plan, d: number) => Array.from({ length: 14 }, (_, s) => plan(s, d));
  const plan = randomPlan(places, 7);

  it(`moves every ${RANDOM_HOURS} hours, always to another place`, () => {
    for (const d of [0, 1, 2, 3]) {
      const hours = tour(plan, d);
      for (let s = 1; s < hours.length; s++)
        if (s % RANDOM_HOURS) expect(hours[s]).toBe(hours[s - 1]);
        else expect(placeOf(hours[s]!)).not.toBe(placeOf(hours[s - 1]!));
    }
  });

  it('only picks activities, and visits many of them', () => {
    const seen = new Set([0, 1, 2, 3, 4, 5].flatMap((d) => tour(plan, d)));
    for (const s of seen) expect(activities).toContain(s);
    expect(seen.size).toBeGreaterThan(activities.length / 2);
    expect(seen.has('couch_tv') || seen.has('lounger_tv')).toBe(true);
  });

  it('is one fixed tour per seed and day, and another the next day or with another seed', () => {
    expect(tour(randomPlan(places, 7), 0)).toEqual(tour(plan, 0));
    expect(tour(plan, 1)).not.toEqual(tour(plan, 0));
    expect(tour(randomPlan(places, 8), 0)).not.toEqual(tour(plan, 0));
  });
});
