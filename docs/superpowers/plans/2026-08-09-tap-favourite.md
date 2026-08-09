# Tap-to-Favourite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tap a photo on an iPad tile → small modal → ♥ adds the photo to the Immich album "Frame favourites"; plus `docs/POWER.md` documenting the iPad battery fixes.

**Architecture:** The tile remembers each slide's Immich asset id and sends `{type:'favourite', id}` over the existing WebSocket; the server validates and calls a new `addToFavourites()` helper in `immich.js` (find-or-create album by name, cached id, duplicate-add counts as success), replying `{type:'favourited', id, ok}`. No new HTTP endpoints, no new dependencies.

**Tech Stack:** Node.js (no framework), `ws`, plain ES5 browser JS (old iOS Safari on A7/A9 iPads). Tests are plain `.mjs` scripts run by `npm test` (no test framework).

**Spec:** `docs/superpowers/specs/2026-08-09-tap-favourite-design.md`

## Global Constraints

- All `tile.html` code must be ES5 and old-Safari safe: `var` only, no arrow functions, no template literals, no `let`/`const`, `-webkit-` prefixes alongside standard CSS properties.
- No new npm dependencies. No new HTTP endpoints — the favourite flow rides the existing `/ws` WebSocket.
- Album name: `process.env.FAVOURITES_ALBUM || 'Frame favourites'` — exact string `Frame favourites`.
- Server-side id validation: `typeof id === 'string' && id.length <= 64 && /^[a-f0-9-]+$/i.test(id)`.
- `addToFavourites` resolves `true`/`false` — it must **never reject** (the WS handler does not catch).
- The helper must issue requests through the swappable `requestImpl` (not `immichRequest` directly), or the `_setRequest` test hook can't intercept it.
- Tile button copy, verbatim: `♡ Add to favourites` → `Adding…` → `✓ Added to Frame favourites` / `Couldn't add — try again`.
- Run `npm test` before every commit; every test file must end `ALL PASS`.

---

### Task 1: `addToFavourites` helper in `immich.js`

**Files:**
- Modify: `immich.js` (helper after `getAssetInfo`, ~line 230; export in the `module.exports` block at ~line 299)
- Create: `test/favourites.mjs`
- Modify: `package.json:9` (add `test/favourites.mjs` to the test loop)

**Interfaces:**
- Consumes: the module-private `requestImpl` / `_setRequest(fn)` transport hook that already exists in `immich.js` (see `test/paginate.mjs` for usage).
- Produces: `immich.addToFavourites(assetId) -> Promise<boolean>` — Task 2's server handler calls exactly this.

- [ ] **Step 1: Write the failing test**

Create `test/favourites.mjs` (conventions copied from `test/paginate.mjs`: `createRequire`, a `check()` collector, exit code from results):

