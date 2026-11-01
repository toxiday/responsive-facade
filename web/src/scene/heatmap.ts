// Illuminance map on the 0.6 m work plane (docs/decisions.md: the sensor height, so it lines
// up with the sun patch). 32×32 lux, bilinear between cell centres, coloured exactly as the
// Facade Optimizer presentation (Tony, 2026-11-01): v3's LUX_CMAP, linear from 0 to 3000+ lux
// (the bake's legend LUT matches the deck's legend to within one level). Contours at the
// usable floor (300) and the glare threshold (3000).
//
// The plane is hidden inside the solid kitchen pieces (counters, range, fridge, island, base
// cabinets): there it would only show through the gaps behind them, as a coloured strip.

import {
  DataTexture,
  DoubleSide,
  FloatType,
  GLSL3,
  Mesh,
  NearestFilter,
  PlaneGeometry,
  RedFormat,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
} from 'three';
import type { FurnitureItem, Legend, Room } from '../data/manifest';
import { GRID_N } from '../data/grid';
import { roomToThree } from './frame';

/** Position 0–1 of `lux` on the ramp (linear, 0 to `vmax`, clamped above as "3000+"). */
export function rampPosition(lux: number, vmax: number): number {
  return Math.min(1, Math.max(0, lux / vmax));
}

const SOLID = new Set(['counter', 'range', 'fridge', 'island', 'cabinet']);
const MASK_CELL = 0.1; // m
const WALL_GAP = 0.12; // pieces this close to a wall are taken to meet it

export interface FloorMask {
  nx: number;
  ny: number;
  /** Row-major, row 0 at the S edge (y = 0); 1 = hidden. */
  cells: Uint8Array;
}

/** Cells of the work plane inside solid pieces standing on the floor and rising above it. */
export function floorMask(room: Room, furniture: FurnitureItem[]): FloorMask {
  const { width: W, depth: D, sensor_height: z } = room;
  const nx = Math.ceil(W / MASK_CELL);
  const ny = Math.ceil(D / MASK_CELL);
  const cells = new Uint8Array(nx * ny);
  for (const f of furniture) {
    if (!SOLID.has(f.type) || f.z0 >= z || f.z1 <= z) continue;
    let [x0, y0, x1, y1] = f.bbox;
    if (x0 < WALL_GAP) x0 = 0;
    if (y0 < WALL_GAP) y0 = 0;
    if (x1 > W - WALL_GAP) x1 = W;
    if (y1 > D - WALL_GAP) y1 = D;
    for (let j = 0; j < ny; j++) {
      const y = ((j + 0.5) * D) / ny;
      if (y < y0 || y > y1) continue;
      for (let i = 0; i < nx; i++) {
        const x = ((i + 0.5) * W) / nx;
        if (x >= x0 && x <= x1) cells[j * nx + i] = 1;
      }
    }
  }
  return { nx, ny, cells };
}

const vertexShader = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const fragmentShader = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D uLux;   // 32x32, texel (col, 31 - row)
uniform sampler2D uLut;   // 256x1 sRGB ramp, used as-is
uniform sampler2D uMask;  // floor mask, texel (x, y from S); 1 = hidden
uniform float uVmax;      // the ramp's top (lux); linear from 0
uniform float uOpacity;
uniform vec2 uLevels;     // usable floor, glare threshold
in vec2 vUv;
out vec4 outColor;

float lux(ivec2 p) {
  p = clamp(p, ivec2(0), ivec2(31));
  return texelFetch(uLux, p, 0).r;
}

void main() {
  if (texture(uMask, vUv).r > 0.5) discard;
  vec2 g = vUv * 32.0 - 0.5;
  ivec2 i = ivec2(floor(g));
  vec2 f = fract(g);
  float v = mix(mix(lux(i), lux(i + ivec2(1, 0)), f.x),
                mix(lux(i + ivec2(0, 1)), lux(i + ivec2(1, 1)), f.x), f.y);
  float t = clamp(v / uVmax, 0.0, 1.0);
  vec3 col = texture(uLut, vec2(t * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).rgb;
  float w = max(fwidth(v), 1e-3);
  float usable = 1.0 - smoothstep(0.6, 1.6, abs(v - uLevels.x) / w);
  float glare = 1.0 - smoothstep(0.6, 1.6, abs(v - uLevels.y) / w);
  col = mix(col, vec3(1.0), usable * 0.95);
  col = mix(col, vec3(0.05), glare * 0.95);
  outColor = vec4(col, uOpacity);
}`;

export class Heatmap {
  readonly mesh: Mesh;
  private readonly data = new Float32Array(GRID_N * GRID_N);
  private readonly tex: DataTexture;

  constructor(room: Room, legend: Legend, furniture: FurnitureItem[] = [], z = room.sensor_height) {
    this.tex = new DataTexture(this.data, GRID_N, GRID_N, RedFormat, FloatType);
    this.tex.minFilter = this.tex.magFilter = NearestFilter;
    this.tex.needsUpdate = true;
    const lut = new Uint8Array(256 * 4);
    legend.lut.forEach(([r, g, b], i) => lut.set([r, g, b, 255], i * 4));
    const lutTex = new DataTexture(lut, 256, 1, RGBAFormat, UnsignedByteType);
    lutTex.needsUpdate = true;
    const m = floorMask(room, furniture);
    const maskTex = new DataTexture(
      Uint8Array.from(m.cells, (v) => v * 255),
      m.nx,
      m.ny,
      RedFormat,
      UnsignedByteType,
    );
    maskTex.minFilter = maskTex.magFilter = NearestFilter;
    maskTex.needsUpdate = true;

    const material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        uLux: { value: this.tex },
        uLut: { value: lutTex },
        uMask: { value: maskTex },
        uVmax: { value: legend.vmax },
        uOpacity: { value: 0.88 },
        uLevels: { value: new Vector2(legend.usable[0], legend.glare) },
      },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    });
    this.mesh = new Mesh(new PlaneGeometry(room.width, room.depth), material);
    this.mesh.rotation.x = -Math.PI / 2; // plane +y (uv v) → room +y (north)
    roomToThree(room.width / 2, room.depth / 2, z, this.mesh.position);
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
  }

  /** lux: 1024 values in floor-grid order (row 0 = N edge, col 0 = W edge). */
  set(lux: ArrayLike<number>): void {
    for (let r = 0; r < GRID_N; r++)
      for (let c = 0; c < GRID_N; c++)
        this.data[(GRID_N - 1 - r) * GRID_N + c] = lux[r * GRID_N + c] ?? 0;
    this.tex.needsUpdate = true;
  }
}
