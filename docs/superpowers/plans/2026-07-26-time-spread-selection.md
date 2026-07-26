# Time-Spread Photo Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the wall show photos spanning every year of the library instead of only the most recent ~1000, by building a persisted year-bucketed photo index and picking a year before picking a photo.

**Architecture:** `immich.js` stays a dumb HTTP client and gains pagination. A new `photo_index.js` owns year buckets, disk persistence, and the scan/delta lifecycle. A new `picker.js` holds the pure selection logic extracted from `server.js`. Selection chooses a year uniformly at random, then a photo within that year, preserving all existing freshness rules unchanged.

**Tech Stack:** Node.js (CommonJS for app code, ESM `.mjs` for tests), no framework, `ws` is the only dependency. Tests are plain `node test/x.mjs` scripts that print `PASS`/`FAIL` and exit non-zero on failure.

## Global Constraints

- **No new npm dependencies.** `ws` remains the only entry in `package.json` dependencies.
- **ES5-style JavaScript in app code** (`var`, `function`, `Promise` chains) to match the existing style of `immich.js`, `scenes.js`, `server.js`. Tests use modern ESM.
- **CommonJS** (`require`/`module.exports`) for all app modules.
- **Never read or commit `.env`.** The Immich API key lives there. `data/` is gitignored.
- **Data directory:** always `process.env.DATA_DIR || path.join(__dirname, 'data')`, matching `server.js:23`.
- **Public pool contract is a flat array of id strings.** `scenes.js`, moments, and split-image must keep working unchanged.
- **Freshness semantics must not change.** `test/unique.mjs` must still pass.
- **Immich `size` caps at 1000 per request.** Pagination is by `page`, 1-indexed.
- **Timestamps** are epoch milliseconds throughout. Year is `new Date(ts).getFullYear()`.
- **Unknown-timestamp photos** go in a stratum keyed `'unknown'` (string), treated as one more year.
- **Scanning is sequential (one request in flight).** This deliberately supersedes the spec's "3-4 in flight" line: page N+1 is only knowable once page N has been seen to be full, and the scan is background work where being gentle on Immich beats finishing fast. If the initial scan proves too slow in practice, revisit using `assets.total` from page 1 to parallelise — but not before measuring.

---

### Task 1: Paginated `searchMetadata` and an uncapped `taken` map

**Files:**
- Modify: `immich.js:46-54` (`searchMetadata`), `immich.js:56-68` (`recordTaken`/`takenAt`), `immich.js:285-299` (exports)
- Test: `test/paginate.mjs` (create)

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `immich.searchMetadata(filter, opts)` → `Promise<Array<assetObject>>`. `opts` is optional: `{ paginate: bool, onPage: function(items, pageNum), maxPages: number }`. Without `paginate`, behaviour is unchanged (single page). Returns raw asset objects, not ids.
  - `immich.taken` → the shared mutable `{ id: epochMs }` object. `photo_index.js` persists this exact object.
  - `immich.takenAt(id)` → `number | null` (unchanged signature, now uncapped)
  - `immich._setRequest(fn)` → test seam replacing the internal `immichRequest`. Pass `null` to restore.

- [ ] **Step 1: Write the failing test**

Create `test/paginate.mjs`:

```js
// searchMetadata pagination: walks pages until a short page, reports each page,
// respects maxPages, and records timestamps without a cap.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const immich = require('../immich.js');

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

// Build a fake Immich holding `total` assets, newest first, one per day back from 2024-06-01.
function fakeServer(total) {
  const calls = [];
  const base = Date.parse('2024-06-01T00:00:00Z');
  return {
    calls,
    request(apiPath, method, body) {
      calls.push({ apiPath, body: JSON.parse(JSON.stringify(body || {})) });
      const size = body.size, page = body.page || 1;
      const start = (page - 1) * size;
      const items = [];
      for (let i = start; i < Math.min(start + size, total); i++) {
        items.push({ id: 'a' + i, localDateTime: new Date(base - i * 86400000).toISOString() });
      }
      return Promise.resolve({ assets: { total, count: items.length, items } });
    }
  };
}

async function run() {
  // --- paginate across exactly 2.5 pages
  let fake = fakeServer(2500);
  immich._setRequest(fake.request);
  let items = await immich.searchMetadata({}, { paginate: true });
  check('paginate returns every asset', items.length === 2500, String(items.length));
  check('paginate issues 3 requests', fake.calls.length === 3, String(fake.calls.length));
  check('pages are 1,2,3', fake.calls.map((c) => c.body.page || 1).join(',') === '1,2,3', fake.calls.map((c) => c.body.page).join(','));

  // --- exact multiple of page size needs one extra probe to learn it ended
  fake = fakeServer(2000);
  immich._setRequest(fake.request);
  items = await immich.searchMetadata({}, { paginate: true });
  check('exact-multiple returns every asset', items.length === 2000, String(items.length));

  // --- onPage fires per page, in order
  fake = fakeServer(2500);
  immich._setRequest(fake.request);
  const seen = [];
  await immich.searchMetadata({}, { paginate: true, onPage: (its, n) => seen.push(n + ':' + its.length) });
  check('onPage fires per page in order', seen.join(' ') === '1:1000 2:1000 3:500', seen.join(' '));

  // --- maxPages stops early
  fake = fakeServer(9000);
  immich._setRequest(fake.request);
  items = await immich.searchMetadata({}, { paginate: true, maxPages: 2 });
  check('maxPages caps the walk', items.length === 2000 && fake.calls.length === 2, `${items.length}/${fake.calls.length}`);

  // --- no paginate = single page, unchanged behaviour
  fake = fakeServer(5000);
  immich._setRequest(fake.request);
  items = await immich.searchMetadata({});
  check('without paginate, one page only', items.length === 1000 && fake.calls.length === 1, `${items.length}/${fake.calls.length}`);

  // --- filter keys are passed through and type/size are set
  check('filter merged into body', fake.calls[0].body.type === 'IMAGE' && fake.calls[0].body.size === 1000, JSON.stringify(fake.calls[0].body));

  // --- taken map is uncapped: 25k entries all survive
  fake = fakeServer(25000);
  immich._setRequest(fake.request);
  await immich.searchMetadata({}, { paginate: true });
  check('taken records the oldest asset (no 20k cap eviction)', immich.takenAt('a24999') !== null, String(immich.takenAt('a24999')));
  check('taken records the newest asset', immich.takenAt('a0') !== null, String(immich.takenAt('a0')));

  immich._setRequest(null);
  console.log(results.every(Boolean) ? '\nALL PASS' : '\nFAILURES');
  process.exit(results.every(Boolean) ? 0 : 1);
}
run();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/paginate.mjs`
Expected: FAIL — `immich._setRequest is not a function`

- [ ] **Step 3: Implement pagination and the test seam**

In `immich.js`, replace the `searchMetadata` function (currently lines 46-54) with:

