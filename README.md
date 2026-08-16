# Mosaic Wall

Turn a pile of old iPads into a synchronised photo wall, fed by your own
[Immich](https://immich.app) library.

This is the software half of a project written up in **[Reframing older
iPads][post]** — the other half is a set of 3D-printed iPad stands, which you
can download on [MakerWorld][makerworld]. You don't need the frames to use this;
any old tablet propped up somewhere will do.

[post]: https://example.com/reframing-old-ipads
[makerworld]: https://makerworld.com/

> **Replace the two links above** with the published post and model URLs.

## Why this exists

There are already several excellent photo-frame front-ends for Immich. The
problem is that they're built with modern web tooling, and an iPad 5 or iPad
mini 2 renders most of them as a blank white screen. Those old iPads can't
install current apps and can't update Safari — but they're exactly the devices
most likely to be sitting unused in a drawer.

So Mosaic Wall talks to the Immich REST API directly and serves a deliberately
old-fashioned page: no build step, no framework, no bundler, ES5-flavoured
JavaScript that ancient Safari can actually parse. Once that constraint was
handled, it became possible to add the things a single-device frame app can't
do — laying tiles out in space, splitting one image across several screens, and
sweeping changes across the wall.

## What it does

You run one server. It serves two pages:

- **`/`** — the *tile* view. Open this on each iPad and add it to the home
  screen. Each tile registers itself over a WebSocket and does what it's told.
- **`/admin`** — the control panel. Pick what the whole wall is doing, arrange
  the tiles in space, tune the look, set a schedule.

Because the server knows where every tile is (you place them on a grid in the
admin, much like arranging displays on a Mac), it can treat the wall as one
surface rather than N independent frames.

### Scenes

| Scene | What it shows |
| --- | --- |
| **Random** | Any photo from the pool — a different one per tile. |
| **One person** | The whole wall shows photos of a single person. |
| **Different people** | Each tile is assigned a different person (you choose who). |
| **Landscapes** | Scenery with no people, across the wall. |
| **On this day** | Today's date across the years. |
| **Favourites** | Your Immich favourites — a curated best-of. |
| **Search** | A smart (CLIP) text search across the library. |
| **Art** | Generative art painted live across the wall instead of photos. |
| **Split image** | One picture spread across the placed tiles, video-wall style. |
| **Mirror** | Live feed from one camera, split across the wall (open `/camera`). |

The people scenes lean on Immich's face recognition, which does the hard part.

### Look and motion

- **Looks:** `none`, `grayscale`, `sepia`, `warm`, `punch`, `noir` — subtle
  grading so a mixed library feels consistent.
- **Transitions:** `fade`, `slide`, `zoom`, `random`.
- **Timing:** `sync` (all tiles together), `stagger`, or `wave` (a sweep across
  the wall — left-right, top-bottom, or diagonal).
- **Effects:** `bokeh`, `snow`, `embers`, `stars`, `network`, `aurora`, `glass`.
- **Art pieces:** `plasma`, `lava`, `kaleido`, `julia`, `tunnel`, `waves`,
  `flow`, `phyllo`, `spiro`, `metaballs`.

### Tap to favourite

Tap any tile and a small panel appears with the photo's caption and a ♥ button
that adds it to an Immich album (`Frame favourites` by default, created on
first use). With several screens showing the same library, curating a best-of
album stops being a chore — anyone walking past can do it with one tap.

### Schedule

Scenes can change on a schedule, including a sleep window that blacks the
screens overnight. Note that blacking the pixels does **not** turn off an LCD
backlight — see [`docs/POWER.md`](docs/POWER.md) for what actually saves power.

## Requirements

- An Immich server you can reach over the network, and an API key.
- Node.js 18+, or Docker.
- One or more tablets with a browser. Genuinely old ones are the point.

## Quick start

```bash
git clone <your-fork-url> mosaic_wall
cd mosaic_wall
cp .env.example .env
```

Edit `.env` and set at minimum `IMMICH_URL` and `IMMICH_API_KEY`. Create the key
in Immich under **Account Settings → API Keys**. Read access is enough unless
you want tap-to-favourite, which also needs album read/write.

With Docker:

```bash
docker compose up -d --build
docker compose logs -f mosaic-wall
```

Or directly:

```bash
npm install
npm start
```

Then open `http://<server>:4000/admin` to drive it, and
`http://<server>:4000/` on each iPad.

On first run the server scans your library and writes a photo index to
`data/photo-index.json`. A large library takes a few minutes; watch for
`[mosaic] photo pool loaded: N ids` in the logs. The index is refreshed
incrementally after that.

## Configuration

Everything is environment variables — see `.env.example` for the full annotated
list. The ones that matter:

| Variable | Default | Purpose |
| --- | --- | --- |
| `IMMICH_URL` | `http://localhost:2283` | Base URL of your Immich server. |
| `IMMICH_API_KEY` | *(none)* | Immich API key. **Required.** |
| `PORT` | `4000` | Port the server listens on. |
| `DATA_DIR` | `./data` | Where the photo index and tile registry live. |
| `TZ` | `UTC` | Timezone for the schedule feature. |
| `FAVOURITES_ALBUM` | `Frame favourites` | Album that tap-to-favourite writes to. |
| `PERSON_IDS` | *(all)* | Restrict people scenes to specific Immich person IDs. |
| `SLIDE_INTERVAL` | `15000` | Milliseconds between photo changes. |

## Setting up the iPads

A few settings make an old iPad behave like an appliance rather than a tablet:

- **No Apple ID signed in** — avoids sign-in nags interrupting the display.
- **No passcode** — so it comes straight back after a power cut.
- **Auto-Lock set to Never** (Settings → Display & Brightness).
- **Auto-brightness off**, and brightness set to whatever the room needs.

Then visit the server URL — ideally on a static IP or a stable hostname — and
use **Share → Add to Home Screen**. Launching from that icon opens the page
full-screen with no browser chrome. Guided Access will keep it there.

### A note on power

The larger iPads draw roughly 7–15 W to stay on continuously, and it is
genuinely easy to end up in a slow discharge you don't notice for a day. Both
the charger *and* the cable have to carry it, and cheap slimline Lightning
adapters are frequently the bottleneck. [`docs/POWER.md`](docs/POWER.md) has the
measurements and the fixes.

### Recommended settings

Turn the slide interval **up**. A wall that changes every fifteen seconds is
restless and pulls your eye all day; one that changes every few minutes lets
you actually notice and enjoy a photo. Longer intervals are also easier on the
battery.

## Security

**This is a LAN appliance. Do not expose it to the internet.**

There is no authentication of any kind. Anyone who can reach the port can open
`/admin`, change what the wall is showing, and fetch any photo from your
library through the image proxy. That's a deliberate trade for a device on a
trusted home network with no keyboard attached — but it means you must not
port-forward it, and you should think twice before running it on a network you
share with people you don't know.

The server sends no CORS headers, so a random website open in a browser on your
network can't script the admin API. Keep it that way.

Your Immich API key stays server-side; it is never sent to the tiles.

## Development

```bash
npm test
```

The unit tests are dependency-free Node scripts under `test/`. Files ending in
`_live.mjs` expect a server already running on `localhost:4000` and are not part
of `npm test`. `test/favourite_e2e.mjs` spins up a mock Immich and a real server
process, so it needs no credentials.

Design notes and implementation plans live in [`docs/`](docs/).

## Contributing

PRs welcome — particularly for other tablet form factors, additional scenes, and
art pieces. Please keep the tile page compatible with old Safari: no build step,
no modern syntax that would break on iOS 12.

## Licence

MIT — see [LICENSE](LICENSE).
