"""close-1 message shapes, canonical signing strings, sweep clock and fee maths.

Everything here mirrors close-call-game.md and close_call_fold.py at commit 66c1da3.
Fee/validation logic is kept identical to the fold so local answers match the referee.
"""

from __future__ import annotations

import json
import re
import secrets
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from importlib import resources

from . import keys

CONTEST = json.loads(resources.files(__package__).joinpath("contest.json").read_text("utf-8"))
SEASON = CONTEST["contest_id"]  # "close-1"
OPENING = datetime.fromisoformat(CONTEST["opening"].replace("Z", "+00:00"))
SWEEP = timedelta(seconds=int(CONTEST["sweep_seconds"]))
LOCK_SWEEP = int(CONTEST["lock_sweep"])
MINT = Decimal(CONTEST["mint"])
MIN_QTY = Decimal(CONTEST["min_qty"])
WINDOW = Decimal(CONTEST["limit_window"])
FEE_RATE = Decimal(CONTEST["fee_rate"])
TRADING_ROOM = CONTEST["rooms"]["trading"][0]
# Offers are published here (by the web app and `offer --post`). It is not a registered trading
# room, so the referee ignores everything in it; final two-signed trades go to TRADING_ROOM.
DESK_ROOM = "closecall-desk"
REFEREE_ROOMS = CONTEST["rooms"]["referee"]
# sha256 of manifest.json at 66c1da3, the package this toolkit implements; the live seed names it.
PACKAGE_SHA256 = "bae09812e25eb6f1369c611f24964f7ea0acafddfc45301a16f33f941296dafa"

TRADE_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
TWO_PLACES = re.compile(r"[0-9]{1,7}(\.[0-9]{1,2})?")


