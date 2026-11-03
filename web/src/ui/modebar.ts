// The facade mode, in a bar along the top (Tony, 2026-11-03): the responsive facade, the
// conventional windows with operable shades, or the schedule-specific facade (one fixed design
// for the daily routine). A mode without data for the season shown is greyed; clicking it says
// so (onUnavailable).

import { el, type FacadeMode } from './controls';

export const MODES: readonly (readonly [FacadeMode, string])[] = [
  ['responsive', 'Responsive facade'],
  ['shades', 'Operable shades'],
  ['schedule', 'Schedule-specific facade'],
];

export class ModeBar {
  readonly el: HTMLElement;
  onChange: (mode: FacadeMode) => void = () => {};
  onUnavailable: () => void = () => {};
  private readonly buttons = new Map<FacadeMode, HTMLButtonElement>();

  constructor(parent: HTMLElement) {
    this.el = el('nav', { class: 'modebar seg', 'aria-label': 'Facade mode' });
    for (const [id, label] of MODES) {
      const b = el('button', { type: 'button' }, label);
      b.addEventListener('click', () =>
        b.getAttribute('aria-disabled') === 'true' ? this.onUnavailable() : this.onChange(id),
      );
      this.buttons.set(id, b);
      this.el.append(b);
    }
    parent.append(this.el);
  }

  /** The mode shown, and which modes have data for the season shown. */
  show(mode: FacadeMode, available: (mode: FacadeMode) => boolean): void {
    for (const [id, b] of this.buttons) {
      b.setAttribute('aria-pressed', String(id === mode));
      b.setAttribute('aria-disabled', String(!available(id)));
    }
  }
}
