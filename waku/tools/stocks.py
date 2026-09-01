"""get_stock_price — latest quote for a well-known public company.
get_portfolio_performance — today's gain/loss on the demo portfolio.
get_stock_history — a daily close series, for charting a "past N days" question.

Same shape as search.py: stdlib urllib only, zero new dependencies.

get_stock_price / get_portfolio_performance use Finnhub's quote endpoint (a
real, documented REST API) and are registered only when FINNHUB_API_KEY is set
(see __init__.py) — unlike search_web there is no keyless fallback, so a tool
the model could call and always fail is worse than no tool at all.
get_portfolio_performance is a distinct tool from get_stock_price so the model
can tell "quote me a ticker" apart from "how's my portfolio doing"; it shares
this file and _fetch_quote because it's the same Finnhub client.

get_stock_history is the odd one out. Finnhub's candle endpoint moved behind a
paywall (free keys get 403), Stooq's CSV download now sits behind a browser
proof-of-work challenge, and every keyed alternative (Alpha Vantage, ...) has
a free tier too small for a teaching demo. What is left that needs no key is
Yahoo Finance's chart endpoint — the same UNDOCUMENTED endpoint yfinance
wraps. It has no SLA and may break without notice; the tool says so in its own
output. Keyless means it is always registered, like search_web's fallback.

v1 scope, on purpose: ticker in (NVDA, AAPL, META, ...), not a company name —
the model is expected to know the ticker already; there is no name→ticker
lookup yet.
"""

from __future__ import annotations

import json
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request

from waku.tools.registry import Tool

_QUOTE_URL = "https://finnhub.io/api/v1/quote"
_HISTORY_URL = "https://query1.finance.yahoo.com/v8/finance/chart/"
_TIMEOUT = 10
_DISCLAIMER = "may be delayed or reflect the latest market close — check an official broker for a live price"
# Yahoo's chart host 429s the bare Python-urllib agent; a browser token (the
# compatibility string every HTTP client sends) gets a normal response.
_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
_HISTORY_MAX_POINTS = 90  # keep a year-long series from bloating the reply


def _fetch_quote(ticker: str, api_key: str) -> dict:
    params = urllib.parse.urlencode({"symbol": ticker, "token": api_key})
    req = urllib.request.Request(f"{_QUOTE_URL}?{params}")
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        return json.loads(resp.read())


def _range_for(days: int) -> str:
    """The shortest Yahoo range that still covers `days` calendar days."""
    for limit, label in ((5, "5d"), (31, "1mo"), (93, "3mo"), (186, "6mo")):
        if days <= limit:
            return label
    return "1y"


def _fetch_history(ticker: str, days: int) -> list[tuple[str, float]]:
    """(YYYY-MM-DD, close) pairs for the last `days` calendar days, oldest
    first, nulls dropped, downsampled to at most _HISTORY_MAX_POINTS."""
    params = urllib.parse.urlencode({"range": _range_for(days), "interval": "1d"})
    req = urllib.request.Request(f"{_HISTORY_URL}{urllib.parse.quote(ticker)}?{params}",
                                 headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        data = json.loads(resp.read())

    chart = data.get("chart") or {}
    if chart.get("error") or not chart.get("result"):
        return []
    result = chart["result"][0]
    stamps = result.get("timestamp") or []
    quote = (result.get("indicators", {}).get("quote") or [{}])[0]
    closes = quote.get("close") or []

    cutoff = time.time() - days * 86400
    rows = [
        (time.strftime("%Y-%m-%d", time.gmtime(t)), round(float(c), 2))
        for t, c in zip(stamps, closes)
        if c is not None and t >= cutoff
    ]
    if len(rows) > _HISTORY_MAX_POINTS:
        step = len(rows) // _HISTORY_MAX_POINTS + 1
        rows = rows[::step]
    return rows


def make_tool(api_key: str) -> Tool:
    def get_stock_price(ticker: str) -> str:
        ticker = ticker.strip().upper()
        try:
            quote = _fetch_quote(ticker, api_key)
        except Exception as exc:
            return (f"Couldn't get a price for '{ticker}': {exc}. The Finnhub API may be "
                     "rate-limited or down — try again shortly, or check FINNHUB_API_KEY.")
        price = quote.get("c")
        prev_close = quote.get("pc")
        if not price and not prev_close:
            return (f"No price data found for '{ticker}'. Check the ticker symbol is "
                     "correct (e.g. NVDA for Nvidia).")
        return f"{ticker} is ${price:.2f} ({_DISCLAIMER})."

    return Tool(
        name="get_stock_price",
        description=(
            "Look up the latest known price for a well-known public company's stock, by "
            "ticker symbol (e.g. NVDA, AAPL, META). Only reliable for major, widely-known "
            "companies — you must already know the ticker; this tool does not resolve "
            "company names to symbols. The price returned may be delayed or from the last "
            "market close, not a live feed."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "ticker": {"type": "string", "description": "stock ticker symbol, e.g. 'NVDA'"},
            },
            "required": ["ticker"],
        },
        fn=get_stock_price,
    )


