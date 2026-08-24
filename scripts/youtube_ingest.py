"""Pull YouTube videos into memory as recommendable resources.

    python scripts/youtube_ingest.py --channel @SomeChannel
    python scripts/youtube_ingest.py --channel UCxxxxxxxxxxxxxxxxxxxxxx
    python scripts/youtube_ingest.py --channel https://youtube.com/@SomeChannel

    python scripts/youtube_ingest.py \\
        --video-id fSQ5jyw7HLg --transcript-file docs/transcripts/video1.txt \\
        --video-id Px2X34Ytil8 --transcript-file docs/transcripts/video2.txt

Needs YOUTUBE_API_KEY (a YouTube Data API v3 key — console.cloud.google.com,
enable "YouTube Data API v3", create an API key; no OAuth, no scopes, this
only reads public channel data) and OPENROUTER_API_KEY (embeddings, via
OpenRouter's /embeddings endpoint — see waku/memory/video_resources.py).
See .env.example.

--channel enumerates a whole channel's uploads and stores title, description,
url and an embedding per video (waku/memory/video_resources.py). --video-id /
--transcript-file instead names specific videos directly (repeatable, paired
by position) and additionally chunks and embeds the given transcript file
into video_transcript_chunks (waku/memory/video_transcripts.py) — for when
you already have transcripts for a handful of videos rather than a whole
channel to scrape. Either way, waku/memory/video_gate.py decides at chat time
whether a lookup is worth it, and waku/memory/__init__.py's
gated_video_lookup checks the transcript before falling back to title/desc.

Zero new dependencies: the API is plain HTTPS + an API key, fetched with
stdlib urllib, the same way waku/tools/search.py talks to Tavily/DuckDuckGo.
Transcript files are read straight off disk — no transcript-fetching API or
library involved.

Re-running --channel re-embeds every video every time — no dedup, no
reconciliation for videos removed from the channel since the last run. Fine
for a channel this size run by hand; not built to run on a schedule against a
large one. --video-id mode does skip a video's transcript chunking if it's
already in video_transcript_chunks (a transcript never changes once
ingested) — see TranscriptChunkStore.has_chunks.
"""

from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from waku.config import load_settings
from waku.db import connect
from waku.memory.video_resources import VideoResourceStore
from waku.memory.video_transcripts import TranscriptChunkStore

API_BASE = "https://www.googleapis.com/youtube/v3"


def _get(path: str, params: dict, api_key: str) -> dict:
    url = f"{API_BASE}/{path}?" + urllib.parse.urlencode({**params, "key": api_key})
    try:
        with urllib.request.urlopen(url, timeout=20) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "ignore")
        raise SystemExit(f"YouTube API error ({exc.code}): {body}") from exc


def _resolve_channel_id(channel: str, api_key: str) -> str:
    """Accepts a channel ID (UC...), a handle (@name or bare name), or a full
    youtube.com URL, and returns the channel ID."""
    if "youtube.com" in channel:
        path = urllib.parse.urlparse(channel).path.strip("/")
        segment = path.split("/")[-1]
        return _resolve_channel_id(segment, api_key)
    if channel.startswith("UC") and len(channel) == 24:
        data = _get("channels", {"part": "contentDetails", "id": channel}, api_key)
    else:
        handle = channel if channel.startswith("@") else f"@{channel}"
        data = _get("channels", {"part": "contentDetails", "forHandle": handle}, api_key)
    items = data.get("items", [])
    if not items:
        raise SystemExit(f"No channel found for '{channel}' — check the handle/ID/URL.")
    return items[0]["contentDetails"]["relatedPlaylists"]["uploads"]


def _iter_playlist_items(uploads_playlist_id: str, api_key: str):
    page_token = None
    while True:
        params = {"part": "snippet", "playlistId": uploads_playlist_id, "maxResults": 50}
        if page_token:
            params["pageToken"] = page_token
        data = _get("playlistItems", params, api_key)
        yield from data.get("items", [])
        page_token = data.get("nextPageToken")
        if not page_token:
            return


