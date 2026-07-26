// Mosaic Wall — orchestrator (Phases 0–1 + free-form layout)
// One server drives a wall of dumb display tiles over WebSocket.
// Layout model: free-form scatter. Each tile has a physical SCREEN size (mm, from
// its model), an orientation (portrait/landscape), and a position on the wall.
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const immich = require('./immich');
const models = require('./models');
const scenes = require('./scenes');
const photoIndex = require('./photo_index');
const picker = require('./picker');

const PORT = parseInt(process.env.PORT || '4000', 10);
// Base per-tile swap interval; each tile jitters ±SLIDE_JITTER around it (loose sync).
const SLIDE_INTERVAL = parseInt(process.env.DEMO_INTERVAL || process.env.SLIDE_INTERVAL || '15000', 10);
const SLIDE_JITTER = Math.min(0.9, Math.max(0, parseFloat(process.env.SLIDE_JITTER || '0.3')));
const WAVE_SPAN = parseInt(process.env.WAVE_SPAN || '1400', 10);      // wave sweep duration across the wall (ms)
const SPOT_INTERVAL = parseInt(process.env.SPOT_INTERVAL || '4500', 10); // spotlight hop cadence (ms)
const LEAD_MS = parseInt(process.env.LEAD_MS || '1100', 10);          // scheduling lead: preload window before a synced swap
const STALE_MS = parseInt(process.env.STALE_MS || '20000', 10);       // no pong for this long => half-open, drop it
const START_TS = Date.now();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const REG_FILE = path.join(DATA_DIR, 'registry.json');

// --- display effects (broadcast to every tile as one config object) ---
const LOOKS = ['none', 'grayscale', 'sepia', 'warm', 'punch', 'noir'];
const TRANSITIONS = ['fade', 'slide', 'zoom', 'random'];
const TIMINGS = ['sync', 'stagger', 'wave'];
// Artistic overlays rendered across the whole wall (Canvas 2D, coordinated by clock + geometry)
const EFFECTS = ['none', 'bokeh', 'snow', 'embers', 'stars', 'network', 'aurora', 'glass'];
// Generative artworks for the 'art' scene — full-screen visuals instead of photos.
// Names must match the tile's renderer catalogue (WebGL shader or Canvas 2D piece).
const ARTS = ['plasma', 'lava', 'kaleido', 'julia', 'tunnel', 'waves', 'flow', 'phyllo', 'spiro', 'metaballs'];
const ART_PALETTES = 6; // colour palettes the tiles know (cosine gradients)
function defaultDisplay() {
  return { look: 'none', transition: 'fade', kenburns: false, vignette: false, tint: false, nightDim: false, spotlight: false, transitionSec: 1.2, kenburnsSec: 22, effect: 'none', effectDensity: 1 };
}
function clampNum(v, def, min, max) { var n = parseFloat(v); if (!isFinite(n)) { return def; } return Math.min(max, Math.max(min, n)); }
// Merge a partial patch onto a base display config, validating every field.
function sanitizeDisplay(patch, base) {
  var d = {};
  var b = base || defaultDisplay();
  d.look = (LOOKS.indexOf(patch.look) !== -1) ? patch.look : b.look;
  d.transition = (TRANSITIONS.indexOf(patch.transition) !== -1) ? patch.transition : b.transition;
  ['kenburns', 'vignette', 'tint', 'nightDim', 'spotlight'].forEach(function (k) {
    d[k] = (typeof patch[k] === 'boolean') ? patch[k] : !!b[k];
  });
  var bt = (b.transitionSec != null) ? b.transitionSec : 1.2;
  var bk = (b.kenburnsSec != null) ? b.kenburnsSec : 22;
  d.transitionSec = (patch.transitionSec != null) ? clampNum(patch.transitionSec, bt, 0, 6) : bt;
  d.kenburnsSec = (patch.kenburnsSec != null) ? clampNum(patch.kenburnsSec, bk, 5, 90) : bk;
  d.effect = (EFFECTS.indexOf(patch.effect) !== -1) ? patch.effect : (EFFECTS.indexOf(b.effect) !== -1 ? b.effect : 'none');
  var be = (b.effectDensity != null) ? b.effectDensity : 1;
  d.effectDensity = (patch.effectDensity != null) ? clampNum(patch.effectDensity, be, 0.2, 2) : be;
  return d;
}

// --- wave sweep directions + daily schedule ---
const WAVE_DIRS = ['lr', 'tb', 'diag'];
function defaultSchedule() {
  return { on: false, wake: '07:00', dayScene: 'random', evening: '19:30', eveScene: 'art', sleep: '22:30' };
}
function sanitizeSchedule(patch, base) {
  var b = base || defaultSchedule();
  var d = {};
  var hm = /^([01]?\d|2[0-3]):[0-5]\d$/;
  d.on = (typeof patch.on === 'boolean') ? patch.on : b.on;
  ['wake', 'evening', 'sleep'].forEach(function (k) { d[k] = (typeof patch[k] === 'string' && hm.test(patch[k])) ? patch[k] : b[k]; });
  d.dayScene = scenes.isScene(patch.dayScene) ? patch.dayScene : b.dayScene;
  d.eveScene = scenes.isScene(patch.eveScene) ? patch.eveScene : b.eveScene;
  return d;
}

