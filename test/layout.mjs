// Free-form layout acceptance.
//  Part A (unit): models.guess() maps a native resolution to the right model.
//  Part B (integration): real tiles report orientation; the server resolves SCREEN
//  mm (swapping for orientation), honours a model + orientation override, records
//  free placement, and computes a wall bounding box.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const models = require('../models.js');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP = 'http://localhost:4000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

// ---- Part A: model guess (pure logic) ----
check('guess 1536x2048 -> mini-2 (ambiguous default)', models.guess(1536, 2048) === 'ipad-mini-2', models.guess(1536, 2048));
check('guess 2048x1536 (landscape) -> mini-2', models.guess(2048, 1536) === 'ipad-mini-2');
check('guess 1620x2160 -> iPad 10.2"', models.guess(1620, 2160) === 'ipad-102', models.guess(1620, 2160));
check('guess 768x1024 -> iPad 2', models.guess(768, 1024) === 'ipad-2');
check('guess 2048x2732 -> Pro 12.9"', models.guess(2048, 2732) === 'ipad-pro-129');
check('guess unknown -> null', models.guess(500, 500) === null);

// ---- Part B: integration ----
function launch(port, w, h) {
  const profile = mkdtempSync(join(tmpdir(), `lay-${port}-`));
  return spawn(CHROME, ['--headless=new','--disable-gpu','--hide-scrollbars',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,`--window-size=${w},${h}`,`${APP}/tile`], { stdio: 'ignore' });
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
const post = (b) => fetch(APP + '/api/admin/tile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const getState = () => fetch(APP + '/api/admin/state').then((r) => r.json());
const removeTile = (id) => fetch(APP + '/api/admin/removeTile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).then((r) => r.json());
const find = (s, id) => (s.tiles || []).find((t) => t.id === id) || {};

const procs = [];
const created = [];
try {
  procs.push(launch(9431, 768, 1024)); // portrait viewport
  procs.push(launch(9432, 1024, 768)); // landscape viewport
  const cA = cdp(await pageWs(9431)); await cA.ready; await cA.send('Runtime.enable');
  const cB = cdp(await pageWs(9432)); await cB.ready; await cB.send('Runtime.enable');
  const devId = async (c) => { for (let i = 0; i < 60; i++) { const v = await c.send('Runtime.evaluate', { expression: "window.localStorage.getItem('mosaic_device_id')", returnByValue: true }).then((r) => r.result.value); if (v) return v; await sleep(250); } throw new Error('no id'); };
  const idA = await devId(cA), idB = await devId(cB);
  created.push(idA, idB);
  await sleep(400);

  let st = await getState(), A = find(st, idA), B = find(st, idB);
  check('orientation detected (A portrait, B landscape)', A.orientation === 'portrait' && B.orientation === 'landscape', `A=${A.orientation} B=${B.orientation}`);

  // assign the same model to both -> portrait resolves upright, landscape swaps
  st = await post({ id: idA, model: 'ipad-mini-2' });
  st = await post({ id: idB, model: 'ipad-mini-2' });
  A = find(st, idA); B = find(st, idB);
  check('portrait screen mm resolved', A.screenMm && near(A.screenMm.w, 120.4) && near(A.screenMm.h, 160.5), JSON.stringify(A.screenMm));
  check('landscape screen mm is swapped', B.screenMm && near(B.screenMm.w, 160.5) && near(B.screenMm.h, 120.4), JSON.stringify(B.screenMm));

  // model picker changes physical size
  st = await post({ id: idA, model: 'ipad-97' }); A = find(st, idA);
  check('model picker changes physical size', A.model === 'ipad-97' && near(A.screenMm.w, 147.8) && near(A.screenMm.h, 197.1), JSON.stringify(A.screenMm));

  // free placement + wall bounding box
  st = await post({ id: idA, place: { x: 0, y: 0 } });
  st = await post({ id: idB, place: { x: 200, y: 0 } });
  A = find(st, idA); B = find(st, idB);
  check('free placement recorded', A.place && A.place.x === 0 && B.place && B.place.x === 200, `A=${JSON.stringify(A.place)} B=${JSON.stringify(B.place)}`);
  // wall bbox is global (spans every placed tile, incl. the operator's) — assert it
  // CONTAINS our two test tiles rather than equals them, so it's isolation-robust.
  const spansX = st.wall && st.wall.x <= 0.6 && (st.wall.x + st.wall.w) >= (200 + B.screenMm.w - 0.6);
  const spansY = st.wall && st.wall.y <= 0.6 && (st.wall.y + st.wall.h) >= (Math.max(A.screenMm.h, B.screenMm.h) - 0.6);
  check('wall bbox spans the placed tiles', spansX && spansY, `wall=${JSON.stringify(st.wall)}`);

  // orientation override swaps B back to portrait
  st = await post({ id: idB, orientation: 'portrait' }); B = find(st, idB);
  check('orientation override swaps screen mm', B.orientation === 'portrait' && near(B.screenMm.w, 120.4) && near(B.screenMm.h, 160.5), `${B.orientation} ${JSON.stringify(B.screenMm)}`);

  const failed = results.filter((r) => !r).length;
  console.log('---------------------------------------------');
  console.log(failed === 0 ? 'LAYOUT: ALL PASS' : `LAYOUT: ${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (e) {
  console.error('TEST ERROR:', e.message);
  process.exitCode = 1;
} finally {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  for (const id of created) { try { await removeTile(id); } catch {} } // don't leave stale test tiles in the registry
}