```js
// addToFavourites: resolves the "Frame favourites" album by name (creating it
// when absent), caches the id, adds assets idempotently, retries once when the
// cached album has been deleted, and never rejects.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const immich = require('../immich.js');

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

// Fake Immich albums API. opts.albums = [{id, albumName}], opts.putResult(assetId) -> per-id result.
function fakeImmich(opts) {
  const albums = (opts.albums || []).slice();
  const calls = [];
  return {
    calls, albums,
    request(apiPath, method, body) {
      calls.push((method || 'GET') + ' ' + apiPath);
      if (opts.down) { return Promise.reject(new Error('connect ECONNREFUSED')); }
      if (apiPath === '/api/albums' && (!method || method === 'GET')) { return Promise.resolve(albums.slice()); }
      if (apiPath === '/api/albums' && method === 'POST') {
        const a = { id: 'created-1', albumName: body.albumName };
        albums.push(a);
        return Promise.resolve(a);
      }
      const m = apiPath.match(/^\/api\/albums\/([^/]+)\/assets$/);
      if (m && method === 'PUT') {
        if (!albums.some((a) => a.id === m[1])) { return Promise.reject(new Error('Immich API error 404 for ' + apiPath)); }
        return Promise.resolve([opts.putResult(body.ids[0])]);
      }
      return Promise.reject(new Error('unexpected ' + (method || 'GET') + ' ' + apiPath));
    }
  };
}

async function run() {
  // --- no album yet: GET finds nothing, POST creates, PUT adds (module cache starts empty)
  let fake = fakeImmich({ albums: [], putResult: (id) => ({ id, success: true }) });
  immich._setRequest(fake.request);
  let ok = await immich.addToFavourites('aaaa-1111');
  check('creates the album when absent, then adds', ok === true, fake.calls.join(' | '));
  check('create flow is GET, POST, PUT', fake.calls.join(',') === 'GET /api/albums,POST /api/albums,PUT /api/albums/created-1/assets', fake.calls.join(','));

  // --- second add: cached album id, one PUT only
  fake.calls.length = 0;
  ok = await immich.addToFavourites('aaaa-2222');
  check('cached id skips album lookup', ok === true && fake.calls.length === 1, fake.calls.join(','));

  // --- duplicate add counts as success
  fake = fakeImmich({ albums: [{ id: 'created-1', albumName: 'Frame favourites' }], putResult: (id) => ({ id, success: false, error: 'duplicate' }) });
  immich._setRequest(fake.request);
  ok = await immich.addToFavourites('aaaa-1111');
  check('duplicate counts as success', ok === true, fake.calls.join(','));

  // --- other per-id failures are false
  fake = fakeImmich({ albums: [{ id: 'created-1', albumName: 'Frame favourites' }], putResult: (id) => ({ id, success: false, error: 'not_found' }) });
  immich._setRequest(fake.request);
  ok = await immich.addToFavourites('gone-0000');
  check('non-duplicate per-id error is false', ok === false, fake.calls.join(','));

  // --- cached album deleted: PUT 404s, cache drops, re-resolve finds the new album, retry succeeds
  fake = fakeImmich({ albums: [{ id: 'alb-2', albumName: 'Frame favourites' }, { id: 'x', albumName: 'Holiday' }], putResult: (id) => ({ id, success: true }) });
  immich._setRequest(fake.request);
  ok = await immich.addToFavourites('bbbb-3333');
  check('deleted album re-resolves and retries once', ok === true, fake.calls.join(','));
  check('retry flow is PUT(stale), GET, PUT(fresh)', fake.calls.join(',') === 'PUT /api/albums/created-1/assets,GET /api/albums,PUT /api/albums/alb-2/assets', fake.calls.join(','));

  // --- Immich unreachable: resolves false, never throws
  fake = fakeImmich({ albums: [], down: true, putResult: () => ({}) });
  immich._setRequest(fake.request);
  ok = await immich.addToFavourites('cccc-4444');
  check('transport failure resolves false', ok === false);

  immich._setRequest(null);
  console.log(results.every(Boolean) ? '\nALL PASS' : '\nFAILURES');
  process.exit(results.every(Boolean) ? 0 : 1);
}
run();
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/favourites.mjs`
Expected: crash with `TypeError: immich.addToFavourites is not a function`

- [ ] **Step 3: Implement the helper in `immich.js`**

Insert after the `getAssetInfo` function (before `clearListCaches`):

```js
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
```

Add to `module.exports`:

```js
  addToFavourites: addToFavourites,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/favourites.mjs`
Expected: every line `PASS`, final `ALL PASS`, exit 0

- [ ] **Step 5: Add to the suite and run everything**

In `package.json`, extend the `test` script's file list with `test/favourites.mjs` (after `test/people_rotation.mjs`):

```
for f in test/paginate.mjs test/scenes.mjs test/index_scan.mjs test/index_persist.mjs test/index_delta.mjs test/spread.mjs test/smart_years.mjs test/people_rotation.mjs test/favourites.mjs; do echo "--- $f"; node $f || exit 1; done
```

Run: `npm test`
Expected: every file `ALL PASS`

- [ ] **Step 6: Commit**

```bash
git add immich.js test/favourites.mjs package.json
git commit -m "immich: addToFavourites — find-or-create album, idempotent add"
```

---

### Task 2: `favourite` message handler in `server.js`

**Files:**
- Modify: `server.js` — the WS message switch inside `wss.on('connection', ...)`; add a branch after the `pong` branch (~line 936)

**Interfaces:**
- Consumes: `immich.addToFavourites(assetId) -> Promise<boolean>` from Task 1 (never rejects).
- Produces: WS protocol used by Task 3 — tile sends `{type:'favourite', id}`; server replies on the same socket `{type:'favourited', id, ok}`.

