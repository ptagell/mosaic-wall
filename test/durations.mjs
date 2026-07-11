// Duration controls: slide interval (server timing) + transition/Ken Burns
// durations (broadcast display config). API validation/clamping + a real tile
// applying the transition and Ken Burns durations. Restores prior settings.
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
  const profile = mkdtempSync(join(tmpdir(), `dur-${port}-`));
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
try {
  saved = await getJson('/api/admin/scenes');

  // ---- API: slide interval ----
  let r = await post('/api/admin/timing', { slideSec: 8 });
  check('slide interval set to 8s', r.slideSec === 8, 'slideSec=' + r.slideSec);
  check('slide interval persisted', (await getJson('/api/admin/scenes')).slideSec === 8);
  r = await post('/api/admin/timing', { slideSec: 1 });
  check('slide interval clamps to min 2s', r.slideSec === 2, 'slideSec=' + r.slideSec);
  r = await post('/api/admin/timing', { slideSec: 99999 });
  check('slide interval clamps to max 600s', r.slideSec === 600, 'slideSec=' + r.slideSec);

  // ---- API: transition + ken burns durations ----
  r = await post('/api/admin/display', { transitionSec: 0.4 });
  check('transition duration set to 0.4s', r.display.transitionSec === 0.4, 'ts=' + r.display.transitionSec);
  r = await post('/api/admin/display', { transitionSec: 99 });
  check('transition duration clamps to max 6s', r.display.transitionSec === 6);
  r = await post('/api/admin/display', { kenburnsSec: 12 });
  check('ken burns duration set to 12s', r.display.kenburnsSec === 12);
  r = await post('/api/admin/display', { kenburnsSec: 1 });
  check('ken burns duration clamps to min 5s', r.display.kenburnsSec === 5);

  // ---- tile applies the durations ----
  await post('/api/admin/timing', { mode: 'stagger', slideSec: 8 }); // stagger => immediate commit (no scheduled lead)
  await post('/api/admin/display', { look: 'none', transition: 'fade', kenburns: false, transitionSec: 0.3, kenburnsSec: 14 });
  procs.push(launch(9497));
  const c = cdp(await pageWs(9497)); await c.ready; await c.send('Runtime.enable');
  let idA = null;
  for (let i = 0; i < 60; i++) { idA = await ev(c, "window.localStorage.getItem('mosaic_device_id')"); if (idA) break; await sleep(250); }
  created.push(idA);
  await sleep(500);

  await post('/api/admin/scene', { scene: 'random' }); // trigger a fresh slide
  const transStyle = () => ev(c, "(function(){var s=document.querySelector('#stage .slide.active');return s?(s.style.transition||s.style.webkitTransition||''):'';})()");
  let ts = '';
  for (let i = 0; i < 30; i++) { ts = await transStyle(); if (/0\.3s/.test(ts)) break; await sleep(200); }
  check('tile applies the 0.3s transition duration', /0\.3s/.test(ts), ts);

  await post('/api/admin/display', { kenburns: true, kenburnsSec: 14 });
  await post('/api/admin/scene', { scene: 'random' });
  const kbDur = () => ev(c, "(function(){var im=document.querySelector('#stage .slide.active img');return im?(im.style.animationDuration||im.style.webkitAnimationDuration||''):'';})()");
  let kb = '';
  for (let i = 0; i < 30; i++) { kb = await kbDur(); if (/14s/.test(kb)) break; await sleep(200); }
  check('tile applies the 14s Ken Burns duration', /14s/.test(kb), kb);

} catch (e) {
  console.error('TEST ERROR:', e.message);
  results.push(false);
} finally {
  if (saved) {
    try { await post('/api/admin/timing', { mode: saved.timing || 'sync', slideSec: saved.slideSec || 15 }); } catch {}
    try { await post('/api/admin/display', saved.display || {}); } catch {}
    try { await post('/api/admin/scene', saved.active === 'one-person' && saved.config && saved.config.personId ? { scene: saved.active, personId: saved.config.personId } : { scene: saved.active || 'random' }); } catch {}
  }
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  for (const id of created) { try { await post('/api/admin/removeTile', { id }); } catch {} }
  const failed = results.filter((x) => !x).length;
  console.log('---------------------------------------------');
  console.log(failed === 0 ? 'DURATIONS: ALL PASS' : `DURATIONS: ${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}
