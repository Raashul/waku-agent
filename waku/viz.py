"""waku-viz — a visualization block the model can embed in its reply.

Perplexity-style output: when a plain sentence would bury the data, the model
writes a fenced ```waku-viz block holding one JSON object, and the dashboard
renders it as an inline SVG chart or a formatted table instead of raw text.

This module is the schema's Python home. It extracts and validates those
blocks so each turn's telemetry can record what it drew, and so any
non-dashboard surface has a parser ready. The renderer that turns a spec into
pixels is waku/ops/static/js/viz.js, and it mirrors the shape validated here.

No new dependency: a viz block is JSON in a code fence. A malformed block is
dropped here (and falls back to a plain code block in the dashboard) rather
than raised — a bad spec must never cost the user their reply.

Spec shapes (keys optional unless marked *):

    line / bar   kind*, title, caption, unit ("$" | "%" | free text),
                 x:      ["Aug 1", "Aug 2", ...]        category / time labels
                 series: [{name*: "TSLA", points*: [220.1, 218.4, ...]}]
    table        kind*, title, caption,
                 columns*: ["Date", "Close"],  rows*: [["Aug 1", 220.1], ...]
    stat         kind*, label, value*, delta, trend ("up" | "down" | "flat")
"""

from __future__ import annotations

import json
import re

VIZ_KINDS = ("line", "bar", "table", "stat")
TRENDS = ("up", "down", "flat")

# ```waku-viz\n ... \n``` — the same fence util.js's markdown renderer keys on.
_FENCE_RE = re.compile(r"```waku-viz[ \t]*\r?\n(.*?)\r?\n```", re.DOTALL)

_NUMBER = (int, float)
_CELL = (str, int, float, bool, type(None))


def _is_number_list(value) -> bool:
    return (
        isinstance(value, list)
        and value != []
        and all(isinstance(n, _NUMBER) and not isinstance(n, bool) for n in value)
    )


def _normalize(obj: dict) -> dict:
    """Fold the two shape deviations a live model actually produces into the
    canonical form before validation: `type` used for `kind`, and a series
    `data` of [label, value] pairs instead of a top-level `x` plus per-series
    `points`. Anything else is left for validate_spec to accept or reject."""
    obj = dict(obj)
    if "kind" not in obj and isinstance(obj.get("type"), str):
        obj["kind"] = obj.pop("type")

    series = obj.get("series")
    if isinstance(series, list) and any(
        isinstance(s, dict) and isinstance(s.get("data"), list) for s in series
    ):
        x = obj.get("x") if isinstance(obj.get("x"), list) else []
        rebuilt = []
        for s in series:
            pairs = s.get("data") if isinstance(s, dict) else None
            if isinstance(pairs, list) and all(
                isinstance(p, (list, tuple)) and len(p) == 2 for p in pairs
            ):
                if not x:
                    x = [p[0] for p in pairs]
                rebuilt.append({"name": s.get("name"), "points": [p[1] for p in pairs]})
            else:
                rebuilt.append(s)
        obj["series"] = rebuilt
        obj["x"] = x
    return obj


def _clean_series(raw) -> list[dict] | None:
    if not isinstance(raw, list) or not raw:
        return None
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            return None
        name, points = item.get("name"), item.get("points")
        if not isinstance(name, str) or not _is_number_list(points):
            return None
        out.append({"name": name, "points": [float(n) for n in points]})
    return out


def validate_spec(obj) -> dict | None:
    """Return a normalized copy of a valid viz spec, or None. Type checks only —
    the renderer tolerates ragged data (a series shorter than the x axis, a
    blank label); it must never see a wrong TYPE (a string where it charts a
    number), which is what turns one bad block into a blank page."""
    if not isinstance(obj, dict):
        return None
    obj = _normalize(obj)
    kind = obj.get("kind")
    if kind not in VIZ_KINDS:
        return None

    spec: dict = {"kind": kind}
    for key in ("title", "caption"):
        if isinstance(obj.get(key), str):
            spec[key] = obj[key]

    if kind in ("line", "bar"):
        series = _clean_series(obj.get("series"))
        if series is None:
            return None
        spec["series"] = series
        x = obj.get("x", [])
        spec["x"] = [str(v) for v in x] if isinstance(x, list) else []
        if isinstance(obj.get("unit"), str):
            spec["unit"] = obj["unit"]
        return spec

    if kind == "table":
        columns, rows = obj.get("columns"), obj.get("rows")
        if not (isinstance(columns, list) and columns
                and all(isinstance(c, str) for c in columns)):
            return None
        if not isinstance(rows, list):
            return None
        clean_rows: list[list] = []
        for row in rows:
            if not isinstance(row, list) or any(not isinstance(c, _CELL) for c in row):
                return None
            clean_rows.append(list(row))
        spec["columns"] = list(columns)
        spec["rows"] = clean_rows
        return spec

    # stat
    value = obj.get("value")
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return None
    spec["value"] = value
    for key in ("label", "delta"):
        if isinstance(obj.get(key), str):
            spec[key] = obj[key]
    if obj.get("trend") in TRENDS:
        spec["trend"] = obj["trend"]
    return spec


def parse_viz_blocks(text: str) -> list[dict]:
    """Every valid waku-viz spec embedded in `text`, in reading order."""
    specs: list[dict] = []
    for match in _FENCE_RE.finditer(text or ""):
        try:
            obj = json.loads(match.group(1))
        except (ValueError, TypeError):
            continue
        spec = validate_spec(obj)
        if spec is not None:
            specs.append(spec)
    return specs


def summarize(text: str) -> dict:
    """Compact per-turn telemetry: how many viz blocks the reply carried, how
    many parsed, which kinds rendered. Persisted in the turn's meta so a trace
    shows a turn drew a chart without storing the whole spec a second time."""
    blocks = _FENCE_RE.findall(text or "")
    specs = parse_viz_blocks(text or "")
    return {
        "blocks": len(blocks),
        "rendered": len(specs),
        "errors": len(blocks) - len(specs),
        "kinds": [s["kind"] for s in specs],
    }
