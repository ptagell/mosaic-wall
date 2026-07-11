// Display-effects integration test against the running orchestrator (port 4000).
//  A: timing sync/stagger/wave round-trips + persists (API)
//  B: display config (look/transition/toggles) validates + persists (API)
//  C: effects actually land on a real tile — look filter, vignette overlay,
//     and the spotlight pulse — verified over CDP.
// Saves and restores pre-test timing + display so live tiles aren't left changed.
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
const postJson = (p, b) => fetch(APP + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));

function launch(port) {
  const profile = mkdtempSync(join(tmpdir(), `disp-${port}-`));
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

const procs = [];
const created = [];
let saved = null;
try {
  saved = await getJson('/api/admin/scenes');

  // ---- A: timing ----
  for (const m of ['stagger', 'wave', 'sync']) {
    const r = await postJson('/api/admin/timing', { mode: m });
    check('timing: ' + m + ' accepted', r.status === 200 && r.body.timing === m);
  }
  check('timing: persisted', (await getJson('/api/admin/scenes')).timing === 'sync');
  check('timing: bad mode rejected (400)', (await postJson('/api/admin/timing', { mode: 'nope' })).status === 400);

  // ---- B: display config API ----
  let r = await postJson('/api/admin/display', { look: 'sepia' });
  check('display: look sepia set', r.status === 200 && r.body.display.look === 'sepia');
  r = await postJson('/api/admin/display', { look: 'bogus' }); // invalid -> unchanged
  check('display: invalid look ignored', r.body.display.look === 'sepia');
  r = await postJson('/api/admin/display', { transition: 'zoom', kenburns: true });
  check('display: transition + kenburns set together', r.body.display.transition === 'zoom' && r.body.display.kenburns === true);
  r = await postJson('/api/admin/display', { vignette: true, tint: true, nightDim: true, spotlight: true });
  check('display: all toggles on', ['vignette', 'tint', 'nightDim', 'spotlight'].every((k) => r.body.display[k] === true));
  check('display: persisted', (await getJson('/api/admin/scenes')).display.look === 'sepia');

  // reset to a clean slate before the tile checks
  await postJson('/api/admin/display', { look: 'none', transition: 'fade', kenburns: false, vignette: false, tint: false, nightDim: false, spotlight: false });

  // ---- C: effects on a real tile ----
  procs.push(launch(9461));
  const c = cdp(await pageWs(9461)); await c.ready; await c.send('Runtime.enable');
  const evalJs = (expr) => c.send('Runtime.evaluate', { expression: expr, returnByValue: true }).then((x) => x.result.value);
  const stageFilter = () => evalJs("(function(){var s=document.getElementById('stage');var cs=getComputedStyle(s);return cs.webkitFilter||cs.filter||'';})()");
  const vignetteShown = () => evalJs("getComputedStyle(document.getElementById('vignette')).display");
  const frameClass = () => evalJs("document.getElementById('frame').className");
  await sleep(600); // let it register + apply initial config

  await postJson('/api/admin/display', { look: 'grayscale' });
  let f = '';
  for (let i = 0; i < 30; i++) { f = await stageFilter(); if (/grayscale/.test(f)) break; await sleep(200); }
  check('tile: look=grayscale applies a grayscale filter', /grayscale/.test(f), f);

  await postJson('/api/admin/display', { look: 'none' });
  for (let i = 0; i < 30; i++) { f = await stageFilter(); if (!/grayscale/.test(f)) break; await sleep(200); }
  check('tile: look=none clears the filter', !/grayscale/.test(f), f);

  await postJson('/api/admin/display', { vignette: true });
  let vd = '';
  for (let i = 0; i < 30; i++) { vd = await vignetteShown(); if (vd === 'block') break; await sleep(200); }
  check('tile: vignette overlay turns on', vd === 'block', vd);
  await postJson('/api/admin/display', { vignette: false });

  // spotlight hops across ALL online tiles by placement order; to be deterministic
  // amid other live tiles, park this test tile far left so it's highlighted first.
  const devId = await evalJs("window.localStorage.getItem('mosaic_device_id')");
  if (devId) created.push(devId);
  await postJson('/api/admin/tile', { id: devId, place: { x: -100000, y: 0 } });
  await postJson('/api/admin/display', { spotlight: true });
  let spotted = false;
  for (let i = 0; i < 48; i++) { if ((await frameClass()) === 'spot') { spotted = true; break; } await sleep(250); }
  check('tile: spotlight pulse reaches a tile', spotted, 'dev=' + devId);
  await postJson('/api/admin/display', { spotlight: false });
  await postJson('/api/admin/tile', { id: devId, place: null }); // cleanup the test placement

} catch (e) {
  console.error('TEST ERROR:', e.message);
  results.push(false);
} finally {
  if (saved) {
    try { await postJson('/api/admin/timing', { mode: saved.timing || 'sync' }); } catch {}
    try { await postJson('/api/admin/display', saved.display || {}); } catch {}
  }
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  for (const id of created) { try { await postJson('/api/admin/removeTile', { id }); } catch {} }
  const failed = results.filter((x) => !x).length;
  console.log('---------------------------------------------');
  console.log(failed === 0 ? 'DISPLAY: ALL PASS' : `DISPLAY: ${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}
