// The year bar, under the time bar (Tony, 2026-11-03). It runs from March to February, so the
// four seasons sit in order (spring from March, summer from June, fall from September, winter
// from December), with a line at each month and a mark at each baked day. The thumb sits on the
// day shown; through the night it runs on to the next season's day, where the next day starts
// (app.ts), and the date beside the bar runs with it. Clicking or dragging picks the nearest
// baked day; with the bar focused, the arrow keys step a season.

import { el, MONTH_NAMES, MONTHS } from './controls';

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const YEAR = 365;
/** The bar starts on the first of this month. */
const FIRST = 3;
const SEASONS: readonly (readonly [string, number])[] = [
  ['Spring', 3],
  ['Summer', 6],
  ['Fall', 9],
  ['Winter', 12],
];

export interface BakedDay {
  month: number;
  day: number;
}

/** Days from the first of `month` to the bar's start. */
function monthStart(month: number): number {
  let d = 0;
  for (let m = FIRST; m !== month; m = (m % 12) + 1) d += DAYS[m - 1]!;
  return d;
}

/** Where a day sits along the bar, 0 to 1 (its middle). */
export function yearPosition({ month, day }: BakedDay): number {
  return (monthStart(month) + day - 0.5) / YEAR;
}

/** The day at a position along the bar (any number: it wraps round the year). */
export function dayAt(position: number): BakedDay {
  let d = Math.floor((((position % 1) + 1) % 1) * YEAR);
  let month = FIRST;
  while (d >= DAYS[month - 1]!) {
    d -= DAYS[month - 1]!;
    month = (month % 12) + 1;
  }
  return { month, day: d + 1 };
}

const pct = (f: number) => `${(f * 100).toFixed(3)}%`;

export class YearBar {
  onPick: (month: number) => void = () => {};
  private readonly date: HTMLOutputElement;
  private readonly track: HTMLElement;
  private readonly marks: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly thumb: HTMLElement;
  private days: BakedDay[] = [];
  private daysKey = '';
  private month = 0;
  private shownAt = '';
  private picked = -1;

  /** Adds its row (the date, the bar and an empty cell) to the time bar's grid. */
  constructor(parent: HTMLElement) {
    this.date = el('output', { class: 'tb-time yb-date' });
    this.track = el('div', {
      class: 'tb-track yb-track',
      role: 'slider',
      tabindex: '0',
      'aria-label': 'Season',
    });
    const rail = el('div', { class: 'tb-rail' });
    this.fill = el('div', { class: 'tb-fill' });
    rail.append(this.fill);
    this.marks = el('div', { class: 'tb-marks' });
    this.thumb = el('div', { class: 'tb-thumb' });
    this.track.append(rail, this.marks, this.thumb);
    parent.append(this.date, this.track, el('span'));
    this.listen();
  }

  /** The city's baked days, and the month of the day shown. */
  show(days: BakedDay[], month: number): void {
    const key = days.map((d) => `${d.month}/${d.day}`).join();
    if (key !== this.daysKey) {
      this.daysKey = key;
      this.days = days;
      this.build();
    }
    this.month = month;
    const d = days.find((x) => x.month === month);
    if (!d) return;
    this.track.setAttribute('aria-valuenow', String(month));
    this.track.setAttribute('aria-valuetext', `${MONTH_NAMES[month - 1]} ${d.day}`);
  }

  /** Put the thumb `position` along the bar (yearPosition; past 1 it wraps to the start). */
  setPosition(position: number): void {
    const f = ((position % 1) + 1) % 1;
    const at = pct(f);
    if (at === this.shownAt) return;
    this.shownAt = at;
    this.thumb.style.left = at;
    this.fill.style.width = at;
    const d = dayAt(f);
    this.date.textContent = `${MONTHS[d.month - 1]} ${d.day}`;
  }

  private build(): void {
    this.shownAt = '';
    const seasonStarts = new Set(SEASONS.map(([, m]) => m));
    const lines: HTMLElement[] = [];
    for (let m = 1; m <= 12; m++) {
      const line = el('div', { class: seasonStarts.has(m) ? 'yb-season' : 'yb-month' });
      line.style.left = pct(monthStart(m) / YEAR);
      lines.push(line);
    }
    const labels = SEASONS.map(([name, m]) => {
      const label = el('span', { class: 'yb-label' }, name);
      label.style.left = pct((monthStart(m) + 45.5) / YEAR); // mid-season
      return label;
    });
    const dots = this.days.map((d) => {
      const dot = el('div', { class: 'yb-day' });
      dot.style.left = pct(yearPosition(d));
      return dot;
    });
    this.marks.replaceChildren(...lines, ...labels, ...dots);
  }

  /** The baked day nearest a position along the bar, round the year. */
  private nearest(position: number): number {
    let best = this.days[0]!.month;
    let gap = Infinity;
    for (const d of this.days) {
      const x = Math.abs(yearPosition(d) - position);
      const g = Math.min(x, 1 - x);
      if (g < gap) [best, gap] = [d.month, g];
    }
    return best;
  }

  private listen(): void {
    const pick = (e: PointerEvent) => {
      const r = this.track.getBoundingClientRect();
      const month = this.nearest((e.clientX - r.left) / r.width);
      if (month === this.picked) return;
      this.picked = month;
      if (month !== this.month) this.onPick(month);
    };
    this.track.addEventListener('pointerdown', (e) => {
      if (!this.days.length) return;
      this.picked = -1;
      this.track.setPointerCapture(e.pointerId);
      pick(e);
    });
    this.track.addEventListener('pointermove', (e) => {
      if (this.track.hasPointerCapture(e.pointerId)) pick(e);
    });
    this.track.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step || !this.days.length) return;
      e.preventDefault();
      e.stopPropagation(); // not the hour (app.ts steps it on the arrow keys)
      const i = this.days.findIndex((d) => d.month === this.month);
      const n = this.days.length;
      this.onPick(this.days[(i + step + n) % n]!.month);
    });
  }
}
