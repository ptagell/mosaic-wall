// The test that proves the feature: with wildly uneven year buckets, the picker
// still gives each year roughly equal airtime — and every existing freshness
// rule survives the change.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const picker = require('../picker.js');

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

// Deliberately lopsided: 2024 has 400x more photos than 2011.
const BUCKETS = {};
const SIZES = { 2011: 20, 2015: 200, 2019: 2000, 2024: 8000 };
for (const y in SIZES) { BUCKETS[y] = Array.from({ length: SIZES[y] }, (_, i) => `${y}-${i}`); }
const yearOf = (id) => String(id).split('-')[0];

function run() {
  // --- year distribution is ~uniform despite 20 vs 8000 bucket sizes
  const counts = {};
  const recent = [];
  const DRAWS = 4000;
  for (let i = 0; i < DRAWS; i++) {
    const id = picker.pickFromBuckets(BUCKETS, { onWall: {}, lastShow: null, recentShown: recent });
    counts[yearOf(id)] = (counts[yearOf(id)] || 0) + 1;
    recent.push(id); if (recent.length > 150) recent.shift();
  }
  const years = Object.keys(SIZES);
  const expected = DRAWS / years.length;
  const worst = Math.max(...years.map((y) => Math.abs((counts[y] || 0) - expected) / expected));
  check('every year gets a share', years.every((y) => counts[y] > 0), JSON.stringify(counts));
  check('year shares within 25% of uniform', worst < 0.25, `worst deviation ${(worst * 100).toFixed(1)}%  ${JSON.stringify(counts)}`);

  // --- for contrast, a naive flat draw would be ~78% 2024
  const flat = [].concat(...years.map((y) => BUCKETS[y]));
  const naive2024 = BUCKETS['2024'].length / flat.length;
  check('sanity: flat draw would be 2024-dominated', naive2024 > 0.7, `${(naive2024 * 100).toFixed(0)}%`);

  // --- freshness: never returns a photo already on another tile
  const onWall = {}; BUCKETS['2011'].forEach((id) => { onWall[id] = true; });
  let leaked = 0;
  for (let i = 0; i < 500; i++) {
    const id = picker.pickFromBuckets(BUCKETS, { onWall, lastShow: null, recentShown: [] });
    if (onWall[id]) leaked++;
  }
  check('never picks a photo already on the wall', leaked === 0, `${leaked} leaks`);

  // --- freshness: never repeats this tile's current photo
  let repeats = 0;
  for (let i = 0; i < 500; i++) {
    const id = picker.pickFromBuckets(BUCKETS, { onWall: {}, lastShow: '2011-0', recentShown: [] });
    if (id === '2011-0') repeats++;
  }
  check('never repeats the tile current photo', repeats === 0, `${repeats} repeats`);

  // --- an exhausted year falls through instead of returning null
  const tiny = { 2011: ['a'], 2024: ['b', 'c'] };
  const got = new Set();
  for (let i = 0; i < 200; i++) {
    got.add(picker.pickFromBuckets(tiny, { onWall: { a: true }, lastShow: null, recentShown: [] }));
  }
  check('exhausted year falls through to another', !got.has(null) && !got.has('a'), [...got].join(','));

  // --- single-photo pool still returns that photo rather than null
  check('single-photo pool returns it', picker.pickFromBuckets({ 2020: ['only'] }, { onWall: {}, lastShow: null, recentShown: [] }) === 'only');

  // --- fully-blocked pool returns null rather than throwing
  check('fully blocked pool returns null', picker.pickFromBuckets({ 2020: ['x'] }, { onWall: { x: true }, lastShow: 'x', recentShown: [] }) === null);

  // --- empty buckets
  check('empty buckets return null', picker.pickFromBuckets({}, { onWall: {}, lastShow: null, recentShown: [] }) === null);

  // --- groupByYear buckets by timestamp and handles undated photos
  const g = picker.groupByYear(['p', 'q', 'r'], (id) => (id === 'p' ? Date.parse('2018-01-01') : id === 'q' ? Date.parse('2021-01-01') : null));
  check('groupByYear buckets by year', (g['2018'] || []).join() === 'p' && (g['2021'] || []).join() === 'q', JSON.stringify(g));
  check('groupByYear puts undated in unknown', (g['unknown'] || []).join() === 'r', JSON.stringify(g));

  // --- rand is injectable for determinism
  const fixed = picker.pickFromBuckets(BUCKETS, { onWall: {}, lastShow: null, recentShown: [], rand: () => 0 });
  const fixed2 = picker.pickFromBuckets(BUCKETS, { onWall: {}, lastShow: null, recentShown: [], rand: () => 0 });
  check('injected rand makes picks deterministic', fixed === fixed2, `${fixed} vs ${fixed2}`);

  console.log(results.every(Boolean) ? '\nALL PASS' : '\nFAILURES');
  process.exit(results.every(Boolean) ? 0 : 1);
}
run();
