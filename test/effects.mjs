// Artistic wall-wide effects: API validation/clamping + effects list in the
// scene snapshot + a real tile running the Canvas 2D effect engine (painting
// pixels, ~30fps RAF loop, region/wallAspect delivered on placement, and the
// overlay hiding when the effect is off). Restores all prior settings.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP = 'http://localhost:4000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const getJson = (p) => fetch(APP + p).then((r) => r.json());
const post = (p, b) => fetch(APP + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

function launch(port) {
  const profile = mkdtempSync(join(tmpdir(), `fx-${port}-`));
  return spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=768,1024', `${APP}/tile`], { stdio: 'ignore' });
}
async function pageWs(port) {
  for (let i = 0; i < 40; i++) { try { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const pg = t.find((x) => x.type === 'page' && x.url.includes('/tile')); if (pg?.webSocketDebuggerUrl) return pg.webSocketDebuggerUrl; } catch {} await sleep(250); }
  throw new Error('no target ' + port);
}
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 1; const pend = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } });
  const ready = new Promise((r) => ws.addEventListener('open', () => r()));
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = id++; pend.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  return { ready, send };
}
const ev = (c, expr) => c.send('Runtime.evaluate', { expression: expr, returnByValue: true }).then((x) => x.result.value);
const fx = (c) => ev(c, 'window.__fx || null');
// count canvas pixels with non-zero alpha (our own drawing => untainted, readable)
const painted = (c) => ev(c, "(function(){var el=document.getElementById('fx');if(!el||!el.width)return -1;var x=el.getContext('2d');var d=x.getImageData(0,0,el.width,el.height).data;var nz=0;for(var i=3;i<d.length;i+=4){if(d[i]>0)nz++;}return nz;})()");
const disp = (c) => ev(c, "document.getElementById('fx').style.display");

const procs = [];
const created = [];
let saved = null;
try {
  saved = await getJson('/api/admin/scenes');

  // ---- API: effect validation + clamping ----
  let r = await post('/api/admin/display', { effect: 'snow' });
  check('effect set to snow', r.display.effect === 'snow', 'effect=' + r.display.effect);
  r = await post('/api/admin/display', { effect: 'not-a-real-effect' });
  check('invalid effect rejected (stays snow)', r.display.effect === 'snow', 'effect=' + r.display.effect);
  r = await post('/api/admin/display', { effectDensity: 5 });
  check('density clamps to max 2', r.display.effectDensity === 2, 'd=' + r.display.effectDensity);
  r = await post('/api/admin/display', { effectDensity: 0.05 });
  check('density clamps to min 0.2', r.display.effectDensity === 0.2, 'd=' + r.display.effectDensity);

  // ---- effects list is advertised to the admin ----
  const snap = await getJson('/api/admin/scenes');
  check('scene snapshot lists effects', Array.isArray(snap.effects) && snap.effects.indexOf('aurora') !== -1 && snap.effects.indexOf('none') !== -1, JSON.stringify(snap.effects));

  // ---- a real tile runs the engine ----
  await post('/api/admin/display', { effect: 'none', effectDensity: 1 });
  procs.push(launch(9498));
  const c = cdp(await pageWs(9498)); await c.ready; await c.send('Runtime.enable');
  let idA = null;
  for (let i = 0; i < 60; i++) { idA = await ev(c, "window.localStorage.getItem('mosaic_device_id')"); if (idA) break; await sleep(250); }
  created.push(idA);
  await post('/api/admin/tile', { id: idA, place: null }); // unplaced => full-wall field on this tile (robust vs other placed tiles)
  await sleep(400);

  // effect off => overlay hidden, no RAF
  await post('/api/admin/display', { effect: 'none' });
  await sleep(300);
  check('overlay hidden when effect off', (await disp(c)) === 'none', 'display=' + (await disp(c)));

  // turn snow on => canvas visible + painting + RAF advancing
  await post('/api/admin/display', { effect: 'snow', effectDensity: 1.5 });
  let f = null;
  for (let i = 0; i < 40; i++) { f = await fx(c); if (f && f.effect === 'snow' && f.frames > 2) break; await sleep(150); }
  check('tile picks up snow effect', !!f && f.effect === 'snow', f ? 'effect=' + f.effect : 'no __fx');
  check('overlay visible when effect on', (await disp(c)) === 'block');
  const framesA = (await fx(c)).frames;
  await sleep(400);
  const framesB = (await fx(c)).frames;
  check('RAF loop is advancing frames', framesB > framesA, `${framesA} -> ${framesB}`);
  const nzSnow = await painted(c);
  check('snow paints pixels onto the canvas', nzSnow > 0, 'nonzero-alpha px=' + nzSnow);

  // glass exercises the offscreen caustic buffer path
  await post('/api/admin/display', { effect: 'glass' });
  let nzGlass = 0;
  for (let i = 0; i < 40; i++) { const g = await fx(c); nzGlass = await painted(c); if (g && g.effect === 'glass' && nzGlass > 0) break; await sleep(150); }
  check('glass (caustics) paints pixels', nzGlass > 0, 'nonzero-alpha px=' + nzGlass);

  // placement delivers this tile's wall region + aspect for seamless fields
  await post('/api/admin/tile', { id: idA, model: 'ipad-mini-2', orientation: 'portrait', place: { x: 0, y: 0 } });
  let placed = null;
  for (let i = 0; i < 30; i++) { placed = await fx(c); if (placed && placed.wallAspect > 0) break; await sleep(150); }
  check('placement pushes wall region + aspect to the tile', !!placed && placed.wallAspect > 0 && placed.region && placed.region.rw > 0 && placed.region.rw <= 1, placed ? `aspect=${placed.wallAspect} rw=${placed.region.rw}` : 'no __fx');

  // turning it off again stops the overlay
  await post('/api/admin/display', { effect: 'none' });
  await sleep(300);
  check('overlay hidden again when turned off', (await disp(c)) === 'none');

} catch (e) {
  console.error('TEST ERROR:', e.message);
  results.push(false);
} finally {
  if (saved) {
    try { await post('/api/admin/display', saved.display || {}); } catch {}
  }
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  for (const id of created) { try { await post('/api/admin/removeTile', { id }); } catch {} }
  const failed = results.filter((x) => !x).length;
  console.log('---------------------------------------------');
  console.log(failed === 0 ? 'EFFECTS: ALL PASS' : `EFFECTS: ${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}
