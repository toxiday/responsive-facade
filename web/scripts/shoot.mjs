// Headless screenshots of the debug views, plus the M1 render check.
//   npm run shoot            (needs PLAYWRIGHT_BROWSERS_PATH from tools/env.*)
//   npm run shoot -- --only room --scale 3 --out <dir>    close-ups of some views
// Writes bake/reports/m1/*.png and render_check.json; exits 1 if the rendered shadow patch
// misses the Radiance patch (IoU below the fixture's threshold).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values: args } = parseArgs({
  options: { only: { type: 'string' }, scale: { type: 'string' }, out: { type: 'string' } },
});
const out = args.out
  ? resolve(args.out)
  : fileURLToPath(new URL('../../bake/reports/m1/', import.meta.url));
const iouMin = JSON.parse(readFileSync(join(root, 'src/__fixtures__/m1.json'), 'utf8')).iou_min;

const SHOTS = [
  ['room', '?'],
  ['room-sw', '?cam=sw'],
  ['room-top', '?cam=top'],
  ['spots-top', '?debug=spots&cam=top'],
  ['pattern-inside-SW-walls', '?debug=pattern'],
  ['pattern-inside-NE-walls', '?debug=pattern&cam=sw'],
  ['pattern-outside-NE-walls', '?debug=pattern&cam=ne&cut=0'],
  ['pattern-outside-SW-walls', '?debug=pattern&cam=sw&cut=0'],
  ['pattern-floor-top', '?debug=pattern&cam=top'],
  ['rhino-outside', '?debug=rhino&cam=sw&cut=0'],
  ['m1-A-shadow', '?debug=m1&case=A&layer=shadow'],
  ['m1-A-shadow-top', '?debug=m1&case=A&layer=shadow&view=top'],
  ['m1-A-radiance-top', '?debug=m1&case=A&layer=radiance&view=top'],
  ['m1-B-shadow', '?debug=m1&case=B&layer=shadow'],
  ['m1-B-shadow-top', '?debug=m1&case=B&layer=shadow&view=top'],
  ['m1-B-radiance-top', '?debug=m1&case=B&layer=radiance&view=top'],
  ...bakeShots(),
  ...appShots(),
].filter(([name]) => !args.only || name.startsWith(args.only));

// The demo (`--only app`): a few selections, and one change frozen mid-way through the facade
// animation (the third entry runs in the page after load). Time is frozen in all but the night
// shots, so the clock cannot move a view on.
function appShots() {
  const q = (state, slot, extra = '') =>
    `?city=houston&month=12&state=${state}&slot=${slot}${extra}`;
  // The last hour, then on by `sec` (8: into the night; 18: the next morning).
  const lastHourThen = (sec) =>
    `window.__rf.app.set({ slot: 99 }).then(() => window.__rf.app.advance(${sec}))`;
  const night = [
    ['app-night', '?city=houston&month=12', lastHourThen(8)],
    ['app-night-tv', q('couch_tv', '16:30'), lastHourThen(8)],
    ['app-night-morning', '?city=houston&month=12', lastHourThen(18)],
    // Time running: the thumb partway from one hour's line to the next.
    ['app-timebar-mid', '?city=houston&month=12&slot=11:30', 'window.__rf.app.advance(2.5)'],
  ];
  const frozen = [
    ['app-ambient', '?'],
    ['app-couch_relax-radiance', q('couch_relax', '12:30', '&layer=radiance')],
    ['app-dining-surrogate', q('dining', '11:30', '&layer=surrogate')],
    ['app-desk-1130', q('desk', '11:30')],
    ['app-couch_tv-1630', q('couch_tv', '16:30')],
    ['app-baseline-radiance', q('baseline', '11:30', '&layer=radiance')],
    // The occupant (M4): where they start, the activity poses, standing, and mid-walk.
    ['app-occupant-entry', '?city=houston&month=12&slot=11:30'],
    ['app-occupant-desk', q('desk', '11:30')],
    ['app-occupant-tv', q('couch_tv', '15:30')],
    ['app-occupant-chaise', q('lounger_relax', '11:30')],
    ['app-occupant-reading', q('lounge_read_w', '11:30')],
    ['app-occupant-range', q('cooking_range', '11:30')],
    ['app-occupant-dining', q('dining', '12:30')],
    ['app-occupant-walking', q('ambient', '11:30'), `window.__rf.app.goToState('dining')`],
    // "Hold until they arrive": mid-walk the facade has not moved; on arrival it has.
    ...[
      ['walking', 2],
      ['arrived', 8],
    ].map(([name, sec]) => [
      `app-hold-${name}`,
      '?city=houston&month=12&slot=11:30&hold=1',
      `(window.__rf.app.goToState('dining'), window.__rf.app.advance(${sec}))`,
    ]),
    // Walking from the entry to sit on the sofa, seen from above.
    ...[2, 3.5, 4.5, 5.2, 5.8, 7].map((sec) => [
      `app-sofa-walk-${String(sec).replace('.', '_')}s`,
      '?city=houston&month=12&slot=11:30&cam=top',
      `(window.__rf.app.goToState('couch_relax'), window.__rf.app.advance(${sec}))`,
    ]),
    ['app-flip-mid', q('couch_relax', '10:30'), () => window.__rf.app.previewAt({ slot: 3 }, 450)],
    // The curtain: TV (mostly closed) to cooking (mostly open) raises; back again drops.
    ...[0, 250, 500, 750].flatMap((ms) => [
      [
        `app-curtain-raise-${ms}`,
        q('couch_tv', '11:30'),
        `window.__rf.app.previewAt({ state: 'cooking_range' }, ${ms})`,
      ],
      [
        `app-curtain-drop-${ms}`,
        q('cooking_range', '11:30'),
        `window.__rf.app.previewAt({ state: 'couch_tv' }, ${ms})`,
      ],
    ]),
  ];
  return [
    ...frozen.map(([name, query, action]) => [
      name,
      `${query}${query === '?' ? '' : '&'}freeze=1`,
      action,
    ]),
    ...night,
  ];
}

