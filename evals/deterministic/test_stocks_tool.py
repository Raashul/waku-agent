"""DETERMINISTIC EVAL — get_stock_price and get_stock_history, offline.

No live call: urlopen is monkeypatched to a canned response, matching
search.py's contract of "no network in evals/deterministic/". What's pinned:
the exact model-facing sentence (ticker, price, delay disclaimer), the honest
message for an unknown ticker, the honest message for a network/API failure,
that get_stock_price only registers with a key while get_stock_history (keyless)
always does, and that history is trimmed to the requested window, drops null
closes, downsamples a long series, and always names its unofficial source.
"""

from __future__ import annotations

import json
import time

from waku.config import Settings
from waku.db import connect
from waku.tools import build_registry, stocks


class _FakeResponse:
    def __init__(self, payload: dict):
        self._body = json.dumps(payload).encode()

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _stub_urlopen(monkeypatch, payload: dict | None = None, raises: Exception | None = None):
    def fake(req, timeout=None):
        if raises is not None:
            raise raises
        return _FakeResponse(payload)

    monkeypatch.setattr("waku.tools.stocks.urllib.request.urlopen", fake)


def _yahoo_chart(pairs: list[tuple[int, float | None]], *, error=None) -> dict:
    """A Yahoo /v8/finance/chart payload from (unix_ts, close) pairs."""
    if error is not None:
        return {"chart": {"result": None, "error": error}}
    return {"chart": {"result": [{
        "timestamp": [t for t, _ in pairs],
        "indicators": {"quote": [{"close": [c for _, c in pairs]}]},
        "meta": {"currency": "USD"},
    }], "error": None}}


_DAY = 86400


def test_returns_the_exact_sentence_the_model_sees(monkeypatch):
    _stub_urlopen(monkeypatch, {"c": 187.42, "pc": 185.0})
    tool = stocks.make_tool(api_key="fake-key")
    out = tool.fn(ticker="nvda")
    assert out == (
        "NVDA is $187.42 (may be delayed or reflect the latest market close — "
        "check an official broker for a live price)."
    )


def test_unknown_ticker_is_an_honest_sentence_not_a_price(monkeypatch):
    _stub_urlopen(monkeypatch, {"c": 0, "pc": 0})
    tool = stocks.make_tool(api_key="fake-key")
    out = tool.fn(ticker="BOGUS")
    assert "No price data found for 'BOGUS'" in out
    assert "$" not in out


def test_api_failure_returns_a_sentence_not_a_traceback(monkeypatch):
    _stub_urlopen(monkeypatch, raises=TimeoutError("timed out"))
    tool = stocks.make_tool(api_key="fake-key")
    out = tool.fn(ticker="NVDA")
    assert out.startswith("Couldn't get a price for 'NVDA'")
    assert "timed out" in out


def test_not_registered_without_a_key(tmp_path):
    settings = Settings(home=tmp_path / "nokey", finnhub_api_key="")
    settings.ensure_home()
    conn = connect(settings.home)
    assert "get_stock_price" not in build_registry(conn, settings, None)._tools


def test_registered_when_a_key_is_present(tmp_path):
    settings = Settings(home=tmp_path / "haskey", finnhub_api_key="fake-key")
    settings.ensure_home()
    conn = connect(settings.home)
    assert "get_stock_price" in build_registry(conn, settings, None)._tools


def test_dashboard_catalog_matches_the_real_registry(tmp_path, monkeypatch):
    """Regression: the Tools tab has a SECOND, hand-built catalog (tools_info in
    dashboard.py) used before a live agent exists, which drifted from
    build_registry once already (the module's own comment warns about this).
    get_stock_price shipped without updating it — this pins both branches so
    the tab can't silently omit or falsely advertise the tool again."""
    from waku.ops import browser_agent, dashboard

    monkeypatch.setattr(browser_agent, "current", lambda: None)
    monkeypatch.setenv("WAKU_HOME", str(tmp_path))

    monkeypatch.delenv("FINNHUB_API_KEY", raising=False)
    names = {c["name"] for c in dashboard.tools_info()["catalog"]}
    assert "get_stock_price" not in names

    monkeypatch.setenv("FINNHUB_API_KEY", "fake-key")
    catalog = dashboard.tools_info()["catalog"]
    entry = next((c for c in catalog if c["name"] == "get_stock_price"), None)
    assert entry is not None
    assert entry["source"] == "finance"


