// Mosaic Wall — photo index.
// Owns the year-bucketed view of the library: which photo ids exist, what year
// each belongs to, and which years have been scanned to completion. Immich
// returns results newest-first, so a descending scan passes through years in
// order — the moment we see a photo from year Y-1, year Y is provably complete
// and never needs fetching again. That is what makes a full scan of a 200k
// library a one-time cost rather than a recurring one.
//
// Public pools are flat id arrays; the year buckets are an internal detail the
// picker reads.
const fs = require('fs');
const path = require('path');
const immich = require('./immich');

const CACHE_VERSION = 1;
const WRITE_DEBOUNCE_MS = parseInt(process.env.INDEX_WRITE_DEBOUNCE_MS || '300000', 10);

// Where the persisted index lives. Declared here so tests can redirect it to a
// temp dir before any write path exists.
var dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
function _setDataDir(d) { dataDir = d; }
function cacheFile() { return path.join(dataDir, 'photo-index.json'); }

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

// File one page of assets into their year buckets.
function absorb(ix, items) {
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it || !it.id || ix.seen[it.id]) { continue; }
    ix.seen[it.id] = true;
    var y = yearOf(it.id);
    if (!ix.years[y]) { ix.years[y] = []; }
    ix.years[y].push(it.id);
  }
}

function notify(key) {
  for (var i = 0; i < updateCbs.length; i++) {
    try { updateCbs[i](key); } catch (e) { console.error('[index] onUpdate: ' + e.message); }
  }
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

// Walk every page for `filter`, bucketing as we go. Resolves after page 1 so the
// wall can start showing photos immediately; the rest continues in background.
function ensure(key, filter) {
  var ix = entry(key, filter);
  if (ix.done || ix.scanning) { return Promise.resolve(pool(key)); }
  ix.scanning = true;
  ix.filter = filter || {};

  var firstPage = null;
  var resolveFirst = null;
  var firstReady = new Promise(function (r) { resolveFirst = r; });
  var scanFilter = withResumeCursor(ix, ix.filter);
  var lastYear = null;

  immich.searchMetadata(scanFilter, {
    paginate: true,
    onPage: function (items) {
      absorb(ix, items);
      // descending order: when the year changes, the previous one is complete
      for (var i = 0; i < items.length; i++) {
        var y = items[i] && items[i].id ? yearOf(items[i].id) : null;
        if (!y || y === 'unknown') { continue; }
        if (lastYear && y !== lastYear) { ix.complete[lastYear] = true; }
        lastYear = y;
      }
      if (firstPage === null) { firstPage = true; resolveFirst(); }
    }
  }).then(function () {
    if (lastYear) { ix.complete[lastYear] = true; } // scan ran to the end
    ix.done = true;
    ix.scanning = false;
    markDirty();
    if (firstPage === null) { resolveFirst(); }     // empty result set
    notify(key);
  }).catch(function (err) {
    console.error('[index] scan ' + key + ': ' + err.message);
    ix.scanning = false;
    markDirty();
    if (firstPage === null) { resolveFirst(); }
    notify(key);
  });

  return firstReady.then(function () { return pool(key); });
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
        // Only a 400/404 means this Immich doesn't know the filter. Anything
        // else (network, 5xx) is transient — disabling on those would silently
        // give up on deletion detection for the rest of the process lifetime.
        if (/Immich API error (400|404)/.test(err.message)) {
          console.log('[index] trashedAfter unsupported, relying on lazy eviction');
          trashedSupported = false;
          return;
        }
        throw err;
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

function _reset() {
  indexes = {}; updateCbs = []; trackedPeople = {}; trashedSupported = true;
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  for (var id in immich.taken) {
    if (Object.prototype.hasOwnProperty.call(immich.taken, id)) { delete immich.taken[id]; }
  }
}

module.exports = {
  ensure: ensure,
  pool: pool,
  buckets: buckets,
  histogram: histogram,
  isComplete: isComplete,
  scanning: scanning,
  onUpdate: onUpdate,
  init: init,
  flush: flush,
  markDirty: markDirty,
  applyDeltas: applyDeltas,
  evict: evict,
  registerPerson: registerPerson,
  libraryPool: libraryPool,
  personPool: personPool,
  favoritesPool: favoritesPool,
  selectionPool: selectionPool,
  _reset: _reset,
  _setDataDir: _setDataDir,
  _indexes: function () { return indexes; }
};
