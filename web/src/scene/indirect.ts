// Daylight fill from the bake (Tony, 2026-11-01). Inside the room the uniform sky light is
// replaced by the illuminance Radiance found there, so a bright state renders bright and a dim
// one dim, at the same exposure (sun.ts: white at 200 lux = 50% grey). The fill scales the
// hemisphere light per fragment, looked up at the fragment's room (x, y) on the 32×32 grid.
//
// Radiance's grid includes direct sun, which the shadow-mapped sun light already draws as crisp
// patches. So the cells the sun reaches (the geometric lit mask, grown by one cell for patch
// edges) are filled in from their sunless neighbours first, leaving only the diffuse and
// interreflected light. That light varies smoothly, so the field is then blurred lightly to
// take out Radiance's sampling noise (about 10 lux cell to cell), which would otherwise show as
// blotches in dim rooms. Window reveals count as inside; the walls' exterior faces keep the sky
// light unchanged.
//
// Upward faces take the field where they are. A vertical face takes it FACING_M in front of
// itself, in the direction it faces: a wall is lit by the room it looks at, not by the floor at
// its foot. Otherwise a window wall glows like the floor beside its own windows, which it cannot
// see; and furniture sides facing a window now read brighter than sides facing away.

import {
  DataTexture,
  FloatType,
  Material,
  MeshStandardMaterial,
  NearestFilter,
  Object3D,
  RedFormat,
  ShaderChunk,
  Vector4,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import type { Room } from '../data/manifest';
import { GRID_N } from '../data/grid';
import { WALL_T } from './shell';
import { AMBIENT_LUX } from './sun';

const CELLS = GRID_N * GRID_N;

/** Grow a 32×32 mask by one cell in all eight directions. */
function dilate(mask: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(CELLS);
  for (let r = 0; r < GRID_N; r++)
    for (let c = 0; c < GRID_N; c++) {
      if (!mask[r * GRID_N + c]) continue;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr >= 0 && rr < GRID_N && cc >= 0 && cc < GRID_N) out[rr * GRID_N + cc] = 1;
        }
    }
  return out;
}

/** One pass of a 3×3 binomial blur, edges clamped; keeps uniform fields and linear ramps. */
function blur(v: Float32Array): Float32Array {
  const w = [0.25, 0.5, 0.25];
  const at = (r: number, c: number) =>
    v[Math.min(GRID_N - 1, Math.max(0, r)) * GRID_N + Math.min(GRID_N - 1, Math.max(0, c))]!;
  const out = new Float32Array(CELLS);
  for (let r = 0; r < GRID_N; r++)
    for (let c = 0; c < GRID_N; c++) {
      let s = 0;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) s += w[dr + 1]! * w[dc + 1]! * at(r + dr, c + dc);
      out[r * GRID_N + c] = s;
    }
  return out;
}

/**
 * Lux without the direct sun: the `lit` cells (grown by one) are replaced by a smooth fill from
 * the rest (Laplace's equation, room edges insulated), then the field is blurred once.
 */
export function indirectLux(lux: ArrayLike<number>, lit: ArrayLike<number> | null): Float32Array {
  return blur(fillSun(Float32Array.from(lux), lit));
}

function fillSun(v: Float32Array, lit: ArrayLike<number> | null): Float32Array {
  if (!lit) return v;
  const hole = dilate(lit);
  let known = 0;
  let sum = 0;
  for (let i = 0; i < CELLS; i++)
    if (!hole[i]) {
      known++;
      sum += v[i]!;
    }
  if (known === 0 || known === CELLS) return v;
  const mean = sum / known;
  for (let i = 0; i < CELLS; i++) if (hole[i]) v[i] = mean;
  // Successive over-relaxation; 32×32 converges well within this.
  for (let it = 0; it < 400; it++)
    for (let r = 0; r < GRID_N; r++)
      for (let c = 0; c < GRID_N; c++) {
        const i = r * GRID_N + c;
        if (!hole[i]) continue;
        let s = 0;
        let n = 0;
        for (const [ok, j] of [
          [r > 0, i - GRID_N],
          [r < GRID_N - 1, i + GRID_N],
          [c > 0, i - 1],
          [c < GRID_N - 1, i + 1],
        ] as const)
          if (ok) {
            s += v[j]!;
            n++;
          }
        v[i] = v[i]! + 1.8 * (s / n - v[i]!);
      }
  return v;
}

