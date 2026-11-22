"""Maia moves come from the calibrated setting for a level, never from the
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


def test_every_level_is_a_measured_target_the_model_can_reach():
    for level in maia.LEVELS:
        row = next(m for m in maia.CALIBRATION.measurements if m.target == level)
        assert abs(row.measured_elo - level) < 60


def test_the_model_is_given_the_calibrated_dial_for_both_players():
    fake = FakeMaia({"e2e4": 0.0})
    maia.move(fake, [], 1800)
    assert fake.asked == [("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 1910)]


def test_a_level_between_two_measured_targets_is_refused():
    with pytest.raises(ValueError):
        maia.move(FakeMaia({"e2e4": 0.0}), [], 1550)
    with pytest.raises(ValueError):
        maia.move(FakeMaia({"e2e4": 0.0}), [], 2400)


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
