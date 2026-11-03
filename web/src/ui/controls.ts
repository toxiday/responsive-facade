// The control panel: the title and a work-in-progress note, then the location (city) and the
// season (a baked month), where the occupant goes (each activity; the list reads "Standing"
// while they are on open floor), what they do on their own (the daily schedule, a random tour,
// or nothing; app/schedule.ts), whether the facade freezes until they arrive, and the heatmap
// layer with its legend. Only city-months that have
// data are offered. The facade mode is in the bar along the top (modebar.ts), the time on the
// bar along the bottom (timebar.ts). With the schedule-specific facade, the occupant keeps to
// the daily routine it was designed for: the other routines and the Go to list are greyed, and
// using them says so (onLocked).

import type { Legend } from '../data/manifest';
import type { Layer } from '../app/record';
import type { Routine } from '../app/schedule';

export const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
// The baked months named by season for now (Tony, 2026-11-03); any other month by its name.
const SEASONS: Record<number, string> = { 3: 'Spring', 6: 'Summer', 9: 'Fall', 12: 'Winter' };
export const monthLabel = (m: number) => SEASONS[m] ?? MONTH_NAMES[m - 1]!;

export interface Choice {
  id: string;
  label: string;
}

/** How the facade is run (modebar.ts): the responsive facade, the conventional windows with
 * operable shades (shade_optimizer/), or the schedule-specific facade, one fixed design for the
 * daily routine (bake/schedule_facade.py). */
export type FacadeMode = 'responsive' | 'shades' | 'schedule';

export interface CityChoice extends Choice {
  /** Baked months with their day of the month, and whether they have shade and schedule files. */
  months: { month: number; day: number; shades: boolean; schedule: boolean }[];
}

export interface Selection {
  city: string;
  month: number;
  slot: number;
  state: string;
  layer: Layer;
  /** The facade mode (Tony, 2026-11-03; the operable shades first replaced the conventional
   * facade's comparison on 2026-11-02). */
  mode: FacadeMode;
  /** "Freeze until arrival": the facade keeps its state while the occupant walks and changes once
   * they arrive (on by default). */
  hold: boolean;
  /** What the occupant does on their own: the daily schedule (the default), a random tour, or
   * nothing. */
  routine: Routine;
  /** Pause the clock (app/clock.ts) at the start of the hour being shown (the time bar's Pause
   * box). */
  freeze: boolean;
}

const ROUTINES: [Routine, string, string][] = [
  ['daily', 'Daily', 'Breakfast, reading, desk work, lunch, the chaise, cooking, TV: an hour each'],
  ['random', 'Random', 'A different activity somewhere in the room every other hour'],
  ['off', 'Off', 'They stay where you send them'],
];

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
  /** A greyed control was used (the schedule-specific facade keeps the daily routine). */
  onLocked: () => void = () => {};
  private readonly city: HTMLSelectElement;
  private readonly month: HTMLSelectElement;
  private readonly state: HTMLSelectElement;
  private readonly hold: HTMLInputElement;
  private locked = false;
  private readonly routines = new Map<Routine, HTMLButtonElement>();
  private readonly layers = new Map<Layer, HTMLButtonElement>();
  private readonly legend: HTMLElement;

  constructor(
    parent: HTMLElement,
    private readonly cities: CityChoice[],
    activities: Choice[],
    legend: Legend,
  ) {
    this.el = el('section', { class: 'panel', 'aria-label': 'Controls' });
    // On a phone the panel is a dropdown (Tony, 2026-11-03): only the title until the header
    // is tapped, so the room stays in view (style.css). Elsewhere it is always open.
    const head = el('header');
    const toggle = el('button', {
      type: 'button',
      class: 'panel-toggle',
      'aria-expanded': 'false',
      'aria-controls': 'panel-body',
      'aria-label': 'Show the controls',
    });
    head.append(
      el('h1', {}, 'Responsive Facade'),
      el('div', { class: 'wip' }, 'Work-in-progress demo'),
      toggle,
    );
    head.addEventListener('click', () => {
      const open = this.el.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Hide the controls' : 'Show the controls');
    });

    this.city = el('select', { 'aria-label': 'City' });
    for (const c of cities) this.city.append(el('option', { value: c.id }, c.label));
    this.city.addEventListener('change', () => {
      // The same season in the new city, where it has it.
      const c = this.cities.find((x) => x.id === this.city.value)!;
      const m = Number(this.month.value);
      this.onChange({
        city: c.id,
        month: c.months.some((x) => x.month === m) ? m : c.months[0]!.month,
      });
    });

    this.month = el('select', { 'aria-label': 'Season' });
    this.month.addEventListener('change', () => this.onChange({ month: Number(this.month.value) }));

    this.state = el('select', { 'aria-label': 'Go to' });
    const standing = el('option', { value: '', disabled: '', hidden: '' }, 'Standing');
    this.state.append(standing);
    for (const a of activities) this.state.append(el('option', { value: a.id }, a.label));
    this.state.addEventListener('change', () => this.onChange({ state: this.state.value }));
    // Greyed, the list doesn't open (a disabled select would swallow the click that says why).
    const blocked = (e: Event) => {
      if (!this.locked) return;
      e.preventDefault();
      this.onLocked();
    };
    this.state.addEventListener('mousedown', blocked);
    this.state.addEventListener('keydown', (e) => {
      if (!['Tab', 'Shift', 'Escape'].includes(e.key)) blocked(e);
    });

    const routine = el('div', { class: 'seg', role: 'group', 'aria-label': 'Routine' });
    for (const [id, label, title] of ROUTINES) {
      const b = el('button', { type: 'button', title }, label);
      b.addEventListener('click', () =>
        b.getAttribute('aria-disabled') === 'true'
          ? this.onLocked()
          : this.onChange({ routine: id }),
      );
      this.routines.set(id, b);
      routine.append(b);
    }

    this.hold = el('input', { type: 'checkbox' });
    this.hold.addEventListener('change', () => this.onChange({ hold: this.hold.checked }));
    const holdLabel = el('label', { class: 'check' });
    holdLabel.append(this.hold, el('span', {}, 'Freeze until arrival'));

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
    const body = el('div', { class: 'panel-body', id: 'panel-body' });
    body.append(
      row('Location', this.city),
      row('Season', this.month),
      row('Go to', this.state),
      row('Routine', routine),
      row('Facade', holdLabel),
      row('Heatmap', seg),
      this.legend,
    );
    this.el.append(head, body);
    parent.append(this.el);
  }

  /** Reflect the current selection. */
  show(sel: Selection): void {
    this.city.value = sel.city;
    const c = this.cities.find((x) => x.id === sel.city)!;
    this.month.replaceChildren(
      ...c.months.map((m) =>
        el(
          'option',
          { value: String(m.month), title: `${MONTH_NAMES[m.month - 1]} ${m.day}` },
          monthLabel(m.month),
        ),
      ),
    );
    this.month.value = String(sel.month);
    const listed = [...this.state.options].some((o) => o.value === sel.state && o.value);
    this.state.value = listed ? sel.state : '';
    // The schedule-specific facade was designed for the daily routine: only that one runs.
    this.locked = sel.mode === 'schedule';
    this.state.setAttribute('aria-disabled', String(this.locked));
    for (const [id, b] of this.routines) {
      b.setAttribute('aria-pressed', String(id === sel.routine));
      b.setAttribute('aria-disabled', String(this.locked && id !== 'daily'));
    }
    this.hold.checked = sel.hold;
    for (const [id, b] of this.layers) b.setAttribute('aria-pressed', String(id === sel.layer));
    this.legend.hidden = sel.layer === 'none';
  }
}
