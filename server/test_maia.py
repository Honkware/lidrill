"""Maia moves come from settings whose strength was measured, never from the
level passed straight to the model, and its think times follow the fit in
think.json without ever running its clock out. The model is scripted, so
these run without torch or the weights."""

import math
import os
import random
import statistics
import threading

import pytest
from fastapi.testclient import TestClient

os.environ["DATA_DIR"] = os.path.join(os.path.dirname(__file__), ".test-data")
os.environ["LIDRILL_KEY"] = "test-key"

import maia  # noqa: E402
from app import app  # noqa: E402

KEY = {"headers": {"x-lidrill-key": "test-key"}}
CLIENT = TestClient(app)


class FakeMaia:
    """Returns fixed logits, -30 for any other legal move, and a score from a function of the board, and
    records what it was asked."""

    def __init__(self, logits, score=lambda board: 0.5):
        self.fixed = logits
        self.score = score
        self.asked = []

    def evaluate(self, board, dial):
        self.asked.append((board.fen(), dial))
        return {m.uci(): self.fixed.get(m.uci(), -30.0) for m in board.legal_moves}, self.score(board)


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


def test_the_endpoint_needs_the_key_and_returns_one_move_and_its_think_time(monkeypatch):
    monkeypatch.setattr(maia, "model", lambda: FakeMaia({"g8f6": 0.0}))
    body = {"moves": ["d2d4"], "level": 1500}
    assert CLIENT.post("/maia/move", json=body).status_code == 401
    out = CLIENT.post("/maia/move", json=body, **KEY).json()
    assert set(out) == {"move", "think"} and out["move"] == "g8f6"
    assert maia.think_fit()["floor"] <= out["think"] <= maia.think_fit()["ceiling"]
    assert CLIENT.post("/maia/move", json={"moves": ["d2d5"], "level": 1500}, **KEY).status_code == 400


def test_the_endpoint_takes_a_clock_and_refuses_a_malformed_one(monkeypatch):
    monkeypatch.setattr(maia, "model", lambda: FakeMaia({"g8f6": 0.0}))
    body = {"moves": ["d2d4"], "level": 1500}
    clock = {"base": 180, "inc": 2, "left": 8}
    out = CLIENT.post("/maia/move", json={**body, "clock": clock}, **KEY).json()
    assert out["move"] == "g8f6" and out["think"] <= 8 / 4 + 2
    for bad in ({"base": 180, "inc": 2}, {"base": 180, "inc": 2, "left": -1}, {"base": 0, "inc": 0, "left": 5}):
        assert CLIENT.post("/maia/move", json={**body, "clock": bad}, **KEY).status_code == 400


# Every legal move after 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d3, so the count
# of legal moves is real and only Maia's spread over them changes
OPEN = maia.replay("e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 d2d3".split())


def spread(n: int) -> dict[str, float]:
    ucis = sorted(m.uci() for m in OPEN.legal_moves)
    return {u: 0.0 if i < n else -30.0 for i, u in enumerate(ucis)}


def times(board, logits, uci, clock=None, n=400) -> list[float]:
    rng = random.Random(7)
    return [maia.think(board, logits, uci, 1.0, 1500, rng, clock) for _ in range(n)]


def test_one_plausible_move_is_played_faster_than_a_choice_of_four():
    one, four = spread(1), spread(4)
    uci = next(u for u, v in one.items() if v == 0.0)
    assert statistics.median(times(OPEN, one, uci)) < statistics.median(times(OPEN, four, uci))


def test_a_recapture_changes_the_time_by_the_fitted_factor():
    # 1. e4 d5 2. exd5, where Qxd5 takes back and Nf6 does not
    board = maia.replay("e2e4 d7d5 e4d5".split())
    logits = {m.uci(): 0.0 for m in board.legal_moves}
    back, other = times(board, logits, "d8d5", n=1)[0], times(board, logits, "g8f6", n=1)[0]
    assert back / other == pytest.approx(math.exp(maia.think_fit()["coef"].get("recapture", 0.0)))


def test_less_time_on_the_clock_means_a_shorter_think():
    logits, uci = spread(4), sorted(m.uci() for m in OPEN.legal_moves)[0]
    lots = times(OPEN, logits, uci, {"base": 300, "inc": 0, "left": 280})
    little = times(OPEN, logits, uci, {"base": 300, "inc": 0, "left": 4})
    assert statistics.median(little) < statistics.median(lots)


def test_a_think_stays_between_the_floor_and_the_cap():
    fit, uci = maia.think_fit(), sorted(m.uci() for m in OPEN.legal_moves)[0]
    for logits in (spread(1), spread(30)):
        t = times(OPEN, logits, uci, n=2000)
        assert fit["floor"] <= min(t) and max(t) <= fit["ceiling"]
        for left in (0.2, 3, 40):
            clock = {"base": 180, "inc": 0, "left": left}
            t = times(OPEN, logits, uci, clock, n=500)
            assert min(t) >= min(fit["floor"], left / 4) and max(t) <= left / 4


