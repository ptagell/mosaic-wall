// Mosaic Wall — scenes engine.
// A "scene" decides WHAT each tile shows. This module is pure content
// orchestration: given the active scene and the set of online tiles, it resolves
// a pool of photo ids per tile. Timing and message-sending live in server.js, so
// this file has no notion of WebSockets, timers, or the wall geometry.
//
// resolvePools(scene, config, tileIds, ctx) -> Promise<{ pools, info }>
//   pools : { tileId: [photoId, ...] }   (each tile draws randomly from its pool)
//   info  : scene-specific summary for the admin UI (selected person, assignments…)
//   ctx   : { defaultPool() -> Promise<[ids]> }  (server-owned, cached default pool)
const immich = require('./immich');
const photoIndex = require('./photo_index');

// Admin-facing catalogue. Order is display order.
var SCENES = [
  { key: 'random',           label: 'Random',          desc: 'Any photo from the pool — a different one per tile.' },
  { key: 'one-person',       label: 'One person',      desc: 'The whole wall shows photos of a single person.' },
  { key: 'different-people', label: 'Different people', desc: 'Each tile is assigned a different person (choose who).' },
  { key: 'landscapes',       label: 'Landscapes',      desc: 'Scenery with no people, across the wall.' },
  { key: 'on-this-day',      label: 'On this day',     desc: 'Today’s date across the years — memories resurface.' },
  { key: 'favorites',        label: 'Favourites',      desc: 'Your Immich favourites — a curated best-of.' },
  { key: 'search',           label: 'Search',          desc: 'A smart (CLIP) text search across the library.' },
  { key: 'art',              label: 'Art',             desc: 'Generative art — plasma, fractals, flow fields — painted live across the wall instead of photos.' },
  { key: 'split-image',      label: 'Split image',     desc: 'One picture spread across the placed tiles (video-wall).' },
  { key: 'mirror',           label: 'Mirror',          desc: 'Live feed from one camera, split across the wall. Open /camera.' }
];
var SCENE_KEYS = SCENES.map(function (s) { return s.key; });
function isScene(k) { return SCENE_KEYS.indexOf(k) !== -1; }

var LANDSCAPE_QUERY = process.env.LANDSCAPE_QUERY || 'beautiful landscape scenery nature no people';

// Give every tile the same pool.
function shareAll(tileIds, ids) {
  var pools = {};
  tileIds.forEach(function (id) { pools[id] = ids || []; });
  return pools;
}
// Any tile whose pool is empty falls back to the default pool (never a blank tile).
function fillBlanks(pools, tileIds, fallback) {
  tileIds.forEach(function (id) {
    if (!pools[id] || !pools[id].length) { pools[id] = fallback || []; }
  });
  return pools;
}

function resolvePools(scene, config, tileIds, ctx) {
  config = config || {};
  tileIds = (tileIds || []).slice().sort(); // deterministic assignment order
  ctx = ctx || {};
  var getDefault = ctx.defaultPool || function () { return photoIndex.selectionPool([]); };

  // NB: we still resolve content (and its counts) with zero tiles, so the admin can
  // show "N matches" before any tile connects; pools just come out empty.

  if (scene === 'one-person') {
    return Promise.all([immich.getPeople(), getDefault()]).then(function (r) {
      var people = r[0] || [], fallback = r[1] || [];
      var chosen = null;
      if (config.personId) {
        for (var i = 0; i < people.length; i++) { if (people[i].id === config.personId) { chosen = people[i]; break; } }
        if (!chosen) { chosen = { id: config.personId, name: config.personId }; }
      } else if (people.length) { chosen = people[0]; }
      if (!chosen) { return { pools: shareAll(tileIds, fallback), info: { personId: null } }; }
      return photoIndex.personPool(chosen.id).then(function (ids) {
        var pools = fillBlanks(shareAll(tileIds, ids), tileIds, fallback);
        return { pools: pools, info: { personId: chosen.id, personName: chosen.name, count: ids.length } };
      });
    });
  }

  if (scene === 'different-people') {
    return Promise.all([immich.getPeople(), getDefault()]).then(function (r) {
      var people = r[0] || [], fallback = r[1] || [];
      // optional subset: only rotate the chosen people
      if (config.personIds && config.personIds.length) {
        var want = {}; config.personIds.forEach(function (pid) { want[pid] = true; });
        var filtered = people.filter(function (p) { return want[p.id]; });
        if (filtered.length) { people = filtered; }
      }
      if (!people.length) { return { pools: shareAll(tileIds, fallback), info: { peopleCount: 0 } }; }
      // round-robin assignment; only fetch each distinct person's photos once
      var assign = {}, need = {};
      tileIds.forEach(function (id, i) { var p = people[i % people.length]; assign[id] = p; need[p.id] = p; });
      var pids = Object.keys(need);
      return Promise.all(pids.map(function (pid) { return photoIndex.personPool(pid); })).then(function (lists) {
        var byPid = {};
        pids.forEach(function (pid, i) { byPid[pid] = lists[i] || []; });
        var pools = {}, assignments = {};
        tileIds.forEach(function (id) {
          var p = assign[id];
          pools[id] = byPid[p.id];
          assignments[id] = { id: p.id, name: p.name };
        });
        pools = fillBlanks(pools, tileIds, fallback);
        return { pools: pools, info: { peopleCount: people.length, assignments: assignments } };
      });
    });
  }

  // generative art needs no photo pools — tiles render locally, server picks artworks
  if (scene === 'art') {
    return Promise.resolve({ pools: shareAll(tileIds, []), info: { artwork: config.artwork || '' } });
  }

  if (scene === 'landscapes') {
    return Promise.all([immich.searchSmart(LANDSCAPE_QUERY), getDefault()]).then(function (r) {
      var ids = r[0] || [], fallback = r[1] || [];
      var pools = fillBlanks(shareAll(tileIds, ids), tileIds, fallback);
      return { pools: pools, info: { query: LANDSCAPE_QUERY, count: ids.length } };
    });
  }

  if (scene === 'on-this-day') {
    return Promise.all([immich.getOnThisDay(), getDefault()]).then(function (r) {
      var ids = r[0] || [], fallback = r[1] || [];
      return { pools: fillBlanks(shareAll(tileIds, ids), tileIds, fallback), info: { count: ids.length } };
    });
  }

  if (scene === 'favorites') {
    return Promise.all([photoIndex.favoritesPool(), getDefault()]).then(function (r) {
      var ids = r[0] || [], fallback = r[1] || [];
      return { pools: fillBlanks(shareAll(tileIds, ids), tileIds, fallback), info: { count: ids.length } };
    });
  }

  if (scene === 'search') {
    var q = (config.query || '').trim();
    if (!q) { return getDefault().then(function (ids) { return { pools: shareAll(tileIds, ids || []), info: { query: '', count: (ids || []).length } }; }); }
    return Promise.all([immich.searchSmart(q), getDefault()]).then(function (r) {
      var ids = r[0] || [], fallback = r[1] || [];
      return { pools: fillBlanks(shareAll(tileIds, ids), tileIds, fallback), info: { query: q, count: ids.length } };
    });
  }

  // 'random' and any unknown key -> shared default pool
  return getDefault().then(function (ids) {
    return { pools: shareAll(tileIds, ids || []), info: { count: (ids || []).length } };
  });
}

module.exports = {
  SCENES: SCENES,
  isScene: isScene,
  resolvePools: resolvePools
};
