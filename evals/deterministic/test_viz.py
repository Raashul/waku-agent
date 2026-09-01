"""DETERMINISTIC EVAL — waku-viz block parsing and validation.

A viz block is JSON the model writes into its own reply; the dashboard renders
it as a chart or table (waku/ops/static/js/viz.js). The failure that matters:
one malformed spec must not blank the page. So what's pinned here is that
validate_spec is a TYPE gate (a string where a number is charted is rejected,
ragged-but-typed data is allowed through), that parse_viz_blocks silently
drops bad blocks and keeps good ones, that summarize() counts them the way
the turn's telemetry reports, and that the two shape deviations a live model
actually produced ("type" for "kind", [label, value] pairs for x + points)
normalize instead of falling through to raw JSON.
"""

from __future__ import annotations

from waku import viz
from waku.config import load_settings
from waku.runtime.session import Session

_LINE = """Tesla is up over the month.

```waku-viz
{"kind": "line", "title": "TSLA", "x": ["Aug 1", "Aug 2", "Aug 3"],
 "series": [{"name": "TSLA", "points": [220.1, 218.4, 242.1]}], "unit": "$"}
```

Check a broker for a live price.
"""


def test_extracts_a_valid_line_block():
    specs = viz.parse_viz_blocks(_LINE)
    assert len(specs) == 1
    spec = specs[0]
    assert spec["kind"] == "line"
    assert spec["series"][0]["points"] == [220.1, 218.4, 242.1]
    assert spec["x"] == ["Aug 1", "Aug 2", "Aug 3"]
    assert spec["unit"] == "$"


def test_reply_with_no_block_yields_nothing():
    assert viz.parse_viz_blocks("just a sentence, no data") == []
    assert viz.summarize("just a sentence")["blocks"] == 0


def test_malformed_json_is_dropped_not_raised():
    text = "```waku-viz\n{not json at all}\n```"
    assert viz.parse_viz_blocks(text) == []
    summ = viz.summarize(text)
    assert summ == {"blocks": 1, "rendered": 0, "errors": 1, "kinds": []}


def test_wrong_type_in_points_is_rejected():
    bad = {"kind": "line", "series": [{"name": "X", "points": [1, "oops", 3]}]}
    assert viz.validate_spec(bad) is None


def test_ragged_but_typed_series_is_allowed():
    # a series shorter than the x axis is the renderer's problem, not a reason
    # to reject the whole block
    ok = {"kind": "line", "x": ["a", "b", "c"],
          "series": [{"name": "X", "points": [1.0, 2.0]}]}
    assert viz.validate_spec(ok) is not None


def test_table_requires_string_columns_and_list_rows():
    good = {"kind": "table", "columns": ["Date", "Close"],
            "rows": [["Aug 1", 220.1], ["Aug 2", 218.4]]}
    assert viz.validate_spec(good)["rows"][0] == ["Aug 1", 220.1]
    assert viz.validate_spec({"kind": "table", "columns": [1, 2], "rows": []}) is None
    assert viz.validate_spec({"kind": "table", "columns": ["a"], "rows": "nope"}) is None


def test_stat_requires_a_value_and_normalizes_trend():
    assert viz.validate_spec({"kind": "stat", "value": "$1.20", "trend": "up"})["trend"] == "up"
    assert "trend" not in viz.validate_spec({"kind": "stat", "value": 5, "trend": "sideways"})
    assert viz.validate_spec({"kind": "stat", "label": "no value"}) is None


def test_unknown_kind_is_rejected():
    assert viz.validate_spec({"kind": "pie", "series": []}) is None
    assert viz.validate_spec("not even a dict") is None


def test_summarize_counts_every_block_and_its_kind():
    two = _LINE + '\n```waku-viz\n{"kind": "stat", "value": "$242.10"}\n```\n'
    summ = viz.summarize(two)
    assert summ == {"blocks": 2, "rendered": 2, "errors": 0, "kinds": ["line", "stat"]}


def test_normalizes_the_shape_a_live_model_actually_produced():
    # verbatim from a dashboard turn: "type" not "kind", and each series
    # carrying [date, price] pairs instead of x + points. It used to fall
    # through to a raw-JSON code block.
    spec = {
        "type": "line",
        "title": "TSLA vs NVDA",
        "x_label": "Date",
        "series": [
            {"name": "TSLA", "data": [["2026-08-03", 322.08], ["2026-08-04", 327.35]]},
            {"name": "NVDA", "data": [["2026-08-03", 206.64], ["2026-08-04", 211.94]]},
        ],
    }
    out = viz.validate_spec(spec)
    assert out is not None
    assert out["kind"] == "line"
    assert out["x"] == ["2026-08-03", "2026-08-04"]
    assert out["series"] == [
        {"name": "TSLA", "points": [322.08, 327.35]},
        {"name": "NVDA", "points": [206.64, 211.94]},
    ]


def test_soul_tells_the_model_the_capability_exists():
    # the block is worthless if the assembled system prompt never describes it,
    # and it must reach installs whose SOUL.md predates the feature
    settings = load_settings()
    settings.ensure_home()
    system = Session(settings, memory=None).build_system("how's TSLA doing this month?")
    assert "waku-viz" in system
    assert '"kind":"line"' in system.replace(" ", "")
