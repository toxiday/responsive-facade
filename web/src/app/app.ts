// The demo (M3): pick a city, a baked day, an hour and an activity, and see the facade the
// bake chose, the sun, the room lit from Radiance, and optionally the heatmap. Changing the
// hour or activity turns only the panels that change. The selection lives in the URL, so a
// view can be linked (and shot by scripts/shoot.mjs).
//
// The occupant (click to walk, the facade chasing them) comes in M4; until then the activity
// is picked from a list. It starts on ambient, the whole-floor state.

import type { Manifest } from '../data/manifest';
import type { MonthData } from '../data/month';
import { MonthStore, type DataIndex } from '../data/store';
import { Stage } from '../scene/stage';
import { Controls, type CityChoice, type Choice, type Selection } from '../ui/controls';
import { Readout } from '../ui/readout';
import { showRecord, type Layer } from './record';

const LAYER_IDS: Layer[] = ['none', 'radiance', 'surrogate'];

export class App {
  readonly stage: Stage;
  private readonly store = new MonthStore();
  private readonly controls: Controls;
  private readonly readout: Readout;
  private readonly cities: CityChoice[];
  private sel!: Selection;
  private data: MonthData | null = null;
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
    const activities: Choice[] = [
      ...manifest.states
        .filter((s) => s.kind !== 'standing')
        .map((s) => ({ id: s.id, label: s.label })),
      { id: 'baseline', label: 'Conventional facade' },
    ];
    this.stage = new Stage(manifest, host);
    this.controls = new Controls(ui, this.cities, activities, manifest.legend);
    this.readout = new Readout(ui);
    this.controls.onChange = (patch) => void this.set(patch);
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
      state: params.get('state') ?? 'ambient',
      layer: layer && LAYER_IDS.includes(layer) ? layer : 'none',
    };
    this.data = await this.store.get(this.sel.city, this.sel.month);
    const wanted = params.get('slot');
    const byLabel = this.data.meta.slots.findIndex((s) => s.label === wanted);
    this.sel.slot = byLabel >= 0 ? byLabel : this.highestSun(this.data);
    if (!this.data.meta.states.includes(this.sel.state)) this.sel.state = 'ambient';
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

  /** Scripted shots: make a change and freeze the animation `ms` into it. */
  async previewAt(patch: Partial<Selection>, ms: number): Promise<void> {
    const t0 = performance.now();
    this.stage.timeOverride = t0;
    await this.set(patch);
    this.stage.timeOverride = t0 + ms;
    this.stage.invalidate();
  }

  private highestSun(data: MonthData): number {
    let best = 0;
    data.meta.slots.forEach((s, i) => {
      if (s.alt > data.meta.slots[best]!.alt) best = i;
    });
    return best;
  }

  private render(animate: boolean): void {
    const data = this.data!;
    const view = showRecord(
      this.stage,
      this.manifest,
      data,
      this.sel.slot,
      this.sel.state,
      this.sel.layer,
      animate,
    );
    this.controls.show(this.sel, data.meta.slots);
    const city = this.cities.find((c) => c.id === this.sel.city)!;
    this.readout.show(this.manifest, view, city.label, this.sel.month, data.meta.day);
    const q = new URLSearchParams(location.search); // keeps cam= and the like
    q.set('city', this.sel.city);
    q.set('month', String(this.sel.month));
    q.set('slot', data.meta.slots[this.sel.slot]!.label);
    q.set('state', this.sel.state);
    q.set('layer', this.sel.layer);
    history.replaceState(null, '', `?${q}`);
  }
}
