# lidrill-server

The server tier's loopback backend (`docs/server-tier.md`).

- `app.py` - FastAPI sync store, one SQLite database per Lichess account at
  `$DATA_DIR/<username>.db`. Opaque row versions `{table, id, updatedAt,
  data}`; per-row conflict rule: newer `updatedAt` wins. Requires the
  `X-Lidrill-Key` shared secret on every endpoint; bind stays on 127.0.0.1 and
  the only doors from the internet are the lidrill Worker's `/api/sync/*` and
  `/api/maia/*` proxies.
- `analysis.py` + `analysis_daemon.py` - phase-2 analysis worker: native
  Stockfish 19 (multi-thread, one job at a time, `Nice=10`) judges pushed
  games with an exact port of the client's `analyze.ts`/`judge.ts`, writes
  the analyzed game back through the rows table, and clients pick it up on
  the next pull.
- `maia.py` - Maia-3 as an opponent: `POST /maia/move` takes a game as UCI
  moves and a level, and answers with one move sampled at the dial and
  temperature `maia-calibrate` gives for that level. torch and maia3
  (`requirements-maia.txt`) are loaded on the first move, so the sync store
  runs without them. The answer also carries `think`, the seconds a player at
  that level would take, drawn around a fit to human clocks held in
  `think.json`. An optional `clock` (`{base, inc, left}` in seconds, `left`
  being Maia's own) sets the pace from its base and increment and caps the
  time at a quarter of `left` plus the increment, so Maia never flags by
  itself. Without one the game is timed as 10+0 and capped at the
  `ceiling` in `think.json`. When Maia's value head has put its expected
  score under its band's threshold in `resign.json` on each of its last
  three turns, from the move given there on, it answers `{"resign": true}`
  with no `move` or `think`. `POST /maia/draw` takes `{moves, level}` with
  the player to move, as the player offers on their own turn, and answers
  `{"accept": bool}`.
- `openings.py` - `POST /maia/policy` takes `{moves, level}` like `/maia/move`
  and answers `{"moves": [{"uci", "p"}, ...]}`, every legal move with the
  probability Maia plays it, most likely first. The probabilities come from
  the same dial and temperature as a sampled move, and a level between two
  measured settings mixes their two distributions in the proportion
  `setting_for` picks them, so they match what the opponent plays. The
  opening trainer builds its trees from them.
- `fit_think.py` and `fit_resign.py` - rebuild `think.json`, `resign.json`
  and their tables (`think_fit.md`, `resign_fit.md`) from a Lichess monthly
  dump, scoring positions with Maia (two forward passes per sampled move for
  the think time, which also counts how surprising the opponent's last move
  was). They also need numpy and zstandard:
  `python fit_think.py lichess_db_standard_rated_2025-10.pgn.zst`.
- `systemd/` - the three VM units (`lidrill-server`, `lidrill-tunnel`,
  `lidrill-analysis`).

## Run (VM)

```sh
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
LIDRILL_KEY=… DATA_DIR=/opt/lidrill/data .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8010
```

The `/maia/*` endpoints also need `requirements-maia.txt`, which says how to
get the CPU build of torch.

## Run (local)

From the repo root, with the same venv, the key that is in `.dev.vars` and a
`DATA_DIR` you can write to (the default is the VM's `/opt/lidrill/data`):

```sh
LIDRILL_KEY=change-me-too DATA_DIR=/tmp/lidrill-data server/.venv/bin/python -m uvicorn app:app --app-dir server --port 8010
```

`bun run dev` then reports the backend as running.

## Test

```sh
.venv/bin/pip install pytest httpx
.venv/bin/pytest
```

The analysis tests script the engine (no Stockfish binary needed); app tests
use a throwaway `DATA_DIR` under this directory.
