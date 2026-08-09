# Tap-to-favourite + power notes

**Date:** 2026-08-09
**Status:** Approved, ready for implementation

## Problem

Two asks, one investigation:

1. Standing at the wall, there is no way to mark a photo worth keeping. Favouriting
   should be a tap on the iPad showing the photo, landing the asset in an Immich album
   ("Frame favourites") for later curation.
2. The larger iPad 5 units drain faster than they charge — they lose battery gradually
   through the day, then shut off. The original idea was browser brightness control;
   investigation showed CSS brightness cannot reduce power on these LCD panels (the
   backlight burns the same regardless of pixel values), and the observed 8W charge
   rate against the iPad 5's 12W (5V × 2.4A) maximum points at the flat AliExpress
   Lightning adapters as the throttle. The fixes are iOS-side and hardware-side, so
   they become **documentation, not code**. No brightness UI is built.

## Decisions

| Question | Decision |
|---|---|
| Gesture | Single tap opens a small modal (replaces today's caption-only peek). |
| Modal contents | Photo caption + ♥ "Add to favourites". Nothing else. |
| Favourite semantics | Add-only, idempotent. Immich duplicate response counts as success. |
| Album | `"Frame favourites"` by name; created if missing. Overridable via `FAVOURITES_ALBUM` env var. |
| Which photo | The one **on the glass**, not the server's `lastShow` — swaps can be scheduled up to 20s ahead, so the tile's own record is authoritative. |
| Transport | The existing WebSocket. No new HTTP endpoints. |
| Brightness / power | Out of scope for code. `docs/POWER.md` documents the real levers. |

## Architecture

| Module | Change |
|---|---|
| `tile.html` | Tap modal; slides remember their asset id; `favourite` / `favourited` WS messages. |
| `server.js` | `favourite` message handler: validate id, call helper, reply. |
| `immich.js` | `addToFavourites(assetId)` — album resolve/create/cache + add. |
| `docs/POWER.md` **(new)** | iOS-side power documentation. No code. |

### Tile: modal

- `show` messages already carry the Immich asset `id` (`server.js` sets it in both the
  normal and split branches); `showImage()` gains the id and stores it as
  `slide.__id`, beside the existing `slide.__cap`. Art slides (`showArt`) and mirror
  frames have no `__id`.
- The tap handler (today: `peekStatus`, dot + caption for 4s) instead opens a card
  anchored low on the screen: caption text (from `__cap`), and a ♥ **Add to
  favourites** button shown only when `currentSlide.__id` exists. The link-status dot
  keeps its current reveal behaviour.
- Dismissal: any tap outside the card, or ~8s with no interaction. A tap while the
  modal is open does not re-trigger opening.
- On ♥ tap: send `{type:'favourite', id: currentSlide.__id}`; the button becomes a
  transient status — "✓ Added to Frame favourites" on `{ok:true}`, "Couldn't add —
  try again" on `{ok:false}` **or after a 4s reply timeout**. The modal auto-dismisses
  a couple of seconds after the confirmation.
- ES5, `-webkit-` prefixed, old-Safari safe like the rest of the page. No new
  dependencies, no `<input type=range>`, no flex features beyond what the page
  already uses.

### Server: message handler

In the WS `message` switch, alongside `orientation`/`timesync`/`pong`:

- `favourite`: accept only ids matching the existing image-route pattern
  (`/^[a-f0-9-]+$/i`, length ≤ 64). Call `immich.addToFavourites(id)`; reply
  `{type:'favourited', id, ok}`. Errors log server-side; the tile only sees `ok`.

### Immich: `addToFavourites(assetId)`

```
resolve album id (cached)
  GET /api/albums → exact albumName match
  none → POST /api/albums {albumName}
PUT /api/albums/{albumId}/assets {ids:[assetId]}
  per-id result: success, or error "duplicate" → treated as success
  404 on the album (deleted since caching) → drop cache, re-resolve, retry once
```

- Album name from `process.env.FAVOURITES_ALBUM || 'Frame favourites'`.
- The album id is cached in a module variable for the process lifetime (the
  deleted-album retry is the invalidation path).
- Any other failure resolves `false`; nothing throws into the WS handler.

## Error handling

| Failure | Behaviour |
|---|---|
| Immich unreachable | Helper resolves `false`; tile shows "Couldn't add — try again". |
| Album deleted after caching | One re-resolve + retry; then `false`. |
| Asset already in album | Immich "duplicate" error → `ok:true`, "✓" shown. |
| No WS reply within 4s (socket dropped mid-request) | Tile shows the failure state. A duplicate later retry is harmless (idempotent). |
| Malformed / non-matching id | Server ignores the message. |
| ♥ tapped as the slide swaps | The id was captured from the slide the modal opened on — the photo the user saw. |

## `docs/POWER.md` contents

1. **Why browser brightness cannot help** — LCD backlight dominates panel power and
   is untouchable from Safari; CSS `brightness()` only darkens pixel values.
2. **Charge-rate finding** — iPad 5 maxes at 12W (5V × 2.4A) negotiated end-to-end;
   ~8W observed through the flat Lightning adapters means the adapter, not the
   upstream brick, is the limit. Verification procedure: same iPad, genuine cable,
   no adapter; compare wattage (Settings → Battery or an inline USB meter).
3. **Shortcuts automation** — per-iPad time-of-day automations using the
   "Set Brightness" action (e.g. minimum at the wall's sleep time, normal in the
   morning), so batteries catch up overnight behind the wall's existing `sleep`
   scene. Works alongside Guided Access.
4. **No Battery API** — iOS Safari exposes no battery level to web pages, so the wall
   cannot monitor or react to charge state; schedules are the only automation.

## Testing

### Unit — no server, no Immich (added to `npm test` loop)

**`test/favourites.mjs`**, using the existing `_setRequest` fake-transport hook:

- resolves an existing album by exact name and PUTs the asset into it
- creates the album when absent, then adds
- second call reuses the cached album id (no second GET)
- "duplicate" per-id error resolves `true`
- album 404 on PUT → re-resolve → retry once → success
- transport failure resolves `false` (never throws)

### Manual — real iPad

Tap a photo → modal shows caption + ♥ → tap ♥ → "✓ Added to Frame favourites" →
asset visible in the Immich album. Repeat on the same photo (still ✓). Tap during
art scene → no ♥, caption only. Stop Immich → ♥ shows the failure message.

## Out of scope

- Any brightness UI (wall-wide or per-tile) — dropped once the underlying problem
  proved to be power, which software brightness cannot affect on LCD.
- An eco/low-power rendering mode (declined for now; revisit if the adapter fix and
  Shortcuts schedule prove insufficient).
- Un-favouriting / album membership state on the tile.
- Battery telemetry (impossible from iOS Safari).
