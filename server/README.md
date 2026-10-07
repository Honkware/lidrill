# lidrill-server

The server tier's loopback backend (`docs/server-tier.md`).

- `app.py` - FastAPI sync store, one SQLite database per Lichess account at
  `$DATA_DIR/<username>.db`. Opaque row versions `{table, id, updatedAt,
  data}`; per-row conflict rule: newer `updatedAt` wins. Requires the
  `X-Lidrill-Key` shared secret on every endpoint; bind stays on 127.0.0.1 and
  the only door from the internet is the lidrill Worker's `/api/sync/*` proxy.
- `analysis.py` + `analysis_daemon.py` - phase-2 analysis worker: native
  Stockfish 19 (multi-thread, one job at a time, `Nice=10`) judges pushed
  games with an exact port of the client's `analyze.ts`/`judge.ts`, writes
  the analyzed game back through the rows table, and clients pick it up on
  the next pull.
- `systemd/` - the three VM units (`lidrill-server`, `lidrill-tunnel`,
  `lidrill-analysis`).

## Run (VM)

```sh
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
LIDRILL_KEY=… DATA_DIR=/opt/lidrill/data .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8010
```

## Test

```sh
.venv/bin/pip install pytest httpx
.venv/bin/pytest
```

The analysis tests script the engine (no Stockfish binary needed); app tests
use a throwaway `DATA_DIR` under this directory.
