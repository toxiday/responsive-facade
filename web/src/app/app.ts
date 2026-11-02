// The demo. Pick a city, a baked day and an hour; click anywhere in the room and the occupant
// walks there (M4): a piece of furniture takes its nearest seat, open floor a standing spot.
// The facade chases them as they walk and settles on the seat's activity when they arrive (or,
// with "Hold until they arrive", keeps its state for the whole walk); on the sofa, clicking the
// TV turns it on and off. The "Go to" list walks them to an activity. The conventional facade
// can be shown instead for comparison. Changes play as a curtain. Time runs on by itself, 5 s a
// baked hour with a 10 s night between days, unless frozen (clock.ts). The selection lives in
// the URL, so a view can be linked (and shot by scripts/shoot.mjs).
//
// By default the occupant follows a daily schedule (schedule.ts), starting at the hour's
// activity; a click, the "Go to" list or the TV takes over from it, and the box unticks. With
// the schedule off, a linked state puts the occupant straight there; otherwise they start
// just in from the entry door, in ambient.

import { Object3D, Raycaster, Vector2 } from 'three';
import type { FurnitureItem, Manifest } from '../data/manifest';
import type { MonthData } from '../data/month';
import { MonthStore, type DataIndex } from '../data/store';
import { OccupantController, RISE_S, SIT_S, WALK_SPEED } from '../occupant/controller';
import { Figure } from '../occupant/figure';
import { floorTarget, itemTarget, stateTarget, tvSeat, type Target } from '../occupant/targets';
import { pathLength, WalkGrid, type Pt } from '../occupant/walk';
import { withEdges } from '../scene/edges';
import { Stage } from '../scene/stage';
import { Controls, type CityChoice, type Choice, type Selection } from '../ui/controls';
import { Readout } from '../ui/readout';
import { TimeBar } from '../ui/timebar';
import { DayClock, HOUR_S, NIGHT_S } from './clock';
import { showRecord, type Layer, type RecordView } from './record';
import { MIN_STAY_S, nextPlanned, plannedState, scheduleGoal } from './schedule';

