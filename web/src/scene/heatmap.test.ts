import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Manifest } from '../data/manifest';
import { floorMask, rampPosition } from './heatmap';

const manifest = JSON.parse(
  readFileSync(new URL('../../public/data/manifest.json', import.meta.url), 'utf8'),
) as Manifest;
const { room } = manifest;
const mask = floorMask(room, manifest.furniture);
const hidden = (x: number, y: number) => {
  const i = Math.min(mask.nx - 1, Math.floor((x / room.width) * mask.nx));
  const j = Math.min(mask.ny - 1, Math.floor((y / room.depth) * mask.ny));
  return mask.cells[j * mask.nx + i] === 1;
};

describe('floorMask', () => {
  it('hides the work plane inside the kitchen run, out to the walls behind it', () => {
    const counter = manifest.furniture.find((f) => f.id === 'counter_0')!;
    const [x0, y0, x1, y1] = counter.bbox;
    expect(hidden((x0 + x1) / 2, (y0 + y1) / 2)).toBe(true);
    expect(hidden((x0 + x1) / 2, room.depth - 0.02)).toBe(true); // the gap at the N wall
    expect(hidden(0.02, (y0 + y1) / 2)).toBe(true); // and at the W wall
  });

  it('leaves open floor and tables visible', () => {
    expect(hidden(room.width / 2, room.depth / 2)).toBe(false);
    const table = manifest.furniture.find((f) => f.type === 'dining_table')!;
    const [x0, y0, x1, y1] = table.bbox;
    expect(hidden((x0 + x1) / 2, (y0 + y1) / 2)).toBe(false);
  });
});

describe('rampPosition', () => {
  it('is linear from 0 to the top of the legend, as in the presentation', () => {
    expect(rampPosition(0, 3000)).toBe(0);
    expect(rampPosition(1500, 3000)).toBe(0.5);
    expect(rampPosition(9000, 3000)).toBe(1);
  });
});
