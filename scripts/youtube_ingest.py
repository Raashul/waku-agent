"""Pull a YouTube channel's videos into memory as recommendable resources.

    python scripts/youtube_ingest.py --channel @SomeChannel
    python scripts/youtube_ingest.py --channel UCxxxxxxxxxxxxxxxxxxxxxx
    python scripts/youtube_ingest.py --channel https://youtube.com/@SomeChannel

Needs YOUTUBE_API_KEY (a YouTube Data API v3 key — console.cloud.google.com,
enable "YouTube Data API v3", create an API key; no OAuth, no scopes, this
only reads public channel data). See .env.example.

For each video this stores title, description, url and an embedding
(waku/memory/video_resources.py) in state.db, so the agent can later match a
question like "how do I open a trading account?" to the right video — see
waku/memory/video_gate.py for how that lookup is gated at chat time.

Zero new dependencies: the API is plain HTTPS + an API key, fetched with
stdlib urllib, the same way waku/tools/search.py talks to Tavily/DuckDuckGo.

Re-running this re-embeds every video every time — no dedup, no reconciliation
for videos removed from the channel since the last run. Fine for a channel
this size run by hand; not built to run on a schedule against a large one.
"""

from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.parse
import urllib.request

from waku.config import load_settings
from waku.db import connect
from waku.memory.video_resources import VideoResourceStore

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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--channel", required=True, help="handle (@name), channel ID (UC...), or full URL")
    parser.add_argument("--api-key", default=os.getenv("YOUTUBE_API_KEY", ""))
    args = parser.parse_args(argv)

    if not args.api_key:
        raise SystemExit("Set YOUTUBE_API_KEY (see .env.example) or pass --api-key.")

    settings = load_settings()
    conn = connect(settings.home)
    store = VideoResourceStore(conn)

    uploads_playlist_id = _resolve_channel_id(args.channel, args.api_key)
    ingested = 0
    for item in _iter_playlist_items(uploads_playlist_id, args.api_key):
        snippet = item["snippet"]
        video_id = snippet["resourceId"]["videoId"]
        store.upsert(
            video_id=video_id,
            title=snippet.get("title", ""),
            description=snippet.get("description", ""),
            url=f"https://youtu.be/{video_id}",
            published_at=snippet.get("publishedAt", ""),
        )
        ingested += 1
        print(f"  {snippet.get('title', video_id)}")

    print(f"\nIngested {ingested} video(s) into {settings.home / 'state.db'} (video_resources table).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
