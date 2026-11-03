// The demo. Pick a city, a baked day and an hour; click anywhere in the room and the occupant
// walks there (M4): a piece of furniture takes its nearest seat, open floor a standing spot.
// By default the facade keeps its state while they walk and changes once they arrive ("Freeze
// until arrival", Tony); unticked, it chases them as they walk. On the sofa, clicking the
// TV turns it on and off. The "Go to" list walks them to an activity. The conventional facade
// can be shown instead for comparison. Changes play as a curtain. Time runs on by itself, 5 s a
// baked hour with a 5 s night between days, unless paused (clock.ts); the sun glides on through
// each hour (glideSun). The demo always opens at
// 08:30 (Tony), or the first baked hour after it; only a paused link (?freeze=1) opens at its
// own ?slot=. The selection lives in the URL, so a view can be linked (and shot by
// scripts/shoot.mjs).
//
// By default the occupant follows a routine (schedule.ts): the daily schedule, or a random tour
// that moves every other hour (?routine=random, with ?seed= to fix the tour), starting at the
// hour's activity. A click, the "Go to" list or the TV takes over, and the routine turns off.
// With it off (?routine=off), a linked state puts the occupant straight there; otherwise they
// start just in from the entry door, in ambient.

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
import { glidingSun } from '../scene/sun';
import { Controls, type CityChoice, type Choice, type Selection } from '../ui/controls';
import { Readout } from '../ui/readout';
import { TimeBar } from '../ui/timebar';
import { DayClock, HOUR_S, NIGHT_S } from './clock';
import { showRecord, type Layer, type RecordView } from './record';
import {
  dailyPlan,
  MIN_STAY_S,
  nextPlanned,
  randomPlan,
  ROUTINES,
  scheduleGoal,
  type Plan,
  type Routine,
} from './schedule';

const LAYER_IDS: Layer[] = ['none', 'radiance', 'surrogate'];
/** A few steps in from the entry door, clear of the open door leaf, facing into the room. */
const ENTRY: Pt = { x: 4.75, y: 8.8 };
const ENTRY_HEADING = 225;
/** The hour the demo opens at (Tony): this, or the first baked hour after it. */
const OPENING_HOUR = '08:30';
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
  /** Where the display sun was last put, in hours into the day; NaN once a render has reset it. */
  private sunAt = NaN;
  /** The daylight level and night as last put on the stage. */
  private daylight = 1;
  private night = false;
  /** The state the routine last sent the occupant to; walk times between states, by pair. */
  private scheduled: string | null = null;
  /** Days since the page opened (the random routine changes with each). Its seed. */
  private day = 0;
  private seed = 0;
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
      if (patch.hold !== undefined || patch.routine !== undefined)
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
      hold: params.get('hold') !== '0',
      freeze: params.get('freeze') === '1',
      routine: ROUTINES.includes(params.get('routine') as Routine)
        ? (params.get('routine') as Routine)
        : params.get('schedule') === '0' // the earlier on/off switch
          ? 'off'
          : 'daily',
    };
    const seed = Number(params.get('seed'));
    this.seed = Number.isInteger(seed) && params.has('seed') ? seed : (Math.random() * 2 ** 31) | 0;
    this.data = await this.store.get(this.sel.city, this.sel.month);
    const slots = this.data.meta.slots;
    const wanted = this.sel.freeze ? params.get('slot') : null;
    const byLabel = slots.findIndex((s) => s.label === wanted);
    const opening = slots.findIndex((s) => s.label >= OPENING_HOUR);
    this.sel.slot = byLabel >= 0 ? byLabel : Math.max(0, opening);
    // On a routine, the occupant starts at the hour's activity; off it, a linked state puts them
    // straight there.
    const plan = this.plan();
    const linked = plan ? plan(this.sel.slot, 0) : params.get('state');
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
   * or chases them again from their next step. Routine: the occupant follows the daily schedule
   * or the random tour (from where they are), or stays put. Freeze (the time bar's Pause box):
   * the clock stops at the start of the hour shown, or runs on from there; paused at night, the
   * day starts. Otherwise nothing is
   * redrawn, so a curtain already moving finishes as it was.
   */
  setOptions(patch: Partial<Pick<Selection, 'hold' | 'freeze' | 'routine'>>): Promise<void> {
    if (patch.routine && patch.routine !== 'off') this.scheduled = null; // to this hour's
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

  /** The visitor sends the occupant somewhere: that takes over from the routine. */
  private takeOver(): void {
    if (this.sel.routine === 'off') return;
    this.sel = { ...this.sel, routine: 'off' }; // at once, so the next frame doesn't follow it
    void this.setOptions({ routine: 'off' });
  }

  /** The routine's plan over the day being shown; null with the routine off. */
  private plan(): Plan | null {
    if (this.sel.routine === 'daily') return dailyPlan(this.data!.meta.slots.map((s) => s.label));
    if (this.sel.routine === 'random') {
      return randomPlan(
        this.manifest.activities.map((a) => a.states),
        this.seed,
      );
    }
    return null;
  }

  /** True while the occupant walks to the routine's next activity. */
  private walkingOn(plan: Plan): boolean {
    const n = this.data!.nSlots;
    const next = nextPlanned(plan, n, this.hour, this.day, this.clock.night);
    const o = this.occupant;
    return next !== null && o.moving && o.destination?.stateId === next;
  }

  /** On a routine: send the occupant on to the state it has for now (schedule.ts). */
  private followSchedule(plan: Plan): void {
    const goal = scheduleGoal(
      plan,
      this.data!.nSlots,
      this.hour,
      this.day,
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
      // On a routine, the hour waits at its end for the occupant to reach the next activity.
      const plan = this.plan();
      this.clock.holdAtEnd = plan !== null && this.walkingOn(plan);
      const wasNight = this.clock.night;
      const next = this.clock.update(dt, this.hour, n);
      if (next !== null) {
        if (wasNight) this.day++;
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
      if (plan) this.followSchedule(plan);
      busy = this.glideSun() || busy;
      const k = this.clock.daylight;
      if (k !== this.daylight) {
        this.daylight = k;
        this.stage.setDaylight(k);
        busy = true;
      }
    }
    return this.tick(dt) || busy;
  }

  /**
   * The display sun glides on through each hour (Tony, 2026-11-02): at the hour's baked sun as
   * the thumb crosses its line, towards the next hour's as the thumb nears the next; through the
   * last hour it sets, and the night keeps it there (sun.ts: glidingSun). The facade, the fill,
   * the heatmap and the readout stay the baked hour's. With the heatmap on, the sun stays at the
   * baked hour, so its patches match the simulation shown. True when the sun moved.
   */
  private glideSun(): boolean {
    const data = this.data!;
    const n = data.nSlots;
    const at =
      this.sel.layer !== 'none'
        ? this.sel.slot
        : this.clock.night
          ? n
          : this.clock.position(this.hour, n);
    if (at === this.sunAt) return false;
    this.sunAt = at;
    this.stage.setSun(glidingSun(data.meta.slots, at));
    return true;
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
    this.sunAt = NaN; // showRecord put the sun at the baked hour; glide it on from there
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
    for (const flag of ['compare', 'freeze'] as const)
      if (this.sel[flag]) q.set(flag, '1');
      else q.delete(flag);
    if (this.sel.hold)
      q.delete('hold'); // on unless the link says 0
    else q.set('hold', '0');
    q.delete('schedule');
    if (this.sel.routine === 'daily') q.delete('routine');
    else q.set('routine', this.sel.routine);
    history.replaceState(null, '', `?${q}`);
  }
}