def _fetch_video_snippets(video_ids: list[str], api_key: str) -> dict[str, dict]:
    """videos.list, batched 50 ids/call (its max) — used by --video-id mode,
    which names videos directly instead of enumerating a whole channel."""
    snippets: dict[str, dict] = {}
    for i in range(0, len(video_ids), 50):
        batch = video_ids[i : i + 50]
        data = _get("videos", {"part": "snippet", "id": ",".join(batch)}, api_key)
        for item in data.get("items", []):
            snippets[item["id"]] = item["snippet"]
    return snippets


def _ingest_channel(channel: str, api_key: str, store: VideoResourceStore, home) -> int:
    print(f"Resolving channel '{channel}'...", flush=True)
    uploads_playlist_id = _resolve_channel_id(channel, api_key)

    print("Fetching video list...", flush=True)
    items = list(_iter_playlist_items(uploads_playlist_id, api_key))
    print(f"Found {len(items)} video(s). Embedding (one API call each, this is the slow part)...", flush=True)

    ingested = 0
    for i, item in enumerate(items, 1):
        snippet = item["snippet"]
        video_id = snippet["resourceId"]["videoId"]
        title = snippet.get("title", video_id)
        print(f"  [{i}/{len(items)}] {title}...", end=" ", flush=True)
        store.upsert(
            video_id=video_id,
            title=title,
            description=snippet.get("description", ""),
            url=f"https://youtu.be/{video_id}",
            published_at=snippet.get("publishedAt", ""),
        )
        ingested += 1
        print("done", flush=True)

    print(f"\nIngested {ingested} video(s) into {home / 'state.db'} (video_resources table).")
    return ingested


def _ingest_named_videos(video_ids: list[str], transcript_files: list[str], api_key: str,
                          store: VideoResourceStore, transcripts: TranscriptChunkStore, home) -> int:
    print(f"Fetching metadata for {len(video_ids)} video(s)...", flush=True)
    snippets = _fetch_video_snippets(video_ids, api_key)

    ingested = 0
    for i, (video_id, transcript_path) in enumerate(zip(video_ids, transcript_files), 1):
        snippet = snippets.get(video_id)
        if snippet is None:
            print(f"  [{i}/{len(video_ids)}] {video_id}: not found on YouTube, skipping", flush=True)
            continue
        title = snippet.get("title", video_id)
        print(f"  [{i}/{len(video_ids)}] {title}...", end=" ", flush=True)
        store.upsert(
            video_id=video_id,
            title=title,
            description=snippet.get("description", ""),
            url=f"https://youtu.be/{video_id}",
            published_at=snippet.get("publishedAt", ""),
        )
        if transcripts.has_chunks(video_id):
            print("video metadata updated, transcript already ingested — skipped", flush=True)
        else:
            text = Path(transcript_path).read_text(encoding="utf-8")
            n_chunks = transcripts.upsert_transcript(video_id, text)
            print(f"done ({n_chunks} transcript chunk(s))", flush=True)
        ingested += 1

    print(f"\nIngested {ingested} video(s) into {home / 'state.db'}.")
    return ingested


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--channel", help="handle (@name), channel ID (UC...), or full URL")
    parser.add_argument("--video-id", action="append", default=[], metavar="ID",
                         help="a specific video id (repeatable, pairs positionally with --transcript-file)")
    parser.add_argument("--transcript-file", action="append", default=[], metavar="PATH",
                         help="local transcript file for the matching --video-id (repeatable)")
    parser.add_argument("--api-key", default=os.getenv("YOUTUBE_API_KEY", ""))
    args = parser.parse_args(argv)

    if not args.api_key:
        raise SystemExit("Set YOUTUBE_API_KEY (see .env.example) or pass --api-key.")
    if not args.channel and not args.video_id:
        raise SystemExit("Pass --channel, or one or more --video-id/--transcript-file pairs.")
    if args.video_id and len(args.video_id) != len(args.transcript_file):
        raise SystemExit("--video-id and --transcript-file must be given the same number of times, "
                          "in matching order.")

    settings = load_settings()
    conn = connect(settings.home)
    store = VideoResourceStore(conn)

    if args.channel:
        _ingest_channel(args.channel, args.api_key, store, settings.home)
    else:
        transcripts = TranscriptChunkStore(conn)
        _ingest_named_videos(args.video_id, args.transcript_file, args.api_key, store, transcripts, settings.home)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
