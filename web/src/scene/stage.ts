// Assembles the scene and owns the render loop. Renders on demand (camera moves, data
// changes) rather than every frame, to stay light on laptops and phones.

import { Scene, type Group, type Object3D } from 'three';
import type { Manifest, Side } from '../data/manifest';
import { FacadeMesh } from '../facade/facadeMesh';
import { createViewRig, type ViewRig } from './camera';
import { createCompass } from './compass';
import { Cutaway } from './cutaway';
import { buildFurniture } from './furniture';
import { Heatmap } from './heatmap';
import { PALETTE } from './materials';
import { createRenderer, rendererOptions } from './renderer';
import { createShell, type Shell } from './shell';
import { SunLight, type SunSlot } from './sun';
import type { WebGLRenderer } from 'three';

export class Stage {
  readonly scene = new Scene();
  readonly renderer: WebGLRenderer;
  readonly rig: ViewRig;
  readonly shell: Shell;
  readonly facade: FacadeMesh;
  readonly furniture: Group;
  readonly sun: SunLight;
  readonly heatmap: Heatmap;
  readonly cutaway: Cutaway;
  private dirty = true;
  private frames = 0;
  onFrame: (() => void) | null = null;

  constructor(
    readonly manifest: Manifest,
    private readonly host: HTMLElement,
    opts: { facadeSides?: Side[] } = {},
  ) {
    const { room } = manifest;
    this.scene.background = PALETTE.background;
    this.renderer = createRenderer(host);
    this.rig = createViewRig(room, this.renderer.domElement);
    this.shell = createShell(room);
    this.facade = new FacadeMesh(room, opts.facadeSides);
    this.furniture = buildFurniture(manifest.furniture);
    this.sun = new SunLight(room, rendererOptions().shadowSize);
    this.heatmap = new Heatmap(room, manifest.legend);
    this.scene.add(
      this.shell.group,
      this.facade.group,
      this.furniture,
      this.sun.light,
      this.sun.light.target,
      this.sun.sky,
      this.heatmap.mesh,
      createCompass(room),
    );

    const parts: Record<Side, Object3D[]> = this.facade.parts();
    for (const side of room.sides) parts[side].push(...this.shell.walls[side]);
    this.cutaway = new Cutaway(
      parts,
      [this.shell.ceiling],
      this.shell.corners.map((c) => ({ obj: c.mesh, sides: c.sides })),
    );

    this.rig.controls.addEventListener('change', () => this.invalidate());
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.loop();
  }

  setSun(slot: SunSlot | null): void {
    this.sun.set(slot);
    this.invalidate();
  }

  invalidate(): void {
    this.dirty = true;
  }

  /** Frames rendered so far (debug pages wait for a few before reading pixels). */
  get frameCount(): number {
    return this.frames;
  }

  private resize(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    this.renderer.setSize(w, h);
    this.rig.resize(w, h);
    this.invalidate();
  }

  private loop = (): void => {
    requestAnimationFrame(this.loop);
    const moving = this.rig.controls.update();
    if (!this.dirty && !moving) return;
    this.dirty = false;
    this.cutaway.update(this.rig.camera, this.rig.target);
    this.renderer.render(this.scene, this.rig.camera);
    this.frames++;
    this.onFrame?.();
  };
}
