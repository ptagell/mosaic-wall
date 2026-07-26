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

// The most recently shown ids drawn from `ids`, treated as too-recent to show.
//
// `limit` caps how many are protected. Default is 75% of `ids` — an escape valve
// so a caller with nowhere else to go always has something left to show.
//
// Pass Infinity when the caller CAN go elsewhere. That distinction matters: the
// 75% rule was written for a pool-wide window, where 75% of thousands of ids far
// exceeded the ~150-deep history, so everything recent was protected in practice.
// Applied per year bucket it means something else entirely — a 2-photo year
// protects only 1, so showing P then Q leaves P showable again immediately, and
// because year-first picking visits a 2-photo year as often as a 4000-photo one,
// those two photos churn and reappear across the wall.
function recentWindow(ids, recentShown, limit) {
  var inPool = {};
  for (var i = 0; i < ids.length; i++) { inPool[ids[i]] = true; }
  var win = (limit == null) ? Math.max(1, Math.floor(ids.length * 0.75)) : limit;
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

function normalise(opts) {
  opts = opts || {};
  return {
    onWall: opts.onWall || {},
    lastShow: opts.lastShow || null,
    recentShown: opts.recentShown || [],
    rand: opts.rand || Math.random
  };
}

// Candidates within one bucket: not on another tile, not this tile's current
// photo, not recently shown. Identical rules to the pre-existing picker.
function eligible(ids, opts, limit) {
  var free = [];
  for (var i = 0; i < ids.length; i++) {
    if (!opts.onWall[ids[i]] && ids[i] !== opts.lastShow) { free.push(ids[i]); }
  }
  if (!free.length) { return { fresh: [], free: free }; }
  var recentW = recentWindow(ids, opts.recentShown, limit);
  var fresh = [];
  for (var k = 0; k < free.length; k++) { if (!recentW[free[k]]) { fresh.push(free[k]); } }
  return { fresh: fresh, free: free };
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

// Uniform draw over a flat id list, with the same freshness rules. Used when
// stratifying is pointless — during a "moment" the whole pool is one event.
function pickUniform(ids, opts) {
  opts = normalise(opts);
  var e = eligible(ids, opts);
  if (e.fresh.length) { return pickFrom(e.fresh, opts.rand); }
  if (e.free.length) { return pickFrom(stalest(e.free, opts.recentShown), opts.rand); }
  return null;
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
    // Infinity: a blocked year yields to the next rather than recycling its
    // own tail. The stalest fallback below covers the all-years-exhausted case.
    var e = eligible(buckets[years[i]] || [], opts, Infinity);
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
