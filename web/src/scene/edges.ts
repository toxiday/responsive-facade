// Linework: dark outlines on furniture, walls and the floor slab, like a line drawing laid over
// the shaded model. Screen-space, so rounded upholstery gets true silhouettes:
//   1. objects on EDGE_LAYER are drawn once more with view-space normals into a render target
//      that also keeps depth;
//   2. a full-screen pass draws a line wherever the normal turns sharply (creases, box edges)
//      or the depth steps (silhouettes; the line goes on the nearer side).
// The camera is orthographic, so depth is linear and a flat surface has zero second derivative
// in depth, which is what keeps sloped floors and walls free of false lines.
// Hidden (cutaway) surfaces are skipped; glass, the heatmap and debug overlays are not on the
// layer, so lines show through them.

import {
  BufferGeometry,
  Camera,
  Color,
  DepthTexture,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshNormalMaterial,
  type Object3D,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type WebGLRenderer,
  type Material,
} from 'three';

export const EDGE_LAYER = 2;
export const LINE_COLOR = new Color('#45423f');

/** Put the meshes in an object on the linework layer (they stay on layer 0 too). */
export function withEdges<T extends Object3D>(obj: T): T {
  obj.traverse((o) => {
    const mesh = o as Mesh;
    if (mesh.isMesh && !(mesh.material as Material).transparent) o.layers.enable(EDGE_LAYER);
  });
  return obj;
}

/** A closed outline on the floor, through room-frame (x, y) points at height z. */
export function floorLoop(points: [number, number][], z: number, color = LINE_COLOR): LineLoop {
  const pos: number[] = [];
  for (const [x, y] of points) pos.push(x, z, -y); // roomToThree
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  return new LineLoop(geo, new LineBasicMaterial({ color }));
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform vec2 texel;
uniform float spread;
uniform float near;
uniform float far;
uniform float depthStep;
uniform vec3 color;
uniform float opacity;
uniform vec2 weights;   // (creases, silhouettes)
varying vec2 vUv;

float viewZ(vec2 uv) {
  return near + texture2D(tDepth, uv).x * (far - near);   // orthographic: linear
}

float crease(vec4 a, vec4 b) {
  if (a.a < 0.5 || b.a < 0.5) return 0.0;
  return 1.0 - dot(a.xyz * 2.0 - 1.0, b.xyz * 2.0 - 1.0);
}

void main() {
  vec2 dx = vec2(texel.x * spread, 0.0);
  vec2 dy = vec2(0.0, texel.y * spread);
  // A crease must hold on both sides: the turn from this pixel must persist one and two samples
  // on, and also separate the pixels either side. A pixel or two that differs on its own is a
  // seam artefact (a hidden face winning the depth test where two coplanar boxes meet).
  vec4 nc = texture2D(tNormal, vUv);
  float nx = min(min(crease(nc, texture2D(tNormal, vUv + dx)),
                     crease(nc, texture2D(tNormal, vUv + 2.0 * dx))),
                 crease(texture2D(tNormal, vUv - dx), texture2D(tNormal, vUv + dx)));
  float ny = min(min(crease(nc, texture2D(tNormal, vUv + dy)),
                     crease(nc, texture2D(tNormal, vUv + 2.0 * dy))),
                 crease(texture2D(tNormal, vUv - dy), texture2D(tNormal, vUv + dy)));
  float n = max(nx, ny);
  float zc = viewZ(vUv);
  float lap = max(viewZ(vUv - dx) + viewZ(vUv + dx), viewZ(vUv - dy) + viewZ(vUv + dy)) - 2.0 * zc;
  float e = max(weights.x * smoothstep(0.12, 0.3, n),
                weights.y * smoothstep(depthStep, depthStep * 2.0, lap));
  if (e <= 0.0) discard;
  gl_FragColor = vec4(color, e * opacity);
}`;

export class EdgePass {
  private readonly target: WebGLRenderTarget;
  private readonly normals = new MeshNormalMaterial();
  private readonly quad: Mesh;
  private readonly quadScene = new Scene();
  private readonly quadCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: ShaderMaterial;
  enabled = true;

  constructor() {
    this.target = new WebGLRenderTarget(1, 1, { depthTexture: new DepthTexture(1, 1) });
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        tNormal: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        texel: { value: new Vector2(1, 1) },
        spread: { value: 1 },
        near: { value: 0.1 },
        far: { value: 200 },
        depthStep: { value: 0.03 },
        color: { value: LINE_COLOR },
        opacity: { value: 0.85 },
        weights: { value: new Vector2(1, 1) },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** Which lines to draw: creases (normal turns) and silhouettes (depth steps). */
  setKinds(creases: boolean, silhouettes: boolean): void {
    this.material.uniforms.weights!.value.set(creases ? 1 : 0, silhouettes ? 1 : 0);
  }

  /** Match the drawing buffer (CSS size × pixel ratio). */
  setSize(width: number, height: number, pixelRatio: number): void {
    this.target.setSize(width, height);
    this.material.uniforms.texel!.value.set(1 / width, 1 / height);
    this.material.uniforms.spread!.value = Math.max(1, Math.round(pixelRatio));
  }

  /** Draw the lines over what the renderer just drew to the screen. */
  render(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
    if (!this.enabled) return;
    const cam = camera as OrthographicCamera;
    this.material.uniforms.near!.value = cam.near;
    this.material.uniforms.far!.value = cam.far;

    // Hide what the cutaway hides (colorWrite off) for the normal pass.
    const hidden: Object3D[] = [];
    scene.traverseVisible((o) => {
      const mat = (o as Mesh).material as Material | Material[] | undefined;
      if (!mat) return;
      const mats = Array.isArray(mat) ? mat : [mat];
      if (mats.every((m) => !m.colorWrite)) hidden.push(o);
    });
    for (const o of hidden) o.visible = false;

    const mask = camera.layers.mask;
    const background = scene.background;
    const autoShadow = renderer.shadowMap.autoUpdate;
    const clearAlpha = renderer.getClearAlpha();
    const clearColor = renderer.getClearColor(new Color());
    camera.layers.set(EDGE_LAYER);
    scene.background = null;
    scene.overrideMaterial = this.normals;
    renderer.shadowMap.autoUpdate = false;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, camera);

    renderer.setRenderTarget(null);
    renderer.setClearColor(clearColor, clearAlpha);
    renderer.shadowMap.autoUpdate = autoShadow;
    scene.overrideMaterial = null;
    scene.background = background;
    camera.layers.mask = mask;
    for (const o of hidden) o.visible = true;

    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.quadScene, this.quadCam);
    renderer.autoClear = autoClear;
  }
}