// --- persisted store: per-tile assignment + active scene. Survives restarts. ---
// tiles: id -> { name, model, orientation ('portrait'|'landscape'|null=auto), place ({x,y} mm | null) }
// scene: active scene key; sceneConfig: { personId? }
let store = {
  tiles: {}, scene: 'random', sceneConfig: {}, timing: 'sync', display: defaultDisplay(),
  slideSec: Math.round(SLIDE_INTERVAL / 1000), waveDir: 'lr', momentsEvery: 0, schedule: defaultSchedule()
};
function loadStore() {
  try {
    var raw = JSON.parse(fs.readFileSync(REG_FILE, 'utf8'));
    if (raw && raw.tiles) { store.tiles = raw.tiles; }
    if (raw && scenes.isScene(raw.scene)) { store.scene = raw.scene; }
    if (raw && raw.sceneConfig && typeof raw.sceneConfig === 'object') { store.sceneConfig = raw.sceneConfig; }
    if (raw && TIMINGS.indexOf(raw.timing) !== -1) { store.timing = raw.timing; }
    if (raw && typeof raw.slideSec === 'number') { store.slideSec = clampNum(raw.slideSec, store.slideSec, 2, 600); }
    if (raw && raw.display && typeof raw.display === 'object') { store.display = sanitizeDisplay(raw.display, defaultDisplay()); }
    else if (raw && typeof raw.grayscale === 'boolean' && raw.grayscale) { store.display = sanitizeDisplay({ look: 'grayscale' }, defaultDisplay()); } // migrate old flag
    if (raw && WAVE_DIRS.indexOf(raw.waveDir) !== -1) { store.waveDir = raw.waveDir; }
    if (raw && typeof raw.momentsEvery === 'number') { store.momentsEvery = Math.round(clampNum(raw.momentsEvery, 0, 0, 50)); }
    if (raw && raw.schedule && typeof raw.schedule === 'object') { store.schedule = sanitizeSchedule(raw.schedule, defaultSchedule()); }
    console.log('[mosaic] registry loaded: ' + Object.keys(store.tiles).length + ' tiles, scene=' + store.scene + ', timing=' + store.timing);
  } catch (e) { console.log('[mosaic] no saved registry yet'); }
}
let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(REG_FILE, JSON.stringify(store, null, 2)); }
    catch (e) { console.error('[mosaic] save failed: ' + e.message); }
  }, 150);
}
function persistedTile(id) {
  if (!store.tiles[id]) { store.tiles[id] = { name: id, model: null, orientation: null, place: null }; saveStore(); }
  return store.tiles[id];
}

// --- runtime registry: id -> { ws, id, screenW, screenH, dpr, nativeW, nativeH, detectedOrientation, online, lastSeen, lastShow } ---
const tiles = new Map();

// --- default photo pool (fallback for every scene) ---
let poolIds = [];
let poolPromise = null;
function ensurePool() {
  if (poolIds.length) { return Promise.resolve(poolIds); }
  if (!poolPromise) {
    poolPromise = photoIndex.selectionPool([]).then(function (ids) {
      poolIds = ids; console.log('[mosaic] photo pool loaded: ' + ids.length + ' ids'); return ids;
    }).catch(function (err) { console.error('[mosaic] pool load failed: ' + err.message); poolPromise = null; return []; });
  }
  return poolPromise;
}
function randomFrom(arr) { return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null; }
function send(ws, obj) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) {} } }

// --- scene engine: decides which pool of photos each tile draws from ---
// timing: 'sync'   = one clock; every tile swaps together (default)
//         'stagger'= each tile on its own jittered timer (calmer shimmer)
//         'wave'   = swaps sweep across the wall by placement (left -> right)
const engine = { scene: 'random', config: {}, pools: {}, info: {}, gen: 0, timing: 'sync', display: defaultDisplay(), splitImg: null, cameraOnline: false, lastFrame: null, lastRelay: 0, slideMs: SLIDE_INTERVAL, artIdx: -1, artPal: -1, currentArt: null, moment: null, momentCount: 0, sleeping: false, schedSlot: null };
function onlineTileIds() {
  var ids = []; tiles.forEach(function (t, id) { if (t.online) { ids.push(id); } }); return ids;
}
// Recompute per-tile pools for the active scene over the current online set.
// Returns the resolved { pools, info }. A newer resolve won't be clobbered by an
// older one (gen guard), but the caller always gets what THIS call computed.
function resolveScene() {
  var myGen = ++engine.gen;
  return scenes.resolvePools(engine.scene, engine.config, onlineTileIds(), { defaultPool: ensurePool })
    .then(function (res) {
      res = res || { pools: {}, info: {} };
      if (myGen === engine.gen) { engine.pools = res.pools || {}; engine.info = res.info || {}; }
      return res;
    })
    .catch(function (err) {
      console.error('[mosaic] scene resolve failed: ' + err.message);
      return { pools: engine.pools, info: engine.info };
    });
}
function poolFor(id) {
  // during a "moment", shared-pool scenes narrow the whole wall to one event
  if (engine.moment && SHARED_SCENES.indexOf(engine.scene) !== -1) { return engine.moment.ids; }
  var p = engine.pools[id]; return (p && p.length) ? p : poolIds;
}

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

// --- moments: every N changes, gather the wall around one event (photos taken
// within a few hours of each other), hold for a couple of swaps, then scatter ---
const SHARED_SCENES = ['random', 'one-person', 'landscapes', 'favorites', 'search', 'on-this-day'];
const MOMENT_SPAN_MS = 3 * 3600000;
const MOMENT_HOLDS = 1; // extra cycles the cluster stays after the one it starts on
function tryStartMoment() {
  if (SHARED_SCENES.indexOf(engine.scene) === -1) { return false; }
  var ids = onlineTileIds();
  var pool = ids.length ? (engine.pools[ids[0]] && engine.pools[ids[0]].length ? engine.pools[ids[0]] : poolIds) : poolIds;
  if (pool.length < 8) { return false; }
  var need = Math.max(3, Math.min(ids.length || 3, 4));
  var best = null;
  for (var tryN = 0; tryN < 12; tryN++) {
    var anchor = randomFrom(pool);
    var ts = immich.takenAt(anchor);
    if (!ts) { continue; }
    var cluster = pool.filter(function (pid) { var t2 = immich.takenAt(pid); return t2 && Math.abs(t2 - ts) <= MOMENT_SPAN_MS; });
    if (cluster.length >= need && (!best || cluster.length > best.ids.length)) { best = { ids: cluster, ts: ts }; }
    if (best && best.ids.length >= need * 3) { break; }
  }
  if (!best) { return false; }
  engine.moment = {
    ids: best.ids, holds: MOMENT_HOLDS,
    label: new Date(best.ts).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })
  };
  console.log('[mosaic] moment: ' + best.ids.length + ' photos from ' + engine.moment.label);
  return true;
}

