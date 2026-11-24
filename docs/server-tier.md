# Server tier (sync backend + analysis), v1 - 2026-10-07

The browser was the whole app; this is the piece that makes one Lichess
account work across devices. The client stays the FSRS scheduler and keeps
working fully offline - the server is a sync store the client talks to when
it can, fire-and-forget.

```
browser A ─┐                        ┌─ cloudflared quick tunnel (lidrill-tunnel)
           ├─ lidrill.org Worker ───┤    https://…trycloudflare.com
browser B ─┘   /api/sync/*         └─ 127.0.0.1:8010  lidrill-server (FastAPI)
                  │                       │ per-account SQLite: /opt/lidrill/data/<user>.db
                  │ Lichess /api/account│
                  └─ (token validated   └─ analysis drainer (lidrill-analysis):
                     at the edge,        native Stockfish 19, one job at a time
                     cached 15 min)
```

## Components

- **lidrill-server** (`server/app.py`, systemd `lidrill-server`): loopback
  FastAPI. One SQLite DB per Lichess account; rows are opaque versions
  `{table, id, updatedAt, data}`. Every endpoint requires `X-Lidrill-Key`;
  only the Worker holds it.
- **lidrill-tunnel** (systemd `lidrill-tunnel`): a *second* cloudflared
  quick tunnel to the backend. The URL changes when the unit restarts - it is a Worker
  secret (`BACKEND_URL`), so updating it is `wrangler secret put`. A named
  tunnel with a stable `lidrill.org` hostname is the obvious v2 upgrade.
- **Worker `/api/sync/*`** (`worker/index.ts`): the internet door for sync. The
  client sends its Lichess token; the Worker validates it against Lichess
  `/api/account` (cached 15 min per token), uses the username as the account
  key, and forwards with the shared secret. The token never reaches the VM.
  A device with no Lichess account sends a sync key in its place
  (`src/sync/key.ts`), and its rows go under a hash of that key.
- **Worker `/api/maia/*`**: the same service also runs Maia-3 (`/maia/move`,
  `/maia/draw`, `/maia/policy`, described in `server/README.md`). These need
  no sign-in; the Worker checks the Origin and a per-visitor rate limit.
- **Client sync** (`src/sync/server.ts`, triggered from `Ctrl`): on sign-in,
  after every game sync, every 5 minutes, and on `online`.

## Sync semantics (v1)

- Tables: `games`, `puzzles` (cards live inside puzzles - the client remains
  the scheduler), `reviews`, `profile`, `syncState`, `journal`, `liPuzzle`,
  `practice`, `replaySessions`, `repertoire`, `openingCards` (`SYNC_TABLES`
  in `src/db.ts`, mirrored by `TABLES` in `server/app.py`). Explanations stay
  in the packet KV; `auth`, `explorer`, `certs` never sync.
- Local writes queue in `syncQueue` (Dexie hooks for keyed tables; the two
  auto-increment tables queue at their write sites). A pass pushes the
  queue's current row states, then pulls rows newer than the `pullSince`
  watermark (keyset-paginated at 500/page).
- Conflict rule per row: **newer `updatedAt` wins**, both directions. Push
  runs before pull within a pass, so a local write is always offered first;
  if the server already holds a newer version, the pull applies it and the
  stale queue entry is dropped.
- No tombstones: rows are only added/updated. `deleteEverything` is the one
  deletion - it flags a server wipe (`DELETE /u/<user>/rows`) so data doesn't
  resurrect on the next pull.
- Failures keep queue entries and watermarks untouched; only an expired
  Lichess sign-in (401) propagates, so the app signs out.

## Server-tier analysis

Pushed games without analysis enqueue a job (`jobs` table). The
`lidrill-analysis` daemon drains one job at a time across all accounts:
native Stockfish 19 (2 threads, `Nice=10`, depth 14) produces per-move
evals, judged by an exact Python port of the client's `analyze.ts`/`judge.ts`
(same white-POV eval entries, same lila thresholds, terminal positions as
cp ±10000, fixed 8-ply book skip = the client's explorer-down fallback). The
analyzed game is written back through the rows table with a fresh
`updatedAt`, so every device picks it up on the next pull; the client's
existing puzzle generator then runs on it as if it had analyzed the game
itself.

Not done: server-tier *certification* (`cert/1.0-server`, packets stamped
`server`). The packet builder is
TS in `src/server/packet.ts` and the current pipeline uploads client-lite
packets from the browser; running the same packet build + narrator natively
on the VM is a follow-up. `division`/`accuracy` stay Lichess-only fields.

## Operations

```sh
systemctl status lidrill-server lidrill-tunnel lidrill-analysis
journalctl -u lidrill-tunnel -g https | head -1   # the current tunnel URL
sudo systemctl restart lidrill-{server,tunnel,analysis}
```

Deploy: the site and the Worker go out from CI when `main` passes
(`.github/workflows/ci.yml`). The VM is updated by hand: `git pull` in
`/opt/lidrill/server` (a clone of the GitHub repo; the venv lives in its
`server/` subdirectory, next to `app.py`), then `systemctl restart …`. Worker
secrets: `wrangler secret put BACKEND_URL` (tunnel URL) and `LIDRILL_KEY`
(shared with `/etc/lidrill/server.env` on the VM). `ARCHITECTURE.md` lists
every variable on both sides.
