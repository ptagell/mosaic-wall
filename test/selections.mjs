// Content-selection test: people subset for "different people", favourites, and
// smart search. API-level (no browser). Restores the operator's scene afterward.
const APP = 'http://localhost:4000';
const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const getJson = (p) => fetch(APP + p).then((r) => r.json());
const post = (p, b) => fetch(APP + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));

let saved = null;
try {
  saved = await getJson('/api/admin/scenes');
  const people = (await getJson('/api/people')).people || [];

  check('catalogue includes favourites + search', ['favorites', 'search'].every((k) => saved.scenes.some((s) => s.key === k)));

  if (people.length >= 2) {
    const subset = [people[0].id, people[1].id];
    let r = await post('/api/admin/scene', { scene: 'different-people', personIds: subset });
    check('different-people honours a chosen subset', r.status === 200 && r.body.info.peopleCount === 2, 'peopleCount=' + r.body.info.peopleCount);
    r = await getJson('/api/admin/scenes');
    check('subset persisted in scene config', (r.config.personIds || []).length === 2, JSON.stringify(r.config.personIds));
    r = await post('/api/admin/scene', { scene: 'different-people', personIds: [] });
    check('empty subset = everyone', r.body.info.peopleCount === people.length, `peopleCount=${r.body.info.peopleCount} total=${people.length}`);
  } else {
    check('different-people subset (skipped — need 2+ people)', true);
  }

  let r = await post('/api/admin/scene', { scene: 'favorites' });
  check('favourites scene accepted', r.status === 200 && r.body.active === 'favorites', 'count=' + r.body.info.count);

  r = await post('/api/admin/scene', { scene: 'search', query: 'sunset over water' });
  check('search accepted + CLIP ran', r.status === 200 && r.body.active === 'search' && r.body.info.query === 'sunset over water', 'matches=' + r.body.info.count);
  r = await getJson('/api/admin/scenes');
  check('search query persisted', r.config.query === 'sunset over water');

  r = await post('/api/admin/scene', { scene: 'search', query: '' });
  check('empty query falls back to the pool', r.body.active === 'search' && r.body.info.count > 0, 'count=' + r.body.info.count);

} catch (e) {
  console.error('TEST ERROR:', e.message);
  results.push(false);
} finally {
  if (saved) {
    try { await post('/api/admin/scene', saved.active === 'one-person' && saved.config && saved.config.personId ? { scene: saved.active, personId: saved.config.personId } : { scene: saved.active || 'random' }); } catch {}
  }
  const failed = results.filter((x) => !x).length;
  console.log('---------------------------------------------');
  console.log(failed === 0 ? 'SELECTIONS: ALL PASS' : `SELECTIONS: ${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}
