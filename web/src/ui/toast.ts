// A short message near the bottom of the page, above the time bar, that fades after a moment
// (Tony, 2026-11-03: "Not available for this facade mode" for a greyed control).

import { el } from './controls';

const SHOW_MS = 2200;

export class Toast {
  private readonly el: HTMLElement;
  private timer = 0;

  constructor(parent: HTMLElement) {
    this.el = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    parent.append(this.el);
  }

  show(text: string): void {
    this.el.textContent = text;
    this.el.classList.add('show');
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.el.classList.remove('show'), SHOW_MS);
  }
}
