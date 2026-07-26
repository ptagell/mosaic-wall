# Time-spread photo selection

**Date:** 2026-07-26
**Status:** Approved, ready for implementation

## Problem

The wall shows almost exclusively recent photos. The cause is in pool construction,
not the picker.

`searchMetadata()` (`immich.js:46-54`) requests a single page:

```js
const body = { size: PAGE_SIZE, type: 'IMAGE' };   // PAGE_SIZE = 1000
return immichRequest('/api/search/metadata', 'POST', body)
```

Two consequences:

1. **No `page` parameter** — only page 1 is ever fetched. Immich caps `size` at 1000
   per request, so raising `PAGE_SIZE` cannot help.
2. **No `order` parameter** — Immich defaults to descending, so page 1 *is* the 1000
   most recent assets.

For a library of ~200,000 photos, every pool is "the newest 1000 matching assets".
Older photos are unreachable. This affects the default (`random`) pool, per-person
pools, and favourites. `pickPhoto()` (`server.js:224-242`) is not at fault — it draws
uniformly, faithfully randomising a truncated list.

`on-this-day` is unaffected (its queries are date-scoped by construction).

## Goal

Show a broad range of years. Coverage, not curation — the aim is that a decade of
photos surfaces, not that the best photos surface.

## Decisions

| Question | Decision |
|---|---|
| Distribution | Even across **years**. 2012 (200 photos) gets the same airtime as 2024 (8,000). |
| Spread visible when? | **Over time.** No per-tile era assignment; a single instant may show three 2019 photos. |
| Scenes covered | Random, one-person, different-people, favourites, landscapes, search. |
| Library pool | **Full scan** of all ~200k, not a sample. |
| Persistence | **Yes** — year buckets persist to `DATA_DIR`. |

### Why a full scan is affordable

A completed year never changes, so it is never re-fetched. The ~200-request scan is a
one-time cost, not a recurring one. This is what makes exhaustive scanning viable at
200k; without it the scan would recur daily and a per-year sample would be preferable.

Past years *can* change in three ways, all handled without rescanning:

- **Back-dated archive import** — new assets with old `localDateTime`. Bumps
  `updatedAt`, so the `updatedAfter` delta catches them and files them by their true year.
- **EXIF date correction** — moves a photo between years. Also bumps `updatedAt`; the
  delta re-files it (removing it from its previous bucket).
- **Deletion** — does *not* bump `updatedAt`. Caught by a `trashedAfter` delta, with
  lazy 404 eviction as a safety net.

### One delta pass feeds every index

A new photo of Alice must reach both `library` and `person:alice`. Running a separate
delta per index would multiply requests by the number of tracked people. Instead the
`updatedAfter` delta is issued **once** with `withPeople: true`; each returned asset
carries its people and its `isFavorite` flag, so a single pass files it into the
library bucket, every matching person bucket, and favourites if applicable.

This keeps the hourly cost at two requests regardless of how many people are tracked.
A person index that does not exist yet is not created by deltas — it is built by a
full scan on first use.

### Rejected alternatives

- **Per-year sampling for the library pool** (~20 requests, ~1000/year). Visually
  indistinguishable and much cheaper per scan, but made unnecessary by year immutability.
- **Rotating era window** — shift the date window each refresh. Nearly free, but parks
  the wall in one era for an hour at a time.
- **Balancing in the pool rather than the picker** — equal quota per year, uniform draw.
  Simpler, but only approximate: a year holding fewer photos than the quota stays
  under-represented.

## Architecture

Three modules, split by concern. `immich.js` (299 lines) would exceed 500 absorbing
scanning, bucketing and persistence, and `server.js` is already 889 lines.

