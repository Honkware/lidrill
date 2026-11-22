"""Maia moves come from settings whose strength was measured, never from the
level passed straight to the model. The model is scripted, so these run
without torch or the weights."""

import os
import random

import pytest
from fastapi.testclient import TestClient

os.environ["DATA_DIR"] = os.path.join(os.path.dirname(__file__), ".test-data")
os.environ["LIDRILL_KEY"] = "test-key"

import maia  # noqa: E402
from app import app  # noqa: E402

KEY = {"headers": {"x-lidrill-key": "test-key"}}
CLIENT = TestClient(app)


class FakeMaia:
    """Returns fixed logits and records what it was asked."""

    def __init__(self, logits):
        self.fixed = logits
        self.asked = []

    def logits(self, board, dial):
        self.asked.append((board.fen(), dial))
        return self.fixed


def test_the_settings_in_use_get_stronger_and_cover_the_levels_offered():
    elos = [elo for elo, _ in maia.ANCHORS]
    assert elos == sorted(set(elos))
    assert elos[0] < maia.MIN_LEVEL + 10 and elos[-1] > maia.MAX_LEVEL


def test_the_model_is_given_a_measured_dial_and_never_the_level():
    fake = FakeMaia({"e2e4": 0.0})
    rng = random.Random(3)
    for _ in range(50):
        maia.move(fake, [], 1800, rng)
    # 1800 sits between the settings measured at 1767 and 1914
    assert {dial for _, dial in fake.asked} == {1910, 2010}


def test_a_level_nearer_the_stronger_setting_uses_it_more_often():
    rng = random.Random(5)
    dials = lambda level: [maia.setting_for(level, rng).dial for _ in range(400)]
    assert dials(1770).count(2010) < 40
    assert 150 < dials(1840).count(2010) < 250
    assert dials(1910).count(2010) > 360
    assert set(dials(600)) == {610, 600}


def test_a_level_outside_the_measured_range_is_refused():
    for level in (590, 2310, 2600):
        with pytest.raises(ValueError):
            maia.move(FakeMaia({"e2e4": 0.0}), [], level)


def test_a_low_temperature_almost_always_plays_the_top_move():
    logits = {"e2e4": 1.0, "d2d4": 0.0}
    rng = random.Random(1)
    cold = [maia.sample(logits, 0.1, rng) for _ in range(200)]
    warm = [maia.sample(logits, 1.2, rng) for _ in range(200)]
    assert cold.count("d2d4") == 0
    assert 40 < warm.count("d2d4") < 90


def test_castling_is_accepted_as_king_takes_rook():
    moves = "e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 e1h1".split()
    assert maia.replay(moves).fen().startswith("r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 b kq")


def test_an_illegal_move_or_a_finished_game_is_refused():
    with pytest.raises(ValueError):
        maia.replay(["e2e5"])
    with pytest.raises(ValueError):
        maia.replay("f2f3 e7e5 g2g4 d8h4".split())


def test_the_endpoint_needs_the_key_and_returns_one_move(monkeypatch):
    monkeypatch.setattr(maia, "model", lambda: FakeMaia({"g8f6": 0.0}))
    body = {"moves": ["d2d4"], "level": 1500}
    assert CLIENT.post("/maia/move", json=body).status_code == 401
    assert CLIENT.post("/maia/move", json=body, **KEY).json() == {"move": "g8f6"}
    assert CLIENT.post("/maia/move", json={"moves": ["d2d5"], "level": 1500}, **KEY).status_code == 400
