"""Backend tests: run on the VM with the venv active (pytest)."""

import json
import os

import pytest
from fastapi.testclient import TestClient

os.environ["DATA_DIR"] = os.path.join(os.path.dirname(__file__), ".test-data")
os.environ["LIDRILL_KEY"] = "test-key"

from app import app  # noqa: E402

KEY = {"headers": {"x-lidrill-key": "test-key"}}
CLIENT = TestClient(app)

PUZZLE = {"id": "g:5", "gameId": "g", "ply": 5, "fen": "fen", "played": "e2e4", "solution": [], "solutionLen": 1, "type": "hang", "tag": "hang", "swingCp": 300, "card": {"due": 1}}


@pytest.fixture(autouse=True)
def clean():
    import glob
    import shutil

    shutil.rmtree(os.environ["DATA_DIR"], ignore_errors=True)
    for f in glob.glob(os.environ["DATA_DIR"] + "*"):
        shutil.rmtree(f, ignore_errors=True)
    yield
    shutil.rmtree(os.environ["DATA_DIR"], ignore_errors=True)


def push(user, rows, **kw):
    return CLIENT.post(f"/u/{user}/push", json={"rows": rows}, **KEY, **kw)


def test_health_requires_key():
    assert CLIENT.get("/health").status_code == 401
    assert CLIENT.get("/health", **KEY).json() == {"ok": True}


def test_push_pull_roundtrip():
    rows = [
        {"table": "puzzles", "id": "g:5", "updatedAt": 100, "data": PUZZLE},
        {"table": "journal", "id": "g", "updatedAt": 200, "data": {"gameId": "g", "at": 1, "opening": "o", "confirmed": False}},
    ]
    res = push("player_01", rows)
    assert res.status_code == 200
    assert res.json()["upserted"] == 2

    pulled = CLIENT.get("/u/player_01/pull", params={"since": 0}, **KEY).json()
    assert [(r["table"], r["id"], r["updatedAt"]) for r in pulled["rows"]] == [("puzzles", "g:5", 100), ("journal", "g", 200)]
    assert pulled["nextCursor"] is None
    assert pulled["rows"][0]["data"] == PUZZLE

    # A pull from `since` after both rows sees nothing
    assert CLIENT.get("/u/player_01/pull", params={"since": 200}, **KEY).json()["rows"] == []
    # ... and exactly at the newest row's time still returns it (clients
    # watermark with their own pull-completion time, so >= is a no-op there)
    assert len(CLIENT.get("/u/player_01/pull", params={"since": 99}, **KEY).json()["rows"]) == 2


def test_newer_updated_at_wins():
    push("player_01", [{"table": "puzzles", "id": "g:5", "updatedAt": 200, "data": {**PUZZLE, "swingCp": 200}}])
    push("player_01", [{"table": "puzzles", "id": "g:5", "updatedAt": 100, "data": {**PUZZLE, "swingCp": 100}}])  # older: no-op
    row = CLIENT.get("/u/player_01/pull", params={"since": 0}, **KEY).json()["rows"][0]
    assert row["data"]["swingCp"] == 200
    assert row["updatedAt"] == 200
    push("player_01", [{"table": "puzzles", "id": "g:5", "updatedAt": 300, "data": {**PUZZLE, "swingCp": 300}}])
    row = CLIENT.get("/u/player_01/pull", params={"since": 0}, **KEY).json()["rows"][0]
    assert row["data"]["swingCp"] == 300


def test_rejects_bad_rows_and_wrong_key():
    assert push("player_01", [{"table": "auth", "id": "x", "updatedAt": 1, "data": {}}]).status_code == 400
    assert push("player_01", [{"table": "puzzles", "id": "x", "updatedAt": -5, "data": {}}]).status_code == 400
    assert CLIENT.post("/u/player_01/push", json={"rows": []}, headers={"x-lidrill-key": "wrong"}).status_code == 401
    assert CLIENT.get("/u/..%2Fetc/passwd/state", **KEY).status_code in (400, 404)


def test_state_and_users_isolated():
    push("player_01", [{"table": "puzzles", "id": "a", "updatedAt": 1, "data": {}}])
    push("other", [{"table": "puzzles", "id": "b", "updatedAt": 1, "data": {}}])
    assert CLIENT.get("/u/player_01/state", **KEY).json()["rows"] == 1
    assert CLIENT.get("/u/other/state", **KEY).json()["rows"] == 1
    assert CLIENT.get("/u/player_01/state", **KEY).json()["lastSeen"] is not None


def test_pagination_cursor():
    rows = [{"table": "syncState", "id": f"s{i}", "updatedAt": 100, "data": {}} for i in range(5)]
    push("player_01", rows)
    page1 = CLIENT.get("/u/player_01/pull", params={"since": 0, "limit": 2}, **KEY).json()
    assert [r["id"] for r in page1["rows"]] == ["s0", "s1"]
    page2 = CLIENT.get("/u/player_01/pull", params={"since": 0, "limit": 2, "cursor": page1["nextCursor"]}, **KEY).json()
    assert [r["id"] for r in page2["rows"]] == ["s2", "s3"]
    page3 = CLIENT.get("/u/player_01/pull", params={"since": 0, "limit": 2, "cursor": page2["nextCursor"]}, **KEY).json()
    assert [r["id"] for r in page3["rows"]] == ["s4"]
    assert page3["nextCursor"] is None


def test_unanalyzed_game_queues_job():
    game = {"id": "lichess:x", "analyzedAt": None, "moves": []}
    push("player_01", [{"table": "games", "id": "lichess:x", "updatedAt": 1, "data": game}])
    assert CLIENT.get("/u/player_01/state", **KEY).json()["pendingAnalysis"] == 1
    analyzed = {**game, "analyzedAt": 5}
    push("player_01", [{"table": "games", "id": "lichess:x", "updatedAt": 5, "data": analyzed}])
    # Re-pushing the analyzed game does not queue it again
    assert CLIENT.get("/u/player_01/state", **KEY).json()["pendingAnalysis"] == 1


def test_wipe():
    push("player_01", [{"table": "puzzles", "id": "a", "updatedAt": 1, "data": {}}])
    assert CLIENT.delete("/u/player_01/rows", **KEY).json() == {"ok": True}
    assert CLIENT.get("/u/player_01/state", **KEY).json()["rows"] == 0
    assert CLIENT.get("/u/player_01/pull", params={"since": 0}, **KEY).json()["rows"] == []


def test_jobs_not_exposed_and_json_roundtrip():
    # data with unicode + nested structures survives the round trip
    data = {"note": "héllo ✓", "nested": {"a": [1, 2, None]}}
    push("player_01", [{"table": "journal", "id": "g", "updatedAt": 1, "data": data}])
    row = CLIENT.get("/u/player_01/pull", params={"since": 0}, **KEY).json()["rows"][0]
    assert row["data"] == data
