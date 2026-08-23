"""Video resources — a YouTube channel's catalog, matched by embedding search.

Deliberately NOT the `facts` table. `facts` is durable claims about the user,
read and rewritten by manage_memory and consolidation.py; a video catalog is
neither, so it gets its own table (waku/db.py) and its own store here rather
than commingling the two.

FTS5 keyword search (what `facts` uses) can't bridge "how do I open a trading
account" to a video titled "Brokerage Account Setup Guide" — zero token
overlap. So this store embeds title+description once at ingestion time
(scripts/youtube_ingest.py) and does cosine similarity at query time instead.
At the scale this is built for (tens of videos), that's just a Python loop
over rows already in memory — no vector index needed.

Embeddings go through OpenRouter rather than OpenAI directly — one key for
both the channel's embeddings and (if WAKU_PROVIDER=openrouter) the main
loop, and OpenRouter's /embeddings endpoint is OpenAI-response-shaped, so
this is the same openai.OpenAI() client, just pointed at a different
base_url:

    OPENROUTER_API_KEY=...   # embeddings only, via openrouter.ai/api/v1
"""

from __future__ import annotations

import json
import math
import os
import sqlite3

from waku.memory.semantic.base import env_or

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


class VideoResourceStore:
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
        self._openai = None
        # OpenRouter's own model id format ("<provider>/<model>"), not the
        # bare "text-embedding-3-small" the direct-OpenAI stores use.
        self.embed_model = env_or("WAKU_VIDEO_EMBED_MODEL", "openai/text-embedding-3-small")

    def _client(self):
        # Built lazily so importing/constructing this store never requires
        # OPENROUTER_API_KEY unless something actually embeds — most turns
        # never reach the gate that would.
        if self._openai is None:
            import openai

            self._openai = openai.OpenAI(
                base_url=OPENROUTER_BASE_URL, api_key=os.environ["OPENROUTER_API_KEY"],
                timeout=30,  # fail fast rather than hang silently on a stuck call
            )
        return self._openai

    def _embed(self, text: str) -> list[float]:
        return self._client().embeddings.create(model=self.embed_model, input=[text]).data[0].embedding

    def upsert(self, video_id: str, title: str, description: str, url: str,
               published_at: str = "") -> None:
        """Embed and (re)write one video. Re-embeds every call — no dedup by
        design (phase 1 is a small channel run by hand, not a cron)."""
        embedding = self._embed(f"{title}\n{description}")
        self.conn.execute(
            """INSERT INTO video_resources (video_id, title, description, url, published_at, embedding)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(video_id) DO UPDATE SET
                 title=excluded.title, description=excluded.description,
                 url=excluded.url, published_at=excluded.published_at,
                 embedding=excluded.embedding""",
            (video_id, title, description, url, published_at, json.dumps(embedding)),
        )
        self.conn.commit()

    def search(self, query: str, top_k: int = 2, threshold: float = 0.35) -> list[dict]:
        """Best-matching videos, best first. Below `threshold` a video is not a
        confident enough match to recommend, so it's dropped rather than
        returned as a weak guess — an empty list means "nothing relevant",
        not "couldn't search"."""
        rows = self.conn.execute(
            "SELECT video_id, title, url, embedding FROM video_resources"
        ).fetchall()
        if not rows:
            return []
        query_embedding = self._embed(query)
        scored = [
            {"video_id": r["video_id"], "title": r["title"], "url": r["url"],
             "score": _cosine(query_embedding, json.loads(r["embedding"]))}
            for r in rows
        ]
        scored = [s for s in scored if s["score"] >= threshold]
        scored.sort(key=lambda s: s["score"], reverse=True)
        return scored[:top_k]

    def count(self) -> int:
        (n,) = self.conn.execute("SELECT COUNT(*) FROM video_resources").fetchone()
        return n
