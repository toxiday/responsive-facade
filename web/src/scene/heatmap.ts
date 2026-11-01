// Illuminance map on the 0.6 m work plane (docs/decisions.md: the sensor height, so it lines
// up with the sun patch). 32×32 lux, bilinear between cell centres, coloured with the bake's
// legend ramp (v3's LUX_CMAP, 0–3000 lux), with contours at the usable floor (300) and the
// glare threshold (3000).

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
import type { Legend, Room } from '../data/manifest';
import { GRID_N } from '../data/grid';
import { roomToThree } from './frame';

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
uniform float uVmax;
uniform float uOpacity;
uniform vec2 uLevels;     // usable floor, glare threshold
in vec2 vUv;
out vec4 outColor;

float lux(ivec2 p) {
  p = clamp(p, ivec2(0), ivec2(31));
  return texelFetch(uLux, p, 0).r;
}

void main() {
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

  constructor(room: Room, legend: Legend, z = room.sensor_height) {
    this.tex = new DataTexture(this.data, GRID_N, GRID_N, RedFormat, FloatType);
    this.tex.minFilter = this.tex.magFilter = NearestFilter;
    this.tex.needsUpdate = true;
    const lut = new Uint8Array(256 * 4);
    legend.lut.forEach(([r, g, b], i) => lut.set([r, g, b, 255], i * 4));
    const lutTex = new DataTexture(lut, 256, 1, RGBAFormat, UnsignedByteType);
    lutTex.needsUpdate = true;

    const material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        uLux: { value: this.tex },
        uLut: { value: lutTex },
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
