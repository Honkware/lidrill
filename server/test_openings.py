"""The opening trainer's move probabilities are the ones the Maia opponent
plays from, so a tree built on them describes the games the player will get.
The model is scripted, so these run without torch or the weights."""

import math
import os
import random

import pytest
from fastapi.testclient import TestClient

os.environ["DATA_DIR"] = os.path.join(os.path.dirname(__file__), ".test-data")
os.environ["LIDRILL_KEY"] = "test-key"

import maia  # noqa: E402
import openings  # noqa: E402
from app import app  # noqa: E402

KEY = {"headers": {"x-lidrill-key": "test-key"}}
CLIENT = TestClient(app)


class DialMaia:
    """Logits that depend on the dial, so a mix of two settings shows."""

    def __init__(self, by_dial, default):
        self.by_dial = by_dial
        self.default = default

    def logits(self, board, dial):
        return self.by_dial.get(dial, self.default)

    # move() also reads the score, to decide on resigning; an even one never resigns
    def evaluate(self, board, dial):
        return self.logits(board, dial), 0.5


def test_the_probabilities_are_the_softmax_at_the_settings_temperature():
    elo, setting = maia.ANCHORS[5]
    fake = DialMaia({}, {"e2e4": 1.0, "d2d4": 0.0, "g1f3": -1.0})
    out = openings.policy(fake, [], round(elo))
    assert [m["uci"] for m in out] == ["e2e4", "d2d4", "g1f3"]
    assert sum(m["p"] for m in out) == pytest.approx(1, abs=1e-3)
    ratio = out[0]["p"] / out[1]["p"]
    assert ratio == pytest.approx(math.exp(1 / setting.temp), rel=1e-2)


def test_a_level_between_two_settings_gives_the_share_maia_really_plays():
    # 1840 sits between the settings at dials 1910 and 2010
    fake = DialMaia({2010: {"e2e4": 0.0, "d2d4": -9.0}}, {"e2e4": -9.0, "d2d4": 0.0})
    p = {m["uci"]: m["p"] for m in openings.policy(fake, [], 1840)}
    rng = random.Random(4)
    played = [maia.move(fake, [], 1840, rng)["move"] for _ in range(2000)]
    assert played.count("e2e4") / 2000 == pytest.approx(p["e2e4"], abs=0.03)
    assert 0.3 < p["e2e4"] < 0.7


def test_a_level_outside_the_range_or_an_illegal_game_is_refused():
    fake = DialMaia({}, {"e2e4": 0.0})
    for level in (590, 2310):
        with pytest.raises(ValueError):
            openings.policy(fake, [], level)
    with pytest.raises(ValueError):
        openings.policy(fake, ["e2e5"], 1500)


def test_the_endpoint_needs_the_key_and_answers_every_move_most_likely_first(monkeypatch):
    monkeypatch.setattr(maia, "model", lambda: DialMaia({}, {"g8f6": 0.0, "d7d5": 0.5, "e7e6": -2.0}))
    body = {"moves": ["d2d4"], "level": 1500}
    assert CLIENT.post("/maia/policy", json=body).status_code == 401
    out = CLIENT.post("/maia/policy", json=body, **KEY).json()
    assert list(out) == ["moves"]
    assert [m["uci"] for m in out["moves"]] == ["d7d5", "g8f6", "e7e6"]
    assert CLIENT.post("/maia/policy", json={"moves": ["d2d5"], "level": 1500}, **KEY).status_code == 400
