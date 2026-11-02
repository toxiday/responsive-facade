// The demo. Pick a city, a baked day and an hour; click anywhere in the room and the occupant
// walks there (M4): a piece of furniture takes its nearest seat, open floor a standing spot.
// The facade chases them as they walk and settles on the seat's activity when they arrive;
// on the sofa, clicking the TV turns it on and off. The "Go to" list walks them to an
// activity. The conventional facade can be shown instead for comparison. Changes play as a
// curtain. The selection lives in the URL, so a view can be linked (and shot by
// scripts/shoot.mjs); a linked state puts the occupant straight there.
//
// On first load the state is ambient, with the occupant just in from the entry door.

import { Object3D, Raycaster, Vector2 } from 'three';
import type { FurnitureItem, Manifest } from '../data/manifest';
import type { MonthData } from '../data/month';
import { MonthStore, type DataIndex } from '../data/store';
import { OccupantController } from '../occupant/controller';
import { Figure } from '../occupant/figure';
import { floorTarget, itemTarget, stateTarget, tvSeat, type Target } from '../occupant/targets';
import { WalkGrid, type Pt } from '../occupant/walk';
import { withEdges } from '../scene/edges';
import { Stage } from '../scene/stage';
import { Controls, type CityChoice, type Choice, type Selection } from '../ui/controls';
import { Readout } from '../ui/readout';
import { showRecord, type Layer, type RecordView } from './record';

const LAYER_IDS: Layer[] = ['none', 'radiance', 'surrogate'];
/** A few steps in from the entry door, clear of the open door leaf, facing into the room. */
const ENTRY: Pt = { x: 4.75, y: 8.8 };
const ENTRY_HEADING = 225;

