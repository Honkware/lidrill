"""Measure where people resign and agree draws, for Maia's resign and draw rules.

Reads rated games from a Lichess monthly dump and scores positions with Maia's
value head, as the expected score (a win plus half a draw) of the side to
move, at the calibrated setting for that player's rating. Four samples, each
filled per 200-point band of the player they are about:

- resigned: games the loser resigned (Termination Normal, a decisive result,
  no mate on the board), scored at the last position with the resigner to move
- mated: games that ended in mate, scored at every turn of the loser
- held: players who did not lose (the winner, or either side of a draw, in
  games ended normally or on time), scored at every turn, to see how often a
  rule would resign a game people went on to save
- agreed: draws that were not stalemate, repetition, the fifty-move rule or
  insufficient material, which leaves agreement, scored at the final position

Writes resign.json, which maia.py reads at play time, and resign_fit.md.

    python fit_resign.py lichess_db_standard_rated_2025-10.pgn.zst [--rows cache.jsonl]
"""

from __future__ import annotations

import argparse
import io
import json
import random
import re
from pathlib import Path

import chess
import chess.pgn
import numpy as np
from maia_calibrate import maia3_79m

import maia
from fit_think import BANDS, TCS, band, games

PER_BAND = {"resigned": 300, "mated": 60, "held": 120, "agreed": 60}
# Turns in a row Maia must be under its band's threshold before resigning
TURNS = 3
GRID = [round(t, 2) for t in np.arange(0.01, 0.5, 0.01)]
# The threshold is the highest that resigns for at most this share of the
# players who did not lose, in the band and the bands either side, as 2% of
# one band's 120 players is two or three games
HELD_MAX = 0.02
# Never resign before the move by which this share of resignations had happened
EARLY = 0.05
# Accept a draw when Maia's score is at most a half plus the better side's
# margin in this share of agreed draws
AGREED = 0.5
# Chosen, not measured: 5% of agreed draws came by move 3, which reads as
# games agreed before they were played, and Maia should play the opening out
DRAW_MOVE = 20


def samples(h: dict, board: chess.Board, rng: random.Random) -> list[tuple[str, bool]]:
    """The samples a finished game could go to, each with the side it is about."""
    term, result = h.get("Termination"), h.get("Result")
    loser = {"1-0": chess.BLACK, "0-1": chess.WHITE}.get(result)
    out = []
    if loser is not None and term in ("Normal", "Time forfeit"):
        out.append(("held", not loser))
        if term == "Normal":
            out.append(("mated" if board.is_checkmate() else "resigned", loser))
    elif result == "1/2-1/2" and term in ("Normal", "Time forfeit"):
        out.append(("held", rng.choice([chess.WHITE, chess.BLACK])))
        if term == "Normal" and not (board.is_stalemate() or board.is_insufficient_material() or board.is_repetition(3)
                                     or board.halfmove_clock >= 100):
            out.append(("agreed", board.turn))
    return out


def scan(path: str, rng: random.Random) -> list[dict]:
    m = maia.model()
    calibration = maia3_79m()
    dial = lambda elo: calibration.lookup(min(maia.TARGETS, key=lambda x: abs(x - elo))).setting.dial
    need = {(k, b): n for k, n in PER_BAND.items() for b in BANDS}
    rows, seen = [], 0
    for h, text in games(path):
        seen += 1
        if h.get("TimeControl") not in TCS or "Rated" not in h.get("Event", "") or "BOT" in (h.get("WhiteTitle"), h.get("BlackTitle")):
            continue
        elos = [h.get("WhiteElo", ""), h.get("BlackElo", "")]
        if h.get("Termination") not in ("Normal", "Time forfeit") or not all(band(e) is not None for e in elos):
            continue
        if not any(need[(k, band(e))] for k in PER_BAND for e in elos):
            continue
        board = chess.pgn.read_game(io.StringIO(text)).end().board()
        if len(board.move_stack) < 2:
            continue
        open_ = [(k, side) for k, side in samples(h, board, rng) if need[(k, band(elos[0 if side == chess.WHITE else 1]))]]
        if not open_:
            continue
        k, side = rng.choice(open_)
        elo = int(elos[0 if side == chess.WHITE else 1])
        d = dial(elo)
        if k in ("resigned", "agreed"):
            if board.turn != side:
                board.pop()
            turns = [(board.fullmove_number, m.evaluate(board, d)[1])]
        else:
            turns, replay = [], chess.Board()
            for mv in board.move_stack:
                if replay.turn == side:
                    turns.append((replay.fullmove_number, m.evaluate(replay, d)[1]))
                replay.push(mv)
        rows.append({"kind": k, "band": band(str(elo)), "elo": elo, "turns": turns})
        need[(k, band(str(elo)))] -= 1
        if len(rows) % 200 == 0:
            print(f"scored {len(rows)} games, {sum(need.values())} to go")
        if not any(need.values()):
            break
    short = {k: v for k, v in need.items() if v}
    print(f"read {seen} games, scored {len(rows)}, unfilled cells {short}")
    return rows


