// Smart search runs per-year so landscapes/search span the library, while CLIP
// relevance ordering is preserved inside each year.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const immich = require('../immich.js');

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

async function run() {
  const calls = [];
  immich._setRequest((p, m, body) => {
    calls.push({ p, body });
    if (p.indexOf('/api/search/smart') !== 0) return Promise.resolve({ assets: { items: [] } });
    const y = new Date(body.takenAfter).getUTCFullYear();
    return Promise.resolve({ assets: { items: [{ id: 's' + y, localDateTime: `${y}-06-01T00:00:00Z` }] } });
  });

  const ids = await immich.searchSmart('beaches');
  const smartCalls = calls.filter((c) => c.p.indexOf('/api/search/smart') === 0);
  check('one query per year', smartCalls.length >= 10, String(smartCalls.length));
  check('every query is date-windowed', smartCalls.every((c) => c.body.takenAfter && c.body.takenBefore), JSON.stringify(smartCalls[0].body));
  check('every query carries the CLIP text', smartCalls.every((c) => c.body.query === 'beaches'));
  check('query size is bounded per year', smartCalls.every((c) => c.body.size <= 200), String(smartCalls[0].body.size));
  check('results span many years', new Set(ids.map((i) => i.slice(1))).size >= 10, String(new Set(ids.map((i) => i.slice(1))).size));

  // second call is served from cache
  const before = calls.length;
  await immich.searchSmart('beaches');
  check('repeat query is cached', calls.length === before, `${before} -> ${calls.length}`);

  // a failing year does not sink the whole search
  calls.length = 0;
  let n = 0;
  immich._setRequest((p, m, body) => {
    n++;
    if (n === 2) return Promise.reject(new Error('boom'));
    const y = new Date(body.takenAfter).getUTCFullYear();
    return Promise.resolve({ assets: { items: [{ id: 'f' + y, localDateTime: `${y}-06-01T00:00:00Z` }] } });
  });
  const partial = await immich.searchSmart('sunsets');
  check('one failing year still returns the rest', partial.length > 5, String(partial.length));

  immich._setRequest(null);
  console.log(results.every(Boolean) ? '\nALL PASS' : '\nFAILURES');
  process.exit(results.every(Boolean) ? 0 : 1);
}
run();
