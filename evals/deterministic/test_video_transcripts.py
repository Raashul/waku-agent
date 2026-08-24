"""DETERMINISTIC EVAL — transcript chunking and the transcript chunk store.

Mirrors test_video_resources.py: embeddings are monkeypatched to fixed
vectors, real ranking behaviour belongs in evals/judge/. What's pinned here:
chunk_text never splits mid-word and respects paragraph/sentence boundaries
(including the Devanagari danda, since the channel's transcripts are an
English/Nepali mix), upsert_transcript is idempotent per (video_id,
chunk_index), has_chunks is the re-ingest skip check, and search joins back
to video_resources for title/url and drops anything below threshold.
"""

from __future__ import annotations

import pytest

from waku.db import connect
from waku.memory.video_resources import VideoResourceStore
from waku.memory.video_transcripts import TranscriptChunkStore, chunk_text


@pytest.fixture
def conn(tmp_path):
    return connect(tmp_path)


@pytest.fixture
def store(conn):
    return TranscriptChunkStore(conn)


def fake_embed(vectors: dict[str, list[float]]):
    calls = []

    def _embed(text):
        calls.append(text)
        return vectors[text]

    _embed.calls = calls
    return _embed


# ---------- chunk_text


def test_chunk_text_of_empty_text_returns_empty_list():
    assert chunk_text("") == []
    assert chunk_text("   \n\n  ") == []


def test_chunk_text_keeps_a_short_paragraph_as_one_chunk():
    assert chunk_text("Open a trading account by visiting the app.", target_chars=1000) == [
        "Open a trading account by visiting the app."
    ]


def test_chunk_text_splits_on_paragraph_boundaries_when_over_budget():
    text = ("A" * 60) + "\n\n" + ("B" * 60)
    chunks = chunk_text(text, target_chars=60)
    assert chunks == ["A" * 60, "B" * 60]


def test_chunk_text_never_splits_a_word_in_half():
    # one long paragraph, no sentence punctuation at all — the only line where
    # a chunk is allowed to exceed target_chars, and even then only whole.
    text = " ".join(["word"] * 50)
    chunks = chunk_text(text, target_chars=20)
    for chunk in chunks:
        for token in chunk.split(" "):
            assert token == "word", f"chunk boundary split a word: {chunk!r}"


def test_chunk_text_splits_on_sentence_boundaries_within_a_long_paragraph():
    text = "First sentence here. Second sentence here. Third sentence here."
    chunks = chunk_text(text, target_chars=25)
    assert len(chunks) > 1
    assert "".join(chunks).replace(" ", "") == text.replace(" ", "")
    for chunk in chunks:
        assert chunk.strip().endswith(".")


def test_chunk_text_treats_the_devanagari_danda_as_a_sentence_end():
    text = "यो पहिलो वाक्य हो। यो दोस्रो वाक्य हो। This is an English sentence."
    chunks = chunk_text(text, target_chars=30)
    assert len(chunks) > 1
    assert any(c.strip().endswith("।") for c in chunks[:-1])


# ---------- upsert_transcript


def test_upsert_transcript_stores_one_row_per_chunk(store):
    store._embed = fake_embed({"First part.": [1.0, 0.0], "Second part.": [0.0, 1.0]})
    n = store.upsert_transcript("vid1", "First part.\n\nSecond part.", target_chars=15)
    assert n == 2
    assert store.count() == 2


def test_upsert_transcript_is_idempotent_by_video_id_and_chunk_index(store):
    store._embed = fake_embed({"Old text.": [1.0, 0.0], "New text.": [1.0, 0.0]})
    store.upsert_transcript("vid1", "Old text.")
    store.upsert_transcript("vid1", "New text.")
    assert store.count() == 1
    row = store.conn.execute(
        "SELECT text FROM video_transcript_chunks WHERE video_id='vid1' AND chunk_index=0"
    ).fetchone()
    assert row["text"] == "New text."


# ---------- has_chunks


def test_has_chunks_is_false_before_ingest_and_true_after(store):
    assert store.has_chunks("vid1") is False
    store._embed = fake_embed({"Some content.": [1.0, 0.0]})
    store.upsert_transcript("vid1", "Some content.")
    assert store.has_chunks("vid1") is True


# ---------- search


def test_search_joins_title_and_url_from_video_resources(conn, store):
    videos = VideoResourceStore(conn)
    videos._embed = fake_embed({"Brokerage Accounts 101\n": [1.0, 0.0]})
    videos.upsert("brokerage", "Brokerage Accounts 101", "", "https://youtu.be/brokerage")

    store._embed = fake_embed({
        "How to open a brokerage account step by step.": [1.0, 0.0],
        "open a trading account": [0.95, 0.05],
    })
    store.upsert_transcript("brokerage", "How to open a brokerage account step by step.")

    results = store.search("open a trading account", threshold=0.0)
    assert results[0]["title"] == "Brokerage Accounts 101"
    assert results[0]["url"] == "https://youtu.be/brokerage"
    assert results[0]["chunk_text"] == "How to open a brokerage account step by step."


def test_search_drops_matches_below_threshold(conn, store):
    videos = VideoResourceStore(conn)
    videos._embed = fake_embed({"How to Cook Rice\n": [0.0, 1.0]})
    videos.upsert("rice", "How to Cook Rice", "", "https://youtu.be/rice")

    store._embed = fake_embed({
        "Boil the rice for ten minutes.": [0.0, 1.0],
        "open a trading account": [1.0, 0.0],
    })
    store.upsert_transcript("rice", "Boil the rice for ten minutes.")

    assert store.search("open a trading account", threshold=0.35) == []


def test_search_on_an_empty_store_returns_empty_without_embedding_the_query(store):
    embed = fake_embed({})
    store._embed = embed
    assert store.search("anything") == []
    assert embed.calls == [], "no chunks to compare against — the query must never be embedded"
