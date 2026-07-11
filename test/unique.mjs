// Freshness rules: no two tiles show the same photo at the same time, and a
// photo that was shown recently doesn't come straight back. Drives 6 raw-WS
// tiles (no browser needed) through several wall swaps and inspects the photo
// ids the server hands out. Restores prior settings and removes its tiles.
const APP = 'http://localhost:4000';
const WS = 'ws://localhost:4000/ws';
const TILES = 6, ROUNDS = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const getJson = (p) => fetch(APP + p).then((r) => r.json());
const post = (p, b) => fetch(APP + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

// a minimal tile: registers, answers pings, records every photo id it's told to show
function fakeTile(deviceId) {
  const t = { id: deviceId, ws: new WebSocket(WS), shows: [], open: false };
  t.ws.addEventListener('open', () => {
    t.ws.send(JSON.stringify({ type: 'register', deviceId, w: 768, h: 1024, screenW: 768, screenH: 1024, dpr: 1, orientation: 'portrait' }));
    t.open = true;
  });
  t.ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'show' && m.id) t.shows.push(m.id);
    else if (m.type === 'ping') t.ws.send(JSON.stringify({ type: 'pong', t: m.t }));
  });
  return t;
}
const latest = (t) => t.shows[t.shows.length - 1];
const dupes = (arr) => arr.filter((x, i) => arr.indexOf(x) !== i);

const tilesList = [];
let saved = null;
try {
  saved = await getJson('/api/admin/scenes');
  await post('/api/admin/timing', { mode: 'sync', slideSec: 600 }); // park the clock; we trigger swaps ourselves
  await post('/api/admin/scene', { scene: 'random' }); // shared pool = duplicates guaranteed without the fix

  for (let i = 0; i < TILES; i++) tilesList.push(fakeTile(`uniq-test-${i}`));
  // every tile gets an initial show on register
  for (let i = 0; i < 80 && tilesList.some((t) => t.shows.length < 1); i++) await sleep(250);
  check('all tiles received an initial photo', tilesList.every((t) => t.shows.length >= 1), tilesList.map((t) => t.shows.length).join(','));
  let wall = tilesList.map(latest);
  check('initial wall has no duplicate photos', new Set(wall).size === wall.length, dupes(wall).join(',') || 'all distinct');

  for (let round = 1; round <= ROUNDS; round++) {
    const before = tilesList.map((t) => t.shows.length);
    await post('/api/admin/showRandom', {});
    for (let i = 0; i < 60 && tilesList.some((t, ix) => t.shows.length <= before[ix]); i++) await sleep(250);
    wall = tilesList.map(latest);
    check(`round ${round}: wall swap has no duplicates`, new Set(wall).size === wall.length, dupes(wall).join(',') || 'all distinct');
  }

  const all = tilesList.flatMap((t) => t.shows);
  check('no photo reappeared across the whole run (recent-history window)', new Set(all).size === all.length, `${all.length} shows, ${new Set(all).size} distinct` + (dupes(all).length ? ' — repeats: ' + [...new Set(dupes(all))].join(',') : ''));

  // ---- the same rules inside the PEOPLE scenes (per-pool recency) ----
  // trigger a wall swap and return the newest photo id per tile
  const newRound = async (trigger) => {
    const before = tilesList.map((t) => t.shows.length);
    await trigger();
    for (let i = 0; i < 60 && tilesList.some((t, ix) => t.shows.length <= before[ix]); i++) await sleep(250);
    return tilesList.map((t, ix) => t.shows.slice(before[ix]).pop());
  };
  // probe each person's pool size (the scene response reports the count)
  const ppl = ((await getJson('/api/people')).people || []).slice(0, 6);
  const probes = [];
  for (const p of ppl) {
    const rr = await post('/api/admin/scene', { scene: 'one-person', personId: p.id });
    probes.push({ id: p.id, name: p.name, count: (rr.info && rr.info.count) || 0 });
  }
  await sleep(1500); // let the probe pushes settle

  const best = probes.slice().sort((a, b) => b.count - a.count)[0];
  if (best && best.count >= TILES) {
    const rounds = [];
    rounds.push(await newRound(() => post('/api/admin/scene', { scene: 'one-person', personId: best.id })));
    for (let r = 0; r < 5; r++) rounds.push(await newRound(() => post('/api/admin/showRandom', {})));
    const walls = rounds.filter((w) => new Set(w).size === w.length).length;
    check('one-person: every wall swap free of duplicates', walls === rounds.length, `${walls}/${rounds.length} rounds clean, pool ${best.count}`);
    const stream = rounds.flat();
    if (best.count >= 60) {
      check('one-person: no repeats across the run', new Set(stream).size === stream.length, `${stream.length} shows from pool of ${best.count}`);
    } else {
      // small pool: repeats are inevitable, but must be spaced out by rotation
      const minGap = Math.max(1, Math.floor((best.count * 0.7) / TILES));
      let ok = true, worst = '';
      const lastRound = {};
      rounds.forEach((wall, ri) => wall.forEach((pid) => {
        if (lastRound[pid] != null && ri - lastRound[pid] < minGap) { ok = false; worst = `${pid} back after ${ri - lastRound[pid]} rounds (< ${minGap})`; }
        lastRound[pid] = ri;
      }));
      check('one-person: small-pool repeats are spaced out', ok, worst || `pool ${best.count}, min gap ${minGap} rounds`);
    }
  } else { console.log('SKIP one-person checks — no person with enough photos'); }

  const trio = probes.filter((p) => p.count >= 30).slice(0, 3);
  if (trio.length >= 2) {
    let asg = {};
    const rounds2 = [];
    rounds2.push(await newRound(async () => {
      const rr = await post('/api/admin/scene', { scene: 'different-people', personIds: trio.map((p) => p.id) });
      asg = (rr.info && rr.info.assignments) || {};
    }));
    for (let r = 0; r < 5; r++) rounds2.push(await newRound(() => post('/api/admin/showRandom', {})));
    const walls2 = rounds2.filter((w) => new Set(w).size === w.length).length;
    check('different-people: every wall swap free of duplicates', walls2 === rounds2.length, `${walls2}/${rounds2.length} rounds clean`);
    // within each person's own photo stream (their tiles combined), nothing repeats —
    // this is what a diluted global window used to get wrong
    const byPerson = {};
    tilesList.forEach((t, ix) => {
      const person = asg[t.id] ? asg[t.id].name : '?';
      rounds2.forEach((wall) => { (byPerson[person] = byPerson[person] || []).push(wall[ix]); });
    });
    let ok2 = true;
    const det = [];
    for (const [name, arr] of Object.entries(byPerson)) {
      det.push(`${name}: ${new Set(arr).size}/${arr.length}`);
      if (new Set(arr).size !== arr.length) ok2 = false;
    }
    check('different-people: no repeats within any one person\'s photos', ok2, det.join(', '));
  } else { console.log('SKIP different-people checks — fewer than 2 people with 30+ photos'); }

} catch (e) {
  console.error('TEST ERROR:', e.message);
  results.push(false);
} finally {
  for (const t of tilesList) { try { t.ws.close(); } catch {} }
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
  for (const t of tilesList) { try { await post('/api/admin/removeTile', { id: t.id }); } catch {} }
  const failed = results.filter((x) => !x).length;
  console.log('---------------------------------------------');
  console.log(failed === 0 ? 'UNIQUE: ALL PASS' : `UNIQUE: ${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}
