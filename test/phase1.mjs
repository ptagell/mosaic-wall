// Phase 1 acceptance: assign names + grid cells to tiles, identify a tile, then
// RESTART the container and assert the assignments survive and tiles reconnect.
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP = 'http://localhost:4000';
const PROJECT = new URL('..', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(port) {
  const profile = mkdtempSync(join(tmpdir(), `p1-${port}-`));
  return spawn(CHROME, ['--headless=new','--disable-gpu','--hide-scrollbars',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'--window-size=512,384',`${APP}/tile`], { stdio: 'ignore' });
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
const post = (path, body) => fetch(APP + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const getState = () => fetch(APP + '/api/admin/state').then((r) => r.json());

const procs = [];
const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

try {
  procs.push(launch(9421)); procs.push(launch(9422));
  const A = cdp(await pageWs(9421)); await A.ready; await A.send('Runtime.enable');
  const B = cdp(await pageWs(9422)); await B.ready; await B.send('Runtime.enable');
  const ev = (c, expr) => c.send('Runtime.evaluate', { expression: expr, returnByValue: true }).then((r) => r.result.value);
  const deviceId = async (c) => { for (let i = 0; i < 60; i++) { const v = await ev(c, "window.localStorage.getItem('mosaic_device_id')"); if (v) return v; await sleep(250); } throw new Error('no deviceId'); };

  const idA = await deviceId(A), idB = await deviceId(B);
  check('two tiles registered with persistent ids', !!idA && !!idB && idA !== idB, `${idA} / ${idB}`);

  // grid + assignments
  await post('/api/admin/grid', { rows: 1, cols: 2 });
  await post('/api/admin/tile', { id: idA, name: 'Left', cell: { row: 0, col: 0 } });
  await post('/api/admin/tile', { id: idB, name: 'Right', cell: { row: 0, col: 1 } });
  let st = await getState();
  const findT = (s, id) => (s.tiles || []).find((t) => t.id === id) || {};
  check('assignments recorded', findT(st, idA).name === 'Left' && findT(st, idA).cell && findT(st, idA).cell.col === 0 && findT(st, idB).name === 'Right' && findT(st, idB).cell.col === 1,
    `A=${findT(st, idA).name}/${JSON.stringify(findT(st, idA).cell)} B=${findT(st, idB).name}/${JSON.stringify(findT(st, idB).cell)}`);

  // identify tile A -> its badge flashes "R1C1"
  await post('/api/admin/identify', { id: idA });
  await sleep(400);
  const badge = await ev(A, "(function(){var e=document.getElementById('ident');return {shown:e.classList.contains('show'),text:e.textContent};})()");
  check('identify flashes the right label on the tile', badge.shown === true && badge.text === 'R1C1', `shown=${badge.shown} text="${badge.text}"`);

  // give the debounced disk write a moment, then RESTART the container
  await sleep(500);
  console.log('... restarting container ...');
  execSync('docker compose restart', { cwd: PROJECT, stdio: 'ignore' });

  // wait for server back up
  for (let i = 0; i < 40; i++) { try { const r = await fetch(APP + '/health'); if (r.ok) break; } catch {} await sleep(500); }
  // wait for BOTH tiles to reconnect (auto-reconnect backoff) with restored assignments
  let restored = false, after = null;
  for (let i = 0; i < 60; i++) {
    after = await getState().catch(() => null);
    if (after) {
      const a = findT(after, idA), b = findT(after, idB);
      if (a.online && b.online && a.name === 'Left' && b.name === 'Right' && a.cell && a.cell.col === 0 && b.cell && b.cell.col === 1) { restored = true; break; }
    }
    await sleep(700);
  }
  const a = findT(after, idA), b = findT(after, idB);
  check('assignments survive a container restart', restored, `A=${a.name}/${a.online} B=${b.name}/${b.online}`);
  check('grid survives restart', after && after.grid && after.grid.rows === 1 && after.grid.cols === 2, JSON.stringify(after && after.grid));

  const failed = results.filter((r) => !r).length;
  console.log('---------------------------------------------');
  console.log(failed === 0 ? 'PHASE 1: ALL PASS' : `PHASE 1: ${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (e) {
  console.error('TEST ERROR:', e.message);
  process.exitCode = 1;
} finally {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
}