def make_portfolio_tool(conn: sqlite3.Connection, api_key: str) -> Tool:
    def get_portfolio_performance() -> str:
        rows = conn.execute(
            "SELECT ticker, shares, price_yesterday, average_price FROM portfolio_positions"
        ).fetchall()
        if not rows:
            return "No positions in the portfolio."

        lines = []
        total_gain = 0.0
        total_baseline_value = 0.0
        for row in rows:
            ticker = row["ticker"]
            try:
                quote = _fetch_quote(ticker, api_key)
            except Exception as exc:
                return (f"Couldn't get today's price for '{ticker}': {exc}. Portfolio "
                         "performance needs a price for every position, so no gain is reported.")
            price = quote.get("c")
            if not price:
                return f"No current price returned for '{ticker}' — can't compute portfolio gain."

            shares = row["shares"]
            baseline = row["price_yesterday"]
            gain = (price - baseline) * shares
            pct = (price - baseline) / baseline * 100
            total_gain += gain
            total_baseline_value += baseline * shares
            sign = "+" if gain >= 0 else "-"
            lines.append(f"{ticker}: {sign}${abs(gain):.2f} ({sign}{abs(pct):.2f}%) today "
                         f"({shares:g} shares at ${price:.2f})")

        total_pct = (total_gain / total_baseline_value * 100) if total_baseline_value else 0.0
        sign = "+" if total_gain >= 0 else "-"
        lines.append(f"Total: {sign}${abs(total_gain):.2f} ({sign}{abs(total_pct):.2f}%) today ({_DISCLAIMER})")
        return "\n".join(lines)

    return Tool(
        name="get_portfolio_performance",
        description=(
            "Report today's dollar and percent gain or loss for each position in the user's "
            "portfolio, plus a total. This is a small, fixed demo portfolio — not a real, "
            "live brokerage account — and it's read-only; there is no tool to add, remove, "
            "or edit positions."
        ),
        input_schema={"type": "object", "properties": {}},
        fn=get_portfolio_performance,
    )


def make_history_tool() -> Tool:
    def get_stock_history(ticker: str, days: int = 30) -> str:
        ticker = ticker.strip().upper()
        days = max(5, min(int(days), 365))
        unknown = (f"No price history found for '{ticker}'. Check the ticker symbol is "
                   "correct (e.g. NVDA for Nvidia); this looks up US-listed symbols.")
        try:
            rows = _fetch_history(ticker, days)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:   # Yahoo's answer for an unknown symbol
                return unknown
            return (f"Couldn't get price history for '{ticker}': {exc}. The data source "
                     "(Yahoo Finance, an unofficial endpoint) may be rate-limiting or down "
                     "— try again shortly.")
        except Exception as exc:
            return (f"Couldn't get price history for '{ticker}': {exc}. The data source "
                     "(Yahoo Finance, an unofficial endpoint) may be rate-limiting or down "
                     "— try again shortly.")
        if not rows:
            return unknown
        span = f"{rows[0][0]} to {rows[-1][0]}"
        lines = "\n".join(f"{date}  {close}" for date, close in rows)
        return (
            f"{ticker} — {len(rows)} daily closes, {span}:\n{lines}\n\n"
            "Source: Yahoo Finance (unofficial endpoint) — end-of-day closes, may lag "
            "or break without notice. Not for trading decisions."
        )

    return Tool(
        name="get_stock_history",
        description=(
            "Get a daily closing-price series for a US-listed stock over the last N days "
            "(default 30, max 365), by ticker symbol (e.g. NVDA, TSLA, AAPL). Use this for "
            "any 'how has X done over the past week/month/year' question, then present the "
            "series as a waku-viz line chart. Closes are end-of-day, not a live feed, and "
            "come from an unofficial source — say so when you report them. You must know "
            "the ticker; this does not resolve company names to symbols."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "ticker": {"type": "string", "description": "stock ticker symbol, e.g. 'TSLA'"},
                "days": {"type": "integer", "description": "how many days of history (5–365, default 30)"},
            },
            "required": ["ticker"],
        },
        fn=get_stock_history,
    )
