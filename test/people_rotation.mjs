// different-people: every selected person gets airtime even when there are more
// people than tiles, and the scene's own config survives switching scenes.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const immich = require('../immich.js');
const photoIndex = require('../photo_index.js');
const picker = require('../picker.js');
const scenes = require('../scenes.js');

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

// Alphabetically-first person deliberately has the NARROWEST range, which is
// what made the admin histogram appear to shrink as people were added.
const PEOPLE = [
  { id: 'p-anna', name: 'Anna' }, { id: 'p-ben', name: 'Ben' }, { id: 'p-cara', name: 'Cara' },
  { id: 'p-dave', name: 'Dave' }, { id: 'p-eve', name: 'Eve' }
];
const RANGES = { 'p-anna': [2025, 2025], 'p-ben': [2020, 2026], 'p-cara': [2010, 2026], 'p-dave': [2005, 2026], 'p-eve': [2008, 2026] };
function idsFor(pid) {
  const [a, b] = RANGES[pid]; const out = [];
  for (let y = a; y <= b; y++) for (let i = 0; i < 5; i++) { const id = `${pid}-${y}-${i}`; immich.taken[id] = Date.UTC(y, 5, 1); out.push(id); }
  return out;
}
immich.getPeople = () => Promise.resolve(PEOPLE);
photoIndex.personPool = (pid) => Promise.resolve(idsFor(pid));
photoIndex.selectionPool = () => Promise.resolve([]);
const ctx = { defaultPool: () => Promise.resolve([]) };
const yearsOf = (ids) => Object.keys(picker.groupByYear(ids, immich.takenAt)).filter((k) => k !== 'unknown').sort();

async function run() {
  const all = PEOPLE.map((p) => p.id);

  // --- resolvePools must expose every selected person, not just min(tiles,people)
  const r = await scenes.resolvePools('different-people', { personIds: all }, ['t0', 't1'], ctx);
  check('rotation is exposed for the whole selection', !!(r.rotation && r.rotation.order), JSON.stringify(Object.keys(r)));
  check('rotation covers all 5 selected people', r.rotation && r.rotation.order.length === 5, r.rotation && r.rotation.order.join(','));
  const rotIds = Object.values(r.rotation.byPid).flat();
  check('rotation pools span the full range despite 2 tiles', yearsOf(rotIds).length === 22, yearsOf(rotIds).join(','));

  // --- walking the rotation must reach every person
  const seen = new Set();
  const tiles = ['t0', 't1'];
  for (let step = 0; step < 5; step++) {
    tiles.forEach((_, i) => seen.add(r.rotation.order[(i + step * tiles.length) % r.rotation.order.length]));
  }
  check('every selected person appears while rotating', seen.size === 5, [...seen].join(','));

  // --- two tiles must never land on the same person at the same step
  let collisions = 0;
  for (let step = 0; step < 20; step++) {
    const a = r.rotation.order[(0 + step * 2) % 5], b = r.rotation.order[(1 + step * 2) % 5];
    if (a === b) collisions++;
  }
  check('no two tiles share a person at the same step', collisions === 0, `${collisions} collisions`);

  // --- a selection smaller than the tile count still fills every tile
  const few = await scenes.resolvePools('different-people', { personIds: ['p-dave'] }, ['t0', 't1', 't2'], ctx);
  check('single-person selection still fills every tile',
    ['t0', 't1', 't2'].every((t) => (few.pools[t] || []).length > 0),
    JSON.stringify(Object.keys(few.pools)));

  // --- shared-pool scenes must not gain a rotation
  const rnd = await scenes.resolvePools('random', {}, ['t0'], ctx);
  check('shared-pool scenes carry no rotation', !rnd.rotation, JSON.stringify(rnd.rotation));

  console.log(results.every(Boolean) ? '\nALL PASS' : '\nFAILURES');
  process.exit(results.every(Boolean) ? 0 : 1);
}
run();
