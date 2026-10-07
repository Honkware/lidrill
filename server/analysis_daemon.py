"""Analysis drainer (docs/server-tier.md, phase 2): one job at a time across
every account database, native Stockfish 19 at depth 14 on 2 threads. Runs as
the lidrill-analysis systemd unit (Nice=10, Restart=always); the FastAPI
service only enqueues (queue_analysis in app.py) - this process owns the
jobs table and writes analyzed games back through the normal rows table so
clients pick them up on their next pull.
"""

import glob
import json
import os
import sqlite3
import sys
import time

from analysis import UciEngine, analyze_game

DATA_DIR = os.environ.get("DATA_DIR", "/opt/lidrill/data")
STOCKFISH = os.environ.get("STOCKFISH", "/opt/lidrill/tools/stockfish-19")
DEPTH = int(os.environ.get("ANALYSIS_DEPTH", "14"))
POLL_S = 15
MAX_ATTEMPTS = 3


def dbs() -> list[str]:
    return sorted(glob.glob(os.path.join(DATA_DIR, "*.db")))


def open_db(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def next_job(conn: sqlite3.Connection) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT game_id FROM jobs WHERE status = 'pending' AND attempts < ? ORDER BY created_at LIMIT 1",
        (MAX_ATTEMPTS,),
    ).fetchone()


def analyze_one(path: str, engine: UciEngine) -> bool:
    conn = open_db(path)
    try:
        job = next_job(conn)
        if not job:
            return False
        game_id = job["game_id"]
        row = conn.execute("SELECT updated_at, data FROM rows WHERE table_name = 'games' AND id = ?", (game_id,)).fetchone()
        now = int(time.time() * 1000)
        if not row:
            conn.execute("UPDATE jobs SET status = 'done', updated_at = ? WHERE game_id = ?", (now, game_id))
            conn.commit()
            return True
        game = json.loads(row["data"])
        try:
            analyzed = analyze_game(game, engine, DEPTH, now=lambda: int(time.time() * 1000))
            with conn:
                # Newer-wins, same rule as a client push: don't clobber a
                # newer local row (e.g. the client analyzed it itself)
                conn.execute(
                    "UPDATE rows SET data = ?, updated_at = ? WHERE table_name = 'games' AND id = ? AND updated_at <= ?",
                    (json.dumps(analyzed, separators=(",", ":")), analyzed["analyzedAt"], game_id, row["updated_at"]),
                )
                conn.execute("UPDATE jobs SET status = 'done', updated_at = ? WHERE game_id = ?", (now, game_id))
        except Exception as e:
            with conn:
                conn.execute(
                    "UPDATE jobs SET status = 'pending', attempts = attempts + 1, updated_at = ? WHERE game_id = ?",
                    (now, game_id),
                )
            print(f"analysis failed for {game_id} ({e}); will retry", file=sys.stderr)
        return True
    finally:
        conn.close()


def main() -> None:
    os.nice(10)
    engine = UciEngine(STOCKFISH)
    print(f"lidrill analysis drainer up: {STOCKFISH}, depth {DEPTH}", flush=True)
    try:
        while True:
            did_any = False
            for path in dbs():
                try:
                    while analyze_one(path, engine):
                        did_any = True
                except sqlite3.OperationalError as e:
                    print(f"{path}: busy ({e})", file=sys.stderr)
            if not did_any:
                time.sleep(POLL_S)
    finally:
        engine.close()


if __name__ == "__main__":
    main()