// --- freshness: never show the same photo on two tiles at once, and keep a
// recent-history window so a photo doesn't reappear soon after it was shown ---
const RECENT_CAP = parseInt(process.env.RECENT_CAP || '150', 10);
var recentShown = []; // fifo of photo ids, most recent last
var recentSet = {};   // id -> true, for O(1) lookups
function noteShown(pid) {
  if (!pid) { return; }
  if (recentSet[pid]) {
    // re-shown (small pool): move to the end so the list stays in true
    // least-recently-shown order for the rotation fallback below
    var ix = recentShown.indexOf(pid);
    if (ix !== -1) { recentShown.splice(ix, 1); }
    recentShown.push(pid);
    return;
  }
  recentShown.push(pid); recentSet[pid] = true;
  while (recentShown.length > RECENT_CAP) { delete recentSet[recentShown.shift()]; }
}
// Pick a photo for one tile. Year-first: see picker.js for why. During a
// "moment" the whole wall is one event — a single year — so stratifying is a
// no-op and we draw uniformly instead. Freshness rules are unchanged; they now
// live in picker.js and run per year bucket rather than over the whole pool.
function pickPhoto(id) {
  var pool = poolFor(id);
  if (!pool.length) { return null; }
  var t = tiles.get(id) || {};
  var onWall = {};
  tiles.forEach(function (ot, oid) { if (oid !== id && ot.online && ot.lastShow) { onWall[ot.lastShow] = true; } });
  var opts = { onWall: onWall, lastShow: t.lastShow, recentShown: recentShown };
  var inMoment = engine.moment && SHARED_SCENES.indexOf(engine.scene) !== -1;
  var pid = inMoment ? picker.pickUniform(pool, opts) : picker.pickFromBuckets(bucketsFor(pool), opts);
  if (pid) { return pid; }
  // pool of one, or everything blocked — show something rather than nothing
  var any = pool.filter(function (p) { return p !== t.lastShow; });
  return any.length ? randomFrom(any) : pool[0];
}

// Show the next photo on one tile, per the active scene.
// `at` (server ms) schedules a clock-aligned swap; omitted = swap on load.
function pushNext(id, at) {
  const t = tiles.get(id);
  if (!t || !t.online) { return; }
  var pid = pickPhoto(id);
  if (!pid) { return; }
  t.lastShow = pid; // set before the async focus lookup so later picks in this cycle see it
  noteShown(pid);
  return Promise.all([immich.getFocus(pid), immich.getAssetInfo(pid)]).then(function (r) {
    var m = { type: 'show', id: pid, img: '/img/' + pid + '?size=preview', focusX: r[0].x, focusY: r[0].y };
    if (r[1] && (r[1].date || r[1].place)) { m.info = r[1]; } // tap-to-see caption
    if (at) { m.at = at; }
    send(t.ws, m);
  });
}
function pushAll(at) { onlineTileIds().forEach(function (id) { pushNext(id, at); }); }

// --- Phase 4: split-image — one picture spanning the placed tiles, bezel-aware ---
// The wall bounding box (mm) and each tile's normalized region come straight from
// the free-form placement, so physical gaps between iPads map to gaps in the image.
function wallBox() {
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
  onlineTileIds().forEach(function (id) {
    var pe = store.tiles[id]; if (!pe || !pe.place) { return; }
    var mm = pe.model ? models.screenMm(pe.model, effectiveOrientation(id)) : null; if (!mm) { return; }
    any = true;
    minX = Math.min(minX, pe.place.x); minY = Math.min(minY, pe.place.y);
    maxX = Math.max(maxX, pe.place.x + mm.w); maxY = Math.max(maxY, pe.place.y + mm.h);
  });
  return any ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
}
function regionFor(id, wall) {
  var pe = store.tiles[id]; if (!pe || !pe.place || !wall || wall.w <= 0 || wall.h <= 0) { return null; }
  var mm = pe.model ? models.screenMm(pe.model, effectiveOrientation(id)) : null; if (!mm) { return null; }
  return { rx: (pe.place.x - wall.x) / wall.w, ry: (pe.place.y - wall.y) / wall.h, rw: mm.w / wall.w, rh: mm.h / wall.h };
}
function splitMsg(id, pid, wall, at, info) {
  var m = { type: 'show', id: pid, img: '/img/' + pid + '?size=preview' };
  if (at) { m.at = at; }
  if (info && (info.date || info.place)) { m.info = info; }
  var r = regionFor(id, wall);
  if (r) { m.split = r; } // placed tiles get their crop; unplaced fall back to the whole image
  return m;
}
function pushSplit(at) {
  if (!poolIds.length) { return; }
  var recentW = picker.recentWindow(poolIds, recentShown);
  var cands = poolIds.filter(function (p) { return p !== engine.splitImg && !recentW[p]; });
  if (!cands.length) { cands = poolIds.filter(function (p) { return p !== engine.splitImg; }); }
  var pid = cands.length ? randomFrom(cands) : randomFrom(poolIds);
  engine.splitImg = pid;
  noteShown(pid);
  var wall = wallBox();
  return immich.getAssetInfo(pid).then(function (info) {
    onlineTileIds().forEach(function (id) { var t = tiles.get(id); if (t) { send(t.ws, splitMsg(id, pid, wall, at, info)); } });
  });
}
function pushSplitOne(id, at) {
  var t = tiles.get(id); if (!t) { return; }
  if (!engine.splitImg) { return pushSplit(at); }
  var pid = engine.splitImg;
  return immich.getAssetInfo(pid).then(function (info) {
    send(t.ws, splitMsg(id, pid, wallBox(), at, info));
  });
}

