"""Server-tier game analysis (docs/server-tier.md, phase 2).

Native Stockfish 19 (multi-thread) produces the per-move evals; the judging
is an exact port of the client's src/analysis/analyze.ts + judge.ts, so a
server-analyzed game row is identical in shape to a client-analyzed one and
syncs down through the normal pull. Differences from the client run, by
design: depth 14 on 2 threads (the client uses single-threaded workers), a
fixed 8-ply book skip (the masters explorer needs a Lichess token the server
doesn't have; the client falls back to the same number), and one job at a
time under Nice=10.
"""

import math
import re
import subprocess
import threading
import time
from typing import Any, Callable

import chess

MATED = 10000
FALLBACK_BOOK_PLIES = 8
STALL_TIMEOUT_S = 120


# --- engine: one line at a time over the native UCI binary ---


class UciEngine:
    """Same contract as the client's Engine (src/analysis/engine.ts): one
    search at a time, answers parsed from info/bestmove lines."""

    def __init__(self, binary: str, threads: int = 2, hash_mb: int = 64):
        self.proc = subprocess.Popen(
            [binary],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        self.lock = threading.Lock()
        self._send("uci")
        self._wait_for("uciok")
        self._send(f"setoption name Threads value {threads}")
        self._send(f"setoption name Hash value {hash_mb}")
        self._send("isready")
        self._wait_for("readyok")

    def _send(self, cmd: str) -> None:
        assert self.proc.stdin
        self.proc.stdin.write(cmd + "\n")
        self.proc.stdin.flush()

    def _wait_for(self, token: str) -> None:
        assert self.proc.stdout
        for line in self.proc.stdout:
            if line.strip() == token:
                return
        raise RuntimeError("engine died")

    def close(self) -> None:
        try:
            self._send("quit")
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()

    def search(self, fen: str, depth: int) -> dict[str, Any]:
        """Best line at `depth`, exactly like Engine.search: the last
        complete multipv-1 info line before bestmove."""
        with self.lock:
            self._send(f"position fen {fen}")
            self._send(f"go depth {depth}")
            best: dict[str, Any] | None = None
            deadline = time.monotonic() + STALL_TIMEOUT_S
            assert self.proc.stdout
            for line in self.proc.stdout:
                if time.monotonic() > deadline:
                    raise TimeoutError(f"stockfish stalled on {fen}")
                line = line.strip()
                if line.startswith("bestmove"):
                    if best is None:
                        raise RuntimeError(f"no eval line before bestmove on {fen}")
                    return best
                parsed = parse_info(line)
                if parsed and parsed["multipv"] == 1:
                    best = parsed
            raise RuntimeError("engine died mid-search")


def parse_info(line: str) -> dict[str, Any] | None:
    if not line.startswith("info ") or " pv " not in line:
        return None
    score = re_search(r" score (cp|mate) (-?\d+)", line)
    depth = re_search(r" depth (\d+)", line)
    if not score or not depth:
        return None
    value = int(score[1])
    eval_: dict[str, Any] = {"mate": value} if score[0] == "mate" else {"cp": value}
    multipv_m = re_search(r" multipv (\d+)", line)
    multipv = int(multipv_m[0]) if multipv_m else 1
    return {"eval": eval_, "pv": line.split(" pv ")[1].strip().split(), "depth": int(depth[0]), "multipv": multipv}


def re_search(pattern: str, text: str):
    m = re.search(pattern, text)
    return m.groups() if m else None


def _clean(e: dict[str, Any]) -> dict[str, Any]:
    """JSON has no undefined: drop Nones so evals look like the client's
    {cp?: number, mate?: number}."""
    return {k: v for k, v in e.items() if v is not None}


# --- judging: exact port of src/analysis/judge.ts (lila's formulas) ---


def _raw(cp: float) -> float:
    return 2 / (1 + math.exp(-0.00368208 * cp)) - 1


def winning_chances(e: dict[str, Any]) -> float:
    if e.get("mate") is not None:
        cp = (21 - min(10, abs(e["mate"]))) * 100
        return _raw(cp if e["mate"] > 0 else -cp)
    return _raw(min(max(-1000, e.get("cp") or 0), 1000))


def judge(prev: dict[str, Any], nxt: dict[str, Any], mover: str) -> str | None:
    def pov(e: dict[str, Any]) -> dict[str, Any]:
        if mover == "white":
            return e
        return {"cp": -e["cp"] if e.get("cp") is not None else None, "mate": -e["mate"] if e.get("mate") is not None else None}

    p, n = pov(prev), pov(nxt)
    if p.get("mate") is not None or n.get("mate") is not None:
        prev_cp, next_cp = p.get("cp") or 0, n.get("cp") or 0
        created = p.get("mate") is None and n.get("mate") is not None and n["mate"] < 0
        lost = p.get("mate") is not None and p["mate"] > 0 and (n.get("mate") is None or n["mate"] < 0)
        if created:
            return "inaccuracy" if prev_cp < -999 else "mistake" if prev_cp < -700 else "blunder"
        if lost:
            return "inaccuracy" if next_cp > 999 else "mistake" if next_cp > 700 else "blunder"
        if p.get("mate") is not None and n.get("mate") is not None:
            return None  # delayed mate isn't judged
    if p.get("cp") is None or n.get("cp") is None:
        return None
    drop = winning_chances(p) - winning_chances(n)
    return "blunder" if drop >= 0.3 else "mistake" if drop >= 0.2 else "inaccuracy" if drop >= 0.1 else None


# --- analysis: exact port of src/analysis/analyze.ts ---


def analyze_moves(moves: list[dict[str, Any]], engine: UciEngine, depth: int, book_plies: int = FALLBACK_BOOK_PLIES) -> list[dict[str, Any]]:
    """Returns the moves with eval/judg/book filled in, white's point of
    view, the mated final position stored as cp ±10000 (client db.ts)."""
    board = chess.Board()
    fens = [board.fen()]
    terminal: list[dict[str, Any] | None] = [None]
    for m in moves:
        board.push_uci(m["uci"])
        fens.append(board.fen())
        if board.is_checkmate():
            terminal.append({"cp": -MATED if board.turn == chess.WHITE else MATED})
        elif board.is_game_over():
            terminal.append({"cp": 0})
        else:
            terminal.append(None)

    evals: list[dict[str, Any] | None] = [None] * len(fens)
    for i in range(min(book_plies, len(moves)), len(fens)):
        if terminal[i]:
            evals[i] = terminal[i]
            continue
        known = moves[i - 1].get("eval") if i > 0 else None
        if known:
            evals[i] = known
            continue
        e = engine.search(fens[i], depth)["eval"]
        # UCI scores are from the side to move; store white's view
        white_to_move = i % 2 == 0
        if white_to_move:
            evals[i] = _clean(e)
        else:
            evals[i] = _clean({"cp": -e["cp"] if e.get("cp") is not None else None, "mate": -e["mate"] if e.get("mate") is not None else None})

    out = []
    for idx, m in enumerate(moves):
        ply = idx + 1
        if ply <= book_plies:
            out.append(_clean({**m, "book": True, "eval": m.get("eval"), "judg": None}))
            continue
        prev, nxt = evals[ply - 1], evals[ply]
        mover = "white" if ply % 2 == 1 else "black"
        mates = abs((terminal[ply] or {}).get("cp") or 0) == MATED
        j = judge(prev, nxt, mover) if prev and nxt and not mates else None
        out.append(_clean({**m, "book": False, "eval": nxt, "judg": j}))
    return out


def analyze_game(game: dict[str, Any], engine: UciEngine, depth: int = 14, now: Callable[[], int] | None = None) -> dict[str, Any]:
    """The stored game row with server analysis applied - the same shape the
    client's runQueue writes (src/analysis/queue.ts)."""
    moves = analyze_moves(game["moves"], engine, depth)
    return {**game, "moves": moves, "analyzedAt": (now or (lambda: int(time.time() * 1000)))()}