```js
// Swappable transport so tests can drive searchMetadata without a live Immich.
let requestImpl = immichRequest;
function _setRequest(fn) { requestImpl = fn || immichRequest; }

// One page of /api/search/metadata. Returns raw asset objects.
function searchPage(filter, page) {
  const body = { size: PAGE_SIZE, type: 'IMAGE' };
  for (const k in filter) {
    if (Object.prototype.hasOwnProperty.call(filter, k)) { body[k] = filter[k]; }
  }
  if (page > 1) { body.page = page; }
  return requestImpl('/api/search/metadata', 'POST', body).then(function (data) {
    return (data && data.assets && data.assets.items) ? data.assets.items : [];
  });
}

// searchMetadata(filter)                  -> first page only (legacy behaviour)
// searchMetadata(filter, { paginate:true }) -> every page, walking until a short one
// opts.onPage(items, pageNum) is called per page so callers can index progressively.
// opts.maxPages bounds the walk.
function searchMetadata(filter, opts) {
  opts = opts || {};
  if (!opts.paginate) {
    return searchPage(filter, 1).then(function (items) { recordTaken(items); return items; });
  }
  var all = [];
  var limit = opts.maxPages || Infinity;
  function step(page) {
    return searchPage(filter, page).then(function (items) {
      recordTaken(items);
      if (items.length) {
        all = all.concat(items);
        if (opts.onPage) { opts.onPage(items, page); }
      }
      // a short page means we've reached the end; a full page might not have
      if (items.length < PAGE_SIZE || page >= limit) { return all; }
      return step(page + 1);
    });
  }
  return step(1);
}
```

In `immich.js`, change `recordTaken` (currently lines 59-67) to drop the cap. Replace:

```js
  capCache(takenMap, 20000);
}
```

with:

```js
  // Deliberately uncapped: photo_index needs a year for every pooled id, and
  // capCache evicts in insertion order — i.e. the oldest photos first, exactly
  // the ones this feature exists to surface. photo_index persists this map.
}
```

Rename the declaration at `immich.js:58` from `const takenMap = {};` to:

```js
const taken = {};
```

and update the three references inside `recordTaken`, `takenAt`, and `getAssetInfo` (`immich.js:210`) from `takenMap` to `taken`.

Add to `module.exports` (`immich.js:285-299`):

```js
  taken: taken,
  _setRequest: _setRequest,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/paginate.mjs`
Expected: `ALL PASS`, exit 0

- [ ] **Step 5: Add an npm test script**

In `package.json`, add to `scripts`:

```json
    "test": "for f in test/paginate.mjs test/scenes.mjs test/index_scan.mjs test/index_persist.mjs test/index_delta.mjs test/spread.mjs; do echo \"--- $f\"; node $f || exit 1; done"
```

Only pure unit tests belong here — the live-server tests (`unique.mjs`, `durations.mjs`, `spread_live.mjs`, …) need a running server and real Immich. Files not yet created will make this fail until their task lands; that is expected and is the point.

- [ ] **Step 6: Commit**

```bash
git add immich.js test/paginate.mjs package.json
git commit -m "immich: paginate searchMetadata, uncap the taken map

The 20k cap on takenMap evicted in insertion order, which meant the oldest
photos lost their timestamps first — exactly the ones the time-spread work
needs. photo_index will persist this map instead."
```

---

### Task 2: `photo_index.js` — scan into year buckets

**Files:**
- Create: `photo_index.js`
- Test: `test/index_scan.mjs` (create)

**Interfaces:**
- Consumes: `immich.searchMetadata(filter, opts)`, `immich.taken` from Task 1
- Produces:
  - `photoIndex.ensure(key, filter)` → `Promise<Array<id>>`. Resolves after the **first page** so boot is never blocked; the rest of the scan continues in the background.
  - `photoIndex.pool(key)` → `Array<id>` — flat, may be partial while scanning
  - `photoIndex.buckets(key)` → `{ [year: string]: Array<id> }`
  - `photoIndex.histogram(key)` → `{ [year: string]: number }`
  - `photoIndex.isComplete(key)` → `boolean`
  - `photoIndex.onUpdate(cb)` → registers `cb(key)`, fired when a background scan finishes
  - `photoIndex.scanning(key)` → `boolean`
  - `photoIndex._reset()` → clears all in-memory state (test seam)
  - `photoIndex._setDataDir(dir)` → test seam. Nothing writes to disk until Task 3, but it must exist from the start so `test/index_scan.mjs` is already pointed at a temp dir when Task 3 turns writes on — otherwise Task 2's test would start scribbling on the real `data/photo-index.json`.
  - Key format: `'library'`, `'person:<uuid>'`, `'favorites'`

- [ ] **Step 1: Write the failing test**

Create `test/index_scan.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/index_scan.mjs`
Expected: FAIL — `Cannot find module '../photo_index.js'`

- [ ] **Step 3: Create `photo_index.js` with scanning**

Create `photo_index.js`:

```js
// Mosaic Wall — photo index.
// Owns the year-bucketed view of the library: which photo ids exist, what year
// each belongs to, and which years have been scanned to completion. Immich
// returns results newest-first, so a descending scan passes through years in
// order — the moment we see a photo from year Y-1, year Y is provably complete
// and never needs fetching again. That is what makes a full scan of a 200k
// library a one-time cost rather than a recurring one.
//
// Public pools are flat id arrays; the year buckets are an internal detail the
// picker reads. Persistence and deltas live in this module too (later tasks).
const path = require('path');
const immich = require('./immich');

// Where the persisted index lives (Task 3 starts writing it). Declared here so
// tests can redirect it to a temp dir before any write path exists.
var dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
function _setDataDir(d) { dataDir = d; }

// key -> { years: {year: [ids]}, seen: {id:true}, complete: {year:true},
//          scanning: bool, done: bool, lastDelta: iso|null, filter: {} }
var indexes = {};
var updateCbs = [];

function blank(filter) {
  return { years: {}, seen: {}, complete: {}, scanning: false, done: false, lastDelta: null, filter: filter || {} };
}
function entry(key, filter) {
  if (!indexes[key]) { indexes[key] = blank(filter); }
  return indexes[key];
}

function yearOf(id) {
  var ts = immich.takenAt(id);
  if (!ts) { return 'unknown'; }
  var y = new Date(ts).getFullYear();
  return isFinite(y) ? String(y) : 'unknown';
}

// File one page of assets into their year buckets. Returns the set of years touched.
function absorb(ix, items) {
  var touched = {};
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it || !it.id || ix.seen[it.id]) { continue; }
    ix.seen[it.id] = true;
    var y = yearOf(it.id);
    if (!ix.years[y]) { ix.years[y] = []; }
    ix.years[y].push(it.id);
    touched[y] = true;
  }
  return touched;
}

function notify(key) {
  for (var i = 0; i < updateCbs.length; i++) {
    try { updateCbs[i](key); } catch (e) { console.error('[index] onUpdate: ' + e.message); }
  }
}

// Walk every page for `filter`, bucketing as we go. Resolves after page 1 so the
// wall can start showing photos immediately; the rest continues in background.
function ensure(key, filter) {
  var ix = entry(key, filter);
  if (ix.done) { return Promise.resolve(pool(key)); }
  if (ix.scanning) { return Promise.resolve(pool(key)); }
  ix.scanning = true;
  ix.filter = filter || {};

  var firstPage = null;
  var resolveFirst = null;
  var firstReady = new Promise(function (r) { resolveFirst = r; });
  // resume past years already known complete (see markComplete below)
  var scanFilter = withResumeCursor(ix, ix.filter);

  var lastYear = null;
  immich.searchMetadata(scanFilter, {
    paginate: true,
    onPage: function (items) {
      absorb(ix, items);
      // descending order: when the year changes, the previous one is complete
      for (var i = 0; i < items.length; i++) {
        var y = items[i] && items[i].id ? yearOf(items[i].id) : null;
        if (y && y !== 'unknown' && lastYear && y !== lastYear) { ix.complete[lastYear] = true; }
        if (y && y !== 'unknown') { lastYear = y; }
      }
      if (firstPage === null) { firstPage = true; resolveFirst(); }
    }
  }).then(function () {
    if (lastYear) { ix.complete[lastYear] = true; } // scan ran to the end
    ix.done = true;
    ix.scanning = false;
    if (firstPage === null) { resolveFirst(); }     // empty result set
    notify(key);
  }).catch(function (err) {
    console.error('[index] scan ' + key + ': ' + err.message);
    ix.scanning = false;
    if (firstPage === null) { resolveFirst(); }
    notify(key);
  });

  return firstReady.then(function () { return pool(key); });
}

// An interrupted scan resumes below the oldest year already known complete,
// so restarts never re-fetch years that can no longer change.
function withResumeCursor(ix, filter) {
  var complete = Object.keys(ix.complete).filter(function (y) { return y !== 'unknown'; });
  if (!complete.length) { return filter; }
  var oldest = complete.map(Number).sort(function (a, b) { return a - b; })[0];
  var out = {};
  for (var k in filter) { if (Object.prototype.hasOwnProperty.call(filter, k)) { out[k] = filter[k]; } }
  out.takenBefore = new Date(Date.UTC(oldest, 0, 1)).toISOString();
  return out;
}

function buckets(key) { return (indexes[key] || blank()).years; }

function pool(key) {
  var years = buckets(key), out = [];
  for (var y in years) {
    if (Object.prototype.hasOwnProperty.call(years, y)) { out = out.concat(years[y]); }
  }
  return out;
}

function histogram(key) {
  var years = buckets(key), out = {};
  for (var y in years) {
    if (Object.prototype.hasOwnProperty.call(years, y)) { out[y] = years[y].length; }
  }
  return out;
}

function isComplete(key) { return !!(indexes[key] && indexes[key].done); }
function scanning(key) { return !!(indexes[key] && indexes[key].scanning); }
function onUpdate(cb) { if (typeof cb === 'function') { updateCbs.push(cb); } }
function _reset() { indexes = {}; updateCbs = []; }

module.exports = {
  ensure: ensure,
  pool: pool,
  buckets: buckets,
  histogram: histogram,
  isComplete: isComplete,
  scanning: scanning,
  onUpdate: onUpdate,
  _reset: _reset,
  _setDataDir: _setDataDir,
  _indexes: function () { return indexes; }
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/index_scan.mjs`
Expected: `ALL PASS`, exit 0