const LAYER_IDS: Layer[] = ['none', 'radiance', 'surrogate'];
/** A few steps in from the entry door, clear of the open door leaf, facing into the room. */
const ENTRY: Pt = { x: 4.75, y: 8.8 };
const ENTRY_HEADING = 225;
/** Allowance for turning on the spot when the schedule times a walk. */
const TURN_S = 0.3;

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
  private readonly clock = new DayClock();
  private readonly timebar: TimeBar;
  /** The hour the clock is on: the slot shown, or the next one while its set() is pending. */
  private hour = 0;
  /** The daylight level and night as last put on the stage. */
  private daylight = 1;
  private night = false;
  /** The state the schedule last sent the occupant to; walk times between states, by pair. */
  private scheduled: string | null = null;
  private readonly walkTimes = new Map<string, number>();
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
    this.occupant.canChase = () => !this.sel.hold && !this.stage.facade.animating;
    this.occupant.onState = (id) => void this.set({ state: id });
    this.occupant.onArrive = () => this.refreshReadout();
    this.stage.scene.add(this.figure.group);
    this.stage.fill.apply(this.figure.group);
    withEdges(this.figure.group);
    this.stage.tickers.push((dt) => this.step(dt));
    this.listen(this.stage.renderer.domElement);

    this.controls = new Controls(ui, this.cities, places, manifest.legend);
    this.readout = new Readout(ui);
    this.controls.onChange = (patch) => {
      if (patch.state !== undefined) return this.goToState(patch.state);
      if (patch.hold !== undefined || patch.schedule !== undefined)
        return void this.setOptions(patch);
      void this.set(patch);
    };
    this.timebar = new TimeBar(ui);
    this.timebar.onPick = (slot) => {
      this.clock.restart();
      void this.set({ slot });
    };
    this.timebar.onFreeze = (freeze) => void this.setOptions({ freeze });
    addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('select, input')) return;
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      const n = this.data?.nSlots ?? 0;
      if (!step || !n) return;
      this.clock.restart();
      void this.set({ slot: Math.min(n - 1, Math.max(0, this.sel.slot + step)) });
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
      hold: params.get('hold') === '1',
      freeze: params.get('freeze') === '1',
      schedule: params.get('schedule') !== '0',
    };
    this.data = await this.store.get(this.sel.city, this.sel.month);
    const wanted = params.get('slot');
    const byLabel = this.data.meta.slots.findIndex((s) => s.label === wanted);
    this.sel.slot = byLabel >= 0 ? byLabel : this.highestSun(this.data);
    // On schedule, the occupant starts at the hour's activity; off it, a linked state puts them
    // straight there.
    const linked = this.sel.schedule
      ? plannedState(this.data.meta.slots[this.sel.slot]!.label)
      : params.get('state');
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

  /**
   * The options that change no view. Hold: the facade keeps its state while the occupant walks,
   * or chases them again from their next step. Schedule: the occupant follows the daily
   * schedule again (from where they are), or stays put. Freeze: the clock stops at the start of the
   * hour shown, or runs on from there; frozen at night, the day starts. Otherwise nothing is
   * redrawn, so a curtain already moving finishes as it was.
   */
  setOptions(patch: Partial<Pick<Selection, 'hold' | 'freeze' | 'schedule'>>): Promise<void> {
    if (patch.schedule) this.scheduled = null; // walk to this hour's activity
    this.pending = this.pending.then(() => {
      this.sel = { ...this.sel, ...patch };
      if (patch.freeze !== undefined) {
        const wasNight = this.clock.night;
        this.clock.restart();
        if (wasNight) {
          this.sel.slot = 0;
          return this.render(true);
        }
      }
      this.controls.show(this.sel);
      this.showTime();
      this.refreshReadout();
      this.syncUrl();
    });
    return this.pending;
  }

  /** Walk the occupant to where a state is had (ambient: no walk, just the state). */
  goToState(stateId: string): void {
    this.takeOver();
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
    if (item || point) this.takeOver();
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

  /** Scripted shots: move the occupant and the clock on by `seconds` at once, in 60 Hz steps. */
  advance(seconds: number): void {
    for (let i = 0; i < Math.round(seconds * 60); i++) this.step(1 / 60);
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

  /** The visitor sends the occupant somewhere: that takes over from the schedule. */
  private takeOver(): void {
    if (!this.sel.schedule) return;
    this.sel = { ...this.sel, schedule: false }; // at once, so the next frame doesn't follow it
    void this.setOptions({ schedule: false });
  }

  private get labels(): string[] {
    return this.data!.meta.slots.map((s) => s.label);
  }

  /** True while the occupant walks to the schedule's next activity. */
  private walkingOn(): boolean {
    const next = nextPlanned(this.labels, this.hour, this.clock.night);
    const o = this.occupant;
    return next !== null && o.moving && o.destination?.stateId === next;
  }

  /** On schedule: send the occupant on to the state the schedule has for now (schedule.ts). */
  private followSchedule(): void {
    const goal = scheduleGoal(
      this.labels,
      this.hour,
      this.clock.night,
      this.clock.left,
      (a, b) => this.walkSeconds(a, b),
      this.clock.night ? NIGHT_S : HOUR_S - MIN_STAY_S,
    );
    if (goal === this.scheduled) return;
    this.scheduled = goal;
    const o = this.occupant;
    if ((o.moving ? o.destination?.stateId : o.stateId) === goal) return;
    const t = stateTarget(this.manifest, this.grid, goal);
    if (t) this.walkTo(t);
  }

  /** About how long the walk from one state's spot to another's takes, seat to seat. */
  private walkSeconds(from: string, to: string): number {
    const key = `${from}>${to}`;
    let s = this.walkTimes.get(key);
    if (s === undefined) {
      const a = stateTarget(this.manifest, this.grid, from);
      const b = stateTarget(this.manifest, this.grid, to);
      const spot = (t: Target) => (t.kind === 'seat' ? t.approach : t.at);
      const path = a && b ? this.grid.path(spot(a), spot(b)) : null;
      s =
        a && b && path
          ? pathLength(path) / WALK_SPEED +
            (a.kind === 'seat' ? RISE_S : 0) +
            (b.kind === 'seat' ? SIT_S : 0) +
            TURN_S
          : 0;
      this.walkTimes.set(key, s);
    }
    return s;
  }

  private walkTo(t: Target): void {
    if (this.occupant.goTo(t)) {
      this.refreshReadout();
      this.stage.invalidate();
    }
  }

  /** One frame: the day's clock (once a day is loaded), then the occupant. */
  private step(dt: number): boolean {
    let busy = false;
    if (this.data) {
      const n = this.data.nSlots;
      // The clock waits while the time bar's thumb is held.
      this.clock.running = !this.sel.freeze && !this.timebar.dragging;
      // On schedule, the hour waits at its end for the occupant to reach the next activity.
      this.clock.holdAtEnd = this.sel.schedule && this.walkingOn();
      const next = this.clock.update(dt, this.hour, n);
      if (next !== null) {
        this.hour = next;
        void this.set({ slot: next });
      }
      this.timebar.setPosition(this.clock.position(this.hour, n));
      // Nightfall dims the room; the morning comes with the first hour's set() above.
      if (this.clock.night !== this.night) {
        this.night = this.clock.night;
        document.body.classList.toggle('night', this.night);
        if (this.night) this.showNight();
      }
      if (this.sel.schedule) this.followSchedule();
      const k = this.clock.daylight;
      if (k !== this.daylight) {
        this.daylight = k;
        this.stage.setDaylight(k);
        busy = true;
      }
    }
    return this.tick(dt) || busy;
  }

  /** Night: no heatmap (there is no baked hour), and the time bar and readout say so. */
  private showNight(): void {
    this.stage.heatmap.mesh.visible = false;
    this.showTime();
    this.refreshReadout();
    this.stage.invalidate();
  }

  private showTime(): void {
    const data = this.data!;
    this.timebar.show(this.sel.slot, data.meta.slots, this.clock.night, this.sel.freeze);
    this.timebar.setPosition(this.clock.position(this.hour, data.nSlots));
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
    this.readout.show(this.manifest, this.view, city.label, this.sel.month, this.data.meta.day, {
      walking,
      held: walking !== null && this.sel.hold && !this.sel.compare,
      morning: this.clock.night ? this.data.meta.slots[0]!.label : null,
    });
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
    if (this.clock.night) this.stage.heatmap.mesh.visible = false;
    this.hour = this.sel.slot;
    this.controls.show(this.sel);
    this.showTime();
    this.refreshReadout();
    this.syncUrl();
  }

  private syncUrl(): void {
    const q = new URLSearchParams(location.search); // keeps cam= and the like
    q.set('city', this.sel.city);
    q.set('month', String(this.sel.month));
    q.set('slot', this.data!.meta.slots[this.sel.slot]!.label);
    q.set('state', this.sel.state);
    q.set('layer', this.sel.layer);
    for (const flag of ['compare', 'hold', 'freeze'] as const)
      if (this.sel[flag]) q.set(flag, '1');
      else q.delete(flag);
    if (this.sel.schedule) q.delete('schedule');
    else q.set('schedule', '0');
    history.replaceState(null, '', `?${q}`);
  }
}
