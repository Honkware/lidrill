"""lidrill-server: the per-account sync store behind the lidrill Worker.

Loopback-only FastAPI service (docs/server-tier.md). One SQLite database per
Lichess account at DATA_DIR/<username>.db holding opaque row versions:
{table, id, updatedAt, data}. Conflict rule per row: newer updatedAt wins.
Nothing here interprets row contents except the analysis job hook (games
without analysis are queued for the native-Stockfish drainer).

Every endpoint requires the X-Lidrill-Key shared secret; only the lidrill
Cloudflare Worker holds it, and direct access stays on 127.0.0.1.
"""

import json
import os
import re
import sqlite3
import time
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query, Request
from pydantic import BaseModel

DATA_DIR = os.environ.get("DATA_DIR", "/opt/lidrill/data")
LIDRILL_KEY = os.environ.get("LIDRILL_KEY", "")

# Mirrors client SYNC_TABLES (src/db.ts): everything the export carries
# except explanations (packet KV) and caches. `auth` never arrives here.
TABLES = {"games", "puzzles", "reviews", "profile", "syncState", "journal", "liPuzzle", "practice", "replaySessions"}

MAX_ROWS_PER_PUSH = 5000
MAX_ROW_BYTES = 2_000_000
MAX_PAGE = 1000

app = FastAPI(title="lidrill-server")
USER_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def connect(user: str) -> sqlite3.Connection:
    if not USER_RE.match(user):
        raise HTTPException(400, "bad user")
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(os.path.join(DATA_DIR, f"{user}.db"), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS rows (
          table_name TEXT NOT NULL,
          id TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          data TEXT NOT NULL,
          PRIMARY KEY (table_name, id)
        );
        CREATE INDEX IF NOT EXISTS idx_rows_updated ON rows(updated_at);
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        );
        -- Analysis drainer queue (docs/server-tier.md): games pushed without
        -- analysis wait here for the native-Stockfish worker
        CREATE TABLE IF NOT EXISTS jobs (
          game_id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        """
    )
    return conn


def guard(key: str | None) -> None:
    if not LIDRILL_KEY or key != LIDRILL_KEY:
        raise HTTPException(401, "unauthorized")


class PushBody(BaseModel):
    rows: list[dict[str, Any]]


def queue_analysis(conn: sqlite3.Connection, table: str, row_id: str, data: Any) -> None:
    """A raw game (no evals yet) is work for the analysis drainer."""
    if table != "games":
        return
    if not isinstance(data, dict) or data.get("analyzedAt") is not None or data.get("serverAnalysis"):
        return
    now = int(time.time() * 1000)
    conn.execute(
        "INSERT OR IGNORE INTO jobs (game_id, status, created_at, updated_at) VALUES (?, 'pending', ?, ?)",
        (row_id, now, now),
    )


@app.get("/health")
def health(x_lidrill_key: str | None = Header(default=None)) -> dict[str, bool]:
    guard(x_lidrill_key)
    return {"ok": True}


@app.post("/u/{user}/push")
def push(user: str, body: PushBody, x_lidrill_key: str | None = Header(default=None)) -> dict[str, Any]:
    guard(x_lidrill_key)
    if len(body.rows) > MAX_ROWS_PER_PUSH:
        raise HTTPException(413, "too many rows")
    conn = connect(user)
    upserted = 0
    with conn:
        for row in body.rows:
            table, row_id, updated_at = row.get("table"), row.get("id"), row.get("updatedAt")
            if table not in TABLES or not isinstance(row_id, str) or not row_id or len(row_id) > 256:
                raise HTTPException(400, f"bad row: {table!r}")
            if not isinstance(updated_at, int) or updated_at <= 0:
                raise HTTPException(400, "bad updatedAt")
            data = row.get("data")
            blob = json.dumps(data, separators=(",", ":"))
            if len(blob) > MAX_ROW_BYTES:
                raise HTTPException(400, "row too large")
            # Newer updatedAt wins; an equal or older push is a no-op
            cur = conn.execute(
                """INSERT INTO rows (table_name, id, updated_at, data) VALUES (?, ?, ?, ?)
                   ON CONFLICT(table_name, id) DO UPDATE SET
                     updated_at = excluded.updated_at, data = excluded.data
                   WHERE excluded.updated_at > rows.updated_at""",
                (table, row_id, updated_at, blob),
            )
            upserted += cur.rowcount if cur.rowcount > 0 else 0
            queue_analysis(conn, table, row_id, data)
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('lastSeen', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (int(time.time() * 1000),),
        )
    conn.close()
    return {"ok": True, "upserted": upserted}


@app.get("/u/{user}/pull")
def pull(
    user: str,
    since: int = Query(default=0),
    cursor: int = Query(default=0),
    limit: int = Query(default=500),
    x_lidrill_key: str | None = Header(default=None),
) -> dict[str, Any]:
    guard(x_lidrill_key)
    limit = min(max(1, limit), MAX_PAGE)
    conn = connect(user)
    total = conn.execute("SELECT COUNT(*) AS n FROM rows WHERE updated_at > ?", (since,)).fetchone()["n"]
    cur = conn.execute(
        """SELECT rowid, table_name, id, updated_at, data FROM rows
           WHERE updated_at > ? OR (updated_at = ? AND rowid > ?)
           ORDER BY updated_at, rowid LIMIT ?""",
        (since, since, cursor, limit),
    )
    fetched = cur.fetchall()
    rows = [
        {"table": r["table_name"], "id": r["id"], "updatedAt": r["updated_at"], "data": json.loads(r["data"])}
        for r in fetched
    ]
    next_cursor = fetched[-1]["rowid"] if len(fetched) == limit else None
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('lastSeen', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (int(time.time() * 1000),),
    )
    conn.commit()
    conn.close()
    return {"rows": rows, "nextCursor": next_cursor, "pending": total}


@app.get("/u/{user}/state")
def state(user: str, x_lidrill_key: str | None = Header(default=None)) -> dict[str, Any]:
    guard(x_lidrill_key)
    conn = connect(user)
    count = conn.execute("SELECT COUNT(*) AS n FROM rows").fetchone()["n"]
    last_seen = conn.execute("SELECT value FROM meta WHERE key = 'lastSeen'").fetchone()
    pending = conn.execute("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'").fetchone()["n"]
    conn.close()
    return {"rows": count, "lastSeen": last_seen["value"] if last_seen else None, "pendingAnalysis": pending}


@app.delete("/u/{user}/rows")
def wipe(user: str, x_lidrill_key: str | None = Header(default=None)) -> dict[str, bool]:
    """A client's 'delete everything' also deletes the server copy."""
    guard(x_lidrill_key)
    conn = connect(user)
    with conn:
        conn.execute("DELETE FROM rows")
        conn.execute("DELETE FROM jobs")
    conn.close()
    return {"ok": True}
