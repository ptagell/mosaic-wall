// Phase 0 acceptance: N independent tiles connect over WS, the server commands a
// photo on register, every tile shows a loaded image, and an admin "show random"
// changes what each tile displays (the command channel works).
// Each tile is a separate Chrome instance (isolated localStorage => distinct deviceId).
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP = 'http://localhost:4000';
const N = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(port) {
  const profile = mkdtempSync(join(tmpdir(), `tile-${port}-`));
  const p = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--window-size=512,384', `${APP}/tile`,
  ], { stdio: 'ignore' });
  return p;
}

async function pageWs(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const pg = t.find((x) => x.type === 'page' && x.url.includes('/tile'));
      if (pg?.webSocketDebuggerUrl) return pg.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error(`no CDP page on ${port}`);
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 1; const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
  });
  const ready = new Promise((res) => ws.addEventListener('open', () => res()));
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = id++; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  return { ready, send };
}

const SAMPLE = `(function(){
  var s=document.querySelectorAll('#stage .slide'); var active=0, src='';
  for(var i=0;i<s.length;i++){var im=s[i].querySelector('img');var ok=im&&im.complete&&im.naturalWidth>0;
    if(s[i].classList.contains('active')&&ok){active++;src=im.getAttribute('src');}}
  return {active:active, total:s.length, src:src, connected:(document.getElementById('dot').className==='on')};
})()`;

const procs = [];
const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

try {
  const clients = [];
  for (let k = 0; k < N; k++) {
    const port = 9401 + k;
    procs.push(launch(port));
  }
  for (let k = 0; k < N; k++) {
    const c = cdp(await pageWs(9401 + k));
    await c.ready; await c.send('Runtime.enable');
    clients.push(c);
  }
  const ev = (c, expr) => c.send('Runtime.evaluate', { expression: expr, returnByValue: true }).then((r) => r.result.value);

  // Every tile connects and shows a commanded photo.
  const firstSrc = [];
  for (let k = 0; k < N; k++) {
    let s = null;
    for (let i = 0; i < 60; i++) { s = await ev(clients[k], SAMPLE); if (s.connected && s.active >= 1) break; await sleep(250); }
    check(`tile ${k + 1} connects + shows a commanded photo`, s.connected && s.active >= 1, `connected=${s.connected} active=${s.active} src=${(s.src || '').slice(0, 28)}`);
    firstSrc.push(s ? s.src : '');
  }

  // Admin sees all tiles online.
  const adminTiles = (await (await fetch(`${APP}/api/admin/tiles`)).json()).tiles || [];
  const online = adminTiles.filter((t) => t.online).length;
  check('admin registry sees all tiles online', online === N, `online=${online}/${N}`);

  // Command channel: show random on all -> each tile's image changes.
  await fetch(`${APP}/api/admin/showRandom`);
  let changed = 0, black = 0;
  for (let k = 0; k < N; k++) {
    let ok = false;
    for (let i = 0; i < 40; i++) {
      const s = await ev(clients[k], SAMPLE);
      if (s.active < 1) black++;
      if (s.src && s.src !== firstSrc[k]) { ok = true; break; }
      await sleep(200);
    }
    if (ok) changed++;
  }
  check('command channel updates every tile', changed === N, `changed=${changed}/${N}`);
  check('no blank frame during command swaps', black === 0, `blackSamples=${black}`);

  const failed = results.filter((r) => !r).length;
  console.log('---------------------------------------------');
  console.log(failed === 0 ? 'PHASE 0: ALL PASS' : `PHASE 0: ${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (e) {
  console.error('TEST ERROR:', e.message);
  process.exitCode = 1;
} finally {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
}
