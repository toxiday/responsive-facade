import { ACESFilmicToneMapping, PCFShadowMap, SRGBColorSpace, WebGLRenderer } from 'three';

export interface RendererOptions {
  /** Shadow map edge in texels; guidelines §7: one 2048 map, smaller on mobile. */
  shadowSize: number;
}

export function rendererOptions(): RendererOptions {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return { shadowSize: coarse ? 1024 : 2048 };
}

export function createRenderer(parent: HTMLElement): WebGLRenderer {
  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(parent.clientWidth, parent.clientHeight);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  parent.appendChild(renderer.domElement);
  return renderer;
}
