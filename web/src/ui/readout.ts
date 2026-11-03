// The readout (guidelines §6, HUD), kept minimal (Tony, 2026-11-01): the activity with the
// location, date and time, the lux at the occupant (Radiance where there is a run), the target and whether the
// light is in v3's band. The rest opens on hover (or a tap, which focuses it): where the number
// is taken and the surrogate's value, the zone's share in band, glare, how the facade got
// there, and the sky. At night (the day's clock) there are no numbers.

import type { Manifest } from '../data/manifest';
import { reading, type RecordView } from '../app/record';
import { MONTHS } from './controls';

const fmt = (v: number) => Math.round(v).toLocaleString('en-US');

export interface ReadoutExtras {
  /** Where the occupant is headed, while they walk (the facade chases them). */
  walking?: string | null;
  /** The facade keeps its state until they arrive. */
  held?: boolean;
  /** At night, the first hour of the next day. */
  morning?: string | null;
}

export class Readout {
  readonly el: HTMLElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('section');
    this.el.className = 'readout';
    this.el.tabIndex = 0; // a tap opens the details on touch screens
    this.el.setAttribute('aria-live', 'polite');
    parent.append(this.el);
  }

  show(
    manifest: Manifest,
    view: RecordView,
    city: string,
    month: number,
    day: number,
    { walking = null, held = false, morning = null }: ReadoutExtras = {},
  ): void {
    const r = reading(manifest, view);
    const m = view.metrics;
    const s = view.slot;
    const label = walking
      ? `Walking to ${walking.charAt(0).toLowerCase()}${walking.slice(1)}`
      : morning
        ? 'Night'
        : (view.state?.label ?? view.stateId);
    const main: string[] = [
      `<div class="title"><span class="hint" aria-hidden="true">▴</span>` +
        `<strong>${label}</strong></div>`,
      `<div class="when">${city}, ${MONTHS[month - 1]} ${day}` +
        `${morning ? '' : `, ${s.label} LST`}</div>`,
    ];
    const more: string[] = [];
    if (held) more.push(`<div>Facade frozen until they arrive.</div>`);
    if (morning) {
      more.push(`<div>The sun is down. The day starts again at ${morning} LST.</div>`);
    } else {
      if (r) {
        const where = r.where === 'floor' ? 'floor median' : 'at the occupant';
        main.push(
          `<div class="big"><span class="num">${fmt(r.radiance ?? r.surrogate)}</span> lux` +
            `<span class="target">Target ${fmt(r.target)} lux</span>` +
            `<span class="chip" data-status="${r.status}">${r.status}</span></div>`,
        );
        more.push(
          `<div>${r.radiance === null ? 'Surrogate' : 'Radiance'} ${where}` +
            (r.radiance === null ? '' : ` · surrogate ${fmt(r.surrogate)} lux`) +
            `</div>`,
        );
      }
      const sh = view.shades;
      const facade = sh
        ? `Shades ${view.ship === 'kept' ? 'kept from the previous hour' : 'set for this hour'}` +
          (view.flips === null ? '.' : `, ${view.flips} of ${sh.drops.length} moved.`)
        : `Facade ${view.ship === 'warm' ? 'adjusted from the previous hour' : 'solved afresh'}` +
          (view.flips === null ? '.' : `, ${view.flips} panels changed.`);
      if (sh) {
        // Per wall, how far down each shade is, window by window.
        const walls = [...new Set(sh.walls)].map(
          (w) =>
            `${w} ` +
            sh.drops
              .map((d, i) => (sh.walls[i] === w ? `${Math.round((100 * d) / sh.rows[i]!)}%` : ''))
              .filter(Boolean)
              .join(', '),
        );
        more.push(`<div>Conventional windows with shades. Down: ${walls.join(' · ')}.</div>`);
      }
      const inBand = m.in_band_rad?.[0] ?? m.in_band_sur[0];
      more.push(
        `<div>${inBand}% of the zone in band · ` +
          `${m.glare_rad ?? m.glare_sur} floor cells over 3000 lux</div>`,
        `<div>${facade} Sun ${s.alt.toFixed(0)}° up, ${s.sky} sky.</div>`,
        `<div class="small">Room lit from the ` +
          `${view.fill === 'radiance' ? 'Radiance result' : 'surrogate'} (direct sun drawn separately)` +
          `${view.tvOn ? '; the TV glow is for show and not in the numbers' : ''}.</div>`,
      );
    }
    this.el.innerHTML = `${main.join('')}<div class="more"><div>${more.join('')}</div></div>`;
  }
}