// --- Phase 6: mirror — ONE separate camera, split live across the wall ---
// Frames arrive from the /camera page over WS; each tile shows its region (reusing
// the split geometry). Immediate (no scheduled `at`), throttled to protect the wall.
const MIRROR_MIN_MS = parseInt(process.env.MIRROR_MIN_MS || '140', 10);
function onCameraFrame(dataUrl) {
  engine.lastFrame = dataUrl;
  if (engine.scene !== 'mirror' || engine.sleeping) { return; }
  var now = Date.now();
  if (now - engine.lastRelay < MIRROR_MIN_MS) { return; } // cap the relay rate
  engine.lastRelay = now;
  var wall = wallBox();
  onlineTileIds().forEach(function (id) {
    var t = tiles.get(id); if (!t) { return; }
    var m = { type: 'frame', img: dataUrl };
    var r = regionFor(id, wall);
    if (r) { m.split = r; }
    send(t.ws, m);
  });
}

// --- 'art' scene: generative visuals instead of photos ---
// The server only picks WHICH artwork + palette shows (tiles render locally, in
// shared wall coordinates + synced clock, so one field spans the whole wall).
// A fixed artwork rotates palettes each cycle so it keeps evolving.
function artSpeed() { return clampNum(engine.config.artSpeed, 1, 0.25, 3); }
function artFixedPal() {
  var p = engine.config.artPalette;
  return (typeof p === 'number' && p >= 0 && p < ART_PALETTES) ? p : null;
}
function pushArt(at) {
  var name = (engine.config.artwork && ARTS.indexOf(engine.config.artwork) !== -1) ? engine.config.artwork : null;
  if (!name) { engine.artIdx = (engine.artIdx + 1) % ARTS.length; name = ARTS[engine.artIdx]; }
  var fixed = artFixedPal();
  engine.artPal = (fixed != null) ? fixed : (engine.artPal + 1) % ART_PALETTES;
  engine.currentArt = name;
  var d = (engine.timing === 'wave') ? waveDelays() : null; // wave: the new artwork sweeps across the wall
  onlineTileIds().forEach(function (id) {
    var t = tiles.get(id); if (!t) { return; }
    var m = { type: 'art', art: name, palette: engine.artPal, speed: artSpeed() };
    if (at) { m.at = at + (d ? (d[id] || 0) : 0); }
    send(t.ws, m);
  });
}
function pushArtOne(id) {
  var t = tiles.get(id); if (!t) { return; }
  if (!engine.currentArt) { return pushArt(); } // first tile in kicks the first artwork
  send(t.ws, { type: 'art', art: engine.currentArt, palette: engine.artPal < 0 ? 0 : engine.artPal, speed: artSpeed() });
}

// --- swap timing ---
// 'sync':    one global interval fires pushAll() — all tiles swap together.
// 'stagger': each tile runs its own timer, jittered ±SLIDE_JITTER around the base.
// 'wave':    one interval, but each tile's swap is delayed by its position so the
//            change sweeps left -> right across the physical wall.
const tileTimers = {};
let syncTimer = null;
function scheduleTile(id) {
  clearTimeout(tileTimers[id]);
  if (engine.slideMs <= 0 || engine.timing !== 'stagger') { return; }
  // coordinated scenes (one wall-wide picture/field/feed) never run per-tile
  // photo timers — a registering tile must not stomp them with a photo later
  if (engine.scene === 'art' || engine.scene === 'split-image' || engine.scene === 'mirror') { return; }
  var factor = 1 + (Math.random() * 2 - 1) * SLIDE_JITTER; // 1 ± jitter
  tileTimers[id] = setTimeout(function () { pushNext(id); scheduleTile(id); }, Math.round(engine.slideMs * factor));
}
function unschedule(id) { clearTimeout(tileTimers[id]); delete tileTimers[id]; }

// Per-tile delay (ms) for a wave sweep, from placement: left->right (x),
// top->bottom (y), or diagonal (x+y) per the configured direction.
function waveDelays() {
  var dir = store.waveDir || 'lr';
  var keyOf = function (pe) {
    if (!pe || !pe.place) { return null; }
    if (dir === 'tb') { return pe.place.y; }
    if (dir === 'diag') { return pe.place.x + pe.place.y; }
    return pe.place.x;
  };
  var ids = onlineTileIds();
  var lo = Infinity, hi = -Infinity;
  ids.forEach(function (id) { var k = keyOf(store.tiles[id]); if (k != null) { lo = Math.min(lo, k); hi = Math.max(hi, k); } });
  if (!isFinite(lo)) { lo = 0; hi = 0; }
  var span = (hi > lo) ? (hi - lo) : 1;
  var out = {};
  ids.forEach(function (id) { var k = keyOf(store.tiles[id]); out[id] = (k == null) ? 0 : Math.round(((k - lo) / span) * WAVE_SPAN); });
  return out;
}
// One coordinated swap across the wall. Every tile is told the SAME server-time
// `at` (a short lead ahead); each converts it to its own clock and flips then, so
// the whole wall changes within a few ms regardless of network jitter. In split
// mode the wall shows one picture; in wave mode the `at` is offset by position.
function runCycle() {
  if (engine.sleeping) { return; } // scheduled night: screens are dark
  if (engine.scene === 'mirror') { return; } // driven by camera frames, not the photo clock
  var lead = Math.min(LEAD_MS, Math.max(300, engine.slideMs - 300)); // never lead longer than the interval
  var at = Date.now() + lead;
  if (engine.scene === 'art') { pushArt(at); return; } // wave handled inside (sweeps the change)
  if (engine.scene === 'split-image') { pushSplit(at); return; }
  // moments: wind the current one down, or start a new one every N changes
  if (engine.moment) { if (--engine.moment.holds < 0) { engine.moment = null; } }
  else if (store.momentsEvery > 0 && ++engine.momentCount >= store.momentsEvery) {
    engine.momentCount = 0;
    tryStartMoment();
  }
  if (engine.timing === 'wave') {
    var d = waveDelays();
    onlineTileIds().forEach(function (id) { pushNext(id, at + (d[id] || 0)); });
  } else {
    pushAll(at);
  }
}
// Immediate refresh after a scene/setting change (respects timing mode).
function kickCycle() {
  if (engine.sleeping) { return; }
  if (engine.scene === 'mirror') { if (engine.lastFrame) { engine.lastRelay = 0; onCameraFrame(engine.lastFrame); } return; }
  if (engine.scene === 'art') { pushArt(); return; } // immediate, no scheduled lead
  if (engine.scene === 'split-image' || engine.timing !== 'stagger') { runCycle(); } else { pushAll(); }
}

