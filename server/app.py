"""lidrill-server: the per-account sync store behind the lidrill Worker.

Loopback-only FastAPI service (docs/server-tier.md). One SQLite database per
Lichess account at DATA_DIR/<username>.db holding opaque row versions:
{table, id, updatedAt, data}. Conflict rule per row: newer updatedAt wins.
Nothing here interprets row contents except the analysis job hook (games
without analysis are queued for the native-Stockfish drainer).

Every endpoint requires the X-Lidrill-Key shared secret; only the lidrill
Cloudflare Worker holds it, and direct access stays on 127.0.0.1.
"""

import hashlib
import json
import os
import re
import sqlite3
import threading
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query, Request
from pydantic import BaseModel

import maia
import openings

DATA_DIR = os.environ.get("DATA_DIR", "/opt/lidrill/data")
LIDRILL_KEY = os.environ.get("LIDRILL_KEY", "")

# Mirrors client SYNC_TABLES (src/db.ts): everything the export carries
# except explanations (packet KV) and caches. `auth` never arrives here.
TABLES = {"games", "puzzles", "reviews", "profile", "syncState", "journal", "liPuzzle", "practice", "replaySessions", "repertoire", "openingCards"}

MAX_ROWS_PER_PUSH = 5000
MAX_ROW_BYTES = 2_000_000
MAX_PAGE = 1000

MAX_EVAL_KEYS = 500
MAX_PLIES = 600
UCI_RE = re.compile(r"^[a-h][1-8][a-h][1-8][qrbn]?$")
KEY_RE = re.compile(r"^[0-9a-f]{64}$")


def warm_maia() -> None:
    try:
        maia.model()
    except ImportError:
        pass  # a sync store without torch and maia3 installed still serves everything else


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Loading the weights takes a couple of seconds, which the first Maia
    # move after a restart would otherwise wait for. Sync is not held up.
    threading.Thread(target=warm_maia, daemon=True).start()
    yield


app = FastAPI(title="lidrill-server", lifespan=lifespan)
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


class MoveBody(BaseModel):
    moves: list[str]
    level: int
    clock: dict[str, float] | None = None  # base, inc and Maia's time left, in seconds


@app.post("/maia/move")
def maia_move(body: MoveBody, x_lidrill_key: str | None = Header(default=None)) -> dict[str, str | float | bool]:
    """Maia-3's reply to a game given as UCI moves from the start position and its think time, or
    {"resign": true}."""
    guard(x_lidrill_key)
    try:
        return maia.move(maia.model(), body.moves, body.level, clock=body.clock)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/maia/policy")
def maia_policy(body: openings.PolicyBody, x_lidrill_key: str | None = Header(default=None)) -> dict[str, list]:
    """Maia-3's probability for every legal move, most likely first, as /maia/move would sample them."""
    guard(x_lidrill_key)
    try:
        return {"moves": openings.policy(maia.model(), body.moves, body.level)}
    except ValueError as e:
        raise HTTPException(400, str(e))


class DrawBody(BaseModel):
    moves: list[str]
    level: int


@app.post("/maia/draw")
def maia_draw(body: DrawBody, x_lidrill_key: str | None = Header(default=None)) -> dict[str, bool]:
    """Whether Maia accepts a draw offered by the player to move."""
    guard(x_lidrill_key)
    try:
        return maia.draw(maia.model(), body.moves, body.level)
    except ValueError as e:
        raise HTTPException(400, str(e))


# Engine evals shared between every browser. A game on Lichess or Chess.com
# is public and its evals are the same for whoever analyses it, so the first
# browser to analyse a game stores them here and the next one, or the same
# player on another device, skips the search. A game is its moves from the
# start position: no player and no game id is stored.


