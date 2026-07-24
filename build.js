#!/usr/bin/env node
/* OPTIONAL convenience — you do not need this to use the kit.
 *
 * Injects a standalone seed file into board.html's <script id="seed"> block and writes a new
 * self-contained board to stdout. Handy for keeping the engine in one place and one seed per
 * project, or for viewing an example:
 *
 *   node build.js examples/nabshift.seed.json > nabshift-board.html
 *   open nabshift-board.html
 *
 * Zero dependencies. The no-build path still works: copy board.html and edit its seed by hand.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const seedPath = process.argv[2];
if (!seedPath) {
  console.error('usage: node build.js <seed.json>  > out.html');
  process.exit(2);
}
const OPEN = '<script id="seed" type="application/json">';
const html = fs.readFileSync(path.join(__dirname, 'board.html'), 'utf8');
const seed = fs.readFileSync(seedPath, 'utf8').trim();

JSON.parse(seed); // fail loudly on a malformed seed rather than shipping a broken board

const i = html.indexOf(OPEN);
if (i === -1) { console.error('board.html has no <script id="seed"> block'); process.exit(1); }
const j = html.indexOf('</script>', i + OPEN.length);
process.stdout.write(html.slice(0, i + OPEN.length) + '\n' + seed + '\n' + html.slice(j));