def test_the_same_seed_gives_the_same_move_and_time():
    fake, moves = FakeMaia(spread(4)), [m.uci() for m in OPEN.move_stack]
    assert maia.move(fake, moves, 1500, random.Random(3)) == maia.move(fake, moves, 1500, random.Random(3))


def test_starting_the_service_loads_the_model_and_a_missing_torch_does_not_stop_it(monkeypatch):
    loaded = threading.Event()
    monkeypatch.setattr(maia, "model", loaded.set)
    with TestClient(app):
        assert loaded.wait(2)

    def missing():
        raise ImportError("No module named 'torch'")

    monkeypatch.setattr(maia, "model", missing)
    with TestClient(app) as client:
        assert client.get("/health", **KEY).json() == {"ok": True}


def game(plies: int) -> list[str]:
    """A legal game of that many plies that has not ended. Only its length matters to these tests."""
    rng, board = random.Random(0), maia.replay([])
    while len(board.move_stack) < plies:
        board.push(rng.choice(sorted(board.legal_moves, key=str)))
        if board.is_game_over():
            board.pop()
    return [m.uci() for m in board.move_stack]


RESIGN, DRAW = maia.resign_fit()["resign"], maia.resign_fit()["draw"]
# Level 1500 plays in the 1400 band, and Maia is white at an even ply
LOST = RESIGN["threshold"]["1400"]


def lost_for(turns: int, moves: list[str]):
    """Under the threshold on Maia's last `turns` turns and at it before."""
    return lambda board: LOST - 0.001 if len(board.move_stack) > len(moves) - 2 * turns else LOST


def test_a_position_lost_for_the_required_turns_resigns():
    moves = game(2 * (RESIGN["min_move"] - 1))
    assert maia.move(FakeMaia({}, lost_for(RESIGN["turns"], moves)), moves, 1500) == {"resign": True}


def test_fewer_lost_turns_than_required_play_on():
    moves = game(2 * (RESIGN["min_move"] - 1))
    for turns in range(1, RESIGN["turns"]):
        assert "move" in maia.move(FakeMaia({}, lost_for(turns, moves)), moves, 1500)


def test_maia_never_resigns_before_the_minimum_move():
    moves = game(2 * (RESIGN["min_move"] - 2))
    assert "move" in maia.move(FakeMaia({}, lambda board: 0.0), moves, 1500)


def test_a_playable_position_costs_one_pass_for_it_and_one_for_the_move_before():
    fake, moves = FakeMaia({}), game(2 * (RESIGN["min_move"] - 1))
    maia.move(fake, moves, 1500)
    assert len(fake.asked) == 2


def test_the_endpoint_answers_only_resign_when_maia_resigns(monkeypatch):
    monkeypatch.setattr(maia, "model", lambda: FakeMaia({}, lambda board: 0.0))
    body = {"moves": game(2 * (RESIGN["min_move"] - 1)), "level": 1500}
    assert CLIENT.post("/maia/move", json=body, **KEY).json() == {"resign": True}


def test_a_surprising_move_to_answer_lengthens_the_typical_think():
    def thinks(fake):
        return [maia.move(fake, ["e2e4"], 1500, random.Random(s))["think"] for s in range(300)]
    expected, surprised = FakeMaia({"e2e4": 0.0}), FakeMaia({"d2d4": 0.0, "e2e4": -3.0})
    assert statistics.median(thinks(surprised)) > statistics.median(thinks(expected))


def test_a_draw_is_taken_in_a_level_position_from_the_minimum_move():
    moves = game(2 * (DRAW["min_move"] - 1))
    assert maia.draw(FakeMaia({}), moves, 1500) == {"accept": True}
    assert maia.draw(FakeMaia({}), moves[:-2], 1500) == {"accept": False}


def test_a_draw_is_refused_when_maia_is_clearly_better():
    # The score is the player's, who is to move
    moves = game(2 * (DRAW["min_move"] - 1))
    maia_better = FakeMaia({}, lambda board: 0.5 - DRAW["margin"] - 0.05)
    assert maia.draw(maia_better, moves, 1500) == {"accept": False}
    maia_worse = FakeMaia({}, lambda board: 0.5 + DRAW["margin"])
    assert maia.draw(maia_worse, moves, 1500) == {"accept": True}


def test_the_draw_endpoint_needs_the_key_and_a_level_on_offer(monkeypatch):
    monkeypatch.setattr(maia, "model", lambda: FakeMaia({}))
    body = {"moves": game(2 * (DRAW["min_move"] - 1)), "level": 1500}
    assert CLIENT.post("/maia/draw", json=body).status_code == 401
    assert CLIENT.post("/maia/draw", json=body, **KEY).json() == {"accept": True}
    assert CLIENT.post("/maia/draw", json={**body, "level": 2400}, **KEY).status_code == 400
