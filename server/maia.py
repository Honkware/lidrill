"""Maia-3 as an opponent at a chosen level.

Maia-3 takes a rating as input, but the strength it plays at differs from
the rating it is given. maia-calibrate holds the dial value and sampling
temperature that were measured to play at each target rating, so a level
is never passed to the model as is. A level between two measured strengths
plays every move with one of the two settings around it, the nearer one more
often, which allows any level in the range without using a setting nobody
measured.

The model sees the last 8 positions, as it did in the calibration games, so
the caller sends the whole game and it is replayed here. torch and maia3 are
only imported when the first move is asked for, which keeps the sync service
and its tests free of them.

Each move also comes with a think time, drawn from a lognormal around a
linear fit of log seconds on what the position, Maia's own move distribution
and the clock give (think.json, from fit_think.py).
"""

import bisect
import json
import math
import random
from collections import deque
from functools import lru_cache
from pathlib import Path

import chess
from maia_calibrate import maia3_79m

# The checkpoint the calibration was measured on
REVISION = "a107d6ceb7b298cb04ae1da4edffe2939858b894"

MIN_LEVEL, MAX_LEVEL = 600, 2300
MAX_PLIES = 600

# The measured strength of each usable setting, weakest first. The 900
# target is left out because its setting measured the same as 1000's, and
# the targets from 2400 up because the model can't reach them.
TARGETS = [600, 700, 800, *range(1000, 2400, 100)]
ANCHORS = sorted(((m.measured_elo, m.setting) for m in maia3_79m().measurements if m.target in TARGETS), key=lambda a: a[0])

# Maia-3 has a think-time head (the third output of its forward), but in the
# released 79M checkpoint it is untrained: it reads about -0.15, which is -15 s
# once the label's /100 scaling is undone, for every position, rating and
# clock tried. The time comes from a fit to human clocks instead, made by
# fit_think.py and kept in think.json.
THINK = Path(__file__).with_name("think.json")
PLY_EDGES = [10, 20, 40, 60]

# A game without a clock is timed as 10+0 with the whole base left at every
# move, and capped by the fit's ceiling instead of by a clock
UNHURRIED = {"base": 600.0, "inc": 0.0, "left": 600.0}


class Maia:
    def __init__(self) -> None:
        import torch
        from maia3.dataset import PIECE_MAP, get_historical_tokens
        from maia3.model_registry import resolve_checkpoint_path
        from maia3.uci import load_model, parse_args
        from maia3.utils import get_all_possible_moves, mirror_move

        # One position at a time: a single thread was as fast as four when timed
        torch.set_num_threads(1)
        self.torch = torch
        self.cfg = parse_args(["--model", "maia3-79m", "--device", "cpu", "--revision", REVISION])
        self.cfg.checkpoint_path = resolve_checkpoint_path(self.cfg.model_spec, revision=REVISION)
        self.model = load_model(self.cfg)
        self.pieces = PIECE_MAP
        self.to_tokens = get_historical_tokens
        self.mirror = mirror_move
        self.index = {m: i for i, m in enumerate(get_all_possible_moves())}

    def _encode(self, board: chess.Board):
        # The model always sees the side to move as white
        out = self.torch.zeros((64, 12), dtype=self.torch.float)
        flip = board.turn == chess.BLACK
        for square, piece in board.piece_map().items():
            color = piece.color
            if flip:
                square, color = chess.square_mirror(square), not color
            out[square, self.pieces[piece.piece_type] + (0 if color == chess.WHITE else 6) - 1] = 1
        return out

    def logits(self, board: chess.Board, dial: int) -> dict[str, float]:
        """Logit of every legal move, keyed by UCI. The dial is the rating given for both players."""
        replay, undone = board.copy(), []
        while replay.move_stack and len(undone) < self.cfg.history - 1:
            undone.append(replay.pop())
        history = deque([self._encode(replay)], maxlen=self.cfg.history)
        for move in reversed(undone):
            replay.push(move)
            history.append(self._encode(replay))
        x = self.to_tokens(history, self.cfg, base=0.0, inc=0.0, clk_left_before=0.0, clk_ponder=0.0)
        elo = self.torch.tensor([dial], dtype=self.torch.long)
        with self.torch.no_grad():
            out = self.model(x.unsqueeze(0), elo, elo)[0][0].float()
        white = board.turn == chess.WHITE
        return {m.uci(): float(out[self.index[m.uci() if white else self.mirror(m.uci())]]) for m in board.legal_moves}