- [ ] **Step 1: Add the handler branch**

In `server.js`, the message switch currently ends:

```js
    } else if (msg.type === 'pong') {
      var t = tiles.get(deviceId); if (t) { t.lastSeen = Date.now(); }
    }
```

Extend it to:

```js
    } else if (msg.type === 'pong') {
      var t = tiles.get(deviceId); if (t) { t.lastSeen = Date.now(); }
    } else if (msg.type === 'favourite') {
      // add the photo on this tile's glass to the favourites album; the tile
      // sends the id it is actually displaying (swaps can be scheduled ahead,
      // so lastShow may already point at the next photo)
      if (!deviceId) { return; }
      if (typeof msg.id !== 'string' || msg.id.length > 64 || !/^[a-f0-9-]+$/i.test(msg.id)) { return; }
      var fid = msg.id;
      immich.addToFavourites(fid).then(function (ok) {
        console.log('[mosaic] favourite ' + fid + ' from ' + deviceId + ': ' + (ok ? 'ok' : 'FAILED'));
        send(ws, { type: 'favourited', id: fid, ok: !!ok });
      });
    }
```

(`send()` already guards `readyState`, so a socket that closed while Immich was slow is safe.)

- [ ] **Step 2: Syntax-check and run the suite**

Run: `node --check server.js && npm test`
Expected: no syntax error; every file `ALL PASS`

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "server: favourite WS message -> addToFavourites, favourited reply"
```

---

### Task 3: Tap modal in `tile.html`

**Files:**
- Modify: `tile.html` — CSS block (~lines 75-80), body markup (~line 90), the `showImage` function (~line 825), the tap-to-peek section (~lines 942-953), and the `ws.onmessage` switch (~line 1026)

**Interfaces:**
- Consumes: `show` messages already carry `msg.id` (the Immich asset id — set in both `pushNext` and `splitMsg` in `server.js`); the `{type:'favourited', id, ok}` reply from Task 2.
- Produces: sends `{type:'favourite', id}` (Task 2's expected shape). Slides gain `slide.__id` alongside the existing `slide.__cap`.

- [ ] **Step 1: Replace the caption CSS with the menu CSS**

Delete the `#cap` rule block:

```css
    /* tap-to-see caption: when and where the photo was taken */
    #cap { position: absolute; left: 10px; bottom: 10px; z-index: 6; max-width: 82%;
      color: #fff; font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: rgba(0,0,0,0.55); padding: 5px 10px; border-radius: 7px;
      opacity: 0; -webkit-transition: opacity 0.3s; transition: opacity 0.3s; pointer-events: none; }
    #cap.show { opacity: 1; }
```

and put in its place:

```css
    /* tap menu: caption + add-to-favourites (replaces the old caption-only peek).
       The shade catches outside taps; the card sits above it. Below #sleep isn't
       needed — openMenu() refuses while sleeping. */
    #shade { position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 10; display: none; }
    #menu { position: absolute; left: 50%; bottom: 26px; z-index: 11; display: none;
      -webkit-transform: translateX(-50%); transform: translateX(-50%);
      width: 78%; max-width: 340px; text-align: center;
      background: rgba(18,18,22,0.93); color: #fff; border-radius: 14px; padding: 14px;
      font: 500 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      box-shadow: 0 8px 28px rgba(0,0,0,0.55); }
    #shade.show, #menu.show { display: block; }
    #mcap { opacity: 0.75; font-size: 13px; margin-bottom: 10px; }
    #mcap:empty { display: none; }
    #fav { display: none; width: 100%; -webkit-appearance: none; appearance: none;
      font: 600 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      color: #fff; background: #b8405f; border: none; border-radius: 10px; padding: 12px 10px; }
    #menu.hasfav #fav { display: block; }
    #fav.done { background: #2e7d4f; }
    #fav.err { background: #8a3434; }
```

- [ ] **Step 2: Replace the caption markup with the menu markup**

Replace `<div id="cap"></div>` with:

```html
  <div id="shade"></div>
  <div id="menu"><div id="mcap"></div><button id="fav" type="button"></button></div>
```

- [ ] **Step 3: Swap the element handles**

Remove `var capEl = document.getElementById('cap');` and add in its place:

