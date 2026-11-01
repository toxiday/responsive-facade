// The readout (guidelines §6, HUD): Radiance lux is the main number, the surrogate smaller
// beside it; the target and whether the occupant's light is in v3's band; the zone's share in
// band, glare, how the facade got there, and the sky.

import type { Manifest } from '../data/manifest';
import { reading, type RecordView } from '../app/record';
import { MONTHS } from './controls';

const fmt = (v: number) => Math.round(v).toLocaleString('en-US');

export class Readout {
  readonly el: HTMLElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('section');
    this.el.className = 'readout';
    this.el.setAttribute('aria-live', 'polite');
    parent.append(this.el);
  }

  show(manifest: Manifest, view: RecordView, city: string, month: number, day: number): void {
    const r = reading(manifest, view);
    const m = view.metrics;
    const label =
      view.stateId === 'baseline'
        ? 'Conventional facade (baseline)'
        : (view.state?.label ?? view.stateId);
    const where = r?.where === 'floor' ? 'floor median' : 'at the occupant';
    const facade =
      view.ship === 'baseline'
        ? 'A fixed conventional facade, judged against the 200 lux ambient brief.'
        : `Facade: ${view.ship === 'warm' ? 'adjusted from the previous hour' : 'solved afresh'}` +
          (view.flips === null ? '.' : `, ${view.flips} panels changed.`);
    const s = view.slot;
    const lines: string[] = [
      `<div class="title"><strong>${label}</strong> <span class="dim">· ${city}, ` +
        `${MONTHS[month - 1]} ${day}, ${s.label} LST</span></div>`,
    ];
    if (r) {
      const main = r.radiance ?? r.surrogate;
      lines.push(
        `<div class="big"><span class="num">${fmt(main)}</span> lux ` +
          `<span class="dim">${r.radiance === null ? 'surrogate' : 'Radiance'} ${where}</span>` +
          (r.radiance === null ? '' : ` <span class="small">surrogate ${fmt(r.surrogate)}</span>`) +
          `</div>`,
        `<div>Target ${fmt(r.target)} lux · <span class="chip" data-status="${r.status}">` +
          `${r.status}</span></div>`,
      );
    }
    const inBand = m.in_band_rad?.[0] ?? m.in_band_sur[0];
    lines.push(
      `<div class="dim">${inBand}% of the zone in band · ` +
        `${m.glare_rad ?? m.glare_sur} floor cells over 3000 lux</div>`,
      `<div class="dim">${facade} Sun ${s.alt.toFixed(0)}° up, ${s.sky} sky.</div>`,
      `<div class="dim small">Room lit from the Radiance result (direct sun drawn separately)` +
        `${view.tvOn ? '; the TV glow is for show and not in the numbers' : ''}.</div>`,
    );
    this.el.innerHTML = lines.join('');
  }
}