def evals_db() -> sqlite3.Connection:
    # A directory, so it can't be taken for an account's <username>.db
    os.makedirs(os.path.join(DATA_DIR, "shared"), exist_ok=True)
    conn = sqlite3.connect(os.path.join(DATA_DIR, "shared", "evals.db"), timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("CREATE TABLE IF NOT EXISTS evals (key TEXT PRIMARY KEY, evals TEXT NOT NULL, updated_at INTEGER NOT NULL)")
    return conn


def evals_key(depth: int, moves: list[str]) -> str:
    """Has to match evalsKey in src/analysis/shared.ts."""
    return hashlib.sha256(f"{depth}:{' '.join(moves)}".encode()).hexdigest()


def clean_eval(e: Any) -> dict[str, int] | None:
    """One eval as the browser stores it, {"cp": n} or {"mate": n} from White's side, or None."""
    if e is None:
        return None
    if not isinstance(e, dict) or len(e) != 1:
        raise HTTPException(400, "bad eval")
    (name, value), = e.items()
    limit = {"cp": 100_000, "mate": 1000}.get(name)
    if limit is None or type(value) is not int or abs(value) > limit:
        raise HTTPException(400, "bad eval")
    return {name: value}


class EvalsGetBody(BaseModel):
    keys: list[str]


class EvalsPutBody(BaseModel):
    depth: int
    moves: list[str]
    evals: list[Any]  # the eval after each move, None where the browser has none


@app.post("/evals/get")
def evals_get(body: EvalsGetBody, x_lidrill_key: str | None = Header(default=None)) -> dict[str, Any]:
    guard(x_lidrill_key)
    if len(body.keys) > MAX_EVAL_KEYS or not all(KEY_RE.match(k) for k in body.keys):
        raise HTTPException(400, "bad keys")
    if not body.keys:
        return {"found": {}}
    conn = evals_db()
    marks = ",".join("?" * len(body.keys))
    found = conn.execute(f"SELECT key, evals FROM evals WHERE key IN ({marks})", body.keys).fetchall()
    conn.close()
    return {"found": {k: json.loads(v) for k, v in found}}


@app.post("/evals/put")
def evals_put(body: EvalsPutBody, x_lidrill_key: str | None = Header(default=None)) -> dict[str, Any]:
    guard(x_lidrill_key)
    if not 1 <= body.depth <= 40:
        raise HTTPException(400, "bad depth")
    if not 0 < len(body.moves) <= MAX_PLIES or not all(UCI_RE.match(m) for m in body.moves):
        raise HTTPException(400, "bad moves")
    if len(body.evals) != len(body.moves):
        raise HTTPException(400, "one eval per move")
    sent = [clean_eval(e) for e in body.evals]
    key = evals_key(body.depth, body.moves)
    conn = evals_db()
    with conn:
        old = conn.execute("SELECT evals FROM evals WHERE key = ?", (key,)).fetchone()
        # An eval already stored is never replaced, so a later upload can
        # fill the gaps another browser left but can't change what is served
        merged = [a if a is not None else b for a, b in zip(json.loads(old[0]), sent)] if old else sent
        conn.execute(
            "INSERT INTO evals (key, evals, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET evals = excluded.evals, updated_at = excluded.updated_at",
            (key, json.dumps(merged, separators=(",", ":")), int(time.time() * 1000)),
        )
    conn.close()
    return {"ok": True, "key": key}


# Visit counts. The Worker sends a hash of the visitor's address that changes
# every day, so a row says "someone was here today" and nothing that can be
# followed to a person or across days. active is set once the visitor has
# touched a board, which a crawler does not do.

DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
VISITOR_RE = re.compile(r"^[0-9a-f]{32}$")


def stats_db() -> sqlite3.Connection:
    os.makedirs(os.path.join(DATA_DIR, "shared"), exist_ok=True)
    conn = sqlite3.connect(os.path.join(DATA_DIR, "shared", "stats.db"), timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS visits (
             day TEXT NOT NULL, visitor TEXT NOT NULL, active INTEGER NOT NULL,
             first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
             PRIMARY KEY (day, visitor))"""
    )
    return conn


class PingBody(BaseModel):
    day: str
    visitor: str
    active: bool


@app.post("/stats/ping")
def stats_ping(body: PingBody, x_lidrill_key: str | None = Header(default=None)) -> dict[str, bool]:
    guard(x_lidrill_key)
    if not DAY_RE.match(body.day) or not VISITOR_RE.match(body.visitor):
        raise HTTPException(400, "bad ping")
    now = int(time.time() * 1000)
    conn = stats_db()
    with conn:
        conn.execute(
            """INSERT INTO visits (day, visitor, active, first_at, last_at) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(day, visitor) DO UPDATE SET
                 active = MAX(active, excluded.active), last_at = excluded.last_at""",
            (body.day, body.visitor, int(body.active), now, now),
        )
    conn.close()
    return {"ok": True}


@app.get("/stats")
def stats(days: int = Query(default=14), x_lidrill_key: str | None = Header(default=None)) -> dict[str, Any]:
    """Visitors and active players for each of the last days, and how many were seen in the last five minutes."""
    guard(x_lidrill_key)
    conn = stats_db()
    rows = conn.execute(
        "SELECT day, COUNT(*), SUM(active) FROM visits GROUP BY day ORDER BY day DESC LIMIT ?", (min(max(1, days), 365),)
    ).fetchall()
    since = int(time.time() * 1000) - 5 * 60 * 1000
    now = conn.execute("SELECT COUNT(*), COALESCE(SUM(active), 0) FROM visits WHERE last_at >= ?", (since,)).fetchone()
    conn.close()
    return {"now": {"visitors": now[0], "active": now[1]}, "days": [{"day": d, "visitors": v, "active": a} for d, v, a in rows]}


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
    cursor: str | None = Query(default=None),
    limit: int = Query(default=500),
    x_lidrill_key: str | None = Header(default=None),
) -> dict[str, Any]:
    guard(x_lidrill_key)
    limit = min(max(1, limit), MAX_PAGE)
    # Keyset over (updated_at, rowid): the cursor is the last row's
    # "updatedAt:rowid", so pages are stable even while new rows land
    args: list[Any] = [since]
    keyset = ""
    if cursor:
        try:
            last_at, last_rowid = cursor.split(":")
            keyset = " AND (updated_at > ? OR (updated_at = ? AND rowid > ?))"
            args += [int(last_at), int(last_at), int(last_rowid)]
        except (ValueError, TypeError):
            raise HTTPException(400, "bad cursor")
    args.append(limit)
    conn = connect(user)
    cur = conn.execute(
        f"""SELECT rowid, table_name, id, updated_at, data FROM rows
           WHERE updated_at > ?{keyset}
           ORDER BY updated_at, rowid LIMIT ?""",
        args,
    )
    fetched = cur.fetchall()
    rows = [
        {"table": r["table_name"], "id": r["id"], "updatedAt": r["updated_at"], "data": json.loads(r["data"])}
        for r in fetched
    ]
    last = fetched[-1] if fetched else None
    next_cursor = f"{last['updated_at']}:{last['rowid']}" if last and len(fetched) == limit else None
    total = conn.execute("SELECT COUNT(*) AS n FROM rows WHERE updated_at > ?", (since,)).fetchone()["n"]
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
    # Asking about a sync code nobody uses must not leave a database behind
    if USER_RE.match(user) and not os.path.exists(os.path.join(DATA_DIR, f"{user}.db")):
        return {"rows": 0, "lastSeen": None, "pendingAnalysis": 0}
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
