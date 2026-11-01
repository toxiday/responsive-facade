// Orientation test pattern (guidelines §5, M1). All four walls are drawn as facade grids.
//   Each wall: its letter and an arrowhead in window panels (5×7 font, doubled; the arrow
//   points towards increasing col), plus a red panel at (row 0, col 0).
//   Expected: S and E letters read correctly from OUTSIDE; N and W read correctly from INSIDE
//   (col 0 is at x = 0 on S/N and at y = 0 on E/W). The red panel sits at the top of the
//   W end of S and N, and at the top of the S end of E and W.
//   Floor: a red Γ in the NW corner (row 0 = N edge, col 0 = W edge), a blue dot in the SE.

import {
  CanvasTexture,
  Color,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  PlaneGeometry,
  SRGBColorSpace,
} from 'three';
import type { Manifest, Side } from '../data/manifest';
import { GRID_N } from '../data/grid';
import { COLS, SIDES, bitIndex } from '../facade/geometry';
import { roomToThree } from '../scene/frame';
import { Stage } from '../scene/stage';

// Arrowhead after each letter, pointing towards increasing col (W alone is symmetric).
const ARROW = ['#..', '##.', '###', '##.', '#..'];

const FONT: Record<Side, string[]> = {
  S: ['.###.', '#...#', '#....', '.###.', '....#', '#...#', '.###.'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
};

export function patternBits(): Uint8Array {
  const bits = new Uint8Array(4 * 512);
  const draw = (side: Side, glyph: string[], row0: number, col0: number) =>
    glyph.forEach((line, gr) =>
      [...line].forEach((ch, gc) => {
        if (ch !== '#') return;
        for (let dr = 0; dr < 2; dr++)
          for (let dc = 0; dc < 2; dc++) {
            const col = col0 + gc * 2 + dc;
            if (col < COLS) bits[bitIndex(side, row0 + gr * 2 + dr, col)] = 1;
          }
      }),
    );
  for (const side of SIDES) {
    draw(side, FONT[side], 1, 4);
    draw(side, ARROW, 3, 17);
  }
  return bits;
}

/** Floor glyph cells: Γ at the NW corner (row 0 cols 0–7, col 0 rows 0–5). */
export function floorGlyph(): { red: number[]; blue: number[] } {
  const red: number[] = [];
  for (let c = 0; c < 8; c++) red.push(c);
  for (let r = 1; r < 6; r++) red.push(r * GRID_N);
  return { red, blue: [GRID_N * GRID_N - 1] };
}

export function runPattern(manifest: Manifest, host: HTMLElement): Stage {
  const room = { ...manifest.room, open: [true, true, true, true] };
  const stage = new Stage({ ...manifest, room }, host, { facadeSides: [...SIDES] });
  stage.furniture.visible = false;
  stage.facade.setBits(patternBits());
  for (const side of SIDES) stage.facade.tint(side, 0, 0, new Color('#e0001b'));

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = GRID_N;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, GRID_N, GRID_N);
  const { red, blue } = floorGlyph();
  ctx.fillStyle = '#e0001b';
  for (const i of red) ctx.fillRect(i % GRID_N, Math.floor(i / GRID_N), 1, 1);
  ctx.fillStyle = '#1b4de0';
  for (const i of blue) ctx.fillRect(i % GRID_N, Math.floor(i / GRID_N), 1, 1);
  const tex = new CanvasTexture(canvas);
  tex.magFilter = tex.minFilter = NearestFilter;
  tex.colorSpace = SRGBColorSpace;
  // Canvas row 0 (top) → v = 1 → room y = D: canvas pixel (c, r) is floor cell (r, c).
  const floor = new Mesh(
    new PlaneGeometry(room.width, room.depth),
    new MeshBasicMaterial({ map: tex }),
  );
  floor.rotation.x = -Math.PI / 2;
  roomToThree(room.width / 2, room.depth / 2, 0.002, floor.position);
  stage.scene.add(floor);
  stage.setSun(null);
  return stage;
}
