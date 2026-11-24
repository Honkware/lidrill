# Architecture

lidrill is a static site that does its work in the browser, with two small services behind it. A Cloudflare Worker (`worker/index.ts`) answers `/api/*` on the same origin as the site, and a Python service (`server/app.py`) on a VM keeps the synced data and runs Maia-3. The browser only ever talks to the Worker. The Worker is the only client of the Python service.

## Browser

The app in `src/` fetches games from Lichess and Chess.com, analyses them with Stockfish 19 (a WebAssembly build in a web worker, copied to `public/engine/` by `scripts/copy-engine.mjs`), builds the puzzles and schedules them with FSRS (`ts-fsrs`). Everything is stored in IndexedDB through Dexie (`src/db.ts`), so the app works offline and without an account. The Lichess token stays in the browser's `auth` table.

## Worker

The Worker holds the secrets and the rate limits, so it is where anything that costs money or needs a key has to pass.

| Endpoint | Purpose | Checks |
| --- | --- | --- |
| `GET /api/challenge` | Issues a proof-of-work challenge signed with `POW_SECRET` | none |
| `POST /api/packet` | Builds a fact packet from the browser's Stockfish report and stores it in the `PACKETS` KV namespace for 30 days | Origin, proof of work, 30 a minute per IP |
| `POST /api/explain` | Has the model write an explanation from a packet, through OpenRouter, and caches the answer | Origin, proof of work, 8 a minute per IP |
| `POST /api/maia/move`, `/api/maia/draw` | Forwarded to the Python service | Origin, 60 a minute per IP |
| `POST /api/maia/policy` | Forwarded to the Python service | Origin, 300 a minute per IP |
| `POST /api/ping` | Counts the visit on the Python service under a daily hash of the address | Origin, 20 a minute per IP |
| `POST /api/flag` | Stores an explanation a player reported as wrong, with its position | Origin, 20 a minute per IP |
| `POST /api/evals/get`, `/api/evals/put` | Forwarded to the Python service | Origin, 120 a minute per IP |
| `/api/sync/*` | Forwarded to `/u/<username>/*` on the Python service | Lichess token or sync key, 240 a minute per account |

The Origin check accepts `lidrill.org`, `www.lidrill.org`, the `workers.dev` address and `http://localhost` on any port (`ORIGINS` in `worker/index.ts`). `http://127.0.0.1` is not on the list, so open the dev site as `localhost`. For sync the Worker asks Lichess who the token belongs to, caches the answer for 15 minutes, and sends only the username on. The token never reaches the VM. A player with no Lichess account syncs with a sync key instead (`src/sync/key.ts`): a random 130-bit secret the first device makes and the second is given as a code. The Worker asks nobody about it and forwards under `k_` and the first 40 hex characters of its SHA-256, so the VM never holds the key, and it holds one address to the account rate across all the keys it sends.

## Python service

`server/app.py` is a FastAPI app that listens on `127.0.0.1:8010`. It is separate from the Worker because it needs a disk and a CPU: one SQLite database per Lichess account holds the synced rows, and Maia-3 runs in PyTorch on the CPU, which costs nothing per move. Every endpoint needs the `X-Lidrill-Key` header, and it sends no CORS headers because no browser calls it.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Answers `{"ok": true}` |
| `POST /u/<user>/push`, `GET /u/<user>/pull` | Sync rows, newer `updatedAt` wins |
| `GET /u/<user>/state`, `DELETE /u/<user>/rows` | Row counts, and the wipe behind "delete everything" |
| `POST /maia/move`, `/maia/draw`, `/maia/policy` | Maia-3's move, its answer to a draw offer, and its move probabilities |
| `POST /evals/get`, `/evals/put` | Engine evals shared between browsers, kept by the hash of a game's moves |
| `POST /stats/ping`, `GET /stats` | Visit counts by day, and how many were active |
| `POST /stats/flag`, `GET /stats/flags` | Explanations players reported as wrong or unclear |

The tables it accepts (`TABLES` in `server/app.py`) have to match `SYNC_TABLES` in `src/db.ts`. A push with a table it does not know is refused with 400. The shared evals are the one thing stored outside an account. A game's evals are the same for whoever analyses it, so the browser asks for the games it is about to analyse (`src/analysis/shared.ts`), searches only the positions that come back empty and uploads what it found. They live in `DATA_DIR/shared/evals.db` under the SHA-256 of the search depth and the moves, with no player or game id, and an eval once stored is never replaced. This is what spares a Chess.com player, who has no account to sync under, the analysis on a second device. The puzzles are still made on each device.

Visits are counted in `DATA_DIR/shared/stats.db`. A page pings when it opens, when its visitor first touches a board and every five minutes while it is in front (`src/ping.ts`). The Worker replaces the address with a hash of it, the browser and the day, keyed with `POW_SECRET`, so a visitor is one row a day and can't be followed to the next. A visitor who has touched a board counts as active, which is the number to trust, since crawlers load pages but don't move pieces. `LIDRILL_VM=<ssh host> bun run stats` prints the counts. No public endpoint serves them. "Report this explanation" under an explanation stores its text and position in the same database, with nothing about the player, and `bun run stats flags` lists them.

`server/analysis_daemon.py` is a second process on the VM that analyses pushed games with native Stockfish. Sync is described in `docs/server-tier.md` and the Maia endpoints in `server/README.md`.

## Path of a request

A Maia move in production goes from the browser to `https://lidrill.org/api/maia/move`, where the Worker checks the Origin and the rate limit and posts the body to `BACKEND_URL/maia/move` with the key. `BACKEND_URL` is a cloudflared quick tunnel that ends at `127.0.0.1:8010` on the VM. Locally `bun run dev` puts Vite in front: the browser calls `http://localhost:5173/api/...`, Vite proxies it to `wrangler dev` on port 8787, and the Worker calls `http://127.0.0.1:8010` directly.

## Configuration

| Name | Side | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Worker secret | Pays for explanations |
| `POW_SECRET` | Worker secret | Signs proof-of-work challenges |
| `BACKEND_URL` | Worker secret | The tunnel's URL, which changes when the tunnel restarts |
| `LIDRILL_KEY` | Worker secret and Python service | The shared key, the same value on both sides |
| `DATA_DIR` | Python service and analysis daemon | Where the SQLite files go, `/opt/lidrill/data` unless set |
| `STOCKFISH`, `ANALYSIS_DEPTH` | Analysis daemon | The engine binary and the search depth, 14 unless set |

Locally the Worker reads its four from `.dev.vars`. On the VM the Python side reads `/etc/lidrill/server.env` through the systemd units in `server/systemd/`. The rate limits and the KV namespace are bindings in `wrangler.jsonc`.
