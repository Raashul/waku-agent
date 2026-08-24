"""Transcript chunks — the spoken content behind a video_resources row.

video_resources.py matches on title + description; that's a ceiling. A lot of
what actually answers a question is said in the video and never written down
anywhere else. This store chunks a video's transcript, embeds each chunk, and
searches those chunks directly — so a question the title never mentions can
still surface the right video, with the exact text that answers it.

Same shape as VideoResourceStore on purpose: the same lazy OpenRouter client,
the same pure-Python cosine scan (imported from video_resources.py, not
reimplemented). What's new is chunk_text() and the join back to
video_resources for title/url — a transcript chunk on its own is useless
without its parent video's metadata, so a video's title/description must be
ingested before or alongside its transcript.

No timestamp columns. The transcripts this ingests are plain text with no
per-line times, so there is nothing to store — a match gives the plain video
URL plus the matching chunk's text, not a `?t=` deep link.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3

from waku.memory.semantic.base import env_or
from waku.memory.video_resources import OPENROUTER_BASE_URL, _cosine

_PARAGRAPH_SPLIT = re.compile(r"\n\s*\n")
# Sentence end: '.', '?', '!', or the Devanagari danda '।' (Nepali) — the
# channel's transcripts are an English/Nepali mix, so an ASCII-only sentence
# boundary would silently stop working on half the content.
_SENTENCE_SPLIT = re.compile(r"(?<=[.?!।])\s+")


def chunk_text(text: str, target_chars: int = 1000) -> list[str]:
    """Split into chunks near target_chars, breaking only at a paragraph or
    sentence boundary — never mid-word. A paragraph that's still too long
    after a sentence split falls back to accumulating whole sentences, so the
    only way a chunk exceeds target_chars is a single run-on sentence with no
    punctuation at all."""
    paragraphs = [p.strip() for p in _PARAGRAPH_SPLIT.split(text.strip()) if p.strip()]
    chunks: list[str] = []
    current = ""
    for para in paragraphs:
        candidate = f"{current} {para}".strip() if current else para
        if len(candidate) <= target_chars:
            current = candidate
            continue
        if current:
            chunks.append(current)
            current = ""
        if len(para) <= target_chars:
            current = para
        else:
            chunks.extend(_chunk_sentences(para, target_chars))
    if current:
        chunks.append(current)
    return chunks


def _chunk_sentences(paragraph: str, target_chars: int) -> list[str]:
    chunks: list[str] = []
    current = ""
    for sentence in _SENTENCE_SPLIT.split(paragraph):
        candidate = f"{current} {sentence}".strip() if current else sentence
        if len(candidate) <= target_chars or not current:
            current = candidate
        else:
            chunks.append(current)
            current = sentence
    if current:
        chunks.append(current)
    return chunks


class TranscriptChunkStore:
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
        self._openai = None
        self.embed_model = env_or("WAKU_TRANSCRIPT_EMBED_MODEL", "openai/text-embedding-3-small")

    def _client(self):
        if self._openai is None:
            import openai

            self._openai = openai.OpenAI(
                base_url=OPENROUTER_BASE_URL, api_key=os.environ["OPENROUTER_API_KEY"],
                timeout=30,
            )
        return self._openai

    def _embed(self, text: str) -> list[float]:
        return self._client().embeddings.create(model=self.embed_model, input=[text]).data[0].embedding

    def has_chunks(self, video_id: str) -> bool:
        """The re-ingest skip check — a transcript never changes once
        ingested, so there's no reason to re-embed it on every run."""
        row = self.conn.execute(
            "SELECT 1 FROM video_transcript_chunks WHERE video_id=? LIMIT 1", (video_id,)
        ).fetchone()
        return row is not None

    def upsert_transcript(self, video_id: str, text: str, target_chars: int = 1000) -> int:
        """Chunk, embed, and store. Returns the number of chunks written."""
        chunks = chunk_text(text, target_chars)
        for i, chunk in enumerate(chunks):
            embedding = self._embed(chunk)
            self.conn.execute(
                """INSERT INTO video_transcript_chunks (video_id, chunk_index, text, embedding)
                   VALUES (?,?,?,?)
                   ON CONFLICT(video_id, chunk_index) DO UPDATE SET
                     text=excluded.text, embedding=excluded.embedding""",
                (video_id, i, chunk, json.dumps(embedding)),
            )
        self.conn.commit()
        return len(chunks)

    def search(self, query: str, top_k: int = 1, threshold: float = 0.35) -> list[dict]:
        """Best-matching chunks, best first, joined to their video's title/url.
        Below `threshold` a chunk is not a confident enough match to recommend,
        so it's dropped — an empty list means "nothing relevant", not "couldn't
        search"."""
        rows = self.conn.execute(
            """SELECT c.video_id, c.text AS chunk_text, c.embedding, v.title, v.url
               FROM video_transcript_chunks c JOIN video_resources v ON v.video_id = c.video_id"""
        ).fetchall()
        if not rows:
            return []
        query_embedding = self._embed(query)
        scored = [
            {"video_id": r["video_id"], "title": r["title"], "url": r["url"],
             "chunk_text": r["chunk_text"], "score": _cosine(query_embedding, json.loads(r["embedding"]))}
            for r in rows
        ]
        scored = [s for s in scored if s["score"] >= threshold]
        scored.sort(key=lambda s: s["score"], reverse=True)
        return scored[:top_k]

    def count(self) -> int:
        (n,) = self.conn.execute("SELECT COUNT(*) FROM video_transcript_chunks").fetchone()
        return n