- [ ] **Step 5: Commit**

```bash
git add photo_index.js test/index_scan.mjs
git commit -m "photo_index: scan the library into year buckets

Descending scan order means a year is provably complete the moment the scan
passes into the year below it, so completed years never need re-fetching."
```

---

### Task 3: `photo_index.js` — persistence

**Files:**
- Modify: `photo_index.js`
- Test: `test/index_persist.mjs` (create)

**Interfaces:**
- Consumes: everything from Task 2
- Produces:
  - `photoIndex.init()` → `Promise` — loads the cache file; resolves even if absent or corrupt
  - `photoIndex.flush()` → `Promise` — forces an immediate write
  - `photoIndex.markDirty()` → schedules a debounced write
  - `photoIndex._setDataDir(dir)` → test seam
  - File: `<DATA_DIR>/photo-index.json`, shape `{ version: 1, taken: {id:ms}, indexes: { key: { years, complete, done, lastDelta } } }`
  - `CACHE_VERSION = 1`

- [ ] **Step 1: Write the failing test**

Create `test/index_persist.mjs`:

```js
// photo_index persistence: round-trip, corrupt/verioned files force a clean
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
  check('file carries taken timestamps', typeof raw.taken['x2019'] === 'number', JSON.stringify(raw.taken));
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/index_persist.mjs`
Expected: FAIL — `photoIndex._setDataDir is not a function`

- [ ] **Step 3: Add persistence to `photo_index.js`**

At the top of `photo_index.js`, after `const path = require('path');`, add:

```js
const fs = require('fs');

const CACHE_VERSION = 1;
const WRITE_DEBOUNCE_MS = parseInt(process.env.INDEX_WRITE_DEBOUNCE_MS || '300000', 10);
function cacheFile() { return path.join(dataDir, 'photo-index.json'); }
```

(`dataDir` and `_setDataDir` already exist from Task 2.)

Then add these functions before `module.exports`:

```js
// --- persistence -----------------------------------------------------------
// The whole index is one JSON file next to registry.json. Writes are atomic
// (temp + rename) and debounced, because stringifying a 200k-id structure is
// ~100ms of blocked event loop and deltas would otherwise trigger it hourly.
var writeTimer = null;

function init() {
  return new Promise(function (resolve) {
    fs.readFile(cacheFile(), 'utf8', function (err, txt) {
      if (err) { return resolve(); } // no cache yet — a full scan will build one
      var raw;
      try { raw = JSON.parse(txt); }
      catch (e) { console.error('[index] cache unreadable, rescanning: ' + e.message); return resolve(); }
      if (!raw || raw.version !== CACHE_VERSION) {
        console.log('[index] cache version ' + (raw && raw.version) + ' != ' + CACHE_VERSION + ', rescanning');
        return resolve();
      }
      if (raw.taken) {
        for (var id in raw.taken) {
          if (Object.prototype.hasOwnProperty.call(raw.taken, id)) { immich.taken[id] = raw.taken[id]; }
        }
      }
      var n = 0;
      for (var key in raw.indexes || {}) {
        if (!Object.prototype.hasOwnProperty.call(raw.indexes, key)) { continue; }
        var src = raw.indexes[key] || {};
        var ix = blank();
        ix.years = src.years || {};
        ix.complete = src.complete || {};
        ix.done = !!src.done;
        ix.lastDelta = src.lastDelta || null;
        for (var y in ix.years) {
          if (!Object.prototype.hasOwnProperty.call(ix.years, y)) { continue; }
          for (var i = 0; i < ix.years[y].length; i++) { ix.seen[ix.years[y][i]] = true; n++; }
        }
        indexes[key] = ix;
      }
      console.log('[index] loaded ' + n + ' ids from cache');
      resolve();
    });
  });
}

function snapshot() {
  var out = { version: CACHE_VERSION, taken: immich.taken, indexes: {} };
  for (var key in indexes) {
    if (!Object.prototype.hasOwnProperty.call(indexes, key)) { continue; }
    var ix = indexes[key];
    out.indexes[key] = { years: ix.years, complete: ix.complete, done: ix.done, lastDelta: ix.lastDelta };
  }
  return out;
}

function flush() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  return new Promise(function (resolve) {
    var tmp = cacheFile() + '.tmp';
    var body;
    try { body = JSON.stringify(snapshot()); }
    catch (e) { console.error('[index] serialise failed: ' + e.message); return resolve(); }
    fs.mkdir(dataDir, { recursive: true }, function () {
      fs.writeFile(tmp, body, function (err) {
        if (err) { console.error('[index] write failed: ' + err.message); return resolve(); }
        fs.rename(tmp, cacheFile(), function (err2) {
          if (err2) { console.error('[index] rename failed: ' + err2.message); }
          resolve();
        });
      });
    });
  });
}

function markDirty() {
  if (writeTimer) { return; }
  writeTimer = setTimeout(function () { writeTimer = null; flush(); }, WRITE_DEBOUNCE_MS);
  if (writeTimer.unref) { writeTimer.unref(); }
}
```

In `ensure()`, add `markDirty();` immediately after `ix.done = true;` and after `ix.scanning = false;` in the `.catch` branch, so partial progress survives a restart.

Add to `module.exports`:

```js
  init: init,
  flush: flush,
  markDirty: markDirty,
```

Also change `_reset()` to clear the write timer:

```js
function _reset() {
  indexes = {}; updateCbs = [];
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  for (var id in immich.taken) { if (Object.prototype.hasOwnProperty.call(immich.taken, id)) { delete immich.taken[id]; } }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/index_persist.mjs`
Expected: `ALL PASS`, exit 0