// (Re)arm all timers for the current timing mode. Idempotent.
function applyTiming() {
  Object.keys(tileTimers).forEach(function (id) { clearTimeout(tileTimers[id]); delete tileTimers[id]; });
  clearInterval(syncTimer); syncTimer = null;
  if (engine.slideMs <= 0) { return; }
  // split and art always run coordinated (one wall-wide picture/field); otherwise
  // stagger = per-tile timers, sync/wave = one interval
  if (engine.scene !== 'split-image' && engine.scene !== 'art' && engine.timing === 'stagger') { onlineTileIds().forEach(scheduleTile); }
  else { syncTimer = setInterval(runCycle, engine.slideMs); }
}
function setTiming(mode) {
  if (TIMINGS.indexOf(mode) === -1) { return false; }
  engine.timing = mode; store.timing = mode; saveStore();
  applyTiming();
  return true;
}
// Slide interval (seconds): how long each photo shows before the wall changes.
function setSlide(sec) {
  var s = clampNum(sec, engine.slideMs / 1000, 2, 600);
  engine.slideMs = Math.round(s * 1000);
  store.slideSec = s; saveStore();
  applyTiming(); // re-arm timers at the new cadence
  return s;
}

// --- display config — pushed to each tile with ITS wall region, so wall-wide
// effects (particles/fields) render seamlessly across the physical layout ---
function tileConfigMsg(id) {
  var msg = { type: 'config', display: engine.display, region: { rx: 0, ry: 0, rw: 1, rh: 1 }, wallAspect: 0 };
  if (id) {
    var wall = wallBox();
    var r = regionFor(id, wall);
    if (r && wall && wall.h > 0) { msg.region = r; msg.wallAspect = wall.w / wall.h; }
  }
  return msg;
}
function broadcastConfig() { tiles.forEach(function (t, id) { if (t.online) { send(t.ws, tileConfigMsg(id)); } }); }
function setDisplay(patch) {
  engine.display = sanitizeDisplay(patch || {}, engine.display);
  store.display = engine.display; saveStore();
  broadcastConfig();
  applySpotlight();
  return engine.display;
}

// --- spotlight: a highlight hops from tile to tile around the wall ---
let spotTimer = null;
let spotIdx = -1;
function spotlightOrder() {
  // walk by placed x (left -> right), unplaced tiles trail after, ties by id
  return onlineTileIds().sort(function (a, b) {
    var pa = store.tiles[a] && store.tiles[a].place, pb = store.tiles[b] && store.tiles[b].place;
    var xa = pa ? pa.x : Infinity, xb = pb ? pb.x : Infinity;
    if (xa !== xb) { return xa - xb; }
    return a < b ? -1 : 1;
  });
}
function spotlightTick() {
  var order = spotlightOrder();
  if (!order.length) { return; }
  spotIdx = (spotIdx + 1) % order.length;
  var t = tiles.get(order[spotIdx]);
  if (t && t.online) { send(t.ws, { type: 'highlight' }); }
}
function applySpotlight() {
  clearInterval(spotTimer); spotTimer = null;
  if (engine.display.spotlight && SPOT_INTERVAL > 0) { spotIdx = -1; spotTimer = setInterval(spotlightTick, SPOT_INTERVAL); }
}

// Switch scene: persist, re-resolve pools, refresh every tile immediately.
// Returns a promise of the freshly-resolved { pools, info }.
function setScene(scene, config) {
  engine.scene = scene;
  engine.config = config || {};
  engine.moment = null; engine.momentCount = 0; // a new scene starts a fresh rhythm
  store.scene = scene; store.sceneConfig = engine.config; saveStore();
  return resolveScene().then(function (res) {
    applyTiming(); kickCycle();
    return res;
  });
}

// --- daily schedule: the wall runs itself — day scene, evening scene, then
// dark screens overnight. Server local time (set TZ in docker-compose). ---
function minutesOf(hm) { var m = /^(\d{1,2}):(\d{2})$/.exec(hm || ''); return m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : 0; }
function scheduleSlot(now) {
  var s = store.schedule;
  if (!s || !s.on) { return null; }
  var mins = now.getHours() * 60 + now.getMinutes();
  var wake = minutesOf(s.wake), eve = minutesOf(s.evening), sleep = minutesOf(s.sleep);
  var asleep = (sleep > wake) ? (mins >= sleep || mins < wake) : (mins >= sleep && mins < wake);
  if (asleep) { return 'sleep'; }
  if (mins >= eve || mins < wake) { return 'evening'; } // < wake only happens when sleep wraps past midnight
  return 'day';
}
function sleepTiles() {
  engine.sleeping = true;
  console.log('[mosaic] schedule: goodnight — screens dark');
  tiles.forEach(function (t) { if (t.online) { send(t.ws, { type: 'sleep' }); } });
}
function wakeTiles() {
  engine.sleeping = false;
  console.log('[mosaic] schedule: good morning — screens on');
  tiles.forEach(function (t) { if (t.online) { send(t.ws, { type: 'wake' }); } });
}
function applySchedule(force) {
  var slot = scheduleSlot(new Date());
  if (!force && slot === engine.schedSlot) { return; }
  engine.schedSlot = slot;
  if (slot === null) { if (engine.sleeping) { wakeTiles(); kickCycle(); } return; } // schedule turned off
  if (slot === 'sleep') { if (!engine.sleeping) { sleepTiles(); } return; }
  if (engine.sleeping) { wakeTiles(); }
  var target = (slot === 'evening') ? store.schedule.eveScene : store.schedule.dayScene;
  if (scenes.isScene(target) && engine.scene !== target) { setScene(target, {}); } else { kickCycle(); }
}
// On boot only honour an active sleep window; scene changes wait for the next
// boundary so a restart doesn't stomp whatever was chosen manually.
function initSchedule() {
  engine.schedSlot = scheduleSlot(new Date());
  if (engine.schedSlot === 'sleep') { sleepTiles(); }
}
setInterval(applySchedule, 30000);

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
    console.log('[mosaic] pools refreshed (' + poolIds.length + ' in default pool)');
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

