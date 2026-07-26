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
const path = require('path');
const immich = require('./immich');

// Where the persisted index lives. Declared here so tests can redirect it to a
// temp dir before any write path exists.
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

// Placeholder until persistence lands; kept here so ensure() can call it.
function markDirty() {}

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