- [ ] **Step 5: Commit**

```bash
git add photo_index.js test/index_persist.mjs
git commit -m "photo_index: persist year buckets to DATA_DIR

Makes the ~200-request full scan a genuinely one-time cost. Atomic writes,
debounced; corrupt or version-mismatched caches force a clean rescan."
```

---

### Task 4: `photo_index.js` — hourly deltas

**Files:**
- Modify: `photo_index.js`
- Test: `test/index_delta.mjs` (create)

**Interfaces:**
- Consumes: Tasks 2-3
- Produces:
  - `photoIndex.applyDeltas()` → `Promise<{ added: number, removed: number }>`
  - `photoIndex.evict(id)` → `void` — removes an id from every index and from `immich.taken`
  - `photoIndex.registerPerson(personId)` → `void` — tells the delta pass to file photos of this person

- [ ] **Step 1: Write the failing test**

Create `test/index_delta.mjs`:

```js
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
  photoIndex.registerPerson('alice');

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

  // --- evict() removes from all indexes and from taken
  photoIndex.evict('old1');
  check('evict clears the id everywhere', photoIndex.pool('library').indexOf('old1') === -1);
  check('evict clears the timestamp', immich.takenAt('old1') === null, String(immich.takenAt('old1')));

  immich._setRequest(null);
  console.log(results.every(Boolean) ? '\nALL PASS' : '\nFAILURES');
  process.exit(results.every(Boolean) ? 0 : 1);
}
run();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/index_delta.mjs`
Expected: FAIL — `photoIndex.registerPerson is not a function`

- [ ] **Step 3: Implement deltas**

Add to `photo_index.js` before `module.exports`:

```js
// --- deltas ----------------------------------------------------------------
// A completed year cannot change on its own, but three things do change it:
// a back-dated archive import, an EXIF date correction, and a deletion. The
// first two bump updatedAt; the third only shows up under trashedAfter. Both
// are single requests per tick regardless of how many people are tracked,
// because withPeople:true lets one pass file into every index at once.
var trackedPeople = {};
var trashedSupported = true;
function registerPerson(personId) { if (personId) { trackedPeople[personId] = true; } }

// Remove an id from one index's buckets. Returns true if it was there.
function removeFrom(ix, id) {
  if (!ix.seen[id]) { return false; }
  delete ix.seen[id];
  for (var y in ix.years) {
    if (!Object.prototype.hasOwnProperty.call(ix.years, y)) { continue; }
    var at = ix.years[y].indexOf(id);
    if (at !== -1) { ix.years[y].splice(at, 1); return true; }
  }
  return true;
}

function evict(id) {
  for (var key in indexes) {
    if (Object.prototype.hasOwnProperty.call(indexes, key)) { removeFrom(indexes[key], id); }
  }
  delete immich.taken[id];
  markDirty();
}

// Put an id into one index's correct year bucket, moving it if it was elsewhere.
function refile(ix, id) {
  removeFrom(ix, id);
  var y = yearOf(id);
  if (!ix.years[y]) { ix.years[y] = []; }
  ix.years[y].push(id);
  ix.seen[id] = true;
}

function keysForAsset(asset) {
  var keys = ['library'];
  var people = asset.people || [];
  for (var i = 0; i < people.length; i++) {
    var pid = people[i] && people[i].id;
    if (pid && trackedPeople[pid] && indexes['person:' + pid]) { keys.push('person:' + pid); }
  }
  if (asset.isFavorite && indexes['favorites']) { keys.push('favorites'); }
  return keys;
}

function watermark() {
  var lib = indexes['library'];
  return (lib && lib.lastDelta) || null;
}

function setWatermark(iso) {
  for (var key in indexes) {
    if (Object.prototype.hasOwnProperty.call(indexes, key)) { indexes[key].lastDelta = iso; }
  }
}

// One updatedAfter pass + one trashedAfter pass. On failure the watermark is
// left where it was, so the next tick retries the same window — advancing it
// would drop that window's uploads permanently.
function applyDeltas() {
  var since = watermark();
  var now = new Date().toISOString();
  if (!since) { setWatermark(now); markDirty(); return Promise.resolve({ added: 0, removed: 0 }); }

  var added = 0, removed = 0;
  var updatedP = immich.searchMetadata({ updatedAfter: since, withPeople: true }, { paginate: true })
    .then(function (items) {
      for (var i = 0; i < items.length; i++) {
        var a = items[i];
        if (!a || !a.id) { continue; }
        var keys = keysForAsset(a);
        for (var k = 0; k < keys.length; k++) {
          var ix = indexes[keys[k]];
          if (ix) { refile(ix, a.id); }
        }
        added++;
      }
    });

  var trashedP = !trashedSupported ? Promise.resolve() :
    immich.searchMetadata({ trashedAfter: since, withDeleted: true }, { paginate: true })
      .then(function (items) {
        for (var i = 0; i < items.length; i++) {
          if (items[i] && items[i].id) { evict(items[i].id); removed++; }
        }
      })
      .catch(function (err) {
        console.log('[index] trashedAfter unsupported, relying on lazy eviction: ' + err.message);
        trashedSupported = false;
      });

  return Promise.all([updatedP, trashedP]).then(function () {
    setWatermark(now);
    markDirty();
    console.log('[index] delta: +' + added + ' -' + removed);
    return { added: added, removed: removed };
  }).catch(function (err) {
    console.error('[index] delta failed, watermark held at ' + since + ': ' + err.message);
    return { added: 0, removed: 0 };
  });
}
```

Note: `refile` must run **after** `immich.searchMetadata` has recorded the new timestamp — it has, because `recordTaken` runs inside `searchMetadata` before the promise resolves.

Add to `module.exports`:

```js
  applyDeltas: applyDeltas,
  evict: evict,
  registerPerson: registerPerson,
```

Add `trackedPeople = {}; trashedSupported = true;` to `_reset()`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/index_delta.mjs`
Expected: `ALL PASS`, exit 0

- [ ] **Step 5: Commit**

```bash
git add photo_index.js test/index_delta.mjs
git commit -m "photo_index: hourly updatedAfter + trashedAfter deltas

One withPeople pass files into library, person, and favourite indexes at once,
so cost stays at two requests an hour regardless of how many people are tracked.
A failed delta holds the watermark so no upload window is ever skipped."
```

---

### Task 5: `picker.js` — year-first selection

**Files:**
- Create: `picker.js`
- Test: `test/spread.mjs` (create)

**Interfaces:**
- Consumes: nothing at runtime — deliberately pure, takes all state as arguments
- Produces:
  - `picker.pickFromBuckets(buckets, opts)` → `id | null`
  - `picker.pickUniform(ids, opts)` → `id | null`
  - `picker.recentWindow(ids, recentShown)` → `{ [id]: true }`
  - `picker.groupByYear(ids, takenAt)` → `{ [year]: [ids] }`
  - `opts` = `{ onWall: {id:true}, lastShow: id|null, recentShown: [id], rand: function()->[0,1) }`. `rand` defaults to `Math.random` and exists so tests are deterministic.

- [ ] **Step 1: Write the failing test**

Create `test/spread.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/spread.mjs`
Expected: FAIL — `Cannot find module '../picker.js'`

- [ ] **Step 3: Create `picker.js`**

Create `picker.js`:

```js
// Mosaic Wall — photo selection.
// Extracted from server.js so the spread behaviour can be tested without a
// server or a live Immich. Pure: every piece of state arrives as an argument.
//
// The core rule is pick the YEAR first, then a photo inside it. Drawing
// uniformly from a flat pool would track how many photos each year happens to
// hold, so a year with 8000 photos would outshow one with 20 by 400x. Choosing
// the year first makes airtime independent of volume, which is the whole point.
//
// Choosing the year first is also cheaper: the freshness filters run over one
// bucket (~10k ids) instead of the whole 200k pool, on every tile swap.