```js
      var shadeEl = document.getElementById('shade');
      var menuEl = document.getElementById('menu');
      var mcapEl = document.getElementById('mcap');
      var favEl = document.getElementById('fav');
```

- [ ] **Step 4: Remember the asset id on each slide**

`showImage` gains a trailing `id` parameter:

```js
      function showImage(imgUrl, focusX, focusY, at, split, info, id) {
```

and inside its `commit()`, right after the `slide.__cap` assignment block, add:

```js
          if (id) { slide.__id = id; } // for tap-to-favourite; art/mirror slides have none
```

Update the call site in `ws.onmessage`:

```js
          } else if (msg.type === 'show') {
            showImage(msg.img, msg.focusX, msg.focusY, msg.at, msg.split, msg.info, msg.id);
```

- [ ] **Step 5: Replace the tap-to-peek section with the menu logic**

Replace the whole section from the comment `/* ---- tap to peek: link-status dot + the photo's caption (kiosk stays clean) ---- */` down to (and including) the `document.addEventListener('mousedown', peekStatus, false);` line with:

```js
      /* ---- tap menu: link-status dot + caption + add-to-favourites ---- */
      var linkUp = false, dotVisible = false;
      var menuTimer = null, favTimer = null, favBusy = false, favId = null;
      function renderDot() { dot.className = (linkUp ? 'on' : '') + (dotVisible ? ' show' : ''); }
      function menuOpen() { return menuEl.className.indexOf('show') !== -1; }
      function armMenu(ms) { clearTimeout(menuTimer); menuTimer = setTimeout(closeMenu, ms); }
      function openMenu() {
        if (sleepEl.className === 'on') { return; } // stay dark during scheduled night
        dotVisible = true; renderDot();
        mcapEl.textContent = (currentSlide && currentSlide.__cap) || '';
        favId = (currentSlide && currentSlide.__id) || null;
        favBusy = false; clearTimeout(favTimer);
        favEl.className = ''; favEl.disabled = false;
        favEl.innerHTML = '&#9825; Add to favourites';
        menuEl.className = 'show' + (favId ? ' hasfav' : '');
        shadeEl.className = 'show';
        armMenu(8000);
      }
      function closeMenu() {
        clearTimeout(menuTimer); clearTimeout(favTimer);
        menuEl.className = ''; shadeEl.className = '';
        favBusy = false; favId = null;
        dotVisible = false; renderDot();
      }
      function favResult(ok) {
        clearTimeout(favTimer); favBusy = false;
        favEl.className = ok ? 'done' : 'err';
        if (ok) { favEl.disabled = true; favEl.innerHTML = '&#10003; Added to Frame favourites'; }
        else { favEl.innerHTML = 'Couldn&rsquo;t add &mdash; try again'; }
        armMenu(ok ? 2500 : 8000);
      }
      favEl.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (!favId || favBusy || favEl.disabled) { return; }
        favBusy = true;
        favEl.className = ''; favEl.innerHTML = 'Adding&hellip;';
        favTimer = setTimeout(function () { if (menuOpen()) { favResult(false); } }, 4000);
        if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ type: 'favourite', id: favId })); }
        else { favResult(false); }
        armMenu(8000);
      }, false);
      function onShadeTap(ev) { ev.preventDefault(); ev.stopPropagation(); closeMenu(); }
      shadeEl.addEventListener('touchstart', onShadeTap, false);
      shadeEl.addEventListener('mousedown', onShadeTap, false);
      function onGlobalTap() { if (!menuOpen()) { openMenu(); } }
      document.addEventListener('touchstart', onGlobalTap, false);
      document.addEventListener('mousedown', onGlobalTap, false);
```

Note: the old `dotTimer` variable disappears with this replacement (the menu timer owns dismissal now). `renderDot()` and `linkUp` keep their names — the `connect()` handlers that call them are untouched.

- [ ] **Step 6: Handle the reply in `ws.onmessage`**

Add a branch after the `identify` branch:

```js
          } else if (msg.type === 'favourited') {
            if (menuOpen() && favBusy && msg.id === favId) { favResult(!!msg.ok); }
```

- [ ] **Step 7: Check for leftovers and syntax**

Run: `grep -n "capEl\|peekStatus\|dotTimer" tile.html`
Expected: no matches.

