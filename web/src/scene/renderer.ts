import { CustomToneMapping, PCFShadowMap, SRGBColorSpace, ShaderChunk, WebGLRenderer } from 'three';

export interface RendererOptions {
  /** Shadow map edge in texels; guidelines §7: one 2048 map, smaller on mobile. */
  shadowSize: number;
}

export function rendererOptions(): RendererOptions {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return { shadowSize: coarse ? 1024 : 2048 };
}

// Tone mapping: the highlight roll-off of Khronos PBR Neutral (three's NeutralToneMapping)
// without its toe. Below 0.8 (linear) colours pass through unchanged, so hues hold at the
// display exposure (sun.ts: white at 200 lux = 50% grey); brighter values (sun patches)
// compress smoothly to white. Neutral's toe subtracts up to 0.04 from every channel, which
// crushes dark colours such as Deep Slate Olive to black.
const CUSTOM_HOOK = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
const ROLL_OFF = /* glsl */ `vec3 CustomToneMapping( vec3 color ) {
  const float start = 0.8;
  const float desaturation = 0.15;
  color *= toneMappingExposure;
  float peak = max( color.r, max( color.g, color.b ) );
  if ( peak < start ) return color;
  float d = 1.0 - start;
  float newPeak = 1.0 - d * d / ( peak + d - start );
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / ( desaturation * ( peak - newPeak ) + 1.0 );
  return mix( color, vec3( newPeak ), g );
}`;

function installToneMapping(): void {
  const chunk = ShaderChunk.tonemapping_pars_fragment;
  if (chunk.includes(ROLL_OFF)) return;
  if (!chunk.includes(CUSTOM_HOOK)) throw new Error('three.js tone mapping hook not found');
  ShaderChunk.tonemapping_pars_fragment = chunk.replace(CUSTOM_HOOK, ROLL_OFF);
}

export function createRenderer(parent: HTMLElement): WebGLRenderer {
  installToneMapping();
  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(parent.clientWidth, parent.clientHeight);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = CustomToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  parent.appendChild(renderer.domElement);
  return renderer;
}