// Bake review (`--only bake`): one state through the day, every activity at the clearest
// hour with the Radiance heatmap, surrogate against Radiance, and the facade from outside.
function bakeShots() {
  const q = (state, slot, extra = '') =>
    `?debug=bake&city=houston&month=12&state=${state}&slot=${slot}${extra}`;
  const hhmm = (slot) => slot.replace(':', '');
  const day = ['08:30', '10:30', '12:30', '14:30', '16:30'].map((t) => [
    `bake-day-couch_relax-${hhmm(t)}`,
    q('couch_relax', t, '&layer=none'),
  ]);
  const states = [
    'ambient',
    'couch_relax',
    'couch_tv',
    'lounge_read_w',
    'dining',
    'cooking_range',
    'desk',
    'baseline',
  ];
  return [
    ...day,
    ...states.map((s) => [`bake-1130-${s}`, q(s, '11:30')]),
    // The room lit by each state's Radiance lux, without the heatmap.
    ...states.map((s) => [`bake-lit-1130-${s}`, q(s, '11:30', '&layer=none')]),
    // The TV on: late in the day, and from the south-west, facing the screen.
    ['bake-tv-1630-couch_tv', q('couch_tv', '16:30', '&layer=none')],
    ['bake-tv-1130-couch_tv-sw', q('couch_tv', '11:30', '&layer=none&cam=sw')],
    ['bake-1130-lounge_read_w-surrogate', q('lounge_read_w', '11:30', '&layer=surrogate')],
    ['bake-1130-desk-top', q('desk', '11:30', '&view=top')],
    ['bake-outside-1130-couch_relax', q('couch_relax', '11:30', '&layer=none&cam=sw&cut=0')],
    ['bake-outside-1130-baseline', q('baseline', '11:30', '&layer=none&cam=sw&cut=0')],
  ];
}

mkdirSync(out, { recursive: true });
const server = await createServer({ root, logLevel: 'error', server: { port: 5199 } });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: Number(args.scale ?? 1),
});
page.on('console', (m) => m.type() === 'error' && console.error(`[page] ${m.text()}`));
page.on('pageerror', (e) => console.error(`[page] ${e.message}`));

// Google Drive sync briefly locks files it is uploading; retry the write instead of failing.
async function writeRetry(path, data) {
  for (let i = 0; ; i++) {
    try {
      return writeFileSync(path, data);
    } catch (e) {
      if (i >= 5) throw e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
}

const results = {};
let failed = false;
try {
  for (const [name, query, action] of SHOTS) {
    await page.goto(base + query);
    await page.waitForFunction(
      () => window.__rf && (window.__rf.ready || window.__rf.error),
      null,
      {
        timeout: 90_000,
      },
    );
    const rf = await page.evaluate(() => window.__rf);
    if (rf.error) throw new Error(`${name}: ${rf.error}`);
    if (action) await page.evaluate(action);
    await page.waitForTimeout(action ? 1200 : 400);
    await writeRetry(join(out, `${name}.png`), await page.screenshot());
    if (rf.m1) {
      const { case: id, iou_render, lit_render, lit_radiance } = rf.m1;
      results[name] = { case: id, iou_render, lit_render, lit_radiance };
      if (iou_render < iouMin) failed = true;
    }
    console.log(`${name}${rf.m1 ? `  IoU ${rf.m1.iou_render.toFixed(3)}` : ''}`);
  }
} finally {
  await browser.close();
  await server.close();
}
if (!args.only) {
  await writeRetry(join(out, 'render_check.json'), JSON.stringify(results, null, 2) + '\n');
}
process.exit(failed ? 1 : 0);