def fires(turns: list, t: float, first: int) -> int | None:
    """Index of the turn a rule with threshold t would resign at, or None."""
    run = 0
    for i, (move, s) in enumerate(turns):
        run = run + 1 if s < t else 0
        if run >= TURNS and move >= first:
            return i
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pgn")
    ap.add_argument("--rows")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    cache = Path(args.rows) if args.rows else None
    if cache and cache.exists():
        rows = [json.loads(line) for line in cache.read_text().splitlines()]
    else:
        rows = scan(args.pgn, random.Random(args.seed))
        if cache:
            cache.write_text("".join(json.dumps(r) + "\n" for r in rows))
    of = lambda k, b=None: [r for r in rows if r["kind"] == k and (b is None or r["band"] == b)]
    pct = lambda v, q: float(np.percentile(v, q)) if v else float("nan")

    first = int(pct([r["turns"][0][0] for r in of("resigned")], EARLY * 100))
    thresholds = {}
    for b in BANDS:
        held = [r for n in (b - 200, b, b + 200) for r in of("held", n)]
        ok = [t for t in GRID if sum(fires(r["turns"], t, first) is not None for r in held) <= HELD_MAX * len(held)]
        thresholds[b] = max(ok) if ok else GRID[0]

    agreed = of("agreed")
    draw_first = DRAW_MOVE
    margin = round(pct([abs(r["turns"][0][1] - 0.5) for r in agreed], AGREED * 100), 2)

    md = [
        "# Resign and draw fit", "",
        f"Written by fit_resign.py from {Path(args.pgn).name}. Games at {', '.join(TCS)}, rated, no bots, ratings "
        f"{BANDS[0]} to {BANDS[-1] + 199}. A score is Maia's expected score for the side to move (a win plus half a "
        f"draw) from its value head, at the calibrated setting nearest the player's rating.", "",
        "## Where people resign", "",
        "The resigner's score at the last position with them to move.", "",
        "| rating | games | median move | median score | p75 | p90 |", "|---|---|---|---|---|---|",
    ]
    for b in BANDS:
        rs = of("resigned", b)
        s = [r["turns"][0][1] for r in rs]
        md.append(f"| {b}-{b + 199} | {len(rs)} | {pct([r['turns'][0][0] for r in rs], 50):.0f} | {pct(s, 50):.3f} | "
                  f"{pct(s, 75):.3f} | {pct(s, 90):.3f} |")
    md += [
        "", f"{EARLY:.0%} of all resignations came before move {first}.", "",
        "## How long people play on", "",
        "Median number of their own turns spent under a score, for players who were mated and for players who did "
        "not lose.", "",
        "| rating | mated | under 0.05 | under 0.1 | under 0.2 | did not lose | under 0.05 | under 0.1 | under 0.2 |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for b in BANDS:
        line = f"| {b}-{b + 199} |"
        for k in ("mated", "held"):
            rs = of(k, b)
            line += f" {len(rs)} |" + "".join(f" {pct([sum(s < t for _, s in r['turns']) for r in rs], 50):.0f} |" for t in (0.05, 0.1, 0.2))
        md.append(line)
    md += [
        "", "## The rule", "",
        f"Maia resigns when its score has been under its band's threshold on each of its last {TURNS} turns, from "
        f"move {first} on. The threshold is the highest of {GRID[0]} to {GRID[-1]} that would have resigned for at "
        f"most {HELD_MAX:.0%} of the players who did not lose in the band and the bands either side. The share in the table is for the band alone, on the same games "
        f"the threshold was chosen on.", "",
        "| rating | threshold | resigns, did not lose | resigns, mated | median turns before mate | resignations under it |",
        "|---|---|---|---|---|---|",
    ]
    for b in BANDS:
        t = thresholds[b]
        held, mated, res = of("held", b), of("mated", b), of("resigned", b)
        at = [(fires(r["turns"], t, first), len(r["turns"])) for r in mated]
        early = [n - i for i, n in at if i is not None]
        md.append(f"| {b}-{b + 199} | {t:.2f} | {np.mean([fires(r['turns'], t, first) is not None for r in held]):.1%} | "
                  f"{len(early) / max(len(mated), 1):.0%} | {pct(early, 50):.0f} | "
                  f"{np.mean([r['turns'][0][1] < t for r in res]):.0%} |")
    md += [
        "", "## Agreed draws", "",
        "A draw by agreement is not marked in the PGN, so these are the draws whose final position was not "
        "stalemate, a threefold repetition, the fifty-move rule or insufficient material. A repetition claimed "
        "before the position came up a third time, or a draw agreed in a repeated position, would be counted wrong. "
        "Who offered is not recorded either, so the table gives how far the final position was from even.", "",
        "| games | median move | p5 move | median abs(score - 0.5) | p75 | p90 |", "|---|---|---|---|---|---|",
    ]
    gap = [abs(r["turns"][0][1] - 0.5) for r in agreed]
    mv = [r["turns"][0][0] for r in agreed]
    md += [
        f"| {len(agreed)} | {pct(mv, 50):.0f} | {pct(mv, 5):.0f} | {pct(gap, 50):.3f} | {pct(gap, 75):.3f} | {pct(gap, 90):.3f} |", "",
        f"Maia accepts a draw offered from move {draw_first} on, a chosen number, when its own score is "
        f"at most 0.5 + {margin:.2f}, the gap in {AGREED:.0%} of these draws.",
    ]

    out = Path(__file__).parent
    (out / "resign_fit.md").write_text("\n".join(md).rstrip() + "\n")
    (out / "resign.json").write_text(json.dumps({
        "source": Path(args.pgn).name.removesuffix(".part"),
        "revision": maia.REVISION,
        "resign": {"turns": TURNS, "min_move": first, "threshold": {str(b): t for b, t in thresholds.items()}},
        "draw": {"min_move": draw_first, "margin": margin},
    }, indent=2) + "\n")
    print("\n".join(md))


if __name__ == "__main__":
    main()
