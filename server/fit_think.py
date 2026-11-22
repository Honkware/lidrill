"""Fit how long a person takes over a move, for Maia's think time.

Reads rated games from a Lichess monthly dump (a truncated download is fine),
samples moves evenly across time controls and rating bands, runs Maia on each
position at the calibrated setting for the mover's rating, and fits ordinary
least squares on log seconds. A move's time is the mover's previous clock
minus the clock after the move plus the increment. Writes think.json, which
maia.py reads at play time, and think_fit.md with the tables behind it.

    python fit_think.py lichess_db_standard_rated_2025-10.pgn.zst [--rows cache.jsonl]

--rows keeps the per-move features, so a refit skips the forward passes (two
per move, one for the move and one for the opponent's move before it, about
40 ms each on a laptop CPU). numpy and zstandard are needed
here only, not by the server.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import random
import re
from pathlib import Path

import chess
import chess.pgn
import numpy as np
import zstandard
from maia_calibrate import maia3_79m

import maia

# The common blitz and rapid controls with enough games in every band; 120+1
# and shorter are left out as bullet, 900+10 is the thinnest kept
TCS = ["180+0", "180+2", "300+0", "300+3", "600+0", "600+5", "900+10"]
BANDS = list(range(600, 2400, 200))
PER_CELL = 500
PER_SIDE = 2
HOLDOUT = 0.2
# A feature that moves the predicted time by less than this across its range
# (10th to 90th percentile, or 0 to 1 for a flag) is dropped
MIN_EFFECT = 0.05
# Clocks are in whole seconds, so a move read as 0 s took somewhere under one
ZERO = 0.5
FRAC_EDGES = [0.1, 0.25, 0.5, 0.75]

HDR = re.compile(r'^\[(\w+) "(.*)"\]$')
CLK = re.compile(r"\[%clk (\d+):(\d+):(\d+)\]")

DESC = {
    "spread": "entropy in nats of Maia's move distribution at the level's temperature, log of the number of plausible moves",
    "log_p": "log of the probability Maia gave the move played",
    "prev_log_p": "log of the probability Maia, at the mover's level, gave the opponent's move just before",
    "recapture": "1 if the move captures on the square the last move captured on",
    "check": "1 if the mover is in check",
    "log_legal": "log of the number of legal moves",
    "rating": "(mover's rating - 1500) / 100",
    # The clock left as a share of the base was a candidate too. At a given ply
    # it mostly tells a slow player from a quick one, so next to log_left it
    # fitted -2.06, and above about 30% of the base a fuller clock meant a
    # quicker move, which would leave Maia rushing with time to spare.
    "log_left": "log seconds on the mover's clock before the move, at least 1",
    "log_base": "log of the base time in seconds",
    "inc": "increment in seconds",
    **{f"ply_{lo}": f"1 if the ply is in [{lo}, {hi})" for lo, hi in zip(maia.PLY_EDGES, maia.PLY_EDGES[1:] + [maia.MAX_PLIES + 1])},
}


def games(path: str):
    # A partial download ends mid-frame, which zstandard reports as an error on
    # the last read, so that ends the scan
    with open(path, "rb") as f:
        text = io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(f, read_across_frames=True), encoding="utf-8")
        h = {}
        try:
            for line in text:
                if m := HDR.match(line):
                    h[m[1]] = m[2]
                elif line.startswith("1."):
                    yield h, line
                    h = {}
        except zstandard.ZstdError:
            print("stream ends early, stopping there")


def band(elo: str) -> int | None:
    if not elo.isdigit() or not BANDS[0] <= int(elo) < BANDS[-1] + 200:
        return None
    return int(elo) // 200 * 200


def scan(path: str, rng: random.Random) -> list[dict]:
    need = {(tc, b): PER_CELL for tc in TCS for b in BANDS}
    rows, gid, seen = [], 0, 0
    for h, text in games(path):
        seen += 1
        tc = h.get("TimeControl")
        if tc not in TCS or "Rated" not in h.get("Event", "") or "BOT" in (h.get("WhiteTitle"), h.get("BlackTitle")):
            continue
        sides = [(c, band(h.get(k, ""))) for c, k in ((0, "WhiteElo"), (1, "BlackElo"))]
        sides = [(c, b) for c, b in sides if b is not None and need[(tc, b)] > 0]
        if not sides or "%clk" not in text:
            continue
        nodes = list(chess.pgn.read_game(io.StringIO(text)).mainline())
        clk = [CLK.search(n.comment or "") for n in nodes]
        if not nodes or not all(clk):
            continue
        clk = [int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3]) for m in clk]
        base, inc = map(int, tc.split("+"))
        gid += 1
        hold = rng.random() < HOLDOUT
        for c, b in sides:
            elo = int(h["WhiteElo" if c == 0 else "BlackElo"])
            # Each side's first move has no clock before it. A negative time is
            # the opponent giving time, and is skipped.
            ok = [i for i in range(2 + c, len(nodes), 2) if clk[i - 2] - clk[i] + inc >= 0]
            for i in rng.sample(ok, min(PER_SIDE, need[(tc, b)], len(ok))):
                rows.append({
                    "game": gid, "holdout": hold, "tc": tc, "base": base, "inc": inc, "elo": elo, "ply": i,
                    "left": clk[i - 2], "think": clk[i - 2] - clk[i] + inc,
                    "moves": [n.move.uci() for n in nodes[:i]], "move": nodes[i].move.uci(),
                })
                need[(tc, b)] -= 1
        if not any(need.values()):
            break
    short = {k: v for k, v in need.items() if v}
    print(f"read {seen} games, sampled {len(rows)} moves from {gid}, unfilled cells {short}")
    return rows


def featurize(rows: list[dict]) -> list[dict]:
    m = maia.model()
    calibration = maia3_79m()
    for n, r in enumerate(rows):
        level = min(maia.TARGETS, key=lambda x: abs(x - r["elo"]))
        setting = calibration.lookup(level).setting
        board = maia.replay(r.pop("moves"))
        logits = m.logits(board, setting.dial)
        # A sampled move is never a side's first, so there is always an opponent's move before it
        before = board.copy()
        prev = before.pop().uci()
        prev_log_p = maia.log_p(m.logits(before, setting.dial), prev, setting.temp)
        clock = {"base": r["base"], "inc": r["inc"], "left": r["left"]}
        r["f"] = maia.think_features(board, logits, r.pop("move"), setting.temp, r["elo"], clock, prev_log_p)
        if n % 2000 == 0:
            print(f"featurized {n} of {len(rows)}")
    return rows


def ols(rows: list[dict], names: list[str]):
    x = np.array([[1.0] + [r["f"][k] for k in names] for r in rows])
    y = np.log([max(r["think"], ZERO) for r in rows])
    beta = np.linalg.lstsq(x, y, rcond=None)[0]
    res = y - x @ beta
    return beta, float(np.sqrt(res @ res / (len(y) - len(beta)))), x, y


def r2(beta, x, y) -> float:
    res = y - x @ beta
    return float(1 - res @ res / ((y - y.mean()) @ (y - y.mean())))


def groups(r: dict) -> dict[str, str]:
    frac = r["left"] / r["base"]
    ply = next((f"{lo}-{hi - 1}" for lo, hi in zip([2] + maia.PLY_EDGES, maia.PLY_EDGES + [9999]) if r["ply"] < hi), "")
    return {
        "ply": ply.replace("-9998", "+"),
        "rating": f"{r['elo'] // 200 * 200}-{r['elo'] // 200 * 200 + 199}",
        "time control": r["tc"],
        "clock left / base": next((f"<{e}" for e in FRAC_EDGES if frac < e), f">={FRAC_EDGES[-1]}"),
        "recapture": "yes" if r["f"]["recapture"] else "no",
        "in check": "yes" if r["f"]["check"] else "no",
        "plausible moves": next((f"<{e}" for e in (1.5, 3, 6) if math.exp(r["f"]["spread"]) < e), ">=6"),
        "Maia's p of the opponent's move": next((f"<{e}" for e in (0.05, 0.2, 0.5) if math.exp(r["f"]["prev_log_p"]) < e), ">=0.5"),
    }


def table(rows: list[dict], key: str, sim: list[float] | None = None) -> list[str]:
    cells: dict[str, list[int]] = {}
    for i, r in enumerate(rows):
        cells.setdefault(groups(r)[key], []).append(i)
    order = sorted(cells, key=lambda k: (float(m[0]) if (m := re.search(r"\d+\.?\d*", k)) else -1, k))
    head = f"| {key} | moves | median s | p90 s |" + (" model median s | model p90 s |" if sim else "")
    out = [head, "|" + "---|" * (head.count("|") - 1)]
    for k in order:
        t = [rows[i]["think"] for i in cells[k]]
        line = f"| {k} | {len(t)} | {np.median(t):.0f} | {np.percentile(t, 90):.0f} |"
        if sim:
            s = [sim[i] for i in cells[k]]
            line += f" {np.median(s):.1f} | {np.percentile(s, 90):.1f} |"
        out.append(line)
    return out + [""]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pgn")
    ap.add_argument("--rows")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    rng = random.Random(args.seed)

    cache = Path(args.rows) if args.rows else None
    if cache and cache.exists():
        rows = [json.loads(line) for line in cache.read_text().splitlines()]
    else:
        rows = featurize(scan(args.pgn, rng))
        if cache:
            cache.write_text("".join(json.dumps(r) + "\n" for r in rows))
    train = [r for r in rows if not r["holdout"]]
    test = [r for r in rows if r["holdout"]]

    md = [
        "# Think-time fit", "",
        f"Written by fit_think.py from {Path(args.pgn).name}: {len(train)} moves from "
        f"{len({r['game'] for r in train})} games to fit and {len(test)} moves from "
        f"{len({r['game'] for r in test})} other games held out. Time controls {', '.join(TCS)}, ratings "
        f"{BANDS[0]} to {BANDS[-1] + 199}, up to {PER_CELL} moves per time control and 200-point band and "
        f"{PER_SIDE} per player per game. Times are whole seconds, and a 0 s move counts as {ZERO} s in the fit.", "",
        "## The data", "",
    ]
    for key in groups(train[0]):
        md += table(train, key)

    names = sorted(DESC)
    beta, _, x, _ = ols(train, names)
    effect = {}
    for j, k in enumerate(names):
        v = np.array([r["f"][k] for r in train])
        span = 1.0 if set(np.unique(v)) <= {0.0, 1.0} else np.percentile(v, 90) - np.percentile(v, 10)
        effect[k] = math.exp(beta[j + 1] * span) - 1
    kept = [k for k in names if abs(effect[k]) >= MIN_EFFECT]
    md += [
        "## Candidate features", "",
        f"All candidates fitted together. Effect is the change in predicted time across the feature's 10th to "
        f"90th percentile, or from 0 to 1 for a flag; under {MIN_EFFECT:.0%} it is dropped.", "",
        "| feature | coef | effect | kept |", "|---|---|---|---|",
        *[f"| {k} | {beta[j + 1]:+.3f} | {effect[k]:+.0%} | {'yes' if k in kept else 'no'} |" for j, k in enumerate(names)],
        "",
    ]

    beta, sigma, x, y = ols(train, kept)
    coef = {"const": float(beta[0]), **{k: float(b) for k, b in zip(kept, beta[1:])}}
    xt = np.array([[1.0] + [r["f"][k] for k in kept] for r in test])
    yt = np.log([max(r["think"], ZERO) for r in test])
    ceiling = float(np.percentile([r["think"] for r in train if r["tc"] == "600+0"], 97))
    over = np.mean([r["think"] > r["left"] / 4 + r["inc"] for r in train])

    sim, srng = [], random.Random(args.seed)
    for r, mu in zip(test, xt @ beta):
        hi = r["left"] / 4 + r["inc"]
        sim.append(min(max(math.exp(srng.gauss(mu, sigma)), min(ZERO, hi)), hi))

    md += [
        "## Final fit", "",
        f"OLS on log seconds with {', '.join(kept)}. Residual sd {sigma:.3f} in log seconds, R squared "
        f"{r2(beta, x, y):.3f} on the fitted moves and {r2(beta, xt, yt):.3f} on the held-out ones. At play time "
        f"the time is drawn from a lognormal around the prediction with that sd, at least {ZERO} s and at most a "
        f"quarter of the clock left plus the increment. People went over that cap on {over:.1%} of the fitted moves. "
        f"With no clock the ceiling is {ceiling:.0f} s, the 97th percentile of 600+0 moves.", "",
        "| feature | coef |", "|---|---|", *[f"| {k} | {v:+.4f} |" for k, v in coef.items()], "",
        "## Held-out games", "",
        "Data against one draw per move from the model, capped by each move's own clock.", "",
    ]
    for key in ("ply", "rating", "time control", "clock left / base", "recapture", "plausible moves", "Maia's p of the opponent's move"):
        md += table(test, key, sim)

    out = Path(__file__).parent
    (out / "think_fit.md").write_text("\n".join(md).rstrip() + "\n")
    month = re.search(r"\d{4}-\d{2}", Path(args.pgn).name)
    (out / "think.json").write_text(json.dumps({
        "source": Path(args.pgn).name.removesuffix(".part"),
        "month": month[0] if month else None,
        "time_controls": TCS,
        "revision": maia.REVISION,
        "games": len({r["game"] for r in train}),
        "moves": len(train),
        "features": {k: DESC[k] for k in kept},
        "coef": {k: round(v, 4) for k, v in coef.items()},
        "sigma": round(sigma, 4),
        "floor": ZERO,
        "ceiling": ceiling,
    }, indent=2) + "\n")
    print("\n".join(md))


if __name__ == "__main__":
    main()
