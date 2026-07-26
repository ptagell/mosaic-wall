// different-people, against a live server: selections survive a round-trip through
// other scenes, and the year histogram reports the whole wall rather than one tile.
const PORT = process.env.MOSAIC_PORT || '4000';
const APP = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}/ws`;
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
    if (m.type === 'show' && m.id) t.shows.push(m.id);
    else if (m.type === 'ping') t.ws.send(JSON.stringify({ type: 'pong', t: m.t }));
  });
  return t;
}

const tiles = [];
let saved = null;
const yrs = (s) => Object.keys(s.years || {}).filter((y) => y !== 'unknown').sort();
try {
  saved = await getJson('/api/admin/scenes');
  const people = (await getJson('/api/people')).people || [];
  check('library has enough named people to test', people.length >= 4, String(people.length));

  // two tiles, deliberately fewer than the selection, which is the case that broke
  for (let i = 0; i < 2; i++) tiles.push(fakeTile(`people-test-${i}`));
  for (let i = 0; i < 60 && tiles.some((t) => t.shows.length < 1); i++) await sleep(250);

  const pick = people.slice(0, Math.min(6, people.length)).map((p) => p.id);
  await post('/api/admin/timing', { mode: 'sync', slideSec: 600 });
  let s = await post('/api/admin/scene', { scene: 'different-people', personIds: pick });
  check('server reports the full selection', s.info && s.info.peopleCount === pick.length, String(s.info && s.info.peopleCount));

  const dpYears = yrs(s);
  check('histogram spans the whole selection, not one tile', dpYears.length >= 8, dpYears.join(','));

  // the histogram must not shrink when more people are added
  const small = await post('/api/admin/scene', { scene: 'different-people', personIds: pick.slice(0, 2) });
  const big = await post('/api/admin/scene', { scene: 'different-people', personIds: pick });
  check('adding people never shrinks the reported spread',
    yrs(big).length >= yrs(small).length,
    `${yrs(small).length} yrs with 2 -> ${yrs(big).length} yrs with ${pick.length}`);

  // selection survives a trip through another scene
  await post('/api/admin/scene', { scene: 'landscapes' });
  const back = await post('/api/admin/scene', { scene: 'different-people' });
  const kept = (back.config && back.config.personIds) || [];
  check('selection survives switching scenes and back',
    kept.length === pick.length && kept.every((id) => pick.includes(id)),
    `${kept.length}/${pick.length} kept`);

  // rotation actually moves people across tiles over successive swaps
  const seenPeople = new Set();
  for (let r = 0; r < 8; r++) {
    const snap = await getJson('/api/admin/scenes');
    Object.values((snap.info && snap.info.assignments) || {}).forEach((a) => seenPeople.add(a.name));
    await post('/api/admin/showRandom', {});
    await sleep(300);
  }
  check('rotation shows more people than there are tiles', seenPeople.size > tiles.length,
    `${seenPeople.size} people across ${tiles.length} tiles: ${[...seenPeople].join(',')}`);
} finally {
  for (const t of tiles) { try { await post('/api/admin/removeTile', { deviceId: t.id }); } catch {} t.ws.close(); }
  if (saved) {
    try { await post('/api/admin/scene', { scene: saved.active, config: saved.config || {} }); } catch {}
    try { await post('/api/admin/timing', { mode: saved.timing, slideSec: saved.slideSec }); } catch {}
  }
}
console.log(results.every(Boolean) ? '\nPEOPLE: ALL PASS' : '\nPEOPLE: FAILURES');
process.exit(results.every(Boolean) ? 0 : 1);
