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
"""

import bisect
import math
import random
from collections import deque
from functools import lru_cache

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


def move(maia, moves: list[str], level: int, rng: random.Random = random) -> str:
    if not MIN_LEVEL <= level <= MAX_LEVEL:
        raise ValueError(f"level {level} is outside {MIN_LEVEL} to {MAX_LEVEL}")
    board = replay(moves)
    setting = setting_for(level, rng)
    return sample(maia.logits(board, setting.dial), setting.temp, rng)