export class App {
  readonly stage: Stage;
  readonly occupant: OccupantController;
  private readonly figure = new Figure();
  private readonly grid: WalkGrid;
  private readonly store = new MonthStore();
  private readonly controls: Controls;
  private readonly readout: Readout;
  private readonly cities: CityChoice[];
  private readonly raycaster = new Raycaster();
  private sel!: Selection;
  private data: MonthData | null = null;
  private view: RecordView | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly manifest: Manifest,
    host: HTMLElement,
    ui: HTMLElement,
    index: DataIndex,
  ) {
    this.cities = manifest.cities
      .filter((c) => index.months[c.id]?.length)
      .map((c) => ({
        id: c.id,
        label: c.label,
        months: index.months[c.id]!.map((m) => ({
          month: m,
          day: c.months.find((x) => x.month === m)?.day ?? 1,
        })),
      }));
    if (!this.cities.length) throw new Error('no baked data (data/index.json is empty)');
    const places: Choice[] = manifest.states
      .filter((s) => s.kind !== 'standing')
      .map((s) => ({ id: s.id, label: s.label }));

    this.stage = new Stage(manifest, host);
    this.stage.zones.showDot = false;
    this.grid = new WalkGrid(manifest.room, manifest.furniture);
    const start = this.grid.nearestFree(ENTRY)!;
    this.occupant = new OccupantController(manifest, this.grid, start, 'ambient', ENTRY_HEADING);
    this.occupant.canChase = () => !this.stage.facade.animating;
    this.occupant.onState = (id) => void this.set({ state: id });
    this.occupant.onArrive = () => this.refreshReadout();
    this.stage.scene.add(this.figure.group);
    this.stage.fill.apply(this.figure.group);
    withEdges(this.figure.group);
    this.stage.tickers.push((dt) => this.tick(dt));
    this.listen(this.stage.renderer.domElement);

    this.controls = new Controls(ui, this.cities, places, manifest.legend);
    this.readout = new Readout(ui);
    this.controls.onChange = (patch) => {
      if (patch.state !== undefined) return this.goToState(patch.state);
      void this.set(patch);
    };
    addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('select, input')) return;
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      const n = this.data?.nSlots ?? 0;
      if (step && n) void this.set({ slot: Math.min(n - 1, Math.max(0, this.sel.slot + step)) });
    });
  }

  /** First view, from the URL where it names a baked city-month; otherwise the defaults. */
  async start(params: URLSearchParams): Promise<void> {
    const city = this.cities.find((c) => c.id === params.get('city')) ?? this.cities[0]!;
    const month = city.months.find((m) => m.month === Number(params.get('month')))?.month;
    const layer = params.get('layer') as Layer | null;
    this.sel = {
      city: city.id,
      month: month ?? city.months[0]!.month,
      slot: -1, // resolved once the day is loaded
      state: 'ambient',
      layer: layer && LAYER_IDS.includes(layer) ? layer : 'none',
      compare: params.get('compare') === '1' || params.get('state') === 'baseline',
    };
    this.data = await this.store.get(this.sel.city, this.sel.month);
    const wanted = params.get('slot');
    const byLabel = this.data.meta.slots.findIndex((s) => s.label === wanted);
    this.sel.slot = byLabel >= 0 ? byLabel : this.highestSun(this.data);
    // A linked state puts the occupant straight there.
    const linked = params.get('state');
    const t = linked ? stateTarget(this.manifest, this.grid, linked) : null;
    if (t) {
      this.occupant.placeAt(t);
      this.sel.state = this.occupant.stateId;
    }
    this.tick(10); // pose the figure at once
    this.render(false);
  }

  /** Change the selection; the facade animates unless the day itself changed. */
  set(patch: Partial<Selection>): Promise<void> {
    this.pending = this.pending.then(async () => {
      const next = { ...this.sel, ...patch };
      if (next.city !== this.sel.city || next.month !== this.sel.month) {
        const prevLabel = this.data?.meta.slots[this.sel.slot]?.label;
        this.data = await this.store.get(next.city, next.month);
        const same = this.data.meta.slots.findIndex((s) => s.label === prevLabel);
        next.slot = patch.slot ?? (same >= 0 ? same : this.highestSun(this.data));
      }
      next.slot = Math.min(this.data!.nSlots - 1, Math.max(0, next.slot));
      this.sel = next;
      this.render(true);
    });
    return this.pending;
  }

  /** Walk the occupant to where a state is had (ambient: no walk, just the state). */
  goToState(stateId: string): void {
    if (stateId === 'ambient') {
      void this.set({ state: 'ambient' });
      return;
    }
    const t = stateTarget(this.manifest, this.grid, stateId);
    if (t) this.walkTo(t);
  }

  /** Click (or tap) at client coordinates, as the pointer handler does. */
  clickAt(clientX: number, clientY: number): void {
    const { item, point } = this.pick(clientX, clientY);
    if (item?.click === 'tv') {
      if (!this.occupant.toggleTv()) {
        const t = tvSeat(this.manifest, this.grid);
        if (t) this.walkTo(t);
      }
      return;
    }
    const t =
      (item && point ? itemTarget(this.manifest, this.grid, item, point) : null) ??
      (point ? floorTarget(this.manifest, this.grid, point) : null);
    if (t) this.walkTo(t);
  }

  /** Scripted shots: move the occupant on by `seconds` at once, in 60 Hz steps. */
  advance(seconds: number): void {
    for (let i = 0; i < Math.round(seconds * 60); i++) this.tick(1 / 60);
    this.stage.invalidate();
  }

  /** Scripted shots: make a change and freeze the animation `ms` into it. */
  async previewAt(patch: Partial<Selection>, ms: number): Promise<void> {
    const t0 = performance.now();
    this.stage.timeOverride = t0;
    await this.set(patch);
    this.stage.timeOverride = t0 + ms;
    this.stage.invalidate();
  }

  private walkTo(t: Target): void {
    if (this.occupant.goTo(t)) {
      this.refreshReadout();
      this.stage.invalidate();
    }
  }

  private tick(dt: number): boolean {
    const o = this.occupant;
    const moving = o.update(dt);
    const seat = o.seatedOn;
    // Sitting down blends into the seated pose; standing up into the standing one.
    const pose = o.mode === 'sitting' ? 'seated' : o.mode === 'rising' ? 'standing' : o.mode;
    const posing = this.figure.update(
      dt,
      o.pos,
      o.heading,
      pose,
      seat ? { height: seat.height, pose: seat.activity.pose } : null,
      o.walked,
    );
    return moving || posing;
  }

  /** The furniture or floor point under client coordinates. */
  private pick(clientX: number, clientY: number): { item: FurnitureItem | null; point: Pt | null } {
    const canvas = this.stage.renderer.domElement;
    const r = canvas.getBoundingClientRect();
    const ndc = new Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.stage.rig.camera);
    for (const hit of this.raycaster.intersectObject(this.stage.furniture, true)) {
      let o: Object3D | null = hit.object;
      while (o && !o.userData.item) o = o.parent;
      const item = o?.userData.item as FurnitureItem | undefined;
      if (item && (item.click || item.seats.length))
        return { item, point: { x: hit.point.x, y: -hit.point.z } };
    }
    const ray = this.raycaster.ray;
    if (Math.abs(ray.direction.y) < 1e-6) return { item: null, point: null };
    const t = -ray.origin.y / ray.direction.y;
    const x = ray.origin.x + t * ray.direction.x;
    const y = -(ray.origin.z + t * ray.direction.z);
    const { width: W, depth: D } = this.manifest.room;
    const inside = t > 0 && x >= 0 && y >= 0 && x <= W && y <= D;
    return { item: null, point: inside ? { x, y } : null };
  }

  /** Taps walk the occupant; drags orbit the camera. Hovering shows what can be clicked. */
  private listen(canvas: HTMLCanvasElement): void {
    let down: { x: number; y: number; t: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 600;
      down = null;
      if (moved < 6 && quick) this.clickAt(e.clientX, e.clientY);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      const { item, point } = this.pick(e.clientX, e.clientY);
      canvas.style.cursor = item || point ? 'pointer' : '';
    });
  }

  private highestSun(data: MonthData): number {
    let best = 0;
    data.meta.slots.forEach((s, i) => {
      if (s.alt > data.meta.slots[best]!.alt) best = i;
    });
    return best;
  }

  private refreshReadout(): void {
    if (!this.view || !this.data) return;
    const city = this.cities.find((c) => c.id === this.sel.city)!;
    const dest = this.occupant.destination;
    const walking =
      this.occupant.moving && dest
        ? dest.kind === 'seat'
          ? (this.manifest.states.find((s) => s.id === dest.stateId)?.label ?? dest.stateId)
          : 'a spot on the floor'
        : null;
    this.readout.show(
      this.manifest,
      this.view,
      city.label,
      this.sel.month,
      this.data.meta.day,
      walking,
    );
  }

  private render(animate: boolean): void {
    const data = this.data!;
    const shown = this.sel.compare ? 'baseline' : this.sel.state;
    this.view = showRecord(
      this.stage,
      this.manifest,
      data,
      this.sel.slot,
      shown,
      this.sel.layer,
      animate,
    );
    if (this.sel.compare) {
      // The conventional facade is judged against ambient; still outline where they are.
      this.stage.zones.set(this.manifest.states.find((s) => s.id === this.sel.state) ?? null);
    }
    this.controls.show(this.sel, data.meta.slots);
    this.refreshReadout();
    const q = new URLSearchParams(location.search); // keeps cam= and the like
    q.set('city', this.sel.city);
    q.set('month', String(this.sel.month));
    q.set('slot', data.meta.slots[this.sel.slot]!.label);
    q.set('state', this.sel.state);
    q.set('layer', this.sel.layer);
    if (this.sel.compare) q.set('compare', '1');
    else q.delete('compare');
    history.replaceState(null, '', `?${q}`);
  }
}
