// End-to-end proof against the real library: drive tiles through many swaps and
// confirm the photos actually shown span many years, not just recent ones.
// Needs a running server (MOSAIC_PORT, default 4000) pointed at a real Immich.
const PORT = process.env.MOSAIC_PORT || '4000';
const APP = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}/ws`;
const TILES = 4, ROUNDS = 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const getJson = (p) => fetch(APP + p).then((r) => r.json());
const post = (p, b) => fetch(APP + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

function fakeTile(deviceId) {
  const t = { id: deviceId, ws: new WebSocket(WS), shows: [] };
  t.ws.addEventListener('open', () => t.ws.send(JSON.stringify({
    type: 'register', deviceId, w: 768, h: 1024, screenW: 768, screenH: 1024, dpr: 1, orientation: 'portrait'
  })));
  t.ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    // the show message already carries the caption date, so years resolve
    // straight off the stream — no extra request per photo
    if (m.type === 'show' && m.id) t.shows.push({ id: m.id, date: (m.info && m.info.date) || '' });
    else if (m.type === 'ping') t.ws.send(JSON.stringify({ type: 'pong', t: m.t }));
  });
  return t;
}

const tiles = [];
let saved = null;
try {
  saved = await getJson('/api/admin/scenes');
  await post('/api/admin/timing', { mode: 'sync', slideSec: 600 }); // park the clock; we drive swaps
  await post('/api/admin/scene', { scene: 'random' });

  // the pool must actually span years before the picker can spread across them
  const snap = await getJson('/api/admin/scenes');
  const poolYears = Object.keys(snap.years || {}).filter((y) => y !== 'unknown').map(Number).sort((a, b) => a - b);
  check('pool spans many years', poolYears.length >= 8, poolYears.join(','));
  check('pool reaches back more than 5 years',
    poolYears.length && (poolYears[poolYears.length - 1] - poolYears[0]) >= 5,
    `${poolYears[0]}-${poolYears[poolYears.length - 1]}`);

  for (let i = 0; i < TILES; i++) tiles.push(fakeTile(`spread-test-${i}`));
  for (let i = 0; i < 80 && tiles.some((t) => t.shows.length < 1); i++) await sleep(250);
  check('all tiles received an initial photo', tiles.every((t) => t.shows.length >= 1), tiles.map((t) => t.shows.length).join(','));

  for (let r = 0; r < ROUNDS; r++) { await post('/api/admin/showRandom', {}); await sleep(350); }

  const shown = tiles.flatMap((t) => t.shows);
  check('collected a decent sample', shown.length >= 60, String(shown.length));

  const years = [];
  for (const s of shown) {
    const m = s.date && String(s.date).match(/\b(19|20)\d{2}\b/);
    if (m) years.push(Number(m[0]));
  }
  const distinct = [...new Set(years)].sort((a, b) => a - b);
  check('resolved years for the sample', years.length > 0, `${years.length}/${shown.length} resolved`);
  check('shown photos span several distinct years', distinct.length >= 5, distinct.join(','));
  check('shown photos are not all from the last two years',
    distinct.length > 0 && (distinct[distinct.length - 1] - distinct[0]) >= 5,
    `${distinct[0]}-${distinct[distinct.length - 1]}`);

  // no single year should swallow the sample
  const counts = {};
  years.forEach((y) => { counts[y] = (counts[y] || 0) + 1; });
  const top = Math.max(...Object.values(counts));
  check('no single year dominates the sample', top / years.length < 0.5,
    `top year ${(top / years.length * 100).toFixed(0)}%  ${JSON.stringify(counts)}`);
} finally {
  for (const t of tiles) { try { await post('/api/admin/removeTile', { deviceId: t.id }); } catch {} t.ws.close(); }
  if (saved) {
    try { await post('/api/admin/scene', { scene: saved.active, config: saved.config || {} }); } catch {}
    try { await post('/api/admin/timing', { mode: saved.timing, slideSec: saved.slideSec }); } catch {}
  }
}
console.log(results.every(Boolean) ? '\nSPREAD: ALL PASS' : '\nSPREAD: FAILURES');
process.exit(results.every(Boolean) ? 0 : 1);
