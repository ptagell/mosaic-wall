// Immich content layer — reused from the immich_web photo-frame server, exposed
// as helpers the orchestrator uses to build scenes. Same API patterns:
// POST /api/search/metadata, GET /api/faces?id=, GET /api/assets/{id}/thumbnail.
const http = require('http');
const url = require('url');

const IMMICH_URL = (process.env.IMMICH_URL || 'http://10.0.0.146:2283').replace(/\/+$/, '');
const API_KEY = process.env.IMMICH_API_KEY;
const PAGE_SIZE = parseInt(process.env.PAGE_SIZE || '1000', 10);
const PERSON_IDS = (process.env.PERSON_IDS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
const LIST_CACHE_TTL = parseInt(process.env.LIST_CACHE_TTL || '600000', 10);

const focusCache = {};
let peopleCache = null;

function immichRequest(apiPath, method, body) {
  return new Promise(function (resolve, reject) {
    const options = url.parse(IMMICH_URL + apiPath);
    options.method = method || 'GET';
    options.headers = { 'X-Api-Key': API_KEY, 'Accept': 'application/json' };
    let payload = null;
    if (body != null) {
      payload = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(options, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch (e) { resolve(Buffer.concat(chunks)); }
        } else {
          reject(new Error('Immich API error ' + res.statusCode + ' for ' + apiPath));
        }
      });
    });
    req.on('error', reject);
    if (payload) { req.write(payload); }
    req.end();
  });
}

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

// searchMetadata(filter)                    -> first page only (legacy behaviour)
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

// When photos were taken (id -> epoch ms), harvested from every search result
// that passes through. Powers "moments" (clusters of photos from one event).
const taken = {};
function recordTaken(items) {
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it || !it.id) { continue; }
    var ts = Date.parse(it.localDateTime || it.fileCreatedAt || '');
    if (isFinite(ts)) { taken[it.id] = ts; }
  }
  // Deliberately uncapped: photo_index needs a year for every pooled id, and
  // capCache evicts in insertion order — i.e. the oldest photos first, exactly
  // the ones this feature exists to surface. photo_index persists this map.
}
function takenAt(id) { return taken[id] || null; }

function idsFrom(items) {
  recordTaken(items);
  var out = [];
  for (var i = 0; i < items.length; i++) {
    if (items[i] && items[i].id) { out.push(items[i].id); }
  }
  return out;
}

// CLIP smart search (POST /api/search/smart), run once per year. "All results"
// is meaningless for a relevance-ranked query — a broad prompt matches most of
// the library — so instead of paginating we window by year. Relevance ordering
// is preserved inside each year; the spread comes from the strata.
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

// Named, non-hidden people as [{id,name}], sorted, cached.
function getPeople() {
  const now = Date.now();
  if (peopleCache && (now - peopleCache.ts) < LIST_CACHE_TTL) {
    return Promise.resolve(peopleCache.data);
  }
  return immichRequest('/api/people?withHidden=false', 'GET').then(function (data) {
    var list = (data && data.people) ? data.people : (Array.isArray(data) ? data : []);
    var named = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p && p.id && p.name && String(p.name).trim() && !p.isHidden) {
        named.push({ id: p.id, name: String(p.name).trim() });
      }
    }
    named.sort(function (a, b) { return a.name.localeCompare(b.name); });
    peopleCache = { data: named, ts: now };
    return named;
  });
}

// "On this day" — today's date across the years. Prefers Immich's memory-lane
// endpoint (one call); falls back to a per-year date-window search. Cached per day.
let onThisDayCache = null;
function getOnThisDay() {
  var now = new Date();
  var key = now.getFullYear() + '-' + now.getMonth() + '-' + now.getDate();
  if (onThisDayCache && onThisDayCache.key === key) { return Promise.resolve(onThisDayCache.ids); }
  var finish = function (ids) { onThisDayCache = { key: key, ids: ids }; return ids; };
  return immichRequest('/api/assets/memory-lane?day=' + now.getDate() + '&month=' + (now.getMonth() + 1), 'GET')
    .then(function (lanes) {
      var items = [];
      (Array.isArray(lanes) ? lanes : []).forEach(function (lane) {
        (lane && lane.assets ? lane.assets : []).forEach(function (a) { if (a && a.type !== 'VIDEO') { items.push(a); } });
      });
      if (!items.length) { throw new Error('memory lane empty'); }
      return finish(idsFrom(items));
    })
    .catch(function () {
      // fallback: ±3 days around today for each of the last 15 years
      var years = [];
      for (var y = now.getFullYear() - 1; y >= now.getFullYear() - 15; y--) { years.push(y); }
      return Promise.all(years.map(function (y) {
        var mid = new Date(y, now.getMonth(), now.getDate());
        var from = new Date(mid.getTime() - 3 * 86400000);
        var to = new Date(mid.getTime() + 4 * 86400000);
        return searchMetadata({ takenAfter: from.toISOString(), takenBefore: to.toISOString() })
          .then(idsFrom).catch(function () { return []; });
      })).then(function (lists) {
        var seen = {}, out = [];
        lists.forEach(function (l) { l.forEach(function (id) { if (!seen[id]) { seen[id] = true; out.push(id); } }); });
        return finish(out);
      });
    });
}

