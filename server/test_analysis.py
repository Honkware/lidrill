"""The judge port must agree with the client's judge.test.ts vectors, and
analyze_moves must reproduce analyze.ts semantics (white POV, book plies,
terminal positions). The engine is scripted - no binary needed in tests."""

import chess
import pytest

from analysis import MATED, analyze_game, analyze_moves, judge, winning_chances


class FakeEngine:
    """Returns a fixed eval per searched FEN."""

    def __init__(self, by_fen):
        self.by_fen = by_fen
        self.searched = []

    def search(self, fen, depth):
        self.searched.append(fen)
        return {"eval": self.by_fen[fen], "pv": [], "depth": depth, "multipv": 1}


def test_winning_chances_matches_lila_anchors():
    assert winning_chances({"cp": 0}) == 0
    assert abs(winning_chances({"cp": 5000}) - winning_chances({"cp": 1000})) < 1e-9
    assert winning_chances({"mate": 1}) > winning_chances({"cp": 1000})


def test_judge_drop_thresholds():
    assert judge({"cp": 0}, {"cp": -30}, "white") is None
    assert judge({"cp": 0}, {"cp": -60}, "white") == "inaccuracy"
    assert judge({"cp": 0}, {"cp": -120}, "white") == "mistake"
    assert judge({"cp": 0}, {"cp": -200}, "white") == "blunder"


def test_judge_mover_pov():
    assert judge({"cp": 0}, {"cp": 200}, "black") == "blunder"
    assert judge({"cp": 0}, {"cp": 200}, "white") is None


def test_judge_mates_like_lila():
    assert judge({"cp": 50}, {"mate": -3}, "white") == "blunder"
    assert judge({"cp": -800}, {"mate": -3}, "white") == "mistake"
    assert judge({"cp": -1200}, {"mate": -3}, "white") == "inaccuracy"
    assert judge({"mate": 2}, {"cp": 300}, "white") == "blunder"
    assert judge({"mate": 2}, {"mate": 4}, "white") is None


def test_analyze_moves_white_pov_and_book():
    # 1. e4 e5 2. Qh5 Nc6 3. Qxf5# is not legal; use a real miniature:
    # 1. f3 e5 2. g4 Qh4#  (fastest mate)
    moves = [
        {"san": "f3", "uci": "f2f3"},
        {"san": "e5", "uci": "e7e5"},
        {"san": "g4", "uci": "g2g4"},
        {"san": "Qh4#", "uci": "d8h4"},
    ]
    board = chess.Board()
    fens = [board.fen()]
    for m in moves:
        board.push_uci(m["uci"])
        fens.append(board.fen())

    # Positions after plies 1..4; script a hanging-mate eval for black's reply
    # and something quiet elsewhere. Book = 2 plies, so plies 3-4 are judged.
    values = {
        fens[1]: {"cp": 20},  # after f3 (white to move... no: after 1.f3, black to move; index i=1 → black)
        fens[2]: {"cp": -30},  # after e5, white to move
        fens[3]: {"cp": -20},  # after g4, black to move
        # fens[4] is checkmate: terminal, never searched
    }
    engine = FakeEngine(values)
    out = analyze_moves(moves, engine, depth=14, book_plies=2)

    assert out[0]["book"] is True and out[1]["book"] is True
    assert out[2]["book"] is False and out[3]["book"] is False
    # evals[i] is the position after ply i, white's POV: after g4 (ply 3)
    # black is to move and reported -20, stored flipped to +20 for white
    assert "eval" not in out[0] and "eval" not in out[1]
    assert out[2]["eval"] == {"cp": 20}
    # Final position is mate, stored as ±10000 from white's view (white mated)
    assert out[3]["eval"] == {"cp": -MATED}
    assert fens[4] not in engine.searched  # terminal positions aren't searched
    assert set(engine.searched) == {fens[2], fens[3]}  # book positions neither


def test_analyze_game_shape():
    moves = [{"san": "f3", "uci": "f2f3"}, {"san": "e5", "uci": "e7e5"}, {"san": "g4", "uci": "g2g4"}, {"san": "Qh4#", "uci": "d8h4"}]
    board = chess.Board()
    fens = [board.fen()]
    for m in moves:
        board.push_uci(m["uci"])
        fens.append(board.fen())
    engine = FakeEngine({fens[1]: {"cp": 20}, fens[2]: {"cp": -30}, fens[3]: {"cp": -20}})
    game = {"id": "lichess:x", "site": "lichess", "moves": moves, "color": "white", "analyzedAt": None}
    out = analyze_game(game, engine, depth=14)
    assert out["analyzedAt"] is not None
    assert out["id"] == "lichess:x"
    assert len(out["moves"]) == 4
    # evals are plain JSON: no None-valued keys
    assert all("cp" not in m or m["cp"] is not None for m in out["moves"])
    assert all("mate" not in m or m["mate"] is not None for m in out["moves"])


def test_evals_not_searched_again_when_known():
    # Lichess-server-analyzed games carry evals on the moves; those positions
    # must not be re-searched (same rule as analyze.ts)
    moves = [
        {"san": "f3", "uci": "f2f3", "eval": {"cp": 20}},
        {"san": "e5", "uci": "e7e5", "eval": {"cp": -30}},
        {"san": "g4", "uci": "g2g4", "eval": {"cp": -400}},
        {"san": "Qh4#", "uci": "d8h4", "eval": {"cp": -MATED}},
    ]
    engine = FakeEngine({})
    out = analyze_moves(moves, engine, depth=14, book_plies=0)
    assert engine.searched == []
    assert out[3]["eval"] == {"cp": -MATED}
