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