| Module | Responsibility |
|---|---|
| `immich.js` | HTTP client for Immich. Gains a `paginate` option on `searchMetadata`. Retains per-asset concerns: `getFocus`, `getAssetInfo`, `proxyImage`, `getPeople`, `getOnThisDay`. |
| `photo_index.js` **(new)** | Year-bucketed index, persistence, scan/delta lifecycle. |
| `picker.js` **(new)** | Pure selection function. Extracted from `server.js` so selection is unit-testable without a live server. |
| `scenes.js` | Unchanged in shape; five callsites repoint from `immich.*` to `photoIndex.*`. |
| `server.js` | Delegates to `picker.js`; owns the scan/delta schedule. |

### `photo_index.js` interface

```
pool(key)          -> [id, ...]              flat, for moments / split-image / existing consumers
buckets(key)       -> { year: [id, ...] }    strata, for the picker
takenAt(id)        -> epoch ms | null        for moments clustering
histogram(key)     -> { year: count }        for the admin readout
ensure(key, filter)-> Promise                start/complete a scan
applyDeltas()      -> Promise                updatedAfter + trashedAfter
evict(id)                                    lazy 404 removal
onUpdate(cb)                                 fired when a background scan completes
```

Keys: `library`, `person:<id>`, `favorites`, `smart:<query>`.

**The public contract stays flat id arrays.** `scenes.js`, `moments`, split-image and
the existing tests are unaffected by the internal bucketing.

### Persistence

`path.join(DATA_DIR, 'photo-index.json')`, following the `registry.json` convention
(`server.js:23-24`). `data/` is already gitignored and bind-mounted in
`docker-compose.yml`.

```js
{ version: 1,
  taken:   { "<id>": 1699999999999, ... },        // shared across all indexes
  indexes: {
    "library":     { years: {2011:[ids],...}, complete: {2011:true,...}, lastDelta },
    "person:<id>": { ... },
    "favorites":   { ... }
  } }
```

One shared `taken` map rather than per-index copies. It replaces the current
`takenMap` and its 20,000-entry cap (`immich.js:66`) — that cap would silently evict
year data for most of a 200k library, and because `capCache` evicts in insertion order
rather than LRU, it would evict the oldest-fetched entries first.

Writes are atomic (temp file + rename) and debounced (~5 min) so deltas do not thrash
the disk. `version` forces a clean rescan when the schema changes.

`complete[year]` encodes year immutability: a complete year is never re-fetched.

## Selection

Pick the **year first, then the photo within it**.

```js
function pickPhoto(id) {
  var pool = poolFor(id);
  if (isMoment(pool)) { return pickUniform(pool, id); }   // one event = one year
  var buckets = bucketsFor(pool);
  var years = shuffled(Object.keys(buckets));
  for (var i = 0; i < years.length; i++) {
    var cand = eligible(buckets[years[i]], id);
    if (cand.length) { return randomFrom(cand); }
  }
  return stalestAcross(pool, id);
}
```

`eligible()` is today's logic verbatim — not on another tile, not this tile's current
photo, not within `recentWindow` — applied to one bucket. **All existing freshness
semantics are preserved; only the final draw changes.**

Walking a shuffled year list gives a uniform year choice with automatic fallthrough:
a sparse year whose photos are all in the recent window yields to the next year rather
than returning nothing.

### Why year-first rather than filter-then-stratify

`pickPhoto` currently performs ~4 full `pool.filter()` passes per tile
(`server.js:230-241`). Free at 1000 ids; ~7M operations per swap cycle at 200k.
Scoping each pass to a single bucket (~10k ids) keeps the hot path cheaper than a naive
port. `recentWindow` is scoped to the bucket for the same reason, which additionally
makes its 75% cap a per-year budget.

`bucketsFor` returns the index's native buckets when the pool has a key, and memoizes
on-demand grouping (WeakMap keyed on array identity) only for synthetic pools.

Photos with no known timestamp go into an `unknown` stratum, treated as one more year.

### Smart-search scenes

`landscapes` and `search` rank by CLIP relevance, so "all results" is not meaningful —
full pagination would return most of the library in relevance order. `SmartSearchDto`
accepts `takenAfter`/`takenBefore`, so these run the CLIP query **per year** with a
bounded size. Relevance is preserved within each year; balance comes from the year
strata. These pools are not persisted (queries are open-ended); they use the existing
`LIST_CACHE_TTL`.

