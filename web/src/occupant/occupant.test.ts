// M4 gate: every state can be reached by clicking, and the controller does what the
// behaviour rules say (docs/decisions.md, States and behaviour).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Manifest } from '../data/manifest';
import { OccupantController } from './controller';
import {
  floorTarget,
  itemTarget,
  nearestStanding,
  stateTarget,
  tvSeat,
  type Target,
} from './targets';
import { WalkGrid, type Pt } from './walk';

const manifest = JSON.parse(
  readFileSync(new URL('../../public/data/manifest.json', import.meta.url), 'utf8'),
) as Manifest;
const grid = new WalkGrid(manifest.room, manifest.furniture);
const entry = grid.nearestFree({ x: 4.92, y: 10.0 })!;
const item = (id: string) => manifest.furniture.find((f) => f.id === id)!;

/** Run the controller until it stops (or 60 s pass); returns the states it emitted. */
function walk(c: OccupantController, t: Target): string[] {
  const seen: string[] = [];
  c.onState = (id) => seen.push(id);
  expect(c.goTo(t)).toBe(true);
  for (let i = 0; i < 3600 && c.mode === 'walking'; i++) c.update(1 / 60);
  expect(c.mode).not.toBe('walking');
  return seen;
}

describe('walk grid', () => {
  it('has the entry free', () => {
    expect(grid.isFree(entry)).toBe(true);
  });

  it('reaches every activity seat and every standing position from the entry', () => {
    for (const s of manifest.states) {
      if (s.kind === 'ambient') continue;
      const t = stateTarget(manifest, grid, s.id);
      expect(t, s.id).not.toBeNull();
      const end = t!.kind === 'seat' ? t!.approach : t!.at;
      const path = grid.path(entry, end);
      expect(path, `path to ${s.id}`).not.toBeNull();
      for (let k = 1; k < path!.length; k++)
        expect(grid.lineFree(path![k - 1]!, path![k]!)).toBe(true);
    }
  });

  it('sends a seat to the right state and its approach to free floor', () => {
    for (const s of manifest.states.filter((x) => x.kind === 'activity')) {
      const t = stateTarget(manifest, grid, s.id)!;
      expect(t.stateId).toBe(s.id);
      if (t.kind === 'seat') expect(grid.isFree(t.approach)).toBe(true);
    }
  });
});

describe('click targets', () => {
  it('a chair takes that chair; a table its activity spot; the fridge the E counter', () => {
    const chair = item('dining_chair_3');
    const t = itemTarget(manifest, grid, chair, { x: 3.4, y: 6.8 })!;
    expect([t.seat.x, t.seat.y]).toEqual([3.401, 6.768]);
    expect(t.stateId).toBe('dining');
    const table = itemTarget(manifest, grid, item('dining_table'), { x: 3, y: 6 })!;
    expect(table.stateId).toBe('dining');
    expect(itemTarget(manifest, grid, item('fridge'), { x: 3.8, y: 10 })!.stateId).toBe(
      'cooking_e',
    );
  });

  it('the sofa: the nearer of its two seats', () => {
    const sofa = item('sofa');
    expect(itemTarget(manifest, grid, sofa, { x: 1.7, y: 3.6 })!.stateId).toBe('couch_relax');
    expect(itemTarget(manifest, grid, sofa, { x: 2.3, y: 2.5 })!.stateId).toBe('lounger_relax');
  });

  it('pieces without a use, like the coffee table, give nothing (the floor is used)', () => {
    expect(itemTarget(manifest, grid, item('coffee_table'), { x: 2.5, y: 3.2 })).toBeNull();
  });

  it('open floor: the nearest free spot and its nearest standing state', () => {
    const p: Pt = { x: 2.7, y: 4.6 };
    const t = floorTarget(manifest, grid, p)!;
    expect(grid.isFree(t.at)).toBe(true);
    expect(t.stateId).toBe(nearestStanding(manifest, t.at));
  });
});

describe('controller', () => {
  it('walks to the desk, chasing with standing states, and sits down to desk work', () => {
    const c = new OccupantController(manifest, grid, entry, 'ambient');
    const seen = walk(c, stateTarget(manifest, grid, 'desk')!);
    expect(c.mode).toBe('seated');
    expect(c.stateId).toBe('desk');
    expect(seen.at(-1)).toBe('desk');
    expect(seen.slice(0, -1).length).toBeGreaterThan(0);
    for (const s of seen.slice(0, -1)) expect(s.startsWith('stand_')).toBe(true);
  });

  it('does not chase while the facade is still changing, but still arrives', () => {
    const c = new OccupantController(manifest, grid, entry, 'ambient');
    c.canChase = () => false;
    expect(walk(c, stateTarget(manifest, grid, 'cooking_range')!)).toEqual(['cooking_range']);
  });

  it('on the sofa the TV toggles; away from it, the TV does nothing', () => {
    const c = new OccupantController(manifest, grid, entry, 'ambient');
    expect(c.toggleTv()).toBe(false);
    walk(c, tvSeat(manifest, grid)!);
    expect(c.stateId).toBe('couch_tv');
    expect(c.toggleTv()).toBe(true);
    expect(c.stateId).toBe('couch_relax');
    expect(c.toggleTv()).toBe(true);
    expect(c.stateId).toBe('couch_tv');
  });

  it('gets up from a seat and walks on to open floor', () => {
    const c = new OccupantController(manifest, grid, entry, 'ambient');
    c.placeAt(stateTarget(manifest, grid, 'lounge_read_e')!);
    expect(c.mode).toBe('seated');
    walk(c, floorTarget(manifest, grid, { x: 2.7, y: 8.0 })!);
    expect(c.mode).toBe('standing');
    expect(c.stateId.startsWith('stand_')).toBe(true);
  });

  it('a new click mid-walk re-routes from where they are', () => {
    const c = new OccupantController(manifest, grid, entry, 'ambient');
    c.goTo(stateTarget(manifest, grid, 'lounge_read_w')!);
    for (let i = 0; i < 60; i++) c.update(1 / 60);
    const here = { ...c.pos };
    expect(c.goTo(stateTarget(manifest, grid, 'counter')!)).toBe(true);
    expect(c.pos).toEqual(here);
  });
});
