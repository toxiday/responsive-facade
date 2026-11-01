// North arrow (guidelines §3.1), fixed in the bottom-right corner of the screen. True north is
// clockwise from room +y by north_angle; the room stays put and the camera orbits, so on every
// frame the needle turns to where true north points in the current view. Drawn as SVG over
// the canvas, so it is crisp at any pixel density.

import { type Camera, Vector3 } from 'three';
import { northThree } from './frame';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_R = 22;
const LABEL_R = 30;

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export class Compass {
  readonly element: SVGSVGElement;
  private readonly needle: SVGGElement;
  private readonly label: SVGTextElement;
  private readonly north: Vector3;
  private angle = NaN;

  constructor(parent: HTMLElement, northAngle: number) {
    this.north = northThree(northAngle);
    const svg = el('svg', { class: 'compass', viewBox: '-36 -36 72 72', role: 'img' });
    svg.setAttribute('aria-label', 'North arrow');
    svg.append(
      el('circle', { r: RING_R, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2 }),
    );
    this.needle = el('g', {});
    this.needle.append(el('polygon', { points: '0,-19 7,12 0,6 -7,12', fill: 'currentColor' }));
    this.label = el('text', {
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      'font-size': 11,
      'font-weight': 700,
      fill: 'currentColor',
    });
    this.label.textContent = 'N';
    svg.append(this.needle, this.label);
    parent.append(svg);
    this.element = svg;
  }

  /** Turn the needle to true north as projected by `camera` around `target`. */
  update(camera: Camera, target: Vector3): void {
    const a = target.clone().project(camera);
    const b = target.clone().add(this.north).project(camera);
    // NDC has y up; the SVG turns clockwise from up with y down.
    const angle = Math.atan2(b.x - a.x, b.y - a.y);
    if (Math.abs(angle - this.angle) < 1e-4) return;
    this.angle = angle;
    this.needle.setAttribute('transform', `rotate(${(angle * 180) / Math.PI})`);
    this.label.setAttribute('x', (LABEL_R * Math.sin(angle)).toFixed(2));
    this.label.setAttribute('y', (-LABEL_R * Math.cos(angle)).toFixed(2));
  }
}
