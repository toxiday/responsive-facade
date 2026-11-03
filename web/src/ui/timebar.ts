// The time bar along the bottom of the page (Tony, 2026-11-01). It is drawn to the clock's own
// time scale (app/clock.ts): a light line at each baked hour, HOUR_S apart, then a dark stretch
// for the NIGHT_S night after the last one. While time runs the thumb glides through each hour,
// and the scene moves on as it reaches the next line. Clicking or dragging picks the nearest
// hour (the clock waits while the thumb is held); the arrow keys step an hour (app.ts). The
// time shown is left of the bar, the Pause box right.

import type { SlotMeta } from '../data/month';
import { barHours, HOUR_S, NIGHT_S } from '../app/clock';
import { el } from './controls';

/** Roughly the width an hour's label needs; closer lines only label every other one (or less). */
const LABEL_PX = 38;

const pct = (f: number) => `${(f * 100).toFixed(3)}%`;

export class TimeBar {
  readonly el: HTMLElement;
  onPick: (slot: number) => void = () => {};
  onFreeze: (freeze: boolean) => void = () => {};
  /** True while the thumb is held. */
  dragging = false;
  private readonly time: HTMLOutputElement;
  private readonly track: HTMLElement;
  private readonly marks: HTMLElement;
  private readonly night: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly thumb: HTMLElement;
  private readonly freeze: HTMLInputElement;
  private labels: HTMLElement[] = [];
  private nSlots = 0;
  private dayKey = '';
  private shownAt = '';
  private picked = -1;

  constructor(parent: HTMLElement) {
    this.el = el('section', { class: 'timebar', 'aria-label': 'Time' });
    this.time = el('output', { class: 'tb-time' });
    this.track = el('div', {
      class: 'tb-track',
      role: 'slider',
      tabindex: '0',
      'aria-label': 'Time of day',
      'aria-valuemin': '0',
    });
    const rail = el('div', { class: 'tb-rail' });
    this.fill = el('div', { class: 'tb-fill' });
    this.night = el('div', { class: 'tb-night' });
    rail.append(this.fill, this.night);
    this.marks = el('div', { class: 'tb-marks' });
    this.thumb = el('div', { class: 'tb-thumb' });
    this.track.append(rail, this.marks, this.thumb);

    this.freeze = el('input', { type: 'checkbox' });
    this.freeze.addEventListener('change', () => this.onFreeze(this.freeze.checked));
    const freezeLabel = el('label', {
      class: 'check',
      title: `Running, each hour shows for ${HOUR_S} s, then a ${NIGHT_S} s night`,
    });
    freezeLabel.append(this.freeze, el('span', {}, 'Pause'));

    this.el.append(this.time, this.track, freezeLabel);
    parent.append(this.el);
    this.listen();
    new ResizeObserver(() => this.thinLabels()).observe(this.track);
  }

  /** The hours of the day being shown, the one shown (or the night), and the Pause box. */
  show(slot: number, slots: SlotMeta[], night: boolean, freeze: boolean): void {
    const key = slots.map((s) => s.label).join();
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.build(slots);
    }
    const text = night ? 'Night' : `${slots[slot]!.label} LST`;
    this.time.textContent = text;
    this.track.setAttribute('aria-valuenow', String(slot));
    this.track.setAttribute('aria-valuetext', text);
    this.freeze.checked = freeze;
  }

  /** Put the thumb `hours` along the bar (DayClock.position). */
  setPosition(hours: number): void {
    const at = pct(Math.min(1, hours / barHours(this.nSlots)));
    if (at === this.shownAt) return;
    this.shownAt = at;
    this.thumb.style.left = at;
    this.fill.style.width = at;
  }

  private build(slots: SlotMeta[]): void {
    const n = slots.length;
    const total = barHours(n);
    this.nSlots = n;
    this.shownAt = '';
    this.track.setAttribute('aria-valuemax', String(n - 1));
    this.labels = [];
    const lines = slots.map((s, k) => {
      const line = el('div', { class: 'tb-mark' });
      line.style.left = pct(k / total);
      const label = el('span', {}, s.label.replace(/^0/, ''));
      this.labels.push(label);
      line.append(label);
      return line;
    });
    const nightLabel = el('span', { class: 'tb-night-label' }, 'Night');
    nightLabel.style.left = pct((n + total) / 2 / total);
    this.marks.replaceChildren(...lines, nightLabel);
    this.night.style.left = pct(n / total);
    this.thinLabels();
  }

  /** Label every hour if there is room, otherwise every other one (or every third...). */
  private thinLabels(): void {
    const perHour = this.track.clientWidth / barHours(this.nSlots || 1);
    const every = Math.max(1, Math.ceil(LABEL_PX / Math.max(1, perHour)));
    this.labels.forEach((l, k) => (l.hidden = k % every !== 0));
  }

  private listen(): void {
    const pick = (e: PointerEvent) => {
      const r = this.track.getBoundingClientRect();
      const hours = ((e.clientX - r.left) / r.width) * barHours(this.nSlots);
      const k = Math.min(this.nSlots - 1, Math.max(0, Math.round(hours)));
      if (k === this.picked) return;
      this.picked = k;
      this.onPick(k);
    };
    this.track.addEventListener('pointerdown', (e) => {
      if (!this.nSlots) return;
      this.dragging = true;
      this.picked = -1;
      this.track.setPointerCapture(e.pointerId);
      pick(e);
    });
    this.track.addEventListener('pointermove', (e) => {
      if (this.dragging) pick(e);
    });
    const release = () => (this.dragging = false);
    this.track.addEventListener('pointerup', release);
    this.track.addEventListener('pointercancel', release);
  }
}