// Caption data for one asset: when and where it was taken. Cached, race-guarded
// so a slow lookup never delays a swap.
const infoCache = {};
function getAssetInfo(assetId) {
  if (infoCache[assetId]) { return Promise.resolve(infoCache[assetId]); }
  var fetchP = immichRequest('/api/assets/' + encodeURIComponent(assetId), 'GET').then(function (a) {
    var ex = (a && a.exifInfo) || {};
    var ts = Date.parse(a.localDateTime || ex.dateTimeOriginal || a.fileCreatedAt || '');
    var date = isFinite(ts) ? new Date(ts).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    var place = [ex.city, ex.country].filter(Boolean).join(', ');
    var info = { date: date, place: place };
    if (isFinite(ts)) { taken[assetId] = ts; }
    infoCache[assetId] = info;
    capCache(infoCache, 8000);
    return info;
  });
  var timeoutP = new Promise(function (resolve) { setTimeout(function () { resolve({ date: '', place: '' }); }, 2500); });
  return Promise.race([fetchP, timeoutP]).catch(function () { return { date: '', place: '' }; });
}

// --- "Frame favourites" album: tap-to-favourite target ---
// Album id is cached for the process lifetime; the deleted-album retry below is
// the invalidation path. Uses requestImpl so tests can drive it via _setRequest.
const FAVOURITES_ALBUM = process.env.FAVOURITES_ALBUM || 'Frame favourites';
let favAlbumId = null;

function resolveFavAlbum() {
  if (favAlbumId) { return Promise.resolve(favAlbumId); }
  return requestImpl('/api/albums', 'GET').then(function (albums) {
    var list = Array.isArray(albums) ? albums : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id && list[i].albumName === FAVOURITES_ALBUM) {
        favAlbumId = list[i].id;
        return favAlbumId;
      }
    }
    return requestImpl('/api/albums', 'POST', { albumName: FAVOURITES_ALBUM }).then(function (created) {
      favAlbumId = (created && created.id) || null;
      if (!favAlbumId) { throw new Error('album create returned no id'); }
      console.log('[immich] created album "' + FAVOURITES_ALBUM + '"');
      return favAlbumId;
    });
  });
}

// Add one asset to the favourites album. Resolves true/false, never rejects.
// Immich reports an already-present asset as error "duplicate" — that is success
// here (add-only, idempotent). Any thrown failure (including a 404 from an album
// deleted since caching) drops the cache and retries the whole flow once.
function addToFavourites(assetId, retried) {
  return resolveFavAlbum().then(function (albumId) {
    return requestImpl('/api/albums/' + albumId + '/assets', 'PUT', { ids: [assetId] }).then(function (out) {
      var r = Array.isArray(out) ? out[0] : null;
      return !!(r && (r.success || r.error === 'duplicate'));
    });
  }).catch(function (err) {
    favAlbumId = null;
    if (!retried) { return addToFavourites(assetId, true); }
    console.error('[immich] favourite ' + assetId + ': ' + err.message);
    return false;
  });
}

// Drop the list-level caches so the next scene resolve sees new uploads.
// Per-asset caches (focus, info, takenAt) stay — those never go stale.
function clearListCaches() {
  var k;
  for (k in smartCache) { delete smartCache[k]; }
  peopleCache = null;
  onThisDayCache = null;
}

function computeFocus(faces) {
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  var iw = 0, ih = 0;
  for (var i = 0; i < faces.length; i++) {
    var f = faces[i];
    if (!f || !f.imageWidth || !f.imageHeight) { continue; }
    iw = f.imageWidth; ih = f.imageHeight;
    if (f.boundingBoxX1 < minX) { minX = f.boundingBoxX1; }
    if (f.boundingBoxY1 < minY) { minY = f.boundingBoxY1; }
    if (f.boundingBoxX2 > maxX) { maxX = f.boundingBoxX2; }
    if (f.boundingBoxY2 > maxY) { maxY = f.boundingBoxY2; }
  }
  if (!iw || !ih || minX === Infinity) { return { x: 50, y: 50 }; }
  var cx = ((minX + maxX) / 2) / iw * 100;
  var cy = ((minY + maxY) / 2) / ih * 100;
  cx = Math.max(0, Math.min(100, cx));
  cy = Math.max(0, Math.min(100, cy));
  return { x: Math.round(cx * 10) / 10, y: Math.round(cy * 10) / 10 };
}

// keep long-running memory bounded — evict oldest entries past the cap
function capCache(obj, n) {
  var keys = Object.keys(obj);
  if (keys.length > n) { for (var i = 0; i < keys.length - n; i++) { delete obj[keys[i]]; } }
}

function getFocus(assetId) {
  if (focusCache[assetId]) { return Promise.resolve(focusCache[assetId]); }
  var fetchP = immichRequest('/api/faces?id=' + encodeURIComponent(assetId), 'GET').then(function (faces) {
    var focus = computeFocus(Array.isArray(faces) ? faces : []);
    focusCache[assetId] = focus;
    capCache(focusCache, 8000);
    return focus;
  });
  var timeoutP = new Promise(function (resolve) {
    setTimeout(function () { resolve({ x: 50, y: 50 }); }, 2500);
  });
  return Promise.race([fetchP, timeoutP]).catch(function () { return { x: 50, y: 50 }; });
}

// Stream an Immich thumbnail/original through to the client.
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

module.exports = {
  IMMICH_URL: IMMICH_URL,
  PERSON_IDS: PERSON_IDS,
  getPeople: getPeople,
  searchSmart: searchSmart,
  getFocus: getFocus,
  getOnThisDay: getOnThisDay,
  getAssetInfo: getAssetInfo,
  addToFavourites: addToFavourites,
  searchMetadata: searchMetadata,
  takenAt: takenAt,
  taken: taken,
  clearListCaches: clearListCaches,
  proxyImage: proxyImage,
  _setRequest: _setRequest
};