def compact(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def amount(text) -> Decimal | None:
    if not isinstance(text, str) or not TWO_PLACES.fullmatch(text):
        return None
    v = Decimal(text)
    return v if v > 0 else None


# ---- sweep clock -------------------------------------------------------------------------

def sweep_now(now: datetime | None = None) -> int:
    """Number of the last sweep that has happened (0 before the first)."""
    now = now or datetime.now(timezone.utc)
    return max(0, int((now - OPENING) // SWEEP))


def next_sweep(now: datetime | None = None) -> int:
    """The sweep that will pick up a message posted now."""
    return sweep_now(now) + 1


def sweep_time(n: int) -> datetime:
    return OPENING + n * SWEEP


# ---- terms -------------------------------------------------------------------------------

def make_terms(maker: str, side: str, qty: str, px: str, taker: str = "any",
               until: int | None = None, tid: str | None = None) -> dict:
    terms = {
        "id": tid or secrets.token_hex(6),
        "maker": maker,
        "px": px,
        "qty": qty,
        "side": side,
        "taker": taker,
        "until": until if until is not None else next_sweep() + 2,
    }
    problem = terms_problem(terms)
    if problem:
        raise ValueError(problem)
    return terms


def terms_problem(t: dict) -> str | None:
    """Mirror of the fold's `shape` check plus the exact-key rule; None when well formed."""
    if not isinstance(t, dict) or set(t) != {"id", "maker", "px", "qty", "side", "taker", "until"}:
        return "terms must have exactly id, maker, px, qty, side, taker, until"
    if not isinstance(t["id"], str) or not TRADE_ID.fullmatch(t["id"]):
        return "id: 1-64 of [A-Za-z0-9_-]"
    if t["side"] not in ("buy", "sell"):
        return "side: buy or sell (the maker's side)"
    qty, px = amount(t["qty"]), amount(t["px"])
    if qty is None or px is None:
        return "qty/px: positive decimal strings, at most two decimals"
    if qty < MIN_QTY:
        return f"qty: at least {MIN_QTY}"
    if type(t["until"]) is not int:
        return "until: integer sweep number"
    if not isinstance(t["maker"], str) or not keys.DID_RE.fullmatch(t["maker"]):
        return "maker: did:key"
    if t["taker"] != "any" and (not isinstance(t["taker"], str) or not keys.DID_RE.fullmatch(t["taker"])):
        return "taker: 'any' or a did:key"
    return None


def terms_string(t: dict) -> str:
    return compact(t)


def maker_payload(t: dict) -> str:
    return f"{SEASON}|terms|{terms_string(t)}"


def taker_payload(t: dict, taker_did: str) -> str:
    return f"{SEASON}|accept|{terms_string(t)}|{taker_did}"


# ---- messages ----------------------------------------------------------------------------

def owner_msg(did: str) -> str:
    return compact({"t": "owner", "season": SEASON, "key": did})


def room_msg(room: str) -> str:
    return compact({"t": "room", "season": SEASON, "room": room})


def offer_msg(t: dict, maker_sig: str) -> str:
    """Not a referee shape (it ignores it): our convention for publishing a signed open offer."""
    return compact({"t": "offer", "season": SEASON, "terms": t, "maker_sig": maker_sig})


def trade_msg(t: dict, taker_did: str, maker_sig: str, taker_sig: str) -> str:
    return compact({"t": "trade", "season": SEASON, "terms": t, "taker": taker_did,
                    "maker_sig": maker_sig, "taker_sig": taker_sig})


def check_offer(obj: dict) -> str | None:
    """None if `obj` is an offer (or trade) whose maker signature verifies."""
    if not isinstance(obj, dict) or obj.get("season") != SEASON or obj.get("t") not in ("offer", "trade"):
        return "not a close-1 offer/trade"
    t = obj.get("terms")
    problem = terms_problem(t)
    if problem:
        return problem
    if not keys.verify(t["maker"], maker_payload(t), obj.get("maker_sig")):
        return "maker signature does not verify"
    return None


def check_trade(obj: dict) -> str | None:
    """None if `obj` is a trade the fold would accept on shape and signatures."""
    problem = check_offer(obj)
    if problem:
        return problem
    if obj["t"] != "trade":
        return "not a trade"
    t, taker = obj["terms"], obj.get("taker")
    if not isinstance(taker, str) or not keys.DID_RE.fullmatch(taker):
        return "taker: countersigner did:key required"
    if t["taker"] != "any" and t["taker"] != taker:
        return "named taker is not the countersigner"
    if not keys.verify(taker, taker_payload(t, taker), obj.get("taker_sig")):
        return "taker signature does not verify"
    return None


# ---- fees & scenarios (identical to Fold.side_fees) --------------------------------------

def side_fees(maker_side: str, qty: Decimal, px: Decimal, close: Decimal) -> tuple[Decimal, Decimal]:
    base = FEE_RATE * qty * px
    gap = (close - px) * qty
    buyer, seller = max(base, gap), max(base, -gap)
    return (buyer, seller) if maker_side == "buy" else (seller, buyer)


def my_fee(my_side: str, qty: Decimal, px: Decimal, close: Decimal) -> Decimal:
    maker_side = my_side  # treat me as maker; fee depends only on my side
    return side_fees(maker_side, qty, px, close)[0]


def within_limits(px: Decimal, ref: Decimal) -> bool:
    return abs(px - ref) <= WINDOW * ref


def limits(ref: Decimal) -> tuple[Decimal, Decimal]:
    return ref - WINDOW * ref, ref + WINDOW * ref


def max_open_qty(cash: Decimal, px: Decimal) -> Decimal:
    """Largest qty (0.01 step) one side can open: qty*px + 1% fee <= cash."""
    q = (cash / (px * (1 + FEE_RATE))).quantize(Decimal("0.01"), rounding="ROUND_DOWN")
    return q if q >= MIN_QTY else Decimal(0)


def pnl_at(my_side: str, qty: Decimal, px: Decimal, s: Decimal, fee: Decimal) -> Decimal:
    move = (s - px) if my_side == "buy" else (px - s)
    return move * qty - fee
