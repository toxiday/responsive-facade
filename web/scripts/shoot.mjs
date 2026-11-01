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
].filter(([name]) => !args.only || name.startsWith(args.only));

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
  for (const [name, query] of SHOTS) {
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
    await page.waitForTimeout(400);
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
