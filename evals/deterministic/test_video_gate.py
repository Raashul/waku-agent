"""DETERMINISTIC EVAL — the gate that decides whether to embed a query at all.

Same contract as retrieval_gate.py's hero moment (evals/deterministic/
test_retrieval_gate.py), applied to the video-resource lookup: a lookup now
costs a real OpenAI embedding call, so a cheap small-model call decides first
whether it's worth making. Pins the parsing and the fail-open posture, not
whether a given model would say true or false for a given sentence.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from evals.helpers import ScriptedClient, response, text_block
from waku.memory.video_gate import GATE_PROMPT, should_recommend_video


def gate(reply_text: str):
    client = ScriptedClient([response([text_block(reply_text)])])
    return should_recommend_video(client, "small-model", "how do I open a trading account?")


# ---------- the happy path


def test_a_yes_carries_the_search_query_through():
    lookup, query, reason = gate(
        '{"lookup": true, "query": "open a trading account", "reason": "how-to question"}'
    )
    assert lookup is True
    assert query == "open a trading account"
    assert reason == "how-to question"


def test_a_no_skips_lookup():
    lookup, _query, reason = gate('{"lookup": false, "query": "", "reason": "not our subject"}')
    assert lookup is False
    assert reason == "not our subject"


def test_prose_around_the_json_is_tolerated():
    lookup, query, _ = gate(
        'Sure! Here is my decision:\n'
        '{"lookup": true, "query": "trading account", "reason": "how-to"}\n'
        'Let me know if you need anything else.'
    )
    assert lookup is True
    assert query == "trading account"


def test_a_reasoning_block_before_the_json_is_tolerated():
    lookup, query, _ = gate(
        "<thinking>This is a how-to question our channel likely covers.</thinking>"
        '{"lookup": true, "query": "trading account", "reason": "how-to"}'
    )
    assert lookup is True
    assert query == "trading account"


# ---------- fail OPEN


def test_a_reply_with_no_json_at_all_fails_open():
    lookup, query, reason = gate("I think you should probably look that up.")
    assert lookup is True
    assert query == "how do I open a trading account?"
    assert "failing open" in reason


def test_malformed_json_fails_open():
    lookup, _query, reason = gate('{"lookup": true, "query": ')
    assert lookup is True
    assert "gate failed open" in reason


def test_an_api_error_fails_open_and_names_the_error_type():
    class Boom:
        def __init__(self):
            self.messages = SimpleNamespace(create=self._create)

        def _create(self, **_kw):
            raise TimeoutError("upstream took too long")

    lookup, query, reason = should_recommend_video(Boom(), "small-model", "what is 2+2?")
    assert lookup is True
    assert query == "what is 2+2?"
    assert "gate failed open" in reason and "TimeoutError" in reason


@pytest.mark.parametrize("missing", ['{"reason": "no lookup key"}', "{}"])
def test_a_json_reply_missing_the_decision_reads_as_no(missing):
    lookup, _query, _reason = gate(missing)
    assert lookup is False


def test_a_missing_query_falls_back_to_the_whole_message():
    lookup, query, _ = gate('{"lookup": true, "reason": "how-to"}')
    assert lookup is True
    assert query == "how do I open a trading account?"


# ---------- the prompt itself


def test_the_gate_asks_for_json_only_and_formats_the_message_in():
    filled = GATE_PROMPT.format(topic_line="", message="how do I open a trading account?")
    assert "how do I open a trading account?" in filled
    assert "ONLY this JSON" in filled
    assert '"lookup"' in filled and '"query"' in filled and '"reason"' in filled


def test_no_channel_topic_env_leaves_the_prompt_unchanged(monkeypatch):
    monkeypatch.delenv("WAKU_CHANNEL_TOPIC", raising=False)
    calls = []

    class Capturing:
        def __init__(self):
            self.messages = SimpleNamespace(create=self._create)

        def _create(self, **kw):
            calls.append(kw)
            return response([text_block('{"lookup": false, "query": "", "reason": "n/a"}')])

    should_recommend_video(Capturing(), "small-model", "how do I open a trading account?")
    assert "The channel covers:" not in calls[0]["messages"][0]["content"]


def test_a_channel_topic_env_is_woven_into_the_prompt(monkeypatch):
    monkeypatch.setenv("WAKU_CHANNEL_TOPIC", "personal finance education and the NEPSE stock market")
    calls = []

    class Capturing:
        def __init__(self):
            self.messages = SimpleNamespace(create=self._create)

        def _create(self, **kw):
            calls.append(kw)
            return response([text_block('{"lookup": false, "query": "", "reason": "n/a"}')])

    should_recommend_video(Capturing(), "small-model", "how do I open a trading account?")
    assert "personal finance education and the NEPSE stock market" in calls[0]["messages"][0]["content"]


def test_the_gate_is_exactly_one_model_call():
    calls = []

    class Counting:
        def __init__(self):
            self.messages = SimpleNamespace(create=self._create)

        def _create(self, **kw):
            calls.append(kw)
            return response([text_block('{"lookup": false, "query": "", "reason": "math"}')])

    should_recommend_video(Counting(), "small-model", "what is 2+2?")
    assert len(calls) == 1
    assert calls[0]["model"] == "small-model"
    assert calls[0]["max_tokens"] >= 600
