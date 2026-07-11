// Phase 3 (tight sync) + Phase 4 (split-image) integration test.
//  Sync: two tiles told the same server-time `at` commit within a tight window.
//  Split: each placed tile renders an oversized image cropped to its own region.
// Cleans up its test tiles; restores the operator's scene + timing.
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
  const profile = mkdtempSync(join(tmpdir(), `ss-${port}-`));
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
const mw = (c) => ev(c, 'JSON.stringify(window.__mw||{})').then((s) => JSON.parse(s || '{}'));
const splitInfo = (c) => ev(c, "(function(){var im=document.querySelector('#stage .slide.active img');if(!im)return '{}';return JSON.stringify({cls:im.className,w:im.style.width,left:im.style.left});})()").then((s) => JSON.parse(s || '{}'));

const procs = [];
const created = [];
let saved = null;
try {
  saved = await getJson('/api/admin/scenes');

  procs.push(launch(9491)); procs.push(launch(9492));
  const cA = cdp(await pageWs(9491)); await cA.ready; await cA.send('Runtime.enable');
  const cB = cdp(await pageWs(9492)); await cB.ready; await cB.send('Runtime.enable');
  const idOf = async (c) => { for (let i = 0; i < 60; i++) { const v = await ev(c, "window.localStorage.getItem('mosaic_device_id')"); if (v) return v; await sleep(250); } throw new Error('no id'); };
  const idA = await idOf(cA), idB = await idOf(cB);
  created.push(idA, idB);
  await sleep(400);

  // give both a model + side-by-side placement so split has real regions
  await post('/api/admin/tile', { id: idA, model: 'ipad-97', orientation: 'portrait', place: { x: 0, y: 0 } });
  await post('/api/admin/tile', { id: idB, model: 'ipad-97', orientation: 'portrait', place: { x: 150, y: 0 } });

  // ---- Phase 3: tight sync ----
  await post('/api/admin/timing', { mode: 'sync' });
  await sleep(1600); // let the clock-offset burst settle
  await post('/api/admin/scene', { scene: 'random' }); // kicks a coordinated, scheduled swap
  let a = {}, b = {};
  for (let i = 0; i < 45; i++) { a = await mw(cA); b = await mw(cB); if (a.at && b.at && a.commit && b.commit) break; await sleep(200); }
  check('both tiles received a scheduled swap (at set)', a.at > 0 && b.at > 0, `atA=${a.at} atB=${b.at}`);
  const skew = Math.abs((a.commit || 0) - (b.commit || 0));
  check('tiles swap within 120ms of each other', a.commit && b.commit && skew < 120, `skew=${skew}ms`);
  const errA = Math.abs((a.commit || 0) - (a.at || 0));
  check('swap fires near its scheduled server time', a.at && errA < 250, `errA=${errA}ms`);

  // ---- Phase 4: split-image ----
  await post('/api/admin/scene', { scene: 'split-image' });
  let sa = {}, sb = {};
  for (let i = 0; i < 45; i++) { sa = await splitInfo(cA); sb = await splitInfo(cB); if (/splitimg/.test(sa.cls || '') && /splitimg/.test(sb.cls || '')) break; await sleep(250); }
  check('both tiles render a split image', /splitimg/.test(sa.cls || '') && /splitimg/.test(sb.cls || ''), `A=${sa.cls} B=${sb.cls}`);
  const wA = parseFloat(sa.w) || 0, leftA = parseFloat(sa.left) || 0, leftB = parseFloat(sb.left) || 0;
  check('split image is oversized (spans the wall)', wA > 768, `imgW=${Math.round(wA)}`);
  check('the two tiles show different regions', Math.abs(leftA - leftB) > 5, `leftA=${Math.round(leftA)} leftB=${Math.round(leftB)}`);

} catch (e) {
  console.error('TEST ERROR:', e.message);
  results.push(false);
} finally {
  if (saved) {
    try { await post('/api/admin/scene', saved.active === 'one-person' && saved.config && saved.config.personId ? { scene: saved.active, personId: saved.config.personId } : { scene: saved.active || 'random' }); } catch {}
    try { await post('/api/admin/timing', { mode: saved.timing || 'sync' }); } catch {}
  }
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  for (const id of created) { try { await post('/api/admin/removeTile', { id }); } catch {} }
  const failed = results.filter((x) => !x).length;
  console.log('---------------------------------------------');
  console.log(failed === 0 ? 'SYNC+SPLIT: ALL PASS' : `SYNC+SPLIT: ${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}
