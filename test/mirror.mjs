// Phase 6 (mirror) integration test. Simulates the /camera source over WebSocket
// (register-camera + camera-frame) and verifies a placed tile renders the live
// frame split to its region, and that /status reports the camera online.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP = 'http://localhost:4000';
const WSURL = 'ws://localhost:4000/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const getJson = (p) => fetch(APP + p).then((r) => r.json());
const post = (p, b) => fetch(APP + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
// 1x1 red PNG
const FRAME = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function launch(port) {
  const profile = mkdtempSync(join(tmpdir(), `mir-${port}-`));
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

const procs = [];
const created = [];
let saved = null;
let cam = null, frameTimer = null;
try {
  saved = await getJson('/api/admin/scenes');
  check('catalogue includes mirror', saved.scenes.some((s) => s.key === 'mirror'));

  // a real tile, placed so it gets a split region
  procs.push(launch(9495));
  const c = cdp(await pageWs(9495)); await c.ready; await c.send('Runtime.enable');
  let idA = null;
  for (let i = 0; i < 60; i++) { idA = await ev(c, "window.localStorage.getItem('mosaic_device_id')"); if (idA) break; await sleep(250); }
  created.push(idA);
  await post('/api/admin/tile', { id: idA, model: 'ipad-97', orientation: 'portrait', place: { x: 0, y: 0 } });

  // connect a simulated camera source
  cam = new WebSocket(WSURL);
  await new Promise((r, rej) => { cam.addEventListener('open', r); cam.addEventListener('error', rej); });
  cam.send(JSON.stringify({ type: 'register-camera' }));
  await sleep(300);
  check('camera registers (/status shows camera online)', (await getJson('/status')).camera === true);

  // switch to mirror + start streaming frames
  await post('/api/admin/scene', { scene: 'mirror' });
  frameTimer = setInterval(() => { try { cam.send(JSON.stringify({ type: 'camera-frame', data: FRAME })); } catch {} }, 200);

  // the tile should render the live frame
  const activeSrc = () => ev(c, "(function(){var i=document.querySelector('#stage .slide.active img');return i?i.getAttribute('src'):'';})()");
  const activeCls = () => ev(c, "(function(){var i=document.querySelector('#stage .slide.active img');return i?i.className:'';})()");
  let src = '', cls = '';
  for (let i = 0; i < 45; i++) { src = await activeSrc(); cls = await activeCls(); if ((src || '').indexOf('data:image') === 0) break; await sleep(200); }
  check('tile renders the live camera frame', (src || '').indexOf('data:image') === 0, (src || '').slice(0, 24));
  check('placed tile crops the frame to its region (splitimg)', /splitimg/.test(cls || ''), cls);

  // dropping the camera flips /status back
  clearInterval(frameTimer); frameTimer = null;
  cam.close(); cam = null;
  for (let i = 0; i < 20; i++) { if ((await getJson('/status')).camera === false) break; await sleep(200); }
  check('camera disconnect clears the online flag', (await getJson('/status')).camera === false);

} catch (e) {
  console.error('TEST ERROR:', e.message);
  results.push(false);
} finally {
  if (frameTimer) { clearInterval(frameTimer); }
  if (cam) { try { cam.close(); } catch {} }
  if (saved) { try { await post('/api/admin/scene', saved.active === 'one-person' && saved.config && saved.config.personId ? { scene: saved.active, personId: saved.config.personId } : { scene: saved.active || 'random' }); } catch {} }
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  for (const id of created) { try { await post('/api/admin/removeTile', { id }); } catch {} }
  const failed = results.filter((x) => !x).length;
  console.log('---------------------------------------------');
  console.log(failed === 0 ? 'MIRROR: ALL PASS' : `MIRROR: ${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}
