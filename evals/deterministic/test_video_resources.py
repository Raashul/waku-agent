"""DETERMINISTIC EVAL — the video resource store: upsert, cosine search,
the similarity threshold, and the count()-gated skip that avoids embedding a
query when nothing has been ingested yet.

Embeddings are monkeypatched to fixed vectors — real ranking behaviour of a
given embedding model is a judgment call and belongs in evals/judge/, not
here. What's pinned: upsert is idempotent by video_id, search sorts by score
and respects top_k, a video below `threshold` is dropped rather than
returned as a weak guess, and an empty store never calls the embedding API.
"""

from __future__ import annotations

import pytest

from waku.db import connect
from waku.memory.video_resources import VideoResourceStore, _cosine


@pytest.fixture
def store(tmp_path):
    return VideoResourceStore(connect(tmp_path))


def fake_embed(vectors: dict[str, list[float]]):
    """Returns a stand-in for VideoResourceStore._embed that looks up a fixed
    vector by exact text match, and records how many times it was called."""
    calls = []

    def _embed(text):
        calls.append(text)
        return vectors[text]

    _embed.calls = calls
    return _embed


# ---------- cosine similarity itself


def test_cosine_of_identical_vectors_is_one():
    assert _cosine([1.0, 0.0], [1.0, 0.0]) == pytest.approx(1.0)


def test_cosine_of_orthogonal_vectors_is_zero():
    assert _cosine([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)


def test_cosine_of_opposite_vectors_is_negative_one():
    assert _cosine([1.0, 0.0], [-1.0, 0.0]) == pytest.approx(-1.0)


# ---------- upsert


def test_upsert_stores_a_retrievable_video(store):
    store._embed = fake_embed({"Opening a Brokerage Account\n": [1.0, 0.0]})
    store.upsert("vid1", "Opening a Brokerage Account", "", "https://youtu.be/vid1")
    assert store.count() == 1


def test_upsert_is_idempotent_by_video_id(store):
    store._embed = fake_embed({
        "Old Title\n": [1.0, 0.0],
        "New Title\n": [1.0, 0.0],
    })
    store.upsert("vid1", "Old Title", "", "https://youtu.be/vid1")
    store.upsert("vid1", "New Title", "", "https://youtu.be/vid1")
    assert store.count() == 1
    row = store.conn.execute("SELECT title FROM video_resources WHERE video_id='vid1'").fetchone()
    assert row["title"] == "New Title"


# ---------- search


def test_search_returns_the_closest_match_first(store):
    store._embed = fake_embed({
        "Brokerage Accounts 101\n": [1.0, 0.0],
        "How to Cook Rice\n": [0.0, 1.0],
        "open a trading account": [0.9, 0.1],
    })
    store.upsert("brokerage", "Brokerage Accounts 101", "", "https://youtu.be/brokerage")
    store.upsert("rice", "How to Cook Rice", "", "https://youtu.be/rice")

    results = store.search("open a trading account", top_k=2, threshold=0.0)
    assert [r["video_id"] for r in results] == ["brokerage", "rice"]
    assert results[0]["score"] > results[1]["score"]


def test_search_drops_matches_below_threshold(store):
    store._embed = fake_embed({
        "How to Cook Rice\n": [0.0, 1.0],
        "open a trading account": [1.0, 0.0],
    })
    store.upsert("rice", "How to Cook Rice", "", "https://youtu.be/rice")

    assert store.search("open a trading account", threshold=0.35) == [], (
        "an unrelated video must not be returned as a weak guess"
    )


def test_search_respects_top_k(store):
    embed = fake_embed({
        "A\n": [1.0, 0.0], "B\n": [0.99, 0.01], "C\n": [0.98, 0.02], "q": [1.0, 0.0],
    })
    store._embed = embed
    for vid, title in [("a", "A"), ("b", "B"), ("c", "C")]:
        store.upsert(vid, title, "", f"https://youtu.be/{vid}")

    results = store.search("q", top_k=2, threshold=0.0)
    assert len(results) == 2


def test_search_on_an_empty_store_returns_empty_without_embedding_the_query(store):
    embed = fake_embed({})
    store._embed = embed
    assert store.search("anything") == []
    assert embed.calls == [], "no videos to compare against — the query must never be embedded"


def test_count_reflects_rows(store):
    store._embed = fake_embed({"A\n": [1.0]})
    assert store.count() == 0
    store.upsert("a", "A", "", "https://youtu.be/a")
    assert store.count() == 1