Run: `node --check server.js && npm test`
Expected: all pass (tile.html has no node check; the grep plus a browser smoke test in Task 5 cover it).

- [ ] **Step 8: Commit**

```bash
git add tile.html
git commit -m "tile: tap menu with add-to-favourites"
```

---

### Task 4: `docs/POWER.md`

**Files:**
- Create: `docs/POWER.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Write the doc**

```markdown
# iPad power notes

The iPad 5 units can drain faster than they charge — gradual loss through the
day, then shutdown. The levers that actually work are below. Software
"brightness" is **not** one of them: these iPads have LCD panels, where the
backlight burns the same power no matter how dark the pixels are painted, so a
CSS `brightness()` filter (what a web page can do) changes the look, not the
draw. iOS Safari also exposes no Battery API, so the wall cannot monitor or
react to charge levels — schedules are the only automation available.

## 1. Fix the charge rate (biggest win)

An iPad 5 charges over Lightning at **12W maximum (5V × 2.4A)**, and that
current has to be negotiated end-to-end. The wattage of the wall brick beyond
12W is irrelevant. The flat low-profile Lightning adapters currently in use
have been observed passing **~8W** — the adapter, not the brick or cable, is
the throttle, and 8W is close to what the screen-on iPad burns.

**Verify:** same iPad, genuine (or known-good 2.4A) cable plugged straight in,
no adapter. Compare charge wattage via an inline USB meter, or watch
Settings → Battery for the charging-rate difference over an hour.

**Fix:** source flat adapters explicitly rated for 2.4A passthrough, or
re-route so a full cable reaches the port directly.

## 2. Drop the backlight on a schedule

The backlight is the single largest consumer. On each iPad, create two
Shortcuts **personal automations** (Shortcuts app → Automation → Time of Day,
"Run Immediately"):

- At the wall's sleep time: **Set Brightness → 0%.**
- At wake time: **Set Brightness →** whatever the room needs (50–70%).

This is real backlight control, works under Guided Access, and pairs with the
wall's scheduled sleep scene (which blacks the pixels but cannot touch the
backlight). With the backlight at 0% overnight, even an 8W feed catches up by
morning.

Also worth setting once per iPad: Settings → Display & Brightness →
auto-brightness off (so ambient light doesn't push it back up), and the lowest
daytime brightness the room tolerates.

## 3. If it's still not enough

The tile page itself does continuous GPU/CPU work (Ken Burns, effects layers,
generative art, crossfades). An "eco mode" that disables those during set
hours was considered and deliberately deferred — see the out-of-scope list in
`docs/superpowers/specs/2026-08-09-tap-favourite-design.md`. Revisit if the
adapter fix plus the brightness schedule doesn't hold charge.
```

- [ ] **Step 2: Commit**

```bash
git add docs/POWER.md
git commit -m "docs: iPad power notes — charge rate, backlight schedule"
```

---

### Task 5: End-to-end verification (manual, real hardware)

**Files:** none — verification only.

- [ ] **Step 1: Local smoke test in a desktop browser**

Start the server pointing at the real Immich (env vars as in `docker-compose.yml`), open `http://localhost:<port>/tile.html`:

- Click once → card appears with caption + "♡ Add to favourites"; status dot appears.
- Click ♥ → "✓ Added to Frame favourites" within a second; card auto-dismisses ~2.5s later.
- Open Immich → the album "Frame favourites" exists and contains the photo.
- Click ♥ on the same photo again (next appearance) → still "✓" (duplicate is success).
- Click outside the card → dismisses. No click for 8s → dismisses.
- Switch the admin scene to `art` → tap shows the artwork title, no ♥ button.
- Stop Immich (or break `IMMICH_URL`) → ♥ shows "Couldn't add — try again" after ~4s.

- [ ] **Step 2: On an actual iPad tile**

Same checks as above by touch, confirming the old-Safari code path (ES5, touch events) behaves: tap opens, ♥ adds, shade-tap dismisses.

- [ ] **Step 3: Deploy** — rebuild/restart per the usual `docker-compose` flow (tile.html, server.js, immich.js are already in the image's COPY list; no Dockerfile change needed). iPads pick the new page up on their 6-hourly self-reload, or immediately via the admin reload action.
