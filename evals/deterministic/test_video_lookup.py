"""DETERMINISTIC EVAL — Memory.gated_video_lookup, end to end offline.

Pins three things that matter more than any single unit:
  1. An empty store skips the gate call entirely (no reason to spend a small-
     model call deciding whether to look up a library that has nothing in it).
  2. A "no" from the gate, or a search that clears nothing, both return "" —
     silence, not a forced weak recommendation.
  3. The URL that reaches the prompt is exactly the one that was stored, never
     reconstructed or altered on the way out.
"""

from __future__ import annotations

from evals.helpers import ScriptedClient, response, text_block
from waku.config import Settings
from waku.memory import Memory


def make_memory(tmp_path, script):
    from waku.db import connect

    conn = connect(tmp_path)
    settings = Settings(home=tmp_path, api_key="offline")
    client = ScriptedClient(script)
    return Memory(conn, settings, client)


def test_an_empty_store_skips_the_gate_call(tmp_path):
    mem = make_memory(tmp_path, script=[])  # any client.messages.create call would IndexError
    assert mem.gated_video_lookup("how do I open a trading account?") == ""


def test_a_gate_no_returns_nothing(tmp_path):
    mem = make_memory(tmp_path, script=[
        response([text_block('{"lookup": false, "query": "", "reason": "not our subject"}')]),
    ])
    mem.videos._embed = lambda text: [1.0, 0.0]
    mem.videos.upsert("vid1", "Brokerage Accounts 101", "", "https://youtu.be/vid1")

    assert mem.gated_video_lookup("what's 2+2?") == ""


def test_a_gate_yes_with_no_confident_match_returns_nothing(tmp_path):
    mem = make_memory(tmp_path, script=[
        response([text_block('{"lookup": true, "query": "trading account", "reason": "how-to"}')]),
    ])
    vectors = {"How to Cook Rice\n": [0.0, 1.0], "trading account": [1.0, 0.0]}
    mem.videos._embed = lambda text: vectors[text]
    mem.videos.upsert("rice", "How to Cook Rice", "", "https://youtu.be/rice")

    assert mem.gated_video_lookup("how do I open a trading account?") == ""


def test_a_confident_match_is_returned_with_the_stored_url_verbatim(tmp_path):
    mem = make_memory(tmp_path, script=[
        response([text_block('{"lookup": true, "query": "trading account", "reason": "how-to"}')]),
    ])
    vectors = {"Brokerage Accounts 101\n": [1.0, 0.0], "trading account": [0.95, 0.05]}
    mem.videos._embed = lambda text: vectors[text]
    mem.videos.upsert("brokerage", "Brokerage Accounts 101", "", "https://youtu.be/brokerage")

    result = mem.gated_video_lookup("how do I open a trading account?")
    assert result == "[video] Brokerage Accounts 101 — https://youtu.be/brokerage"


def test_notify_receives_the_gate_decision(tmp_path):
    mem = make_memory(tmp_path, script=[
        response([text_block('{"lookup": false, "query": "", "reason": "not our subject"}')]),
    ])
    mem.videos._embed = lambda text: [1.0, 0.0]
    mem.videos.upsert("vid1", "Brokerage Accounts 101", "", "https://youtu.be/vid1")

    events = []
    mem.gated_video_lookup("what's 2+2?", notify=lambda kind, ev: events.append((kind, ev)))
    assert events == [("video_gate", {"decision": "skip", "reason": "not our subject"})]
