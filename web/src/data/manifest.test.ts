import { describe, expect, it } from 'vitest';
import manifestJson from '../../public/data/manifest.json';
import { checkManifest, type Manifest, ownerGrid } from './manifest';

const manifest = checkManifest(manifestJson as unknown as Manifest);

describe('manifest', () => {
  it('decodes owner strings', () => {
    expect(Array.from(ownerGrid('.01.'))).toEqual([-1, 0, 1, -1]);
  });

  it('owner grids agree with occupied_cells and zone counts', () => {
    for (const s of manifest.states) {
      const g = ownerGrid(s.owner);
      expect(g.length).toBe(1024);
      expect(g.filter((v) => v >= 0).length).toBe(s.occupied_cells);
      expect(Math.max(...g)).toBeLessThan(s.zones.length);
    }
  });

  it('every clickable seat names an activity', () => {
    const acts = new Set(manifest.activities.map((a) => a.id));
    for (const item of manifest.furniture)
      if (item.seat) expect(acts.has(item.click ?? ''), item.id).toBe(true);
  });

  it('has standing states with one zone each', () => {
    const standing = manifest.states.filter((s) => s.kind === 'standing');
    expect(standing.length).toBeGreaterThan(20);
    for (const s of standing) expect(s.zones).toHaveLength(1);
  });
});