# ---- get_stock_history --------------------------------------------------------

def test_history_is_formatted_oldest_first_with_a_source_line(monkeypatch):
    now = int(time.time())
    pairs = [(now - 2 * _DAY, 322.08), (now - _DAY, 327.35), (now, 321.55)]
    _stub_urlopen(monkeypatch, _yahoo_chart(pairs))
    out = stocks.make_history_tool().fn(ticker="tsla", days=30)

    assert out.startswith("TSLA — 3 daily closes, ")
    assert "322.08" in out and "321.55" in out
    assert out.index("322.08") < out.index("321.55")   # oldest first
    assert "Yahoo Finance (unofficial endpoint)" in out
    assert "Not for trading decisions." in out


def test_history_trims_to_the_requested_window(monkeypatch):
    now = int(time.time())
    pairs = [(now - n * _DAY, 100.0 + n) for n in range(80, -1, -1)]  # 81 days
    _stub_urlopen(monkeypatch, _yahoo_chart(pairs))
    out = stocks.make_history_tool().fn(ticker="TSLA", days=30)

    dates = [ln.split()[0] for ln in out.splitlines() if ln[:2].isdigit()]
    assert dates, "expected dated rows"
    oldest = time.strftime("%Y-%m-%d", time.gmtime(now - 30 * _DAY))
    assert min(dates) >= oldest   # nothing older than the 30-day cutoff


def test_history_drops_null_closes(monkeypatch):
    now = int(time.time())
    pairs = [(now - 2 * _DAY, 322.08), (now - _DAY, None), (now, 321.55)]
    _stub_urlopen(monkeypatch, _yahoo_chart(pairs))
    out = stocks.make_history_tool().fn(ticker="TSLA", days=30)
    assert "2 daily closes" in out
    assert out.count("\n322.08") == 0 or "None" not in out


def test_history_downsamples_a_long_series(monkeypatch):
    now = int(time.time())
    pairs = [(now - n * _DAY, 100.0 + n) for n in range(364, -1, -1)]  # ~365 days
    _stub_urlopen(monkeypatch, _yahoo_chart(pairs))
    out = stocks.make_history_tool().fn(ticker="TSLA", days=365)
    rows = [ln for ln in out.splitlines() if ln[:2].isdigit()]
    assert 0 < len(rows) <= stocks._HISTORY_MAX_POINTS


def test_history_unknown_ticker_is_an_honest_sentence(monkeypatch):
    # Yahoo answers an unknown symbol two ways: a 200 with result:null...
    _stub_urlopen(monkeypatch, _yahoo_chart([], error={"code": "Not Found"}))
    assert "No price history found for 'BOGUS'" in stocks.make_history_tool().fn(ticker="BOGUS")

    # ...and, more often, a bare HTTP 404.
    import urllib.error
    err = urllib.error.HTTPError("url", 404, "Not Found", {}, None)
    _stub_urlopen(monkeypatch, raises=err)
    out = stocks.make_history_tool().fn(ticker="BOGUS")
    assert "No price history found for 'BOGUS'" in out
    assert "rate-limiting" not in out   # a bad ticker is not an outage


def test_history_api_failure_returns_a_sentence_not_a_traceback(monkeypatch):
    _stub_urlopen(monkeypatch, raises=TimeoutError("timed out"))
    out = stocks.make_history_tool().fn(ticker="TSLA")
    assert out.startswith("Couldn't get price history for 'TSLA'")
    assert "timed out" in out


def test_history_is_registered_without_any_key(tmp_path):
    settings = Settings(home=tmp_path / "nokey", finnhub_api_key="")
    settings.ensure_home()
    conn = connect(settings.home)
    registry = build_registry(conn, settings, None)
    assert "get_stock_history" in registry._tools
    assert "get_stock_price" not in registry._tools   # keyed, still gated


def test_range_for_picks_the_shortest_covering_window():
    assert stocks._range_for(5) == "5d"
    assert stocks._range_for(30) == "1mo"
    assert stocks._range_for(90) == "3mo"
    assert stocks._range_for(200) == "1y"
