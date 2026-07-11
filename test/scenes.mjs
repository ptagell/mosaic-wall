// Scene engine acceptance (unit). Mocks the Immich content layer with canned
// data so resolvePools() is tested in isolation — no server, no live Immich.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const immich = require('../immich.js');
const scenes = require('../scenes.js');

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- canned content ----
const PEOPLE = [{ id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' }, { id: 'p3', name: 'Cara' }];
const PHOTOS = { p1: ['a1', 'a2', 'a3'], p2: ['b1', 'b2'], p3: [] }; // p3 has none
const DEFAULT = ['d1', 'd2', 'd3', 'd4'];
const SMART = ['s1', 's2', 's3'];

// scenes.js holds a live reference to this same module object, so patching works
immich.getPeople = () => Promise.resolve(PEOPLE);
immich.getPersonPhotoIds = (id) => Promise.resolve(PHOTOS[id] || []);
immich.searchSmart = () => Promise.resolve(SMART);
immich.getPhotoIdsForSelection = () => Promise.resolve(DEFAULT);

const ctx = { defaultPool: () => Promise.resolve(DEFAULT) };
const tiles = ['t-a', 't-b', 't-c'];

async function run() {
  let r;

  r = await scenes.resolvePools('random', {}, tiles, ctx);
  check('random: every tile shares the default pool', tiles.every(id => same(r.pools[id], DEFAULT)) && r.info.count === 4);

  r = await scenes.resolvePools('one-person', { personId: 'p1' }, tiles, ctx);
  check('one-person: whole wall shows the chosen person',
    tiles.every(id => same(r.pools[id], PHOTOS.p1)) && r.info.personName === 'Alice' && r.info.count === 3);

  r = await scenes.resolvePools('one-person', {}, tiles, ctx);
  check('one-person auto: picks the first person', r.info.personId === 'p1', r.info.personId);

  r = await scenes.resolvePools('one-person', { personId: 'p3' }, tiles, ctx);
  check('one-person with no photos falls back to default', tiles.every(id => same(r.pools[id], DEFAULT)));

  r = await scenes.resolvePools('different-people', {}, tiles, ctx);
  const a = r.info.assignments;
  check('different-people: distinct round-robin assignment',
    a['t-a'].id === 'p1' && a['t-b'].id === 'p2' && a['t-c'].id === 'p3',
    JSON.stringify({ 'a': a['t-a'].name, 'b': a['t-b'].name, 'c': a['t-c'].name }));
  check('different-people: each tile draws its own person (empty p3 -> default)',
    same(r.pools['t-a'], PHOTOS.p1) && same(r.pools['t-b'], PHOTOS.p2) && same(r.pools['t-c'], DEFAULT));

  r = await scenes.resolvePools('different-people', {}, ['x1', 'x2', 'x3', 'x4'], ctx);
  check('different-people wraps when tiles > people', r.info.assignments['x4'].id === 'p1', r.info.assignments['x4'].name);

  r = await scenes.resolvePools('landscapes', {}, tiles, ctx);
  check('landscapes: shared smart-search pool', tiles.every(id => same(r.pools[id], SMART)) && r.info.count === 3);

  r = await scenes.resolvePools('random', {}, [], ctx);
  check('no tiles -> empty pools', Object.keys(r.pools).length === 0);

  r = await scenes.resolvePools('bogus-scene', {}, tiles, ctx);
  check('unknown scene falls back to the default pool', tiles.every(id => same(r.pools[id], DEFAULT)));

  check('isScene() recognises the catalogue', scenes.SCENES.every(s => scenes.isScene(s.key)) && !scenes.isScene('nope'));

  const failed = results.filter(x => !x).length;
  console.log('---------------------------------------------');
  console.log(failed === 0 ? 'SCENES: ALL PASS' : `SCENES: ${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}
run();