@lru_cache(maxsize=1)
def model() -> Maia:
    return Maia()


def replay(moves: list[str]) -> chess.Board:
    if len(moves) > MAX_PLIES:
        raise ValueError("game too long")
    board = chess.Board()
    for uci in moves:
        board.push_uci(uci)  # ValueError on a move that isn't legal
    if board.is_game_over():
        raise ValueError("game is over")
    return board


def sample(logits: dict[str, float], temp: float, rng: random.Random) -> str:
    top = max(logits.values())
    weights = [math.exp((v - top) / temp) for v in logits.values()]
    return rng.choices(list(logits), weights)[0]


def setting_for(level: int, rng: random.Random):
    i = bisect.bisect_left([elo for elo, _ in ANCHORS], level)
    if i == 0 or i == len(ANCHORS):
        return ANCHORS[min(i, len(ANCHORS) - 1)][1]
    (lo, weaker), (hi, stronger) = ANCHORS[i - 1], ANCHORS[i]
    return stronger if rng.random() < (level - lo) / (hi - lo) else weaker


def think_features(board: chess.Board, logits: dict[str, float], uci: str, temp: float, rating: float,
                   clock: dict[str, float]) -> dict[str, float]:
    """Everything the think-time fit may use, for the move uci about to be played on board."""
    top = max(logits.values())
    w = {m: math.exp((v - top) / temp) for m, v in logits.items()}
    z = sum(w.values())
    move = chess.Move.from_uci(uci)
    recap = False
    if board.move_stack and board.is_capture(move) and move.to_square == board.peek().to_square:
        before = board.copy()
        recap = before.is_capture(before.pop())
    ply = len(board.move_stack)
    f = {
        "spread": -sum(x / z * math.log(x / z) for x in w.values() if x > 0),
        "log_p": (logits[uci] - top) / temp - math.log(z),
        "recapture": float(recap),
        "check": float(board.is_check()),
        "log_legal": math.log(len(logits)),
        "rating": (rating - 1500) / 100,
        "log_left": math.log(max(clock["left"], 1.0)),
        "log_base": math.log(clock["base"]),
        "inc": clock["inc"],
    }
    for lo, hi in zip(PLY_EDGES, PLY_EDGES[1:] + [MAX_PLIES + 1]):
        f[f"ply_{lo}"] = float(lo <= ply < hi)
    return f


@lru_cache(maxsize=1)
def think_fit() -> dict:
    return json.loads(THINK.read_text())


def cap(clock: dict[str, float] | None) -> float:
    """Longest think allowed. On a clock Maia keeps at least three quarters of what it had."""
    return think_fit()["ceiling"] if clock is None else clock["left"] / 4 + clock["inc"]


def think(board: chess.Board, logits: dict[str, float], uci: str, temp: float, level: int, rng: random.Random,
          clock: dict[str, float] | None = None) -> float:
    fit = think_fit()
    f = think_features(board, logits, uci, temp, level, clock or UNHURRIED)
    mu = fit["coef"]["const"] + sum(c * f[k] for k, c in fit["coef"].items() if k != "const")
    hi = cap(clock)
    return min(max(math.exp(rng.gauss(mu, fit["sigma"])), min(fit["floor"], hi)), hi)


def check_clock(clock: dict[str, float] | None) -> None:
    if clock is None:
        return
    if set(clock) != {"base", "inc", "left"}:
        raise ValueError("clock needs base, inc and left")
    if clock["base"] <= 0 or clock["inc"] < 0 or clock["left"] < 0:
        raise ValueError("clock base must be positive, inc and left not negative")


def move(maia, moves: list[str], level: int, rng: random.Random = random,
         clock: dict[str, float] | None = None) -> dict[str, str | float]:
    """Maia's move and how long a player at that level would take over it, in seconds."""
    if not MIN_LEVEL <= level <= MAX_LEVEL:
        raise ValueError(f"level {level} is outside {MIN_LEVEL} to {MAX_LEVEL}")
    check_clock(clock)
    board = replay(moves)
    setting = setting_for(level, rng)
    logits = maia.logits(board, setting.dial)
    uci = sample(logits, setting.temp, rng)
    # Down to a tenth, so a time at the cap stays under it
    return {"move": uci, "think": math.floor(think(board, logits, uci, setting.temp, level, rng, clock) * 10) / 10}
