// The "more awesome" batch: on-this-day scene, moments (event clusters),
// wave directions, daily schedule (sleep/wake), tap captions (info on show
// msgs + UI), wall-wide Ken Burns in split mode, and hourly-refresh plumbing.
// Raw-WS tiles for message-level checks + one headless Chrome tile for UI.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP = 'http://localhost:4000';
const WSU = 'ws://localhost:4000/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const getJson = (p) => fetch(APP + p).then((r) => r.json());
const post = (p, b) => fetch(APP + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

function fakeTile(deviceId) {
  const t = { id: deviceId, ws: new WebSocket(WSU), msgs: [] };
  t.ws.addEventListener('open', () => t.ws.send(JSON.stringify({ type: 'register', deviceId, w: 768, h: 1024, screenW: 768, screenH: 1024, dpr: 1, orientation: 'portrait' })));
  t.ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    t.msgs.push(m);
    if (m.type === 'ping') t.ws.send(JSON.stringify({ type: 'pong', t: m.t }));
  });
  return t;
}
const has = (t, pred) => t.msgs.some(pred);
async function waitFor(fn, tries = 40) { for (let i = 0; i < tries; i++) { if (fn()) return true; await sleep(250); } return fn(); }

function launch(port) {
  const profile = mkdtempSync(join(tmpdir(), `awe-${port}-`));
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
const fakes = [];
let saved = null;
try {
  saved = await getJson('/api/admin/scenes');
  await post('/api/admin/timing', { mode: 'sync', slideSec: 600 });
  await post('/api/admin/schedule', { on: false });

  // ---- API: wave directions + moments cadence ----
  let r = await post('/api/admin/timing', { waveDir: 'diag' });
  check('wave direction set to diagonal', r.waveDir === 'diag', 'waveDir=' + r.waveDir);
  r = await post('/api/admin/timing', { waveDir: 'sideways' });
  check('invalid wave direction rejected', r.waveDir === 'diag');
  r = await post('/api/admin/timing', { waveDir: 'lr', momentsEvery: 99 });
  check('moments cadence clamps to 50', r.momentsEvery === 50, 'momentsEvery=' + r.momentsEvery);
  r = await post('/api/admin/timing', { momentsEvery: 0 });
  check('moments off accepted', r.momentsEvery === 0);

  // ---- API: schedule sanitize ----
  r = await post('/api/admin/schedule', { on: false, wake: '25:99', evening: '19:30', sleep: '22:30', dayScene: 'random', eveScene: 'art' });
  check('bad wake time rejected (keeps prior)', /^([01]?\d|2[0-3]):[0-5]\d$/.test(r.schedule.wake), 'wake=' + r.schedule.wake);
  check('schedule scenes accepted', r.schedule.eveScene === 'art', 'eveScene=' + r.schedule.eveScene);

  // ---- on-this-day scene ----
  r = await post('/api/admin/scene', { scene: 'on-this-day' });
  check('on-this-day scene activates', r.active === 'on-this-day', 'active=' + r.active);
  check('on-this-day reports a count', typeof r.info.count === 'number', 'count=' + r.info.count);
  console.log(`      (on this day: ${r.info.count} memories)`);
  await post('/api/admin/scene', { scene: 'random' });

  // ---- captions ride on show messages ----
  fakes.push(fakeTile('awe-test-0'), fakeTile('awe-test-1'));
  created.push('awe-test-0', 'awe-test-1');
  await waitFor(() => fakes.every((t) => has(t, (m) => m.type === 'show')));
  await post('/api/admin/showRandom', {});
  await waitFor(() => fakes.some((t) => has(t, (m) => m.type === 'show' && m.info && m.info.date)));
  check('show messages carry caption info (date)', fakes.some((t) => has(t, (m) => m.type === 'show' && m.info && m.info.date)),
    JSON.stringify((fakes[0].msgs.filter((m) => m.type === 'show').pop() || {}).info || null));

  // ---- moments: gather the wall around one event ----
  r = await post('/api/admin/moment', {});
  if (r.ok) {
    check('moment starts on demand', r.moment && r.moment.count >= 3, `count=${r.moment && r.moment.count} label="${r.moment && r.moment.label}"`);
    const snap = await getJson('/api/admin/scenes');
    check('moment visible in the snapshot', !!snap.moment, JSON.stringify(snap.moment));
    // wind it down so it doesn't linger into other suites
    await post('/api/admin/showRandom', {}); await post('/api/admin/showRandom', {});
  } else {
    check('moment starts on demand', false, 'no cluster found — takenAt data missing?');
  }

  // ---- schedule: sleep now (TZ-proof window: asleep except 00:00-00:01) ----
  const preSleep = fakes.map((t) => t.msgs.length);
  r = await post('/api/admin/schedule', { on: true, wake: '00:00', sleep: '00:01', evening: '23:58', dayScene: 'random', eveScene: 'art' });
  check('schedule reports sleeping', r.sleeping === true, 'sleeping=' + r.sleeping);
  await waitFor(() => fakes.every((t) => has(t, (m) => m.type === 'sleep')));
  check('tiles told to sleep', fakes.every((t) => has(t, (m) => m.type === 'sleep')));
  // a tile registering during the night is put straight to sleep
  const night = fakeTile('awe-test-2'); fakes.push(night); created.push('awe-test-2');
  await waitFor(() => has(night, (m) => m.type === 'sleep'));
  check('late-registering tile is sent to sleep', has(night, (m) => m.type === 'sleep'));
  r = await post('/api/admin/schedule', { on: false });
  await waitFor(() => fakes.every((t) => has(t, (m) => m.type === 'wake')));
  check('disabling the schedule wakes the wall', fakes.every((t) => has(t, (m) => m.type === 'wake')) && r.sleeping === false);

  // ---- wall-wide Ken Burns in split mode + caption UI (real browser) ----
  await post('/api/admin/display', { kenburns: true, transitionSec: 0.3 });
  await post('/api/admin/scene', { scene: 'split-image' });
  procs.push(launch(9496));
  const c = cdp(await pageWs(9496)); await c.ready; await c.send('Runtime.enable');
  let idA = null;
  for (let i = 0; i < 60; i++) { idA = await ev(c, "window.localStorage.getItem('mosaic_device_id')"); if (idA) break; await sleep(250); }
  created.push(idA);
  // a split region needs a model + placement (far away so the operator's wall is
  // untouched); the placement change itself re-crops the split picture
  await post('/api/admin/tile', { id: idA, model: 'ipad-mini-2', orientation: 'portrait', place: { x: -100000, y: -100000 } });
  let kb = null;
  for (let i = 0; i < 40; i++) {
    kb = await ev(c, "(function(){var im=document.querySelector('#stage .slide.active img');if(!im)return null;return {cls:im.className, dur:im.style.animationDuration||im.style.webkitAnimationDuration||'', org:im.style.transformOrigin||im.style.webkitTransformOrigin||''};})()");
    if (kb && /splitimg/.test(kb.cls) && /kb/.test(kb.cls)) break; await sleep(250);
  }
  check('split image runs Ken Burns', !!kb && /splitimg/.test(kb.cls) && /kb/.test(kb.cls), kb ? kb.cls : 'no img');
  check('split Ken Burns zooms about the wall centre', !!kb && /px/.test(kb.org), kb ? 'origin=' + kb.org : '');
  await ev(c, "document.dispatchEvent(new MouseEvent('mousedown'))");
  await sleep(400);
  const cap = await ev(c, "(function(){var el=document.getElementById('cap');return {cls:el.className, txt:el.textContent};})()");
  check('tap shows the caption', cap && /show/.test(cap.cls) && cap.txt.length > 0, cap ? `"${cap.txt}"` : '');

} catch (e) {
  console.error('TEST ERROR:', e.message);
  results.push(false);
} finally {
  try { await post('/api/admin/schedule', { on: false }); } catch {}
  if (saved) {
    try { await post('/api/admin/timing', { mode: saved.timing || 'sync', slideSec: saved.slideSec || 15, waveDir: saved.waveDir || 'lr', momentsEvery: saved.momentsEvery || 0 }); } catch {}
    try { await post('/api/admin/display', saved.display || {}); } catch {}
    try { await post('/api/admin/schedule', saved.schedule || { on: false }); } catch {}
    try {
      const body = { scene: saved.active || 'random' };
      if (saved.config && saved.config.personId) body.personId = saved.config.personId;
      if (saved.config && saved.config.query) body.query = saved.config.query;
      if (saved.config && saved.config.artwork != null) body.artwork = saved.config.artwork;
      await post('/api/admin/scene', body);
    } catch {}
  }
  for (const t of fakes) { try { t.ws.close(); } catch {} }
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  for (const id of created) { try { await post('/api/admin/removeTile', { id }); } catch {} }
  const failed = results.filter((x) => !x).length;
  console.log('---------------------------------------------');
  console.log(failed === 0 ? 'AWESOME: ALL PASS' : `AWESOME: ${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}
