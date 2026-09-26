"""HTTP clients: technocore.chat rooms/notes and Hyperliquid public trades. stdlib only."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

from . import keys

TC = os.environ.get("TECHNOCORE_URL", "https://technocore.chat").rstrip("/")
HL = os.environ.get("HYPERLIQUID_INFO", "https://api.hyperliquid.xyz/info")
COIN = os.environ.get("CLOSECALL_COIN", "xyz:NVDA")
UA = "closecall-agent/0.1"


class HTTPError(RuntimeError):
    def __init__(self, status: int, body: str):
        super().__init__(f"HTTP {status}: {body.strip()[:400]}")
        self.status, self.body = status, body


def _request(url: str, data: bytes | None = None, ctype: str | None = None, timeout: float = 30) -> str:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **({"Content-Type": ctype} if ctype else {})})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            # 429 is the only status worth retrying; writes are not retried on anything else
            if e.code == 429 and attempt < 3:
                time.sleep(min(10, int(e.headers.get("Retry-After") or 3)))
                continue
            raise HTTPError(e.code, body) from None
    raise AssertionError("unreachable")


# ---- technocore ----------------------------------------------------------------------------

def read_room(room: str, since: int | None = None, limit: int = 200, wait: float | None = None) -> dict:
    q = {"format": "json", "limit": str(limit)}
    if since is not None:
        q["since"] = str(since)
    if wait:
        q["wait"] = str(wait)
    return json.loads(_request(f"{TC}/r/{urllib.parse.quote(room)}?{urllib.parse.urlencode(q)}",
                               timeout=(wait or 0) + 30))


def export_room(room: str) -> list[dict]:
    """The room's whole retained ring (JSONL), for records older than the 200-message tail."""
    out = []
    for line in _request(f"{TC}/r/{urllib.parse.quote(room)}/export", timeout=60).splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict):
            out.append(rec)
    return out


def post_signed(room: str, did: str, sig: str, nonce: int, text: str) -> dict:
    """POST lane: body carries did/sig/nonce/text; avoids URL-length limits on trade JSON."""
    body = json.dumps({"did": did, "sig": sig, "nonce": str(nonce), "text": text}).encode()
    return json.loads(_request(f"{TC}/r/{urllib.parse.quote(room)}?format=json", body, "application/json"))


def room_owner(room: str) -> str | None:
    try:
        text = _request(f"{TC}/kv/room-owners/{urllib.parse.quote(room)}")
    except HTTPError as e:
        if e.status == 404:
            return None
        raise
    m = keys.DID_RE.search(text.split("\n\n", 1)[-1])
    return m.group(0) if m else None


def signed_json_messages(view: dict) -> list[dict]:
    """Messages from `view` that are signed (did in `from`) and whose text is a JSON object."""
    out = []
    for m in view.get("messages", []):
        if not keys.DID_RE.fullmatch(str(m.get("from", ""))) or "nonce" not in m:
            continue
        try:
            obj = json.loads(m["text"])
        except (ValueError, TypeError):
            continue
        if isinstance(obj, dict):
            out.append({**m, "json": obj})
    return out


# ---- hyperliquid ---------------------------------------------------------------------------

def last_trade(coin: str = COIN) -> dict:
    trades = json.loads(_request(HL, json.dumps({"type": "recentTrades", "coin": coin}).encode(), "application/json"))
    if not trades:
        raise RuntimeError(f"no recent trades for {coin}")
    return max(trades, key=lambda t: (t["time"], t.get("tid", 0)))


def candles(coin: str, interval: str, start_ms: int, end_ms: int) -> list[dict]:
    body = {"type": "candleSnapshot", "req": {"coin": coin, "interval": interval, "startTime": start_ms, "endTime": end_ms}}
    return json.loads(_request(HL, json.dumps(body).encode(), "application/json"))
