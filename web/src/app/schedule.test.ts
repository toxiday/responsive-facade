import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Manifest } from '../data/manifest';
import { stateTarget } from '../occupant/targets';
import { WalkGrid } from '../occupant/walk';
import { DAY_PLAN, MIN_STAY_S, nextPlanned, plannedState, scheduleGoal } from './schedule';
import { HOUR_S } from './clock';

const manifest = JSON.parse(
  readFileSync(new URL('../../public/data/manifest.json', import.meta.url), 'utf8'),
) as Manifest;

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
    const labels = ['08:30', '09:30', '10:30', '11:30'];
    const walk = () => 3; // seconds from anything to anything
    expect(scheduleGoal(labels, 0, false, 4, walk)).toBe('dining');
    expect(scheduleGoal(labels, 0, false, 3, walk)).toBe('lounge_read_w');
    // Desk to desk: nothing to walk to.
    expect(scheduleGoal(labels, 2, false, 0.5, walk)).toBe('desk');
  });

  it('stays at least MIN_STAY_S at each activity, however long the walk on', () => {
    const labels = ['08:30', '09:30'];
    const lead = HOUR_S - MIN_STAY_S;
    const long = () => 7;
    expect(scheduleGoal(labels, 0, false, lead + 0.1, long, lead)).toBe('dining');
    expect(scheduleGoal(labels, 0, false, lead, long, lead)).toBe('lounge_read_w');
    expect(nextPlanned(labels, 0, false)).toBe('lounge_read_w');
    expect(nextPlanned(labels, 1, false)).toBeNull(); // the night keeps the last hour
    expect(nextPlanned(labels, 1, true)).toBe('dining');
  });

  it('keeps the last hour through the night, then heads for breakfast before morning', () => {
    const labels = ['14:30', '15:30', '16:30'];
    const walk = () => 4;
    expect(scheduleGoal(labels, 2, false, 0.1, walk)).toBe('couch_tv');
    expect(scheduleGoal(labels, 2, true, 8, walk)).toBe('couch_tv');
    expect(scheduleGoal(labels, 2, true, 4, walk)).toBe('desk');
  });
});
