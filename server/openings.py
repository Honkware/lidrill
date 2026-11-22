"""Maia-3's whole move distribution in a position, for the opening trainer.

The probabilities are the ones /maia/move samples from: each legal move's
logit at the level's measured dial, divided by that setting's temperature and
softmaxed. A level between two measured settings plays each move with one or
the other (maia.setting_for), so its distribution is the mix of the two,
weighted the way setting_for picks them.
"""

from __future__ import annotations

import bisect
import math

from maia_calibrate import Setting
from pydantic import BaseModel

import maia


class PolicyBody(BaseModel):
    moves: list[str]
    level: int


def mix(level: int) -> list[tuple[float, Setting]]:
    """The settings a level plays with and how often, as maia.setting_for chooses them."""
    anchors = maia.ANCHORS
    i = bisect.bisect_left([elo for elo, _ in anchors], level)
    if i == 0 or i == len(anchors):
        return [(1.0, anchors[min(i, len(anchors) - 1)][1])]
    (lo, weaker), (hi, stronger) = anchors[i - 1], anchors[i]
    f = (level - lo) / (hi - lo)
    return [(f, stronger), (1 - f, weaker)]


def policy(model, moves: list[str], level: int) -> list[dict[str, str | float]]:
    """Every legal move with the probability Maia plays it, most likely first."""
    if not maia.MIN_LEVEL <= level <= maia.MAX_LEVEL:
        raise ValueError(f"level {level} is outside {maia.MIN_LEVEL} to {maia.MAX_LEVEL}")
    board = maia.replay(moves)
    out: dict[str, float] = {}
    for w, setting in mix(level):
        if w == 0:
            continue
        logits = model.logits(board, setting.dial)
        top = max(logits.values())
        e = {m: math.exp((v - top) / setting.temp) for m, v in logits.items()}
        z = sum(e.values())
        for m, x in e.items():
            out[m] = out.get(m, 0.0) + w * x / z
    return [{"uci": m, "p": round(p, 4)} for m, p in sorted(out.items(), key=lambda kv: -kv[1])]
