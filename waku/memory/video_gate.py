"""The gate that decides WHETHER to look up a video resource at all.

Same shape as retrieval_gate.py's hero moment, for the same reason: a video
lookup now means a real OpenAI embedding call (waku/memory/video_resources.py
does cosine similarity, not free FTS5), so it isn't free to run on every turn.
A cheap small-model call decides first:

    does answering THIS message benefit from pointing at one of our videos?
"what's 2+2" -> no. "how do I open a trading account?" -> yes.

Deliberately a second, separate gate call from retrieval_gate.should_retrieve
rather than one combined prompt — the two questions are different ("does this
need the user's personal facts" vs "does this look like something our video
library covers") and conflating them would make either one worse at its job.
"""

from __future__ import annotations

import json

import anthropic

GATE_PROMPT = """\
You are a gate deciding whether to search a library of educational YouTube \
videos before answering. Given the user's message, decide if a video from \
that library would help answer it — the kind of how-to or explainer question \
a video would cover, not something that needs the user's personal facts or \
current events.

Reply with ONLY this JSON, nothing else:
{{"lookup": true/false, "query": "<search text if true, else empty>", "reason": "<5 words>"}}

Math, small talk, personal facts, scheduling, or anything unrelated to the \
channel's subject matter -> false. A how-to / explainer / "what is X" \
question the channel plausibly covers -> true.

User message: {message}"""


def should_recommend_video(
    client: anthropic.Anthropic, small_model: str, message: str
) -> tuple[bool, str, str]:
    """Returns (lookup?, search_query, reason). Fails open like retrieval_gate:
    a rare gate error costs one extra embedding call, not a silently missing
    feature."""
    try:
        response = client.messages.create(
            model=small_model,
            max_tokens=600,
            messages=[{"role": "user", "content": GATE_PROMPT.format(message=message)}],
        )
        text = "".join(b.text for b in response.content if b.type == "text")
        if "{" not in text:
            return True, message, "gate returned no JSON — failing open"
        decision = json.loads(text[text.index("{") : text.rindex("}") + 1])
        return bool(decision.get("lookup")), decision.get("query", message), decision.get("reason", "")
    except Exception as exc:
        return True, message, f"gate failed open ({type(exc).__name__})"
