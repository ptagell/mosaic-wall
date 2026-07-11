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
const personPhotosCache = {};
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

function searchMetadata(filter) {
  const body = { size: PAGE_SIZE, type: 'IMAGE' };
  for (const k in filter) {
    if (Object.prototype.hasOwnProperty.call(filter, k)) { body[k] = filter[k]; }
  }
  return immichRequest('/api/search/metadata', 'POST', body).then(function (data) {
    return (data && data.assets && data.assets.items) ? data.assets.items : [];
  });
}

function idsFrom(items) {
  var out = [];
  for (var i = 0; i < items.length; i++) {
    if (items[i] && items[i].id) { out.push(items[i].id); }
  }
  return out;
}

// CLIP smart search (POST /api/search/smart) — used for content scenes like
// "landscapes" that aren't tied to a named person. Cached by query.
const smartCache = {};
function searchSmart(query) {
  var key = String(query || '');
  var now = Date.now();
  var cached = smartCache[key];
  if (cached && (now - cached.ts) < LIST_CACHE_TTL) { return Promise.resolve(cached.ids); }
  return immichRequest('/api/search/smart', 'POST', { query: key, size: PAGE_SIZE, type: 'IMAGE' })
    .then(function (data) {
      var items = (data && data.assets && data.assets.items) ? data.assets.items : [];
      var ids = idsFrom(items);
      smartCache[key] = { ids: ids, ts: now };
      return ids;
    }).catch(function (err) {
      console.error('[immich] smart search "' + key + '": ' + err.message);
      return [];
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

// Immich "favorites" (isFavorite=true) — a curated best-of selection. Cached.
let favCache = null;
function getFavorites() {
  var now = Date.now();
  if (favCache && (now - favCache.ts) < LIST_CACHE_TTL) { return Promise.resolve(favCache.ids); }
  return searchMetadata({ isFavorite: true }).then(function (items) {
    var ids = idsFrom(items); favCache = { ids: ids, ts: now }; return ids;
  }).catch(function (err) { console.error('[immich] favorites: ' + err.message); return []; });
}

function getPersonPhotoIds(personId) {
  const now = Date.now();
  const cached = personPhotosCache[personId];
  if (cached && (now - cached.ts) < LIST_CACHE_TTL) {
    return Promise.resolve(cached.ids);
  }
  return searchMetadata({ personIds: [personId] }).then(function (items) {
    var ids = idsFrom(items);
    personPhotosCache[personId] = { ids: ids, ts: now };
    return ids;
  }).catch(function (err) {
    console.error('[immich] person ' + personId + ': ' + err.message);
    return [];
  });
}

// Deduped union of ids for a selection; falls back to env default, then all photos.
function getPhotoIdsForSelection(personIds) {
  var ids = (personIds && personIds.length) ? personIds : PERSON_IDS;
  if (!ids.length) {
    return searchMetadata({}).then(idsFrom);
  }
  return Promise.all(ids.map(getPersonPhotoIds)).then(function (lists) {
    var seen = {}, out = [];
    for (var i = 0; i < lists.length; i++) {
      for (var j = 0; j < lists[i].length; j++) {
        var id = lists[i][j];
        if (!seen[id]) { seen[id] = true; out.push(id); }
      }
    }
    return out;
  });
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
function proxyImage(res, assetId, size) {
  var upstream = IMMICH_URL + '/api/assets/' + assetId + '/thumbnail?size=' + (size || 'preview');
  var req = http.request(upstream, { headers: { 'X-Api-Key': API_KEY } });
  req.on('error', function (err) {
    console.error('[immich] image proxy: ' + err.message);
    if (!res.headersSent) { res.writeHead(502); res.end('Image unavailable'); }
  });
  req.on('response', function (up) {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  req.end();
}

module.exports = {
  IMMICH_URL: IMMICH_URL,
  PERSON_IDS: PERSON_IDS,
  getPeople: getPeople,
  getPersonPhotoIds: getPersonPhotoIds,
  getPhotoIdsForSelection: getPhotoIdsForSelection,
  getFavorites: getFavorites,
  searchSmart: searchSmart,
  getFocus: getFocus,
  proxyImage: proxyImage
};