function effectiveOrientation(id) {
  var pe = store.tiles[id] || {};
  if (pe.orientation === 'portrait' || pe.orientation === 'landscape') { return pe.orientation; }
  var rt = tiles.get(id);
  return (rt && rt.detectedOrientation) ? rt.detectedOrientation : 'portrait';
}
function identify(deviceId) {
  var t = tiles.get(deviceId);
  if (!t || !t.online) { return false; }
  var pe = store.tiles[deviceId] || {};
  send(t.ws, { type: 'identify', label: pe.name || deviceId });
  return true;
}

// --- registry pruning: drop stale tiles so the list only holds real devices ---
function forgetTile(id) {
  var existed = Object.prototype.hasOwnProperty.call(store.tiles, id) || tiles.has(id);
  delete store.tiles[id];
  tiles.delete(id);
  unschedule(id);
  delete engine.pools[id];
  return existed;
}
function removeOfflineTiles() {
  var ids = {};
  Object.keys(store.tiles).forEach(function (id) { ids[id] = true; });
  tiles.forEach(function (t, id) { ids[id] = true; });
  var removed = 0;
  Object.keys(ids).forEach(function (id) {
    var rt = tiles.get(id);
    if (!(rt && rt.online)) { if (forgetTile(id)) { removed++; } }
  });
  if (removed) { saveStore(); }
  return removed;
}

// --- HTTP ---
function serveFile(res, file, type) {
  fs.readFile(path.join(__dirname, file), function (err, data) {
    if (err) { res.writeHead(500); res.end('error'); return; }
    res.writeHead(200, { 'Content-Type': type }); res.end(data);
  });
}
function sendJson(res, obj, code) { res.writeHead(code || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise(function (resolve) {
    var chunks = []; req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { resolve({}); } });
  });
}

function tileState(id) {
  var rt = tiles.get(id) || {};
  var pe = store.tiles[id] || { name: id, model: null, orientation: null, place: null };
  var orient = effectiveOrientation(id);
  var m = pe.model ? models.byKey(pe.model) : null;
  return {
    id: id,
    name: pe.name,
    online: !!rt.online,
    model: pe.model || null,
    modelName: m ? m.name : null,
    orientationSetting: pe.orientation || 'auto',
    orientation: orient,
    detectedOrientation: rt.detectedOrientation || null,
    nativeW: rt.nativeW || 0,
    nativeH: rt.nativeH || 0,
    dpr: rt.dpr || 1,
    screenMm: pe.model ? models.screenMm(pe.model, orient) : null,
    place: pe.place || null
  };
}
function stateSnapshot() {
  var ids = {};
  Object.keys(store.tiles).forEach(function (id) { ids[id] = true; });
  tiles.forEach(function (t, id) { ids[id] = true; });
  var list = Object.keys(ids).map(tileState);
  // wall bounding box (mm) over placed tiles with a known screen size
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
  list.forEach(function (t) {
    if (t.place && t.screenMm) {
      any = true;
      minX = Math.min(minX, t.place.x); minY = Math.min(minY, t.place.y);
      maxX = Math.max(maxX, t.place.x + t.screenMm.w); maxY = Math.max(maxY, t.place.y + t.screenMm.h);
    }
  });
  var wall = any ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
  return { tiles: list, wall: wall };
}
function sceneSnapshot() {
  // Year spread of what the wall is actually drawing from, so the admin can
  // show the coverage rather than making you watch the wall to judge it.
  var activePool = poolIds;
  var onlineIds = onlineTileIds();
  if (onlineIds.length && engine.pools[onlineIds[0]] && engine.pools[onlineIds[0]].length) {
    activePool = engine.pools[onlineIds[0]];
  }
  var years = {};
  var groups = picker.groupByYear(activePool, immich.takenAt);
  for (var gy in groups) {
    if (Object.prototype.hasOwnProperty.call(groups, gy)) { years[gy] = groups[gy].length; }
  }
  return {
    years: years,
    scenes: scenes.SCENES, active: engine.scene, config: engine.config, info: engine.info,
    timing: engine.timing, timings: TIMINGS, looks: LOOKS, transitions: TRANSITIONS, effects: EFFECTS, artworks: ARTS, artPalettes: ART_PALETTES, display: engine.display,
    slideSec: Math.round((engine.slideMs / 1000) * 10) / 10, camera: engine.cameraOnline,
    waveDir: store.waveDir, waveDirs: WAVE_DIRS, momentsEvery: store.momentsEvery,
    moment: engine.moment ? { count: engine.moment.ids.length, label: engine.moment.label } : null,
    schedule: store.schedule, sleeping: engine.sleeping
  };
}

