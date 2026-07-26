// photo_index persistence: round-trip, corrupt/versioned files force a clean
// rescan, and an interrupted scan resumes below the oldest complete year.
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const immich = require('../immich.js');
const photoIndex = require('../photo_index.js');

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function server(items) {
  const calls = [];
  return { calls, request(p, m, body) { calls.push(JSON.parse(JSON.stringify(body || {}))); return Promise.resolve({ assets: { items } }); } };
}
const ASSETS = [
  { id: 'x2024', localDateTime: '2024-04-04T00:00:00Z' },
  { id: 'x2019', localDateTime: '2019-04-04T00:00:00Z' }
];

async function run() {
  const dir = mkdtempSync(join(tmpdir(), 'pidx-'));
  const file = join(dir, 'photo-index.json');

  // --- scan, flush, and read back
  photoIndex._reset(); photoIndex._setDataDir(dir);
  immich._setRequest(server(ASSETS).request);
  await photoIndex.ensure('library', {});
  for (let i = 0; i < 50 && photoIndex.scanning('library'); i++) await sleep(20);
  await photoIndex.flush();
  check('cache file written', existsSync(file));
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  check('file carries a version', raw.version === 1, String(raw.version));
  check('file carries taken timestamps', typeof raw.taken['x2019'] === 'number', typeof raw.taken['x2019']);
  check('file carries year buckets', raw.indexes.library.years['2019'].join() === 'x2019', JSON.stringify(raw.indexes.library.years));

  // --- reload from disk issues zero requests
  photoIndex._reset(); photoIndex._setDataDir(dir);
  const fresh = server([]);
  immich._setRequest(fresh.request);
  await photoIndex.init();
  check('init restores buckets', photoIndex.buckets('library')['2024'].join() === 'x2024', JSON.stringify(photoIndex.buckets('library')));
  check('init restores completeness', photoIndex.isComplete('library') === true);
  await photoIndex.ensure('library', {});
  check('restored index needs no requests', fresh.calls.length === 0, String(fresh.calls.length));
  check('takenAt restored for moments', immich.takenAt('x2019') !== null, String(immich.takenAt('x2019')));

  // --- corrupt file -> clean rescan, no crash
  writeFileSync(file, '{ this is not json');
  photoIndex._reset(); photoIndex._setDataDir(dir);
  const afterCorrupt = server(ASSETS);
  immich._setRequest(afterCorrupt.request);
  await photoIndex.init();
  check('corrupt file leaves an empty index', photoIndex.pool('library').length === 0, String(photoIndex.pool('library').length));
  await photoIndex.ensure('library', {});
  for (let i = 0; i < 50 && photoIndex.scanning('library'); i++) await sleep(20);
  check('corrupt file triggers a real rescan', afterCorrupt.calls.length > 0, String(afterCorrupt.calls.length));

  // --- version mismatch -> clean rescan
  writeFileSync(file, JSON.stringify({ version: 999, taken: { z: 1 }, indexes: { library: { years: { 2001: ['z'] }, complete: {}, done: true } } }));
  photoIndex._reset(); photoIndex._setDataDir(dir);
  immich._setRequest(server([]).request);
  await photoIndex.init();
  check('version mismatch discards the cache', photoIndex.pool('library').length === 0, String(photoIndex.pool('library').length));

  // --- interrupted scan resumes below the oldest complete year
  writeFileSync(file, JSON.stringify({
    version: 1, taken: { a: Date.parse('2024-01-01') },
    indexes: { library: { years: { 2024: ['a'] }, complete: { 2024: true }, done: false, lastDelta: null } }
  }));
  photoIndex._reset(); photoIndex._setDataDir(dir);
  const resume = server([]);
  immich._setRequest(resume.request);
  await photoIndex.init();
  check('incomplete index is not marked done', photoIndex.isComplete('library') === false);
  await photoIndex.ensure('library', {});
  for (let i = 0; i < 50 && photoIndex.scanning('library'); i++) await sleep(20);
  check('resume scans below the oldest complete year',
    resume.calls.length > 0 && resume.calls[0].takenBefore === new Date(Date.UTC(2024, 0, 1)).toISOString(),
    JSON.stringify(resume.calls[0]));

  immich._setRequest(null);
  console.log(results.every(Boolean) ? '\nALL PASS' : '\nFAILURES');
  process.exit(results.every(Boolean) ? 0 : 1);
}
run();
