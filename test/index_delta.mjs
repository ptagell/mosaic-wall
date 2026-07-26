// photo_index deltas: one updatedAfter pass files into every index, back-dated
// imports land in their true year, date corrections re-file, trashed assets are
// evicted, and a failed delta does not advance the watermark.
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
const dir = mkdtempSync(join(tmpdir(), 'pidx-d-'));

// Routes by which filter key is present, so one stub serves scans and both deltas.
function router(handlers) {
  const calls = [];
  return {
    calls,
    request(p, m, body) {
      calls.push(JSON.parse(JSON.stringify(body || {})));
      if (body.trashedAfter) { return Promise.resolve({ assets: { items: handlers.trashed || [] } }); }
      if (body.updatedAfter) { return Promise.resolve({ assets: { items: handlers.updated || [] } }); }
      return Promise.resolve({ assets: { items: handlers.scan || [] } });
    }
  };
}
async function settle(key) { for (let i = 0; i < 50 && photoIndex.scanning(key); i++) await sleep(20); }

async function run() {
  // --- baseline: library + one person index
  photoIndex._reset(); photoIndex._setDataDir(dir);
  let r = router({ scan: [{ id: 'old1', localDateTime: '2020-05-05T00:00:00Z' }] });
  immich._setRequest(r.request);
  await photoIndex.ensure('library', {}); await settle('library');
  await photoIndex.ensure('person:alice', { personIds: ['alice'] }); await settle('person:alice');
  await photoIndex.ensure('favorites', { isFavorite: true }); await settle('favorites');
  photoIndex.registerPerson('alice');
  await photoIndex.applyDeltas(); // first call just sets the watermark

  // --- one delta pass files a new photo into library, person, and favourites
  r = router({ updated: [{
    id: 'new1', localDateTime: '2026-07-20T00:00:00Z', isFavorite: true,
    people: [{ id: 'alice' }]
  }] });
  immich._setRequest(r.request);
  let res = await photoIndex.applyDeltas();
  check('delta reports one addition', res.added === 1, JSON.stringify(res));
  check('new photo in library 2026', (photoIndex.buckets('library')['2026'] || []).join() === 'new1', JSON.stringify(photoIndex.buckets('library')));
  check('new photo in alice index', (photoIndex.buckets('person:alice')['2026'] || []).join() === 'new1', JSON.stringify(photoIndex.buckets('person:alice')));
  check('new photo in favourites', (photoIndex.buckets('favorites')['2026'] || []).join() === 'new1', JSON.stringify(photoIndex.buckets('favorites')));
  const updCalls = r.calls.filter((c) => c.updatedAfter).length;
  check('one updatedAfter request regardless of person count', updCalls === 1, String(updCalls));
  check('delta requests people data', r.calls.some((c) => c.updatedAfter && c.withPeople === true), JSON.stringify(r.calls));

  // --- back-dated archive import lands in its true year, not the current one
  r = router({ updated: [{ id: 'arch1', localDateTime: '2009-02-02T00:00:00Z' }] });
  immich._setRequest(r.request);
  await photoIndex.applyDeltas();
  check('back-dated import lands in 2009', (photoIndex.buckets('library')['2009'] || []).join() === 'arch1', JSON.stringify(photoIndex.buckets('library')));

  // --- a date correction re-files between buckets, leaving no duplicate
  r = router({ updated: [{ id: 'arch1', localDateTime: '2011-02-02T00:00:00Z' }] });
  immich._setRequest(r.request);
  await photoIndex.applyDeltas();
  check('corrected date moves to 2011', (photoIndex.buckets('library')['2011'] || []).join() === 'arch1', JSON.stringify(photoIndex.buckets('library')));
  check('corrected date leaves 2009 empty', (photoIndex.buckets('library')['2009'] || []).length === 0, JSON.stringify(photoIndex.buckets('library')['2009']));

  // --- trashedAfter evicts from every index
  r = router({ trashed: [{ id: 'new1' }] });
  immich._setRequest(r.request);
  res = await photoIndex.applyDeltas();
  check('delta reports one removal', res.removed === 1, JSON.stringify(res));
  check('trashed id gone from library', photoIndex.pool('library').indexOf('new1') === -1);
  check('trashed id gone from alice', photoIndex.pool('person:alice').indexOf('new1') === -1);
  check('trashed id gone from favourites', photoIndex.pool('favorites').indexOf('new1') === -1);

  // --- a failed delta must not advance the watermark
  const before = photoIndex._indexes()['library'].lastDelta;
  immich._setRequest(() => Promise.reject(new Error('immich down')));
  await photoIndex.applyDeltas();
  check('failed delta leaves the watermark unmoved', photoIndex._indexes()['library'].lastDelta === before, `${before} -> ${photoIndex._indexes()['library'].lastDelta}`);

  // --- a transient outage must not permanently disable deletion detection
  r = router({ trashed: [{ id: 'old1' }] });
  immich._setRequest(r.request);
  res = await photoIndex.applyDeltas();
  check('trashedAfter still tried after a transient failure', res.removed === 1, JSON.stringify(res));

  // --- but a real 400 does disable it, falling back to lazy eviction
  photoIndex._reset(); photoIndex._setDataDir(dir);
  immich._setRequest((p, m, body) => {
    if (body.trashedAfter) { return Promise.reject(new Error('Immich API error 400 for /api/search/metadata')); }
    return Promise.resolve({ assets: { items: [] } });
  });
  await photoIndex.ensure('library', {}); await settle('library');
  await photoIndex.applyDeltas();       // sets watermark
  res = await photoIndex.applyDeltas(); // hits the 400
  check('a 400 disables trashedAfter without failing the delta', res.added === 0 && res.removed === 0, JSON.stringify(res));

  // --- evict() removes from all indexes and from taken
  photoIndex._reset(); photoIndex._setDataDir(dir);
  immich._setRequest(router({ scan: [{ id: 'old1', localDateTime: '2020-05-05T00:00:00Z' }] }).request);
  await photoIndex.ensure('library', {}); await settle('library');
  photoIndex.evict('old1');
  check('evict clears the id everywhere', photoIndex.pool('library').indexOf('old1') === -1);
  check('evict clears the timestamp', immich.takenAt('old1') === null, String(immich.takenAt('old1')));

  immich._setRequest(null);
  console.log(results.every(Boolean) ? '\nALL PASS' : '\nFAILURES');
  process.exit(results.every(Boolean) ? 0 : 1);
}
run();