/** How far in front of a vertical face its light level is taken (m). */
const FACING_M = 1.5;

const HEMI = 'irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );';

const PARS = /* glsl */ `
uniform sampler2D rfFill;  // 32x32 fill factor (lux / AMBIENT_LUX), texel (col, 31 - row)
uniform vec4 rfFillRoom;   // room width, depth, 1 when the fill is on, inside margin (m)
float rfFillAt( ivec2 p ) {
  return texelFetch( rfFill, clamp( p, ivec2( 0 ), ivec2( 31 ) ), 0 ).r;
}
float rfFillFactor( vec3 viewPos, vec3 viewNormal ) {
  if ( rfFillRoom.z < 0.5 ) return 1.0;
  // View to world (viewMatrix is rigid), then three (x, y, z) to room (x, -z).
  vec3 w = ( vec4( viewPos - viewMatrix[ 3 ].xyz, 0.0 ) * viewMatrix ).xyz;
  vec2 xy = vec2( w.x, - w.z );
  // Inside up to just short of the walls' exterior faces, so window reveals take the fill.
  if ( any( lessThan( xy, vec2( - rfFillRoom.w ) ) ) ||
       any( greaterThan( xy, rfFillRoom.xy + rfFillRoom.w ) ) ) return 1.0;
  vec3 n = ( vec4( viewNormal, 0.0 ) * viewMatrix ).xyz;
  vec2 q = xy + ${FACING_M.toFixed(2)} * vec2( n.x, - n.z ); // horizontal part of the normal
  vec2 g = q / rfFillRoom.xy * 32.0 - 0.5;
  ivec2 i = ivec2( floor( g ) );
  vec2 f = fract( g );
  return mix( mix( rfFillAt( i ), rfFillAt( i + ivec2( 1, 0 ) ), f.x ),
              mix( rfFillAt( i + ivec2( 0, 1 ) ), rfFillAt( i + ivec2( 1, 1 ) ), f.x ), f.y );
}
`;

export class DaylightFill {
  private readonly data = new Float32Array(CELLS);
  private readonly uniforms: {
    rfFill: { value: DataTexture };
    rfFillRoom: { value: Vector4 };
  };
  private readonly patched = new WeakSet<Material>();

  constructor(room: Room) {
    const tex = new DataTexture(this.data, GRID_N, GRID_N, RedFormat, FloatType);
    tex.minFilter = tex.magFilter = NearestFilter;
    tex.needsUpdate = true;
    this.uniforms = {
      rfFill: { value: tex },
      rfFillRoom: { value: new Vector4(room.width, room.depth, 0, WALL_T - 0.01) },
    };
  }

  /** Indirect lux in floor-grid order (see indirectLux), or null for the uniform sky light. */
  set(lux: ArrayLike<number> | null): void {
    this.uniforms.rfFillRoom.value.z = lux ? 1 : 0;
    if (!lux) return;
    for (let r = 0; r < GRID_N; r++)
      for (let c = 0; c < GRID_N; c++)
        this.data[(GRID_N - 1 - r) * GRID_N + c] = (lux[r * GRID_N + c] ?? 0) / AMBIENT_LUX;
    this.uniforms.rfFill.value.needsUpdate = true;
  }

  /** Patch every standard material under `root` to take the fill. */
  apply(root: Object3D): void {
    root.traverse((o) => {
      const m = (o as Object3D & { material?: Material | Material[] }).material;
      for (const mat of Array.isArray(m) ? m : m ? [m] : [])
        if (mat instanceof MeshStandardMaterial) this.patch(mat);
    });
  }

  private patch(mat: MeshStandardMaterial): void {
    if (this.patched.has(mat)) return;
    this.patched.add(mat);
    const uniforms = this.uniforms;
    mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
      Object.assign(shader.uniforms, uniforms);
      const begin = ShaderChunk.lights_fragment_begin;
      if (!begin.includes(HEMI)) throw new Error('three.js hemisphere light code not found');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <lights_pars_begin>', `#include <lights_pars_begin>\n${PARS}`)
        .replace(
          '#include <lights_fragment_begin>',
          begin.replace(
            HEMI,
            HEMI.replace(
              'irradiance += ',
              'irradiance += rfFillFactor( geometryPosition, geometryNormal ) * ',
            ),
          ),
        );
    };
    mat.customProgramCacheKey = () => 'rf-daylight-fill';
    mat.needsUpdate = true;
  }
}
