// Scene engine integration test against the running orchestrator (port 4000).
//  Part A (HTTP): the scene API validates, resolves real Immich content, and persists.
//  Part B (CDP): a real headless tile receives a fresh image when the scene switches.
// The pre-test scene is saved and restored so live tiles aren't left changed.
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
  const profile = mkdtempSync(join(tmpdir(), `scene-${port}-`));
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
  saved = await getJson('/api/admin/scenes'); // remember current scene to restore later

  // ---- Part A: scene API ----
  const cat = saved;
  check('scene catalogue present', Array.isArray(cat.scenes) && cat.scenes.length >= 4, (cat.scenes || []).map(s => s.key).join(','));

  const people = (await getJson('/api/people')).people || [];
  const person = people[0];

  let r = await postJson('/api/admin/scene', person ? { scene: 'one-person', personId: person.id } : { scene: 'one-person' });
  check('one-person: accepted + active set', r.status === 200 && r.body.active === 'one-person', JSON.stringify(r.body.info || {}));
  if (person) check('one-person: resolved the requested person', r.body.info && r.body.info.personName === person.name, (r.body.info || {}).personName);

  r = await getJson('/api/admin/scenes');
  check('scene persisted (GET reflects one-person)', r.active === 'one-person');

  r = await postJson('/api/admin/scene', { scene: 'different-people' });
  check('different-people: accepted', r.status === 200 && r.body.active === 'different-people', 'people=' + ((r.body.info || {}).peopleCount));

  r = await postJson('/api/admin/scene', { scene: 'landscapes' });
  check('landscapes: accepted + smart-search ran', r.status === 200 && r.body.active === 'landscapes', 'matches=' + ((r.body.info || {}).count));

  r = await postJson('/api/admin/scene', { scene: 'bogus-scene' });
  check('unknown scene rejected (400)', r.status === 400);

  // ---- Part B: a real tile receives a fresh image on scene switch ----
  await postJson('/api/admin/scene', { scene: 'random' });
  procs.push(launch(9451));
  const c = cdp(await pageWs(9451)); await c.ready; await c.send('Runtime.enable');
  const activeSrc = async () => c.send('Runtime.evaluate', {
    expression: "(function(){var i=document.querySelector('#stage .slide.active img');return i?i.getAttribute('src'):'';})()",
    returnByValue: true
  }).then((x) => x.result.value || '');

  let first = '';
  for (let i = 0; i < 40; i++) { first = await activeSrc(); if (first.indexOf('/img/') !== -1) break; await sleep(300); }
  check('tile displays an image under the active scene', first.indexOf('/img/') !== -1, first);
  const devB = await c.send('Runtime.evaluate', { expression: "window.localStorage.getItem('mosaic_device_id')", returnByValue: true }).then((x) => x.result.value);
  if (devB) created.push(devB);

  await postJson('/api/admin/scene', { scene: 'random' }); // forces an immediate push to all tiles
  let changed = false, next = first;
  for (let i = 0; i < 30; i++) { next = await activeSrc(); if (next && next !== first) { changed = true; break; } await sleep(300); }
  check('tile swaps to a new image when the scene is (re)applied', changed, next);

} catch (e) {
  console.error('TEST ERROR:', e.message);
  results.push(false);
} finally {
  if (saved && saved.active) {
    try { await postJson('/api/admin/scene', saved.active === 'one-person' && saved.config && saved.config.personId ? { scene: saved.active, personId: saved.config.personId } : { scene: saved.active }); } catch {}
  }
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  for (const id of created) { try { await postJson('/api/admin/removeTile', { id }); } catch {} }
  const failed = results.filter((x) => !x).length;
  console.log('---------------------------------------------');
  console.log(failed === 0 ? 'SCENE LIVE: ALL PASS' : `SCENE LIVE: ${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}
