// Device-registry removal test against the running orchestrator (port 4000).
// Creates a throwaway tile, takes it offline, and removes it — verifying the
// forgetTile path (which /api/admin/removeOffline also uses) without touching
// any of the operator's real, configured tiles.
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
const postJson = (p, b) => fetch(APP + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const findTile = (s, id) => (s.tiles || []).find((t) => t.id === id);

function launch(port) {
  const profile = mkdtempSync(join(tmpdir(), `dev-${port}-`));
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

let chrome = null;
try {
  const baseline = ((await getJson('/api/admin/state')).tiles || []).length;

  chrome = launch(9481);
  const c = cdp(await pageWs(9481)); await c.ready; await c.send('Runtime.enable');
  let idA = null;
  for (let i = 0; i < 60; i++) { idA = await c.send('Runtime.evaluate', { expression: "window.localStorage.getItem('mosaic_device_id')", returnByValue: true }).then((r) => r.result.value); if (idA) break; await sleep(250); }
  check('throwaway tile registered with an id', !!idA, idA);

  let st = await getJson('/api/admin/state');
  check('new tile shows as online', !!(findTile(st, idA) || {}).online);

  // take it offline
  chrome.kill('SIGKILL'); chrome = null;
  let offline = false;
  for (let i = 0; i < 30; i++) { st = await getJson('/api/admin/state'); const t = findTile(st, idA); if (t && !t.online) { offline = true; break; } await sleep(300); }
  check('tile goes offline when its browser closes', offline);
  check('offline tile is still listed (stale entry to prune)', !!findTile(st, idA));

  // remove just this tile
  st = await postJson('/api/admin/removeTile', { id: idA });
  check('removeTile drops it from the list', !findTile(st, idA));
  check('other tiles untouched (count back to baseline)', (st.tiles || []).length === baseline, `now=${(st.tiles || []).length} baseline=${baseline}`);

  // and it stays gone after a fresh read (persisted)
  st = await getJson('/api/admin/state');
  check('removal persisted', !findTile(st, idA));

} catch (e) {
  console.error('TEST ERROR:', e.message);
  results.push(false);
} finally {
  if (chrome) { try { chrome.kill('SIGKILL'); } catch {} }
  const failed = results.filter((x) => !x).length;
  console.log('---------------------------------------------');
  console.log(failed === 0 ? 'DEVICES: ALL PASS' : `DEVICES: ${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}
