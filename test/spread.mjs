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
  check('every year gets a share', years.every((y) => counts[y] > 0), JSON.stringify(counts));

  // Years with enough photos to sustain a fair share must get equal airtime.
  // Years that DON'T are capped by arithmetic, not by policy: the no-repeat
  // history is 150 deep, so a 20-photo year can supply at most 20 of any 150
  // consecutive shows (13%) — below an even 25% share of four years. Forcing it
  // higher would mean reshowing its photos inside the no-repeat window, which is
  // the guarantee test/unique.mjs enforces. Freshness wins; the cap is honest.
  const dense = years.filter((y) => SIZES[y] >= 150);
  const denseShares = dense.map((y) => counts[y] / DRAWS);
  const spread = Math.max(...denseShares) - Math.min(...denseShares);
  check('years with enough photos share airtime evenly', spread < 0.05,
    `spread ${(spread * 100).toFixed(1)}pp across ${dense.join(',')}  ${JSON.stringify(counts)}`);

  // The sparse year is capped, but must still be lifted far above the
  // proportional share a flat draw would give it — that's the whole point.
  const total = years.reduce((n, y) => n + SIZES[y], 0);
  const sparse = years.find((y) => SIZES[y] < 150);
  const lift = (counts[sparse] / DRAWS) / (SIZES[sparse] / total);
  check('a sparse year is lifted far above its proportional share', lift > 20,
    `${sparse}: ${(counts[sparse] / DRAWS * 100).toFixed(1)}% vs ${(SIZES[sparse] / total * 100).toFixed(2)}% proportional — ${lift.toFixed(0)}x`);

  // Regression guard: year-first picking must not reintroduce repeats. Scoping
  // the recent window per bucket once made a 2-photo year recycle its own tail.
  const tight = { 2004: ['a'], 2008: ['b', 'c'], 2012: Array.from({ length: 400 }, (_, i) => `d${i}`) };
  const recentT = [], shown = [];
  for (let i = 0; i < 120; i++) {
    const id = picker.pickFromBuckets(tight, { onWall: {}, lastShow: shown[shown.length - 1] || null, recentShown: recentT });
    shown.push(id); recentT.push(id); if (recentT.length > 150) recentT.shift();
  }
  check('no photo repeats inside the history window', new Set(shown).size === shown.length,
    `${shown.length} shows, ${new Set(shown).size} distinct`);

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

  // --- a real library has years holding one or two photos. Those must appear,
  // but must not dominate: uniform year choice alone would give a lone 2004
  // photo ~1/N of every show. The cooldown floor keeps it occasional.
  const REAL = { 2004: 1, 2009: 15, 2012: 1153, 2019: 278, 2025: 3876 };
  const realBuckets = {};
  for (const y in REAL) { realBuckets[y] = Array.from({ length: REAL[y] }, (_, i) => `${y}-${i}`); }
  const realCounts = {};
  const realRecent = [];
  const REAL_DRAWS = 6000;
  for (let i = 0; i < REAL_DRAWS; i++) {
    const id = picker.pickFromBuckets(realBuckets, { onWall: {}, lastShow: null, recentShown: realRecent });
    realCounts[yearOf(id)] = (realCounts[yearOf(id)] || 0) + 1;
    realRecent.push(id); if (realRecent.length > 150) realRecent.shift();
  }
  const loneShare = (realCounts['2004'] || 0) / REAL_DRAWS;
  check('a one-photo year still appears', (realCounts['2004'] || 0) > 0, `${realCounts['2004']} shows`);
  check('a one-photo year does not dominate', loneShare < 0.05, `${(loneShare * 100).toFixed(2)}% of shows  ${JSON.stringify(realCounts)}`);
  check('dense years still share airtime broadly', Object.keys(realCounts).length === 5, JSON.stringify(realCounts));

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