## Refresh schedule

| Event | Action | Requests |
|---|---|---|
| First boot | Full scan, progressive, background | ~200 |
| Later boots | Load from disk | 0 |
| Hourly (`POOL_REFRESH_MS`) | `updatedAfter` + `trashedAfter` deltas | 2 |
| Daily (`FULL_RESCAN_MS`, new) | Rescan current year only | ~10-20 |
| Completed past years | Never re-fetched | 0 |
| Scene switch / admin change | Served from cached pool | 0 |
| New face pool, first use | Full scan for that person | 3-8 |

The scan is **progressive**: the wall shows photos from the first page while the rest
loads in the background. Boot is never blocked. `onUpdate` triggers `resolveScene()`
when a scan completes so pools pick up the full set.

The scan runs at **limited concurrency (3-4 in flight)**. It is background work;
gentleness toward Immich matters more than finishing quickly.

## Error handling

| Failure | Behaviour |
|---|---|
| Corrupt / unparseable cache file | Log, discard, full rescan. Never blocks boot. |
| `version` mismatch | Clean rescan. |
| Killed mid-scan | `complete[year]` is set only when a year finishes, so partial years rescan next boot. No resume bookkeeping. |
| Delta query fails | Log; **leave `lastDelta` unadvanced** so the next tick retries the same window. Advancing on failure would permanently lose that hour's uploads. |
| `trashedAfter` unsupported | Probe once, log, fall back to lazy eviction alone. |
| Immich unreachable at boot | Wall runs entirely from the cache file — an improvement over today, where it shows nothing. |
| Thumbnail 404 | Lazy-evict from **every** index and from `taken` together, so no index is left holding an id whose timestamp has gone. **Only on 404/400** — never on 5xx or timeout, which are transient and must not prune the pool. |
| Concurrent scans | Guard flag; a second request is a no-op while one runs. |

## Memory

~20MB of bucket arrays plus ~20MB for `taken` — **~40-50MB resident** for the library
index, plus a few MB for person indexes. Boot parses ~10MB of JSON once (~150ms).

`JSON.stringify` on a ~10MB structure blocks the event loop for roughly 100ms. At a
5-minute write debounce this is invisible, but it is a real pause.

No new dependencies; `ws` remains the only one.

## Testing

### Unit — no server, no Immich

Following the monkey-patch style of `test/scenes.mjs`.

- **`index_scan.mjs`** — pagination walks pages until short; ids assembled; years marked
  complete; stops correctly.
- **`index_delta.mjs`** — a single delta pass files one asset into library, every
  matching person index, and favourites; a back-dated archive import lands in an old
  year; a date correction re-files between buckets; `trashedAfter` evicts from all
  indexes; a failed delta does not advance the watermark.
- **`index_persist.mjs`** — write/read round-trip; corrupt file and version bump both
  force a clean rescan; an incomplete year resumes.
- **`spread.mjs`** — *the test that proves the feature.* Synthetic buckets with
  deliberately lopsided sizes (2011: 20 photos, 2024: 8,000); N draws through
  `picker.js`; assert each year's share falls within tolerance of uniform. Also assert
  freshness invariants hold under stratification: no duplicate across the wall, no
  immediate repeat.

### Integration — existing live-server tier

- **`unique.mjs`** — must still pass unchanged; freshness semantics are deliberately
  untouched.
- **`spread_live.mjs`** — drive tiles through many rounds against the real library,
  resolve shown ids to years, assert coverage spans a wide year range.

## Admin readout

`/api/admin/scenes` already returns an `info` block. Add the active pool's year
histogram and render it in `admin.html`, so the spread can be confirmed directly
(`2009: 340, 2010: 512, ...`) rather than by watching the wall.

## Out of scope

- Per-tile era assignment ("2011 next to 2023" at a glance). Decided against; would be
  a separate "Through the years" scene.
- Changes to `on-this-day`, which is already date-scoped.
- Any change to freshness or `moments` semantics.