const server = http.createServer(function (req, res) {
  var u = url.parse(req.url, true);
  var p = u.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (p === '/' || p === '/tile' || p === '/tile.html') { return serveFile(res, 'tile.html', 'text/html; charset=utf-8'); }
  if (p === '/admin' || p === '/admin.html') { return serveFile(res, 'admin.html', 'text/html; charset=utf-8'); }
  if (p === '/camera' || p === '/camera.html') { return serveFile(res, 'camera.html', 'text/html; charset=utf-8'); }
  if (p === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (p === '/status') {
    var online = onlineTileIds().length;
    return sendJson(res, {
      ok: true, uptimeSec: Math.round((Date.now() - START_TS) / 1000),
      tiles: Object.keys(store.tiles).length, online: online,
      scene: engine.scene, timing: engine.timing, pool: poolIds.length, camera: !!engine.cameraOnline
    });
  }

  // --- admin API ---
  if (p === '/api/models') { return sendJson(res, { models: models.MODELS }); }
  if (p === '/api/admin/state') { return sendJson(res, stateSnapshot()); }
  if (p === '/api/admin/showRandom') { kickCycle(); return sendJson(res, { ok: true }); } // "Next now" — respects the active scene
  if (p === '/api/admin/scenes') { return sendJson(res, sceneSnapshot()); }
  if (p === '/api/admin/scene' && req.method === 'POST') {
    return readBody(req).then(function (b) {
      var scene = String(b.scene || '');
      if (!scenes.isScene(scene)) { return sendJson(res, { error: 'unknown scene' }, 400); }
      var cfg = {};
      if (b.personId) { cfg.personId = String(b.personId); }
      if (Array.isArray(b.personIds)) { cfg.personIds = b.personIds.map(String).filter(Boolean); }
      if (typeof b.query === 'string') { cfg.query = b.query; }
      // artwork: a specific piece, or '' / anything unknown = cycle through them all
      if (typeof b.artwork === 'string') { cfg.artwork = (ARTS.indexOf(b.artwork) !== -1) ? b.artwork : ''; }
      // artPalette: pin one of the palettes (0..N-1); '' / invalid = cycle palettes
      if (b.artPalette != null && b.artPalette !== '') {
        var ap = parseInt(b.artPalette, 10);
        if (isFinite(ap) && ap >= 0 && ap < ART_PALETTES) { cfg.artPalette = ap; }
      }
      // artSpeed: animation speed multiplier for the artworks
      if (b.artSpeed != null) { cfg.artSpeed = clampNum(b.artSpeed, 1, 0.25, 3); }
      return setScene(scene, cfg).then(function (resolved) {
        var snap = sceneSnapshot(); snap.info = (resolved && resolved.info) || {};
        sendJson(res, snap);
      });
    });
  }
  if (p === '/api/admin/timing' && req.method === 'POST') {
    return readBody(req).then(function (b) {
      if (b.mode != null && !setTiming(String(b.mode))) { return sendJson(res, { error: 'mode must be sync, stagger or wave' }, 400); }
      if (b.slideSec != null) { setSlide(b.slideSec); }
      if (typeof b.waveDir === 'string' && WAVE_DIRS.indexOf(b.waveDir) !== -1) { store.waveDir = b.waveDir; saveStore(); }
      if (b.momentsEvery != null) { store.momentsEvery = Math.round(clampNum(b.momentsEvery, store.momentsEvery, 0, 50)); engine.momentCount = 0; saveStore(); }
      sendJson(res, sceneSnapshot());
    });
  }
  if (p === '/api/admin/schedule' && req.method === 'POST') {
    return readBody(req).then(function (b) {
      store.schedule = sanitizeSchedule(b || {}, store.schedule);
      saveStore();
      applySchedule(true); // take effect now, not at the next boundary
      sendJson(res, sceneSnapshot());
    });
  }
  if (p === '/api/admin/moment' && req.method === 'POST') {
    var started = tryStartMoment();
    if (started) { engine.momentCount = 0; kickCycle(); }
    return sendJson(res, { ok: started, moment: engine.moment ? { count: engine.moment.ids.length, label: engine.moment.label } : null });
  }
  if (p === '/api/admin/display' && req.method === 'POST') {
    return readBody(req).then(function (b) { setDisplay(b || {}); sendJson(res, sceneSnapshot()); });
  }

  if (p === '/api/admin/tile' && req.method === 'POST') {
    return readBody(req).then(function (b) {
      if (!b.id) { return sendJson(res, { error: 'id required' }, 400); }
      var pe = persistedTile(String(b.id));
      if (typeof b.name === 'string' && b.name.trim()) { pe.name = b.name.trim(); }
      if (typeof b.model === 'string') { pe.model = models.byKey(b.model) ? b.model : pe.model; }
      if (b.orientation === 'auto') { pe.orientation = null; }
      else if (b.orientation === 'portrait' || b.orientation === 'landscape') { pe.orientation = b.orientation; }
      if (b.place === null) { pe.place = null; }
      else if (b.place && typeof b.place.x === 'number' && typeof b.place.y === 'number') {
        pe.place = { x: Math.round(b.place.x * 10) / 10, y: Math.round(b.place.y * 10) / 10 };
      }
      saveStore();
      // placement/model/orientation changes move wall regions — refresh each tile's
      // effect slice, and re-crop the split picture if that scene is active
      broadcastConfig();
      if (engine.scene === 'split-image') { kickCycle(); }
      sendJson(res, stateSnapshot());
    });
  }
  if (p === '/api/admin/identify' && req.method === 'POST') {
    return readBody(req).then(function (b) { sendJson(res, { ok: identify(String(b.id)) }); });
  }
  if (p === '/api/admin/reload' && req.method === 'POST') {
    return readBody(req).then(function (b) {
      var t = tiles.get(String(b.id)); if (t && t.online) { send(t.ws, { type: 'reload' }); } sendJson(res, { ok: !!(t && t.online) });
    });
  }
  if (p === '/api/admin/reloadAll' && req.method === 'POST') {
    var n = 0; tiles.forEach(function (t) { if (t.online) { send(t.ws, { type: 'reload' }); n++; } });
    return sendJson(res, { ok: true, reloaded: n });
  }
  if (p === '/api/admin/removeOffline' && req.method === 'POST') {
    var removed = removeOfflineTiles();
    var snap = stateSnapshot(); snap.removed = removed;
    return sendJson(res, snap);
  }
  if (p === '/api/admin/removeTile' && req.method === 'POST') {
    return readBody(req).then(function (b) {
      if (forgetTile(String(b.id))) { saveStore(); }
      sendJson(res, stateSnapshot());
    });
  }

  // --- content (reused Immich layer) ---
  if (p === '/api/people') { return immich.getPeople().then(function (pp) { sendJson(res, { people: pp }); }).catch(function () { sendJson(res, { people: [] }); }); }
  if (p === '/api/focus') {
    var fid = String(u.query.id || '');
    if (!/^[a-f0-9-]{8,}$/i.test(fid)) { return sendJson(res, { x: 50, y: 50 }); }
    return immich.getFocus(fid).then(function (f) { sendJson(res, f); });
  }
  var imgMatch = p.match(/^\/img\/([a-f0-9-]+)$/);
  if (imgMatch) { var size = u.query.size === 'thumbnail' ? 'thumbnail' : 'preview'; return immich.proxyImage(res, imgMatch[1], size, photoIndex.evict); }

  res.writeHead(404); res.end('Not Found');
});

// --- WebSocket hub ---
const wss = new WebSocketServer({ server: server, path: '/ws' });
function genId() { return 'tile-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }

wss.on('connection', function (ws) {
  var deviceId = null;
  var isCamera = false;
  ws.on('message', function (buf) {
    var msg;
    try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
    if (msg.type === 'register-camera') {
      isCamera = true; engine.cameraOnline = true;
      console.log('[mosaic] camera source connected');
      send(ws, { type: 'welcome-camera', mirror: engine.scene === 'mirror' });
      return;
    }
    if (msg.type === 'camera-frame') {
      if (isCamera && typeof msg.data === 'string') { onCameraFrame(msg.data); }
      return;
    }
    if (msg.type === 'register') {
      deviceId = (msg.deviceId && String(msg.deviceId)) || genId();
      var nativeW = Math.round((msg.screenW || 0) * (msg.dpr || 1));
      var nativeH = Math.round((msg.screenH || 0) * (msg.dpr || 1));
      tiles.set(deviceId, {
        ws: ws, id: deviceId, screenW: msg.screenW || 0, screenH: msg.screenH || 0, dpr: msg.dpr || 1,
        nativeW: nativeW, nativeH: nativeH, detectedOrientation: msg.orientation || 'portrait',
        online: true, lastSeen: Date.now(), lastShow: (tiles.get(deviceId) || {}).lastShow || null
      });
      var pe = persistedTile(deviceId);
      if (!pe.model && nativeW && nativeH) { var g = models.guess(nativeW, nativeH); if (g) { pe.model = g; saveStore(); } }
      console.log('[mosaic] tile registered: ' + deviceId + ' native ' + nativeW + 'x' + nativeH + ' ' + (msg.orientation || '?') + ' model=' + pe.model);
      send(ws, { type: 'welcome', deviceId: deviceId });
      send(ws, tileConfigMsg(deviceId));
      if (engine.sleeping) { send(ws, { type: 'sleep' }); } // scheduled night: stay dark, skip content
      // include this tile in the scene, show something now, and (in stagger mode)
      // start its own timer; in sync mode the global interval already covers it.
      var reg = deviceId;
      resolveScene().then(function () {
        if (engine.sleeping) { return; }
        if (engine.scene === 'mirror') { if (engine.lastFrame) { var w = wallBox(); var r = regionFor(reg, w); var m = { type: 'frame', img: engine.lastFrame }; if (r) { m.split = r; } send(tiles.get(reg).ws, m); } }
        else if (engine.scene === 'split-image') { pushSplitOne(reg); }
        else if (engine.scene === 'art') { pushArtOne(reg); }
        else { pushNext(reg); }
        scheduleTile(reg);
      });
    } else if (msg.type === 'orientation') {
      var rt = tiles.get(deviceId);
      if (rt && (msg.orientation === 'portrait' || msg.orientation === 'landscape')) { rt.detectedOrientation = msg.orientation; }
    } else if (msg.type === 'timesync') {
      // echo the tile's send-time plus our clock so it can estimate the offset
      send(ws, { type: 'timesync', t0: msg.t0, ts: Date.now() });
    } else if (msg.type === 'pong') {
      var t = tiles.get(deviceId); if (t) { t.lastSeen = Date.now(); }
    }
  });
  ws.on('close', function () {
    if (isCamera) { engine.cameraOnline = false; console.log('[mosaic] camera source disconnected'); return; }
    if (deviceId) { var t = tiles.get(deviceId); if (t) { t.online = false; } unschedule(deviceId); console.log('[mosaic] tile offline: ' + deviceId); }
  });
  ws.on('error', function () {});
});

setInterval(function () { tiles.forEach(function (t) { if (t.online) { send(t.ws, { type: 'ping', t: Date.now() }); } }); }, 5000);
// watchdog: drop half-open connections that stopped ponging (WS 'close' never fired)
setInterval(function () {
  var now = Date.now();
  tiles.forEach(function (t) {
    if (t.online && t.lastSeen && (now - t.lastSeen) > STALE_MS) {
      try { t.ws.terminate(); } catch (e) {}
      t.online = false; unschedule(t.id);
      console.log('[mosaic] tile timed out (half-open): ' + t.id);
    }
  });
}, 8000);

loadStore();
engine.scene = scenes.isScene(store.scene) ? store.scene : 'random';
engine.config = store.sceneConfig || {};
engine.timing = (TIMINGS.indexOf(store.timing) !== -1) ? store.timing : 'sync';
engine.display = sanitizeDisplay(store.display || {}, defaultDisplay());
engine.slideMs = Math.round(clampNum(store.slideSec, SLIDE_INTERVAL / 1000, 2, 600) * 1000);
server.listen(PORT, function () {
  console.log('[mosaic] orchestrator running on port ' + PORT);
  console.log('[mosaic] Immich: ' + immich.IMMICH_URL);
  console.log('[mosaic] admin: http://<host>:' + PORT + '/admin');
  console.log('[mosaic] scene: ' + engine.scene + ', timing: ' + engine.timing + ', look: ' + engine.display.look);
  // A background scan finishing means the pool just grew — re-derive it and
  // re-resolve, so the wall draws from the full year range rather than the
  // first page. Re-derives via selectionPool rather than reading the 'library'
  // index directly: with PERSON_IDS set the default pool is a union of person
  // indexes, and those complete independently.
  photoIndex.onUpdate(function () {
    photoIndex.selectionPool([]).then(function (ids) {
      if (ids && ids.length) { poolIds = ids; }
      return resolveScene();
    }).catch(function (err) { console.error('[mosaic] pool re-derive failed: ' + err.message); });
  });
  photoIndex.init().then(ensurePool).then(resolveScene).then(applyTiming);
  applySpotlight();
  initSchedule();
});

// Persist the index before dying, so a restart doesn't rescan 200k photos.
function shutdown() { photoIndex.flush().then(function () { process.exit(0); }); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
server.on('error', function (err) { console.error('[mosaic] server error: ' + err.message); process.exit(1); });