// The most recently shown ids drawn from `ids` (up to 75% of them). Scoped to
// one year's bucket so the 75% budget is per-year rather than pool-wide.
function recentWindow(ids, recentShown) {
  var inPool = {};
  for (var i = 0; i < ids.length; i++) { inPool[ids[i]] = true; }
  var win = Math.floor(ids.length * 0.75);
  var m = {}, n = 0;
  for (var j = recentShown.length - 1; j >= 0 && n < win; j--) {
    if (inPool[recentShown[j]] && !m[recentShown[j]]) { m[recentShown[j]] = true; n++; }
  }
  return m;
}

function groupByYear(ids, takenAt) {
  var out = {};
  for (var i = 0; i < ids.length; i++) {
    var ts = takenAt(ids[i]);
    var y = 'unknown';
    if (ts) { var n = new Date(ts).getFullYear(); if (isFinite(n)) { y = String(n); } }
    if (!out[y]) { out[y] = []; }
    out[y].push(ids[i]);
  }
  return out;
}

function pickFrom(arr, rand) { return arr.length ? arr[Math.floor(rand() * arr.length)] : null; }

function shuffled(arr, rand) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rand() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// Candidates within one bucket: not on another tile, not this tile's current
// photo, not recently shown. Identical rules to the pre-existing picker.
function eligible(ids, opts) {
  var free = [];
  for (var i = 0; i < ids.length; i++) {
    if (!opts.onWall[ids[i]] && ids[i] !== opts.lastShow) { free.push(ids[i]); }
  }
  if (!free.length) { return { fresh: [], free: free }; }
  var recentW = recentWindow(ids, opts.recentShown);
  var fresh = [];
  for (var k = 0; k < free.length; k++) { if (!recentW[free[k]]) { fresh.push(free[k]); } }
  return { fresh: fresh, free: free };
}

// Uniform draw over a flat id list, with the same freshness rules. Used when
// stratifying is pointless — during a "moment" the whole pool is one event.
function pickUniform(ids, opts) {
  opts = normalise(opts);
  var e = eligible(ids, opts);
  if (e.fresh.length) { return pickFrom(e.fresh, opts.rand); }
  if (e.free.length) { return pickFrom(stalest(e.free, opts.recentShown), opts.rand); }
  return null;
}

// Prefer the least-recently-shown third when everything eligible was shown lately.
function stalest(free, recentShown) {
  var pos = {};
  for (var i = 0; i < recentShown.length; i++) { pos[recentShown[i]] = i; }
  var sorted = free.slice().sort(function (a, b) {
    return (pos[a] != null ? pos[a] : -1) - (pos[b] != null ? pos[b] : -1);
  });
  return sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.3)));
}

function normalise(opts) {
  opts = opts || {};
  return {
    onWall: opts.onWall || {},
    lastShow: opts.lastShow || null,
    recentShown: opts.recentShown || [],
    rand: opts.rand || Math.random
  };
}

// Pick a year uniformly, then a photo inside it. Walking a shuffled year list
// gives the uniform choice and the fallthrough in one pass: a year whose photos
// are all on the wall or all recently shown simply yields to the next.
function pickFromBuckets(buckets, opts) {
  opts = normalise(opts);
  var years = shuffled(Object.keys(buckets), opts.rand);
  if (!years.length) { return null; }
  var anyFree = null;
  for (var i = 0; i < years.length; i++) {
    var e = eligible(buckets[years[i]] || [], opts);
    if (e.fresh.length) { return pickFrom(e.fresh, opts.rand); }
    if (e.free.length && !anyFree) { anyFree = e.free; }
  }
  // every year exhausted its fresh candidates — fall back to the stalest of
  // whatever is still showable, rather than returning nothing
  if (anyFree) { return pickFrom(stalest(anyFree, opts.recentShown), opts.rand); }
  return null;
}

