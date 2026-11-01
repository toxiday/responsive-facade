import './style.css';
import { loadManifest } from './data/manifest';
import type { Vec3 } from './data/manifest';
import type { ViewName } from './scene/camera';
import type { Stage } from './scene/stage';

declare global {
  interface Window {
    __rf: { ready: boolean; error?: string; m1?: unknown };
  }
}
window.__rf = { ready: false };

const VIEWS: [string, string][] = [
  ['Room', '?'],
  ['Spots', '?debug=spots&cam=top'],
  ['Pattern', '?debug=pattern'],
  ['M1 · A', '?debug=m1&case=A'],
  ['M1 · B', '?debug=m1&case=B'],
  ['Rhino', '?debug=rhino'],
];

function hud(lines: string[]): void {
  const el = document.getElementById('hud')!;
  const links = VIEWS.map(([label, q]) => `<a href="${q}">${label}</a>`).join(' · ');
  el.innerHTML = `<strong>Responsive Facade</strong> <span class="dim">M1 preview</span>
    <nav>${links}</nav>${lines.map((l) => `<div>${l}</div>`).join('')}`;
}

function whenRendered(stage: Stage): Promise<void> {
  const start = stage.frameCount;
  return new Promise((resolve) => {
    const check = () => {
      if (stage.frameCount >= start + 3) return resolve();
      stage.invalidate(); // the loop renders on demand; ask for frames until we have them
      requestAnimationFrame(check);
    };
    check();
  });
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const host = document.getElementById('stage')!;
  const manifest = await loadManifest();
  const debug = params.get('debug');
  let stage: Stage;

  if (debug === 'pattern') {
    const { runPattern } = await import('./debug/pattern');
    stage = runPattern(manifest, host);
    hud([
      'Letters: S and E read from outside, N and W from inside.',
      'Red panel = row 0, col 0. Floor: red Γ = NW corner (row 0, col 0).',
    ]);
  } else if (debug === 'm1') {
    const { runM1 } = await import('./debug/m1');
    const { stage: s, result, fixtureCase: c } = await runM1(manifest, host, params);
    stage = s;
    window.__rf.m1 = result;
    const layers = ['shadow', 'radiance', 'surrogate']
      .map((l) => `<a href="?debug=m1&case=${c.id}&layer=${l}">${l}</a>`)
      .join(' · ');
    hud([
      `${c.label}: ${c.month}/${c.day} ${c.slot} LST, sun alt ${c.alt.toFixed(1)}°`,
      `Rendered shadow vs Radiance (magenta): IoU ${result.iou_render.toFixed(3)} ` +
        `(${result.lit_render} vs ${result.lit_radiance} lit cells)`,
      `Layer: ${layers} · <a href="?debug=m1&case=${c.id}&layer=shadow&view=top">top view</a>`,
    ]);
  } else if (debug === 'spots') {
    const { runSpots } = await import('./debug/spots');
    stage = runSpots(manifest, host);
    const standing = manifest.states.filter((s) => s.kind === 'standing').length;
    const activity = manifest.states.filter((s) => s.kind === 'activity').length;
    hud([
      `Magenta: seats and the cooking spot (tick = facing); circles: the ${activity} activity zones.`,
      `Blue: ${standing} standing positions on the open floor (one state each).`,
    ]);
  } else if (debug === 'rhino') {
    const { runRhino } = await import('./debug/rhino');
    stage = await runRhino(manifest, host);
    hud(['501.6 optimised facade; magenta = merged glazing from the Rhino model.']);
  } else {
    const { Stage } = await import('./scene/stage');
    const fixture = (await import('./__fixtures__/m1.json')).default;
    const c = fixture.cases[0]!;
    stage = new Stage(manifest, host);
    stage.facade.setBits(c.facade);
    stage.setSun({ sunRoom: c.sun_room as Vec3, alt: c.alt, dni: c.dni, dhi: c.dhi });
    hud([`Test facade and hand-written slot: Houston ${c.month}/${c.day} ${c.slot} LST.`]);
  }
  const cam = params.get('cam') ?? params.get('view');
  if (cam && ['axo', 'top', 'ne', 'se', 'sw', 'nw'].includes(cam))
    stage.rig.setView(cam as ViewName);
  if (params.get('cut') === '0') stage.cutaway.walls = false;
  const lines = params.get('lines'); // 0 = off, n = creases only, d = silhouettes only
  if (lines === '0') stage.edges.enabled = false;
  else if (lines === 'n' || lines === 'd') stage.edges.setKinds(lines === 'n', lines === 'd');
  stage.invalidate();
  await whenRendered(stage);
  window.__rf.ready = true;
}

main().catch((err: unknown) => {
  window.__rf.error = String(err);
  const el = document.getElementById('hud');
  if (el) el.textContent = `Could not start: ${String(err)}`;
  console.error(err);
});
