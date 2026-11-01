// Fails the build if the shipped site breaks the data budget (guidelines §4.5, §7a):
// baked data ≤ 20 MB in total and every file < 50 MB.
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const MB = 1024 * 1024;
const DATA_LIMIT = 20 * MB;
const FILE_LIMIT = 50 * MB;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [{ path: p, size: statSync(p).size }];
  });
}

const files = walk(DIST);
const total = files.reduce((s, f) => s + f.size, 0);
const data = files
  .filter((f) => relative(DIST, f.path).split(/[\\/]/)[0] === 'data')
  .reduce((s, f) => s + f.size, 0);
const tooBig = files.filter((f) => f.size >= FILE_LIMIT);

console.log(
  `dist: ${files.length} files, ${(total / MB).toFixed(2)} MB (data ${(data / MB).toFixed(2)} MB)`,
);
let failed = false;
if (data > DATA_LIMIT) {
  console.error(`data is ${(data / MB).toFixed(2)} MB, over the 20 MB budget`);
  failed = true;
}
for (const f of tooBig) {
  console.error(`${relative(DIST, f.path)} is ${(f.size / MB).toFixed(1)} MB (limit 50 MB)`);
  failed = true;
}
process.exit(failed ? 1 : 0);
