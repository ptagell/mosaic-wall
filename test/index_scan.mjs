// photo_index scanning: buckets by year, resolves early for progressive boot,
// marks years complete as the descending scan passes them, dedupes, and
// guards against concurrent scans of the same key.
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const immich = require('../immich.js');
const photoIndex = require('../photo_index.js');

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Point at a temp dir from the start: Task 3 turns on debounced disk writes and
// this test must never touch the real data/photo-index.json.
const TMP = mkdtempSync(join(tmpdir(), 'pidx-scan-'));
const reset = () => { photoIndex._reset(); photoIndex._setDataDir(TMP); };

// 2500 assets spread over 2024, 2023, 2022 (1000/1000/500), newest first.
function yearsServer() {
  const calls = [];
  const mk = (y, i) => ({ id: `${y}-${i}`, localDateTime: new Date(Date.UTC(y, 5, 1 + (i % 27))).toISOString() });
  const all = [];
  for (let i = 0; i < 1000; i++) all.push(mk(2024, i));
  for (let i = 0; i < 1000; i++) all.push(mk(2023, i));
  for (let i = 0; i < 500; i++) all.push(mk(2022, i));
  return {
    calls, all,
    request(apiPath, method, body) {
      calls.push({ apiPath, body: JSON.parse(JSON.stringify(body || {})) });
      const size = body.size, page = body.page || 1, start = (page - 1) * size;
      return Promise.resolve({ assets: { items: all.slice(start, start + size) } });
    }
  };
}

async function run() {
  reset();
  const fake = yearsServer();
  immich._setRequest(fake.request);

  // --- ensure() resolves early (first page) so boot isn't blocked
  const done = [];
  photoIndex.onUpdate((k) => done.push(k));
  const early = await photoIndex.ensure('library', {});
  check('ensure resolves after the first page', early.length === 1000, String(early.length));
  check('scan still running in background', photoIndex.scanning('library') === true);

  // --- background scan completes
  for (let i = 0; i < 50 && photoIndex.scanning('library'); i++) await sleep(20);
  check('scan finished', photoIndex.scanning('library') === false);
  check('onUpdate fired with the key', done.includes('library'), done.join(','));

  // --- buckets by year
  const b = photoIndex.buckets('library');
  check('three year buckets', Object.keys(b).sort().join(',') === '2022,2023,2024', Object.keys(b).sort().join(','));
  check('2024 bucket size', b['2024'].length === 1000, String(b['2024'].length));
  check('2022 bucket size', b['2022'].length === 500, String(b['2022'].length));

  // --- flat pool is the union
  check('pool is the union', photoIndex.pool('library').length === 2500, String(photoIndex.pool('library').length));

  // --- histogram
  const h = photoIndex.histogram('library');
  check('histogram counts per year', h['2023'] === 1000 && h['2022'] === 500, JSON.stringify(h));

  // --- completeness
  check('index reports complete', photoIndex.isComplete('library') === true);

  // --- concurrent ensure() does not start a second scan
  const before = fake.calls.length;
  await photoIndex.ensure('library', {});
  check('re-ensure of a complete index issues no requests', fake.calls.length === before, `${before}->${fake.calls.length}`);

  // --- unknown timestamps land in the 'unknown' stratum
  reset();
  immich._setRequest(() => Promise.resolve({ assets: { items: [
    { id: 'u1' }, { id: 'u2', localDateTime: 'not-a-date' }, { id: 'k1', localDateTime: '2019-03-04T00:00:00Z' }
  ] } }));
  await photoIndex.ensure('library', {});
  for (let i = 0; i < 50 && photoIndex.scanning('library'); i++) await sleep(20);
  const ub = photoIndex.buckets('library');
  check('undated photos go to the unknown stratum', (ub['unknown'] || []).length === 2, JSON.stringify(Object.keys(ub)));
  check('dated photo still bucketed by year', (ub['2019'] || []).length === 1, JSON.stringify(Object.keys(ub)));

  // --- duplicate ids are not double-counted
  reset();
  immich._setRequest(() => Promise.resolve({ assets: { items: [
    { id: 'd1', localDateTime: '2020-01-01T00:00:00Z' }, { id: 'd1', localDateTime: '2020-01-01T00:00:00Z' }
  ] } }));
  await photoIndex.ensure('library', {});
  for (let i = 0; i < 50 && photoIndex.scanning('library'); i++) await sleep(20);
  check('duplicate ids deduped', photoIndex.pool('library').length === 1, String(photoIndex.pool('library').length));

  immich._setRequest(null);
  console.log(results.every(Boolean) ? '\nALL PASS' : '\nFAILURES');
  process.exit(results.every(Boolean) ? 0 : 1);
}
run();