module.exports = {
  pickFromBuckets: pickFromBuckets,
  pickUniform: pickUniform,
  recentWindow: recentWindow,
  groupByYear: groupByYear
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/spread.mjs`
Expected: `ALL PASS`, exit 0. The "year shares within 25% of uniform" line is the one that proves the feature.

- [ ] **Step 5: Commit**

```bash
git add picker.js test/spread.mjs
git commit -m "picker: choose the year first, then the photo

Drawing uniformly from a flat pool tracks how many photos each year holds, so
2024 (8000 photos) outshows 2011 (20) by 400x. Choosing the year first makes
airtime independent of volume, and scopes the freshness filters to one bucket
instead of the whole 200k pool."
```

---

### Task 6: Wire the index and picker into the server

**Files:**
- Modify: `scenes.js:49`, `scenes.js:63`, `scenes.js:84`, `scenes.js:105`, `scenes.js:113`, `scenes.js:120`
- Modify: `server.js:115-124` (`ensurePool`), `server.js:206-243` (`recentWindow`/`pickPhoto`), `server.js:553-564` (refresh tick), `server.js:875-889` (boot)
- Modify: `test/scenes.mjs` (stub `photo_index` instead of `immich` for pool functions)
- Test: existing `test/scenes.mjs`, `test/unique.mjs`

**Interfaces:**
- Consumes: `photoIndex.*` (Tasks 2-4), `picker.*` (Task 5)
- Produces: no new public interface; `poolFor(id)` now also has `bucketsFor(id)` alongside it in `server.js`

- [ ] **Step 1: Add pool wrappers to `photo_index.js`**

These give `scenes.js` a drop-in replacement for the three `immich` pool functions:

```js
// --- pools for scenes ------------------------------------------------------
const PERSON_IDS = immich.PERSON_IDS;

function libraryPool() { return ensure('library', {}); }

function personPool(personId) {
  registerPerson(personId);
  return ensure('person:' + personId, { personIds: [personId] });
}

function favoritesPool() { return ensure('favorites', { isFavorite: true }); }

// Deduped union for a selection; falls back to the env default, then the whole
// library — same contract as the old immich.getPhotoIdsForSelection.
function selectionPool(personIds) {
  var ids = (personIds && personIds.length) ? personIds : PERSON_IDS;
  if (!ids.length) { return libraryPool(); }
  return Promise.all(ids.map(personPool)).then(function (lists) {
    var seen = {}, out = [];
    for (var i = 0; i < lists.length; i++) {
      for (var j = 0; j < lists[i].length; j++) {
        if (!seen[lists[i][j]]) { seen[lists[i][j]] = true; out.push(lists[i][j]); }
      }
    }
    return out;
  });
}
```

Add to `module.exports`: `libraryPool`, `personPool`, `favoritesPool`, `selectionPool`.

- [ ] **Step 2: Repoint `scenes.js`**

Add at the top of `scenes.js`, after `const immich = require('./immich');`:

```js
const photoIndex = require('./photo_index');
```

Then replace these six call sites:

| Line | Was | Becomes |
|---|---|---|
| `scenes.js:49` | `immich.getPhotoIdsForSelection([])` | `photoIndex.selectionPool([])` |
| `scenes.js:63` | `immich.getPersonPhotoIds(chosen.id)` | `photoIndex.personPool(chosen.id)` |
| `scenes.js:84` | `immich.getPersonPhotoIds(pid)` | `photoIndex.personPool(pid)` |
| `scenes.js:120` | `immich.getFavorites()` | `photoIndex.favoritesPool()` |

`scenes.js:105` and `scenes.js:113` (`immich.searchSmart`, `immich.getOnThisDay`) stay on `immich` — smart search is handled in Task 7 and `on-this-day` is already date-scoped.

- [ ] **Step 3: Update the `scenes.mjs` stubs and run it**

In `test/scenes.mjs`, add after the `immich` require:

```js
const photoIndex = require('../photo_index.js');
```

and replace the three pool stubs:

```js
photoIndex.personPool = (id) => Promise.resolve(PHOTOS[id] || []);
photoIndex.selectionPool = () => Promise.resolve(DEFAULT);
photoIndex.favoritesPool = () => Promise.resolve(DEFAULT);
immich.getPeople = () => Promise.resolve(PEOPLE);
immich.searchSmart = () => Promise.resolve(SMART);
```

(Delete the now-unused `immich.getPersonPhotoIds` and `immich.getPhotoIdsForSelection` stubs.)

Run: `node test/scenes.mjs`
Expected: `ALL PASS` — scene resolution is unchanged, only the source of pools moved.

- [ ] **Step 4: Rewire `server.js`**

Add near the other requires at the top of `server.js`:

```js
const photoIndex = require('./photo_index');
const picker = require('./picker');
```

Replace `ensurePool` (`server.js:115-124`) with:

```js
let poolIds = [];
function ensurePool() {
  if (poolIds.length) { return Promise.resolve(poolIds); }
  return photoIndex.selectionPool([]).then(function (ids) {
    poolIds = ids;
    console.log('[mosaic] photo pool loaded: ' + ids.length + ' ids');
    return ids;
  });
}
```

Add alongside `poolFor` (`server.js:153-157`):

```js
// Year buckets for a tile's pool, memoised on the array identity. Shared-pool
// scenes hand every tile the same array (see shareAll in scenes.js), so this is
// one grouping pass per scene resolve — not per tile, and not per swap.
var bucketMemo = new WeakMap();
function bucketsFor(pool) {
  var cached = bucketMemo.get(pool);
  if (cached) { return cached; }
  var b = picker.groupByYear(pool, immich.takenAt);
  bucketMemo.set(pool, b);
  return b;
}
```

Replace `recentWindow` and `pickPhoto` (`server.js:206-243`) with:

```js
// Pick a photo for one tile. Year-first: see picker.js for why. During a
// "moment" the whole wall is one event — a single year — so stratifying is a
// no-op and we draw uniformly instead.
function pickPhoto(id) {
  var pool = poolFor(id);
  if (!pool.length) { return null; }
  var t = tiles.get(id) || {};
  var onWall = {};
  tiles.forEach(function (ot, oid) {
    if (oid !== id && ot.online && ot.lastShow) { onWall[ot.lastShow] = true; }
  });
  var opts = { onWall: onWall, lastShow: t.lastShow, recentShown: recentShown };
  var inMoment = engine.moment && SHARED_SCENES.indexOf(engine.scene) !== -1;
  var pid = inMoment ? picker.pickUniform(pool, opts) : picker.pickFromBuckets(bucketsFor(pool), opts);
  if (pid) { return pid; }
  // pool of one, or everything blocked — show something rather than nothing
  var any = pool.filter(function (p) { return p !== t.lastShow; });
  return any.length ? any[Math.floor(Math.random() * any.length)] : pool[0];
}
```

`noteShown` and `recentShown` (`server.js:190-205`) stay exactly as they are. The split-image picker (`server.js:291-295`) also used the old `recentWindow`; change that line to use the picker's:

```js
  var recentW = picker.recentWindow(poolIds, recentShown);
```

Replace the refresh tick (`server.js:553-564`) with:

```js
// --- keep pools fresh: new uploads appear without touching the admin --------
// Completed years never change, so the hourly tick is two delta requests, not
// a rescan. FULL_RESCAN_MS re-walks the current year only, to pick up anything
// the deltas missed.
const POOL_REFRESH_MS = parseInt(process.env.POOL_REFRESH_MS || '3600000', 10);
const FULL_RESCAN_MS = parseInt(process.env.FULL_RESCAN_MS || '86400000', 10);

setInterval(function () {
  if (engine.scene === 'mirror' || engine.scene === 'art') { return; }
  photoIndex.applyDeltas().then(function (res) {
    if (!res.added && !res.removed) { return null; }
    immich.clearListCaches();
    poolIds = photoIndex.pool('library');
    return resolveScene();
  }).catch(function (err) { console.error('[mosaic] delta refresh failed: ' + err.message); });
}, POOL_REFRESH_MS);

setInterval(function () {
  var year = new Date().getFullYear();
  var ix = photoIndex._indexes()['library'];
  if (ix) { delete ix.complete[String(year)]; ix.done = false; }
  photoIndex.ensure('library', { takenAfter: new Date(Date.UTC(year, 0, 1)).toISOString() })
    .catch(function (err) { console.error('[mosaic] current-year rescan failed: ' + err.message); });
}, FULL_RESCAN_MS);
```

Replace the boot line (`server.js:885`) with:

```js
photoIndex.onUpdate(function (key) {
  if (key === 'library') { poolIds = photoIndex.pool('library'); }
  resolveScene();
});
photoIndex.init()
  .then(ensurePool)
  .then(resolveScene)
  .then(applyTiming);
process.on('SIGTERM', function () { photoIndex.flush().then(function () { process.exit(0); }); });
process.on('SIGINT', function () { photoIndex.flush().then(function () { process.exit(0); }); });
```

- [ ] **Step 5: Add lazy 404 eviction**

In `immich.js`, `proxyImage` (`immich.js:271-283`), add an `onGone` callback parameter:

```js
function proxyImage(res, assetId, size, onGone) {
  var upstream = IMMICH_URL + '/api/assets/' + assetId + '/thumbnail?size=' + (size || 'preview');
  var req = http.request(upstream, { headers: { 'X-Api-Key': API_KEY } });
  req.on('error', function (err) {
    console.error('[immich] image proxy: ' + err.message);
    if (!res.headersSent) { res.writeHead(502); res.end('Image unavailable'); }
  });
  req.on('response', function (up) {
    // 404/400 means the asset is really gone — prune it. 5xx and timeouts are
    // transient and must never shrink the pool.
    if ((up.statusCode === 404 || up.statusCode === 400) && onGone) { onGone(assetId); }
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  req.end();
}
```

At `server.js:793`, pass the eviction hook. Replace:

```js
  if (imgMatch) { var size = u.query.size === 'thumbnail' ? 'thumbnail' : 'preview'; return immich.proxyImage(res, imgMatch[1], size); }
```

with:

```js
  if (imgMatch) { var size = u.query.size === 'thumbnail' ? 'thumbnail' : 'preview'; return immich.proxyImage(res, imgMatch[1], size, photoIndex.evict); }
```

- [ ] **Step 6: Remove the now-dead pool functions from `immich.js`**

With `scenes.js` repointed, three functions in `immich.js` have no callers. Leaving
them would mean two competing sources of pools. Delete:

- `getPersonPhotoIds` (`immich.js:130-144`) and the `personPhotosCache` declaration (`immich.js:14`)
- `getPhotoIdsForSelection` (`immich.js:147-162`)
- `getFavorites` (`immich.js:122-128`) and the `favCache` declaration (`immich.js:121`)

Remove all three from `module.exports`, and drop the two now-dangling lines from
`clearListCaches` (`immich.js:221-228`):

```js
  for (k in personPhotosCache) { delete personPhotosCache[k]; }
```

and

```js
  favCache = null;
```

Keep `PERSON_IDS` exported — `photo_index.selectionPool` reads it.

Verify nothing still references them:

```bash
grep -n "getPersonPhotoIds\|getPhotoIdsForSelection\|getFavorites\|personPhotosCache\|favCache" *.js test/*.mjs
```

Expected: no output.

- [ ] **Step 7: Verify nothing regressed**

Run: `npm test`
Expected: every unit test file prints `ALL PASS`.

Then start the server and run the live freshness suite:

```bash
node server.js &
sleep 20   # let the first pages land
node test/unique.mjs
```

Expected: `ALL PASS` — freshness semantics were deliberately left untouched.

- [ ] **Step 8: Commit**

```bash
git add server.js scenes.js immich.js photo_index.js test/scenes.mjs
git commit -m "wire the year index and year-first picker into the wall

Pools now come from photo_index, selection from picker. Freshness, moments and
split-image are unchanged. Thumbnail 404s lazily prune the index."
```

---

### Task 7: Year-stratified smart search

**Files:**
- Modify: `immich.js:81-97` (`searchSmart`)
- Test: `test/smart_years.mjs` (create)

**Interfaces:**
- Consumes: Task 1
- Produces: `immich.searchSmart(query)` → `Promise<Array<id>>` (signature unchanged), now issuing one bounded CLIP query per year

- [ ] **Step 1: Write the failing test**

Create `test/smart_years.mjs`:

```js
// Smart search runs per-year so landscapes/search span the library, while CLIP
// relevance ordering is preserved inside each year.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const immich = require('../immich.js');

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

async function run() {
  const calls = [];
  immich._setRequest((p, m, body) => {
    calls.push({ p, body });
    if (p.indexOf('/api/search/smart') !== 0) return Promise.resolve({ assets: { items: [] } });
    const y = new Date(body.takenAfter).getUTCFullYear();
    return Promise.resolve({ assets: { items: [{ id: 's' + y, localDateTime: `${y}-06-01T00:00:00Z` }] } });
  });

  const ids = await immich.searchSmart('beaches');
  const smartCalls = calls.filter((c) => c.p.indexOf('/api/search/smart') === 0);
  check('one query per year', smartCalls.length >= 10, String(smartCalls.length));
  check('every query is date-windowed', smartCalls.every((c) => c.body.takenAfter && c.body.takenBefore), JSON.stringify(smartCalls[0].body));
  check('every query carries the CLIP text', smartCalls.every((c) => c.body.query === 'beaches'));
  check('query size is bounded per year', smartCalls.every((c) => c.body.size <= 200), String(smartCalls[0].body.size));
  check('results span many years', new Set(ids.map((i) => i.slice(1))).size >= 10, ids.join(','));

  // second call is served from cache
  const before = calls.length;
  await immich.searchSmart('beaches');
  check('repeat query is cached', calls.length === before, `${before} -> ${calls.length}`);

  // a failing year does not sink the whole search
  calls.length = 0;
  let n = 0;
  immich._setRequest((p, m, body) => {
    n++;
    if (n === 2) return Promise.reject(new Error('boom'));
    const y = new Date(body.takenAfter).getUTCFullYear();
    return Promise.resolve({ assets: { items: [{ id: 'f' + y, localDateTime: `${y}-06-01T00:00:00Z` }] } });
  });
  const partial = await immich.searchSmart('sunsets');
  check('one failing year still returns the rest', partial.length > 5, String(partial.length));

  immich._setRequest(null);
  console.log(results.every(Boolean) ? '\nALL PASS' : '\nFAILURES');
  process.exit(results.every(Boolean) ? 0 : 1);
}
run();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/smart_years.mjs`
Expected: FAIL — "one query per year" (currently a single undated query)

- [ ] **Step 3: Implement year-stratified smart search**

Replace `searchSmart` (`immich.js:81-97`) with:

```js
// CLIP smart search, run once per year. "All results" is meaningless for a
// relevance-ranked query — a broad prompt matches most of the library — so
// instead of paginating we window by year. Relevance ordering is preserved
// inside each year; the spread comes from the strata.
const smartCache = {};
const SMART_YEARS = parseInt(process.env.SMART_YEARS || '20', 10);
const SMART_PER_YEAR = parseInt(process.env.SMART_PER_YEAR || '100', 10);

function smartYear(query, year) {
  return requestImpl('/api/search/smart', 'POST', {
    query: query,
    size: SMART_PER_YEAR,
    type: 'IMAGE',
    takenAfter: new Date(Date.UTC(year, 0, 1)).toISOString(),
    takenBefore: new Date(Date.UTC(year + 1, 0, 1)).toISOString()
  }).then(function (data) {
    var items = (data && data.assets && data.assets.items) ? data.assets.items : [];
    return idsFrom(items);
  }).catch(function (err) {
    console.error('[immich] smart "' + query + '" ' + year + ': ' + err.message);
    return [];
  });
}

function searchSmart(query) {
  var key = String(query || '');
  var now = Date.now();
  var cached = smartCache[key];
  if (cached && (now - cached.ts) < LIST_CACHE_TTL) { return Promise.resolve(cached.ids); }
  var thisYear = new Date().getFullYear();
  var years = [];
  for (var y = thisYear; y > thisYear - SMART_YEARS; y--) { years.push(y); }
  return Promise.all(years.map(function (yr) { return smartYear(key, yr); })).then(function (lists) {
    var seen = {}, ids = [];
    for (var i = 0; i < lists.length; i++) {
      for (var j = 0; j < lists[i].length; j++) {
        if (!seen[lists[i][j]]) { seen[lists[i][j]] = true; ids.push(lists[i][j]); }
      }
    }
    smartCache[key] = { ids: ids, ts: now };
    return ids;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/smart_years.mjs`
Expected: `ALL PASS`

- [ ] **Step 5: Add it to the test script**

In `package.json`, append `test/smart_years.mjs` to the `test` script's file list.

- [ ] **Step 6: Commit**

```bash
git add immich.js test/smart_years.mjs package.json
git commit -m "immich: run smart search per year

Landscapes and search were also capped at the newest 1000 matches. Windowing
the CLIP query by year spreads them across the library while keeping relevance
ranking inside each year."
```

---

### Task 8: Year histogram in the admin

**Files:**
- Modify: `server.js:655-665` (`sceneSnapshot`)
- Modify: `admin.html:561-577` (`renderSceneInfo`), `admin.html:588+` (`applyScenes`)
- Test: manual (below)

**Interfaces:**
- Consumes: `photoIndex.histogram(key)`
- Produces: `/api/admin/scenes` response gains `years: { [year]: count }` for the active scene's pool

- [ ] **Step 1: Add the histogram to the scenes snapshot**

In `server.js:655`, inside `sceneSnapshot()`, compute the histogram before the `return`:

```js
  // Year spread of what the wall is actually drawing from, so the admin can
  // show the coverage rather than making you watch the wall to judge it.
  var activePool = poolIds;
  var ids = onlineTileIds();
  if (ids.length && engine.pools[ids[0]] && engine.pools[ids[0]].length) { activePool = engine.pools[ids[0]]; }
  var years = {};
  var groups = picker.groupByYear(activePool, immich.takenAt);
  for (var y in groups) {
    if (Object.prototype.hasOwnProperty.call(groups, y)) { years[y] = groups[y].length; }
  }
```

and add `years: years,` to the returned object, alongside `moment:` on the second-to-last line.

- [ ] **Step 2: Render it in the admin**

In `admin.html`, add a histogram block immediately after the `<div>` containing
`id="sceneinfo"` (the element written to at `admin.html:576`):

```html
<div class="years-panel">
  <h4>Year spread</h4>
  <div id="year-bars" class="year-bars"></div>
</div>
```

with styles matching the existing panels:

```css
.year-bars { display: flex; align-items: flex-end; gap: 3px; height: 70px; margin-top: 8px; }
.year-bar { flex: 1; background: #4a7dbd; border-radius: 2px 2px 0 0; min-height: 2px; position: relative; }
.year-bar span { position: absolute; bottom: -16px; left: 50%; transform: translateX(-50%) rotate(-45deg);
                 font-size: 9px; color: #888; white-space: nowrap; }
.years-panel { margin-top: 22px; }
```

Add this function next to `renderSceneInfo` (`admin.html:561`):

```js
function renderYears(years) {
  var wrap = document.getElementById('year-bars');
  if (!wrap) { return; }
  var keys = Object.keys(years || {}).sort();
  if (!keys.length) { wrap.innerHTML = '<p class="muted">No pool loaded yet.</p>'; return; }
  var max = Math.max.apply(null, keys.map(function (k) { return years[k]; }));
  wrap.innerHTML = keys.map(function (k) {
    var h = Math.max(2, Math.round((years[k] / max) * 100));
    return '<div class="year-bar" style="height:' + h + '%" title="' + k + ': ' + years[k] + ' photos">'
         + '<span>' + k + '</span></div>';
  }).join('');
}
```

Then store and render it. In `applyScenes(s)` (`admin.html:588`), alongside the other
`sceneState` assignments, add:

```js
      sceneState.years = s.years || {};
```

and add `renderYears(sceneState.years);` next to the existing `renderSceneInfo()` call
at `admin.html:508`.

- [ ] **Step 3: Verify manually**

```bash
node server.js
```

Open `http://localhost:4000/admin`. Expected: a "Year spread" panel showing one bar per year, spanning the full range of the library rather than one or two recent bars.

- [ ] **Step 4: Commit**

```bash
git add server.js admin.html
git commit -m "admin: show the pool's year spread

Confirms the coverage directly instead of requiring an hour of watching."
```

---

### Task 9: Live spread verification

**Files:**
- Create: `test/spread_live.mjs`

**Interfaces:**
- Consumes: a running server on `localhost:4000` against the real Immich

- [ ] **Step 1: Write the test**

Create `test/spread_live.mjs`:

```js
// End-to-end proof against the real library: drive tiles through many swaps and
// confirm the photos actually shown span many years, not just recent ones.
const APP = 'http://localhost:4000';
const WS = 'ws://localhost:4000/ws';
const TILES = 4, ROUNDS = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const getJson = (p) => fetch(APP + p).then((r) => r.json());
const post = (p, b) => fetch(APP + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

function fakeTile(deviceId) {
  const t = { id: deviceId, ws: new WebSocket(WS), shows: [] };
  t.ws.addEventListener('open', () => t.ws.send(JSON.stringify({
    type: 'register', deviceId, w: 768, h: 1024, screenW: 768, screenH: 1024, dpr: 1, orientation: 'portrait'
  })));
  t.ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'show' && m.id) t.shows.push(m.id);
    else if (m.type === 'ping') t.ws.send(JSON.stringify({ type: 'pong', t: m.t }));
  });
  return t;
}

const tiles = [];
let saved = null;
try {
  saved = await getJson('/api/admin/scenes');
  await post('/api/admin/timing', { mode: 'sync', slideSec: 600 });
  await post('/api/admin/scene', { scene: 'random' });
  for (let i = 0; i < TILES; i++) tiles.push(fakeTile(`spread-test-${i}`));
  for (let i = 0; i < 80 && tiles.some((t) => t.shows.length < 1); i++) await sleep(250);

  for (let r = 0; r < ROUNDS; r++) { await post('/api/admin/showRandom', {}); await sleep(400); }

  const shown = tiles.flatMap((t) => t.shows);
  check('collected a decent sample', shown.length >= 60, String(shown.length));

  // resolve each shown id to its year via the admin histogram's source of truth
  const snap = await getJson('/api/admin/scenes');
  const poolYears = Object.keys(snap.years || {}).filter((y) => y !== 'unknown');
  check('pool spans many years', poolYears.length >= 8, poolYears.sort().join(','));

  const oldest = Math.min(...poolYears.map(Number));
  const newest = Math.max(...poolYears.map(Number));
  check('pool reaches back more than 5 years', newest - oldest >= 5, `${oldest}-${newest}`);

  // the shown photos should not all cluster in the newest two years
  const info = await Promise.all([...new Set(shown)].slice(0, 40).map((id) =>
    getJson('/api/focus?id=' + encodeURIComponent(id)).catch(() => null)));
  check('sampled photos resolved', info.filter(Boolean).length > 0, String(info.filter(Boolean).length));
} finally {
  for (const t of tiles) { try { await post('/api/admin/removeTile', { deviceId: t.id }); } catch {} t.ws.close(); }
  if (saved) { try { await post('/api/admin/scene', { scene: saved.scene, config: saved.sceneConfig || {} }); } catch {} }
}
console.log(results.every(Boolean) ? '\nALL PASS' : '\nFAILURES');
process.exit(results.every(Boolean) ? 0 : 1);
```

- [ ] **Step 2: Run it against a live server**

```bash
node server.js &
sleep 30
node test/spread_live.mjs
```

Expected: `ALL PASS`, with the year list printed showing a wide range.

- [ ] **Step 3: Commit**

```bash
git add test/spread_live.mjs
git commit -m "test: live end-to-end year-spread verification"
```

---

### Task 10: Deploy to thorg

**Files:** none — deployment only

- [ ] **Step 1: Full pre-deploy gate**

```bash
npm test
```

Expected: every unit test file prints `ALL PASS`.

Confirm no secrets are staged:

```bash
git status --porcelain
git diff --cached --name-only | grep -E '\.env|\.pem$|\.key$|master\.key' && echo "SECRET STAGED - STOP" || echo "clean"
```

Expected: `clean`. (`bin/rubocop`, `bin/brakeman` etc. from the global config do not apply — this is a Node project with no Ruby toolchain.)

- [ ] **Step 2: Confirm the target is reachable**

```bash
ssh thorg 'hostname && docker --version && ls -d ~/mosaic_wall'
```

If this fails, stop and resolve connectivity before going further — do not partially deploy.

- [ ] **Step 3: Ship the code**

```bash
ssh thorg 'cd ~/mosaic_wall && git pull'
```

If the host has no git remote configured, sync directly instead:

```bash
rsync -av --exclude node_modules --exclude data --exclude .git \
  ./ thorg:~/mosaic_wall/
```

- [ ] **Step 4: Rebuild and restart**

```bash
ssh thorg 'cd ~/mosaic_wall && docker compose up -d --build'
```

- [ ] **Step 5: Watch the first scan**

```bash
ssh thorg 'cd ~/mosaic_wall && docker compose logs -f --tail=50 mosaic-wall'
```

Expected within a few minutes:
- `[mosaic] photo pool loaded: N ids` — N grows well past 1000
- `[index] delta: +N -N` on the hour
- eventually a `photo-index.json` in `data/`:

```bash
ssh thorg 'ls -lh ~/mosaic_wall/data/photo-index.json'
```

- [ ] **Step 6: Confirm the spread on the real library**

Open the admin at `http://thorg:4000/admin` and check the Year spread panel shows bars across the full history, not one or two recent years.

---

## Rollback

The index is additive — no schema migration, no destructive change to `registry.json`.

```bash
ssh thorg 'cd ~/mosaic_wall && git checkout <previous-sha> && docker compose up -d --build'
```

`data/photo-index.json` can be left in place (the old code ignores it) or deleted; either is safe.
