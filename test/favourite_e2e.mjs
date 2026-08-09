// Tap-to-favourite end to end: real server.js + real headless-Chrome tile, with
// a mock Immich standing in for the photo library and albums API. Verifies the
// whole path — tap opens the menu, ♥ sends favourite over the WS, the server
// creates "Frame favourites" and PUTs the asset, the tile shows the ✓ — plus
// the failure path. Not in the npm test loop (spawns Chrome), like the other
// live/e2e tiers. Run: node test/favourite_e2e.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const IMMICH_PORT = 4199, APP_PORT = 4123, CDP_PORT = 9231;
const APP = `http://localhost:${APP_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

// --- mock Immich ---
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
// ids must be hex+dash like real Immich uuids — the /img route regex insists
const ASSETS = [
  { id: 'e2e00001-aaaa-bbbb-cccc-000000000001', localDateTime: '2019-04-05T10:00:00Z' },
  { id: 'e2e00002-aaaa-bbbb-cccc-000000000002', localDateTime: '2021-08-12T10:00:00Z' },
  { id: 'e2e00003-aaaa-bbbb-cccc-000000000003', localDateTime: '2023-01-20T10:00:00Z' }
];
const mock = { albums: [], albumPosts: [], putIds: [], failPut: false };
const immichMock = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', () => {
    const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (p === '/api/search/metadata' || p === '/api/search/smart') { return json(200, { assets: { total: ASSETS.length, count: ASSETS.length, items: ASSETS } }); }
    if (p === '/api/people') { return json(200, { people: [] }); }
    if (p === '/api/assets/memory-lane') { return json(200, []); }
    if (p === '/api/faces') { return json(200, []); }
    let m = p.match(/^\/api\/assets\/([^/]+)\/thumbnail$/);
    if (m) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
    m = p.match(/^\/api\/assets\/([^/]+)$/);
    if (m) { return json(200, { id: m[1], localDateTime: '2019-04-05T10:00:00Z', exifInfo: { city: 'Melbourne', country: 'Australia' } }); }
    if (p === '/api/albums' && req.method === 'GET') { return json(200, mock.albums); }
    if (p === '/api/albums' && req.method === 'POST') {
      const b = JSON.parse(Buffer.concat(body).toString());
      mock.albumPosts.push(b.albumName);
      const a = { id: 'fav-alb-1', albumName: b.albumName };
      mock.albums.push(a);
      return json(201, a);
    }
    m = p.match(/^\/api\/albums\/([^/]+)\/assets$/);
    if (m && req.method === 'PUT') {
      const b = JSON.parse(Buffer.concat(body).toString());
      mock.putIds.push(b.ids[0]);
      if (mock.failPut) { return json(200, [{ id: b.ids[0], success: false, error: 'not_found' }]); }
      return json(200, [{ id: b.ids[0], success: true }]);
    }
    json(404, {});
  });
});

// --- CDP plumbing (as in scene_live.mjs) ---
async function pageWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const pg = t.find((x) => x.type === 'page' && x.url.includes('/tile'));
      if (pg?.webSocketDebuggerUrl) return pg.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('no CDP target');
}
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 1; const pend = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } });
  const ready = new Promise((r) => ws.addEventListener('open', () => r()));
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = id++; pend.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  return { ready, send, close: () => ws.close() };
}
const evalIn = async (c, expr) => (await c.send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
async function tapAt(c, x, y) {
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
async function waitFor(c, expr, ms = 8000, step = 200) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await evalIn(c, expr)) return true; await sleep(step); }
  return false;
}

async function run() {
  await new Promise((r) => immichMock.listen(IMMICH_PORT, r));
  const dataDir = mkdtempSync(join(tmpdir(), 'fav-e2e-'));
  const server = spawn('node', ['server.js'], {
    env: { ...process.env, IMMICH_URL: `http://127.0.0.1:${IMMICH_PORT}`, IMMICH_API_KEY: 'e2e-test', PORT: String(APP_PORT), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const serverLog = [];
  server.stdout.on('data', (d) => serverLog.push(d.toString()));
  server.stderr.on('data', (d) => serverLog.push(d.toString()));
  const profile = mkdtempSync(join(tmpdir(), 'fav-e2e-chrome-'));
  let chrome = null, c = null;
  try {
    // wait for the app to answer
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { try { await fetch(APP + '/api/admin/state'); up = true; } catch { await sleep(250); } }
    if (!up) { throw new Error('server did not start:\n' + serverLog.join('')); }

    chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--window-size=768,1024', `${APP}/tile`], { stdio: 'ignore' });
    c = cdp(await pageWs());
    await c.ready;
    await c.send('Runtime.enable');

    // a real photo slide is on the glass with its asset id attached
    const gotPhoto = await waitFor(c, `window.__mw && window.__mw.src && window.__mw.src.indexOf('/img/') === 0`, 15000);
    check('tile shows a photo', gotPhoto, gotPhoto ? '' : serverLog.join('').slice(-500));
    await sleep(400); // let the slide finish becoming currentSlide

    // tap opens the menu with caption + ♥
    await tapAt(c, 380, 400);
    const menuUp = await waitFor(c, `document.getElementById('menu').className.indexOf('show') !== -1`, 2000);
    check('tap opens the menu', menuUp);
    check('menu offers the favourite button', await evalIn(c, `document.getElementById('menu').className.indexOf('hasfav') !== -1`));
    check('menu shows the caption', await evalIn(c, `document.getElementById('mcap').textContent.length > 0`), await evalIn(c, `document.getElementById('mcap').textContent`));

    // ♥ round-trip: album created, asset added, ✓ shown
    const fav = await evalIn(c, `(function(){var r=document.getElementById('fav').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
    await tapAt(c, fav.x, fav.y);
    const done = await waitFor(c, `document.getElementById('fav').className === 'done'`, 6000);
    check('favourite confirms on the tile', done, await evalIn(c, `document.getElementById('fav').innerHTML`));
    check('tile shows the ✓ copy', await evalIn(c, `document.getElementById('fav').innerHTML.indexOf('Added to Frame favourites') !== -1`));
    check('album was created by name', mock.albumPosts.join(',') === 'Frame favourites', mock.albumPosts.join(','));
    check('the shown asset was added', mock.putIds.length === 1 && ASSETS.some((a) => a.id === mock.putIds[0]), mock.putIds.join(','));

    // shade tap closes without reopening
    await tapAt(c, 10, 10);
    await sleep(300);
    check('outside tap closes the menu', await evalIn(c, `document.getElementById('menu').className === ''`));

    // failure path: Immich rejects the add → visible error, retry stays available
    mock.failPut = true;
    await tapAt(c, 380, 400);
    await waitFor(c, `document.getElementById('menu').className.indexOf('show') !== -1`, 2000);
    const fav2 = await evalIn(c, `(function(){var r=document.getElementById('fav').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
    await tapAt(c, fav2.x, fav2.y);
    const errShown = await waitFor(c, `document.getElementById('fav').className === 'err'`, 6000);
    check('failed add shows the error state', errShown, await evalIn(c, `document.getElementById('fav').innerHTML`));
    check('error copy invites retry', await evalIn(c, `document.getElementById('fav').innerHTML.indexOf('try again') !== -1`));
    check('retry button is not disabled', await evalIn(c, `document.getElementById('fav').disabled === false`));
  } finally {
    if (c) { try { c.close(); } catch {} }
    if (chrome) { chrome.kill('SIGKILL'); }
    server.kill('SIGKILL');
    immichMock.close();
  }
  console.log(results.every(Boolean) ? '\nALL PASS' : '\nFAILURES');
  process.exit(results.every(Boolean) ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(1); });
