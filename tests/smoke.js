#!/usr/bin/env node
/* Zero-dependency invariant harness for the board kit.
 *
 *   node tests/smoke.js
 *
 * Validates every seed (the demo baked into board.html + everything under examples/) against
 * the same rules the engine relies on, and reproduces the engine's readiness derivation so a
 * broken graph fails here instead of silently in a browser. No deps, runs in CI.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const ok = (name) => console.log('  ✓ ' + name);
const fail = (name, msg) => { failures++; console.log('  ✗ ' + name + '\n      ' + msg); };
function check(name, cond, msg) { cond ? ok(name) : fail(name, msg || 'assertion failed'); }

/* ---- pull the inline seed out of board.html (the demo board) ---- */
function seedFromHtml(file) {
  const s = fs.readFileSync(file, 'utf8');
  const open = '<script id="seed" type="application/json">';
  const i = s.indexOf(open);
  if (i === -1) throw new Error('no <script id="seed"> in ' + file);
  const j = s.indexOf('</script>', i + open.length);
  return JSON.parse(s.slice(i + open.length, j));
}

/* ---- the engine's own logic, reproduced: derive state for every task ---- */
function derive(seed) {
  const byId = {};
  seed.tasks.forEach((t) => { byId[t.id] = t; });
  return seed.tasks.map((t) => {
    const blockers = (t.deps || []).filter((d) => byId[d] && byId[d].status !== 'done');
    const state = t.status === 'done' ? 'done' : (blockers.length ? 'blocked' : 'ready');
    return { id: t.id, state, blockers };
  });
}

/* ---- cycle detection over the dep graph ---- */
function hasCycle(seed) {
  const byId = {}; seed.tasks.forEach((t) => { byId[t.id] = t; });
  const WHITE = 0, GRAY = 1, BLACK = 2, color = {};
  seed.tasks.forEach((t) => { color[t.id] = WHITE; });
  let cyc = null;
  function visit(id, trail) {
    color[id] = GRAY;
    for (const d of (byId[id] && byId[id].deps) || []) {
      if (!byId[d]) continue;
      if (color[d] === GRAY) { cyc = trail.concat(d).join(' → '); return true; }
      if (color[d] === WHITE && visit(d, trail.concat(d))) return true;
    }
    color[id] = BLACK;
    return false;
  }
  for (const t of seed.tasks) { if (color[t.id] === WHITE && visit(t.id, [t.id])) break; }
  return cyc;
}

