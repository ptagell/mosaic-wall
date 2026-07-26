// searchMetadata pagination: walks pages until a short page, reports each page,
// respects maxPages, and records timestamps without a cap.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const immich = require('../immich.js');

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

// Build a fake Immich holding `total` assets, newest first, one per day back from 2024-06-01.
function fakeServer(total) {
  const calls = [];
  const base = Date.parse('2024-06-01T00:00:00Z');
  return {
    calls,
    request(apiPath, method, body) {
      calls.push({ apiPath, body: JSON.parse(JSON.stringify(body || {})) });
      const size = body.size, page = body.page || 1;
      const start = (page - 1) * size;
      const items = [];
      for (let i = start; i < Math.min(start + size, total); i++) {
        items.push({ id: 'a' + i, localDateTime: new Date(base - i * 86400000).toISOString() });
      }
      return Promise.resolve({ assets: { total, count: items.length, items } });
    }
  };
}

async function run() {
  // --- paginate across exactly 2.5 pages
  let fake = fakeServer(2500);
  immich._setRequest(fake.request);
  let items = await immich.searchMetadata({}, { paginate: true });
  check('paginate returns every asset', items.length === 2500, String(items.length));
  check('paginate issues 3 requests', fake.calls.length === 3, String(fake.calls.length));
  check('pages are 1,2,3', fake.calls.map((c) => c.body.page || 1).join(',') === '1,2,3', fake.calls.map((c) => c.body.page).join(','));

  // --- exact multiple of page size needs one extra probe to learn it ended
  fake = fakeServer(2000);
  immich._setRequest(fake.request);
  items = await immich.searchMetadata({}, { paginate: true });
  check('exact-multiple returns every asset', items.length === 2000, String(items.length));

  // --- onPage fires per page, in order
  fake = fakeServer(2500);
  immich._setRequest(fake.request);
  const seen = [];
  await immich.searchMetadata({}, { paginate: true, onPage: (its, n) => seen.push(n + ':' + its.length) });
  check('onPage fires per page in order', seen.join(' ') === '1:1000 2:1000 3:500', seen.join(' '));

  // --- maxPages stops early
  fake = fakeServer(9000);
  immich._setRequest(fake.request);
  items = await immich.searchMetadata({}, { paginate: true, maxPages: 2 });
  check('maxPages caps the walk', items.length === 2000 && fake.calls.length === 2, `${items.length}/${fake.calls.length}`);

  // --- no paginate = single page, unchanged behaviour
  fake = fakeServer(5000);
  immich._setRequest(fake.request);
  items = await immich.searchMetadata({});
  check('without paginate, one page only', items.length === 1000 && fake.calls.length === 1, `${items.length}/${fake.calls.length}`);

  // --- filter keys are passed through and type/size are set
  check('filter merged into body', fake.calls[0].body.type === 'IMAGE' && fake.calls[0].body.size === 1000, JSON.stringify(fake.calls[0].body));

  // --- taken map is uncapped: 25k entries all survive
  fake = fakeServer(25000);
  immich._setRequest(fake.request);
  await immich.searchMetadata({}, { paginate: true });
  check('taken records the oldest asset (no 20k cap eviction)', immich.takenAt('a24999') !== null, String(immich.takenAt('a24999')));
  check('taken records the newest asset', immich.takenAt('a0') !== null, String(immich.takenAt('a0')));

  immich._setRequest(null);
  console.log(results.every(Boolean) ? '\nALL PASS' : '\nFAILURES');
  process.exit(results.every(Boolean) ? 0 : 1);
}
run();
