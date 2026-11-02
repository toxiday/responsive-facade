// The control panel: city and baked day, where the occupant goes (each activity; the list reads
// "Standing" while they are on open floor), whether they follow the daily schedule
// (app/schedule.ts), whether the facade holds still until they arrive,
// the conventional facade for comparison, and the heatmap layer with its legend. Only
// city-months that have data are offered. The time is on the bar along the bottom (timebar.ts).

import type { Legend } from '../data/manifest';
import type { Layer } from '../app/record';

export const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

export interface Choice {
  id: string;
  label: string;
}

export interface CityChoice extends Choice {
  /** Baked months with their day of the month. */
  months: { month: number; day: number }[];
}

export interface Selection {
  city: string;
  month: number;
  slot: number;
  state: string;
  layer: Layer;
  /** Show the conventional facade instead of the responsive one. */
  compare: boolean;
  /** Hold the facade while the occupant walks; it changes once they arrive (on by default). */
  hold: boolean;
  /** The occupant follows the daily schedule (on unless turned off). */
  schedule: boolean;
  /** Stop the clock (app/clock.ts) at the start of the hour being shown. */
  freeze: boolean;
}

const LAYERS: [Layer, string][] = [
  ['none', 'Off'],
  ['radiance', 'Radiance'],
  ['surrogate', 'Surrogate'],
];

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text = '',
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
}

/** The deck's legend (Facade Optimizer presentation): bold title, ticks every 500 lux. */
function legendBar(legend: Legend): HTMLElement {
  const box = el('div', { class: 'legend' });
  const title = el('div', { class: 'legend-title' });
  title.append(el('strong', {}, 'Illuminance'), el('span', {}, ' lux'));
  const stops = [];
  for (let i = 0; i <= 16; i++) {
    const [r, g, b] = legend.lut[Math.round((i / 16) * 255)]!;
    stops.push(`rgb(${r} ${g} ${b}) ${(i / 16) * 100}%`);
  }
  const bar = el('div', { class: 'legend-bar' });
  bar.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
  const ticks = el('div', { class: 'legend-ticks' });
  for (let v = 0; v <= legend.vmax; v += 500) {
    const t = el('span', {}, v === legend.vmax ? `${v}+` : `${v}`);
    t.style.left = `${(v / legend.vmax) * 100}%`;
    ticks.append(t);
  }
  const note = el(
    'div',
    { class: 'legend-note' },
    `On the work plane, ${0.6} m up. White line ${legend.usable[0]} lux, dark line ${legend.glare} lux.`,
  );
  box.append(title, bar, ticks, note);
  return box;
}

export class Controls {
  readonly el: HTMLElement;
  onChange: (patch: Partial<Selection>) => void = () => {};
  private readonly city: HTMLSelectElement;
  private readonly month: HTMLSelectElement;
  private readonly state: HTMLSelectElement;
  private readonly compare: HTMLInputElement;
  private readonly hold: HTMLInputElement;
  private readonly schedule: HTMLInputElement;
  private readonly layers = new Map<Layer, HTMLButtonElement>();
  private readonly legend: HTMLElement;

  constructor(
    parent: HTMLElement,
    private readonly cities: CityChoice[],
    activities: Choice[],
    legend: Legend,
  ) {
    this.el = el('section', { class: 'panel', 'aria-label': 'Controls' });
    const head = el('header');
    head.append(
      el('h1', {}, 'Responsive Facade'),
      el('p', { class: 'dim' }, 'Unit 501.6. A facade that reshapes itself for each activity.'),
    );

    this.city = el('select', { 'aria-label': 'City' });
    for (const c of cities) this.city.append(el('option', { value: c.id }, c.label));
    this.city.addEventListener('change', () => {
      const c = this.cities.find((x) => x.id === this.city.value)!;
      this.onChange({ city: c.id, month: c.months[0]!.month });
    });

    this.month = el('select', { 'aria-label': 'Day' });
    this.month.addEventListener('change', () => this.onChange({ month: Number(this.month.value) }));

    this.state = el('select', { 'aria-label': 'Go to' });
    const standing = el('option', { value: '', disabled: '', hidden: '' }, 'Standing');
    this.state.append(standing);
    for (const a of activities) this.state.append(el('option', { value: a.id }, a.label));
    this.state.addEventListener('change', () => this.onChange({ state: this.state.value }));

    this.schedule = el('input', { type: 'checkbox' });
    this.schedule.addEventListener('change', () =>
      this.onChange({ schedule: this.schedule.checked }),
    );
    const scheduleLabel = el('label', {
      class: 'check',
      title: 'Breakfast, reading, desk work, lunch, the chaise, cooking, TV: an activity an hour',
    });
    scheduleLabel.append(this.schedule, el('span', {}, 'Daily routine'));

    this.hold = el('input', { type: 'checkbox' });
    this.hold.addEventListener('change', () => this.onChange({ hold: this.hold.checked }));
    const holdLabel = el('label', { class: 'check' });
    holdLabel.append(this.hold, el('span', {}, 'Hold until they arrive'));

    this.compare = el('input', { type: 'checkbox' });
    this.compare.addEventListener('change', () => this.onChange({ compare: this.compare.checked }));
    const compareLabel = el('label', { class: 'check' });
    compareLabel.append(this.compare, el('span', {}, 'Conventional facade'));

    const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Heatmap' });
    for (const [id, label] of LAYERS) {
      const b = el('button', { type: 'button', 'data-layer': id }, label);
      b.addEventListener('click', () => this.onChange({ layer: id }));
      this.layers.set(id, b);
      seg.append(b);
    }
    this.legend = legendBar(legend);

    const row = (label: string, ...kids: HTMLElement[]) => {
      const r = el('div', { class: 'row' });
      r.append(el('span', { class: 'row-label' }, label), ...kids);
      return r;
    };
    this.el.append(
      head,
      row('Place', this.city, this.month),
      row('Go to', this.state),
      row('Schedule', scheduleLabel),
      row('Facade', holdLabel),
      row('Compare', compareLabel),
      row('Heatmap', seg),
      this.legend,
    );
    parent.append(this.el);
  }

  /** Reflect the current selection. */
  show(sel: Selection): void {
    this.city.value = sel.city;
    const c = this.cities.find((x) => x.id === sel.city)!;
    this.month.replaceChildren(
      ...c.months.map((m) =>
        el('option', { value: String(m.month) }, `${MONTHS[m.month - 1]} ${m.day}`),
      ),
    );
    this.month.value = String(sel.month);
    const listed = [...this.state.options].some((o) => o.value === sel.state && o.value);
    this.state.value = listed ? sel.state : '';
    this.schedule.checked = sel.schedule;
    this.hold.checked = sel.hold;
    this.compare.checked = sel.compare;
    for (const [id, b] of this.layers) b.setAttribute('aria-pressed', String(id === sel.layer));
    this.legend.hidden = sel.layer === 'none';
  }
}