function validate(label, seed) {
  console.log('\n' + label);
  const cfg = seed.config || {};

  // config: two lanes + ext
  check('config.lanes has exactly 2 lanes',
    Array.isArray(cfg.lanes) && cfg.lanes.length === 2,
    'expected 2 lanes, got ' + (cfg.lanes ? cfg.lanes.length : 'none'));
  (cfg.lanes || []).forEach((l, i) => {
    check('lane[' + i + '] has id/label/color', l && l.id && l.label && l.color, JSON.stringify(l));
  });
  check('config.ext defined', cfg.ext && cfg.ext.label, 'missing config.ext');

  const laneIds = (cfg.lanes || []).map((l) => l.id);
  const validOwners = new Set(laneIds.concat(['ext']));
  const worldLanes = (cfg.lanes || []).filter((l) => l.world);
  check('at most one lane flagged world:true', worldLanes.length <= 1, worldLanes.length + ' lanes marked world');

  // tracks
  const trackIds = new Set((seed.tracks || []).map((t) => t.id));
  check('has at least one track', trackIds.size >= 1, 'no tracks');
  (seed.tracks || []).forEach((tr) => {
    check('track "' + tr.id + '" has name + color', tr.name && tr.color, JSON.stringify(tr));
  });

  // tasks
  const ids = new Set();
  let dup = null, badOwner = null, badTrack = null, badStatus = null, missingDep = null;
  (seed.tasks || []).forEach((t) => {
    if (ids.has(t.id)) dup = t.id; ids.add(t.id);
    if (!validOwners.has(t.owner)) badOwner = t.id + ' (owner=' + t.owner + ')';
    if (!trackIds.has(t.track)) badTrack = t.id + ' (track=' + t.track + ')';
    if (t.status !== 'open' && t.status !== 'done') badStatus = t.id + ' (status=' + t.status + ')';
    (t.deps || []).forEach((d) => { if (!ids.has(d) && !(seed.tasks || []).some((x) => x.id === d)) missingDep = t.id + ' → ' + d; });
  });
  check('task ids are unique', !dup, 'duplicate id: ' + dup);
  check('every owner is a lane id or "ext"', !badOwner, 'bad owner: ' + badOwner);
  check('every task track exists', !badTrack, 'bad track: ' + badTrack);
  check('every status is open|done', !badStatus, 'bad status: ' + badStatus);

  // deps resolve
  let unresolved = null;
  (seed.tasks || []).forEach((t) => {
    (t.deps || []).forEach((d) => { if (!ids.has(d)) unresolved = t.id + ' → ' + d; });
  });
  check('every dep resolves to a real task', !unresolved, 'dangling dep: ' + unresolved);

  // acyclic
  const cyc = hasCycle(seed);
  check('dependency graph is acyclic', !cyc, 'cycle: ' + cyc);

  // terminus: at most one, and it should be reachable (has deps or the graph converges on it)
  const termini = (seed.tasks || []).filter((t) => t.terminus);
  check('at most one terminus', termini.length <= 1, termini.length + ' tasks flagged terminus');

  // readiness derivation runs and produces sane states
  const states = derive(seed);
  const ready = states.filter((s) => s.state === 'ready').length;
  const blocked = states.filter((s) => s.state === 'blocked').length;
  const done = states.filter((s) => s.state === 'done').length;
  check('readiness derivation covers every task', states.length === (seed.tasks || []).length);
  console.log('      ' + states.length + ' tasks — ' + ready + ' ready, ' + blocked + ' blocked, ' + done + ' done');

  // functional unblock check: completing every dep of a blocked task makes it ready
  const blockedSample = states.find((s) => s.state === 'blocked');
  if (blockedSample) {
    const clone = JSON.parse(JSON.stringify(seed));
    const byId = {}; clone.tasks.forEach((t) => { byId[t.id] = t; });
    (byId[blockedSample.id].deps || []).forEach((d) => { if (byId[d]) byId[d].status = 'done'; });
    const after = derive(clone).find((s) => s.id === blockedSample.id);
    check('completing its blockers unblocks "' + blockedSample.id + '"', after.state === 'ready',
      'still ' + after.state + ' after clearing deps');
  } else {
    ok('no blocked task to exercise unblock (graph fully ready/done)');
  }
}

/* ---- board.html engine sanity: generic, no leftover project coupling ---- */
function checkEngine() {
  console.log('\nboard.html engine');
  const html = fs.readFileSync(path.join(ROOT, 'board.html'), 'utf8');
  const engine = html.slice(0, html.indexOf('<script id="seed"')) +
                 html.slice(html.indexOf('</script>', html.indexOf('<script id="seed"')));
  check('exposes window.BoardMap', /window\.BoardMap\s*=/.test(html));
  check('reads seed.config', /seed\.config/.test(html));
  const leaks = ['pilot-live', 'nabshift', 'NabMap', '--mike', '--claude'];
  leaks.forEach((tok) => {
    check('engine free of "' + tok + '"', engine.toLowerCase().indexOf(tok.toLowerCase()) === -1,
      'found "' + tok + '" in the generic engine (should only live in a seed)');
  });
}

/* ---- run ---- */
console.log('board-kit smoke test');
try {
  checkEngine();
  validate('board.html (demo seed)', seedFromHtml(path.join(ROOT, 'board.html')));
  const exDir = path.join(ROOT, 'examples');
  fs.readdirSync(exDir).filter((f) => f.endsWith('.seed.json')).forEach((f) => {
    validate('examples/' + f, JSON.parse(fs.readFileSync(path.join(exDir, f), 'utf8')));
  });
} catch (e) {
  failures++;
  console.log('\n  ✗ harness error: ' + e.message);
}

console.log('\n' + (failures ? '✗ ' + failures + ' failure(s)' : '✓ all checks passed'));
process.exit(failures ? 1 : 0);
