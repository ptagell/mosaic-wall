// Generative art scene: full-screen visuals instead of photos. API (scene +
// artwork config + catalogue in the snapshot) and a real tile rendering art —
// canvas slide painting pixels, RAF advancing, artwork switching, cycling on
// the slide clock, and photos resuming when the scene changes back.
// Restores prior settings and removes its tiles.
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
  const profile = mkdtempSync(join(tmpdir(), `art-${port}-`));
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
const art = (c) => ev(c, 'window.__art || null');
// nonzero-alpha + non-black pixel count of the active slide's canvas (2D canvases only)
const painted = (c) => ev(c, "(function(){var el=document.querySelector('#stage .slide.active canvas');if(!el)return -1;var x=null;try{x=el.getContext('2d');}catch(e){}if(!x)return -2;var d;try{d=x.getImageData(0,0,el.width,el.height).data;}catch(e){return -3;}var nz=0;for(var i=0;i<d.length;i+=4){if(d[i]>8||d[i+1]>8||d[i+2]>8)nz++;}return nz;})()");

const procs = [];
const created = [];
let saved = null;
try {
  saved = await getJson('/api/admin/scenes');

  // ---- API: catalogue + scene + artwork config ----
  check('scene catalogue includes art', (saved.scenes || []).some((s) => s.key === 'art'));
  check('snapshot lists artworks', Array.isArray(saved.artworks) && saved.artworks.includes('plasma') && saved.artworks.includes('flow'), JSON.stringify(saved.artworks));
  let r = await post('/api/admin/scene', { scene: 'art', artwork: 'phyllo' });
  check('art scene set with fixed artwork', r.active === 'art' && r.config.artwork === 'phyllo', `active=${r.active} artwork=${r.config && r.config.artwork}`);
  r = await post('/api/admin/scene', { scene: 'art', artwork: 'not-real' });
  check('unknown artwork falls back to cycle', r.config.artwork === '', `artwork="${r.config && r.config.artwork}"`);
  r = await post('/api/admin/scene', { scene: 'art', artwork: 'plasma', artPalette: 3, artSpeed: 99 });
  check('palette pin accepted', r.config.artPalette === 3, 'artPalette=' + r.config.artPalette);
  check('speed clamps to max 3', r.config.artSpeed === 3, 'artSpeed=' + r.config.artSpeed);
  r = await post('/api/admin/scene', { scene: 'art', artwork: 'plasma', artPalette: '', artSpeed: 0.01 });
  check('empty palette means cycle', r.config.artPalette == null, 'artPalette=' + r.config.artPalette);
  check('speed clamps to min 0.25', r.config.artSpeed === 0.25, 'artSpeed=' + r.config.artSpeed);

  // ---- a real tile renders art ----
  await post('/api/admin/timing', { mode: 'sync', slideSec: 600 }); // park the cycle; we drive changes explicitly
  await post('/api/admin/scene', { scene: 'art', artwork: 'phyllo' });
  procs.push(launch(9499));
  const c = cdp(await pageWs(9499)); await c.ready; await c.send('Runtime.enable');
  let idA = null;
  for (let i = 0; i < 60; i++) { idA = await ev(c, "window.localStorage.getItem('mosaic_device_id')"); if (idA) break; await sleep(250); }
  created.push(idA);

  let a = null;
  for (let i = 0; i < 40; i++) { a = await art(c); if (a && a.art === 'phyllo' && a.frames > 2) break; await sleep(200); }
  check('tile renders phyllotaxis on register', !!a && a.art === 'phyllo', a ? `art=${a.art} mode=${a.mode}` : 'no __art');
  const f1 = a ? a.frames : 0;
  await sleep(500);
  a = await art(c);
  check('art animation advances frames', !!a && a.frames > f1, a ? `${f1} -> ${a.frames}` : 'no __art');
  const nz = await painted(c);
  check('artwork paints coloured pixels', nz > 0, 'painted px=' + nz);

  // ---- switching to a shader artwork (GL or 2D fallback both fine),
  //      with a pinned palette and speed riding along ----
  await post('/api/admin/scene', { scene: 'art', artwork: 'plasma', artPalette: 2, artSpeed: 2 });
  a = null;
  for (let i = 0; i < 40; i++) { a = await art(c); if (a && a.art === 'plasma' && a.frames > 2) break; await sleep(200); }
  check('tile switches to plasma', !!a && a.art === 'plasma', a ? `mode=${a.mode} ${a.w}x${a.h}` : 'no __art');
  check('tile uses the pinned palette', !!a && a.palette === 2, a ? 'palette=' + a.palette : 'no __art');
  check('tile uses the requested speed', !!a && a.speed === 2, a ? 'speed=' + a.speed : 'no __art');
  const fp = a ? a.frames : 0;
  await sleep(500);
  a = await art(c);
  check('plasma keeps animating', !!a && a.frames > fp, a ? `${fp} -> ${a.frames}` : 'no __art');

  // ---- cycle mode advances on the slide clock ----
  await post('/api/admin/scene', { scene: 'art', artwork: '' });
  await post('/api/admin/timing', { slideSec: 2 });
  const seen = new Set();
  for (let i = 0; i < 40; i++) { a = await art(c); if (a) seen.add(a.art); if (seen.size >= 2) break; await sleep(250); }
  check('cycle mode moves through artworks', seen.size >= 2, [...seen].join(','));
  await post('/api/admin/timing', { slideSec: 600 });

  // ---- stagger timing must NOT push photos over the art (register arms
  // per-tile photo timers; art/split/mirror scenes have to suppress them) ----
  await post('/api/admin/scene', { scene: 'art', artwork: 'phyllo' });
  await post('/api/admin/timing', { mode: 'stagger', slideSec: 2 });
  await post('/api/admin/reload', { id: idA }); // reload re-registers, like the admin button
  a = null;
  for (let i = 0; i < 40; i++) { a = await art(c); if (a && a.art === 'phyllo' && a.frames > 2) break; await sleep(250); }
  check('art shows again after reload under stagger', !!a && a.art === 'phyllo', a ? 'art=' + a.art : 'no __art');
  await sleep(4500); // > one full stagger period (2s ± jitter)
  const kind = await ev(c, "(function(){var s=document.querySelector('#stage .slide.active');if(!s)return 'none';if(s.querySelector('canvas'))return 'canvas';if(s.querySelector('img'))return 'img';return '?';})()");
  check('stagger timer does not replace art with a photo', kind === 'canvas', 'active slide holds: ' + kind);
  await post('/api/admin/timing', { mode: 'sync', slideSec: 600 });

  // ---- photos resume when the scene changes back ----
  await post('/api/admin/scene', { scene: 'random' });
  let img = null;
  for (let i = 0; i < 40; i++) { img = await ev(c, "(function(){var s=document.querySelector('#stage .slide.active img');return s?s.src:null;})()"); if (img) break; await sleep(250); }
  check('photos resume after art scene', !!img && /\/img\//.test(img), img || 'no img');

} catch (e) {
  console.error('TEST ERROR:', e.message);
  results.push(false);
} finally {
  if (saved) {
    try { await post('/api/admin/timing', { mode: saved.timing || 'sync', slideSec: saved.slideSec || 15 }); } catch {}
    try {
      const body = { scene: saved.active || 'random' };
      if (saved.config && saved.config.personId) body.personId = saved.config.personId;
      if (saved.config && saved.config.query) body.query = saved.config.query;
      if (saved.config && saved.config.artwork != null) body.artwork = saved.config.artwork;
      await post('/api/admin/scene', body);
    } catch {}
  }
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  for (const id of created) { try { await post('/api/admin/removeTile', { id }); } catch {} }
  const failed = results.filter((x) => !x).length;
  console.log('---------------------------------------------');
  console.log(failed === 0 ? 'ART: ALL PASS' : `ART: ${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}
