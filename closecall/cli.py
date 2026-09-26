"""closecall: a small, careful agent for Technocore Close Call (close-1).

Every command that writes to technocore.chat is a dry run unless --send is given.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from . import keys, net, protocol as P, state

MANIFEST_URL = ("https://raw.githubusercontent.com/flop-labs/technocore-close-call-challenge/"
                "{rev}/manifest.json")


def out(obj) -> None:
    print(json.dumps(obj, indent=2, ensure_ascii=False, default=str))


def _me():
    k = keys.load_key()
    return k, keys.did_of(k)


def _post(key, did: str, room: str, text: str, send: bool) -> dict:
    """Sign `room|nonce|text` and POST it, or print what would be posted."""
    if len(text) > 4096:
        raise SystemExit(f"text is {len(text)} chars, over technocore's 4096 cap")
    for attempt in range(2):
        nonce = state.next_nonce(did, room)
        sig = keys.sign(key, f"{room}|{nonce}|{text}")
        if not send:
            return {"dry_run": True, "room": room, "nonce": nonce, "did": did, "sig": sig, "text": text,
                    "hint": "re-run with --send to post"}
        try:
            res = net.post_signed(room, did, sig, nonce, text)
        except net.HTTPError as e:
            m = re.search(r"not greater than (\d+)", e.body)
            if m and attempt == 0:
                state.bump_nonce(did, room, int(m.group(1)))
                continue
            raise SystemExit(f"post refused: {e}")
        posted = res.get("posted", {})
        state.journal({"room": room, "seq": posted.get("seq"), "nonce": nonce, "text": text})
        return {"posted": True, "room": room, "seq": posted.get("seq"), "ts": posted.get("ts")}
    raise AssertionError("unreachable")


def _latest(room: str, kind: str, signer: str | None) -> dict | None:
    """Newest message of JSON type `kind` in `room`, from `signer` when given."""
    view = net.read_room(room, limit=200)
    for m in reversed(net.signed_json_messages(view)):
        if m["json"].get("t") == kind and (signer is None or m["from"] == signer):
            return m
    return None


def _reference() -> tuple[Decimal | None, dict | None]:
    owner = net.room_owner("d-close1-price")
    msg = _latest("d-close1-price", "price", owner) if owner else None
    if not msg:
        print("warning: no referee price post found; the 5% limit check was skipped", file=sys.stderr)
        return None, None
    n = msg["json"].get("n")
    lag = P.sweep_now() - n if type(n) is int else None
    if lag is None or lag > 2:
        print(f"warning: referee price post is {lag} sweeps old; limits may have moved", file=sys.stderr)
    return P.amount(str(msg["json"].get("ref", {}).get("px"))), msg


# ---- commands ------------------------------------------------------------------------------

def cmd_did(a) -> None:
    print(_me()[1])


def cmd_clock(a) -> None:
    now = datetime.now(timezone.utc)
    n = P.sweep_now(now)
    out({"now": now.isoformat(timespec="seconds"), "last_sweep": n, "next_sweep": n + 1,
         "next_sweep_at": P.sweep_time(n + 1).isoformat(), "lock_sweep": P.LOCK_SWEEP,
         "lock_at": P.sweep_time(P.LOCK_SWEEP).isoformat(), "sweeps_left": max(0, P.LOCK_SWEEP - n)})


def cmd_check(a) -> None:
    """Is the contest live and is the referee who it claims to be? Read-only."""
    report: dict = {"rooms": {}}
    owners = {}
    for room in P.REFEREE_ROOMS:
        owner = net.room_owner(room)
        owners[room] = owner
        report["rooms"][room] = {"owner": owner}
    distinct = {o for o in owners.values() if o}
    report["referee_did"] = distinct.pop() if len(distinct) == 1 and all(owners.values()) else None
    if not report["referee_did"]:
        report["verdict"] = "NOT READY: referee rooms missing or owned by different keys"
        return out(report)
    ref_did = report["referee_did"]
    # The seed is the room's first post and falls out of the 200-message tail within a day:
    # read the whole retained ring instead.
    seed = None
    for m in net.signed_json_messages({"messages": net.export_room("d-close1-price")}):
        if m["from"] == ref_did and m["json"].get("t") == "seed" and m["json"].get("season") == P.SEASON:
            seed = m
            break
    report["seed"] = seed and {"seq": seed["seq"], "ts": seed["ts"], **seed["json"]}
    if not seed:
        report["seed_note"] = "no seed in the retained ring: verify it against the FLOP Labs launch record"
    if seed and a.rev:
        raw = urllib.request.urlopen(MANIFEST_URL.format(rev=a.rev), timeout=30).read()
        report["manifest_sha256"] = hashlib.sha256(raw).hexdigest()
        report["manifest_matches_seed"] = report["manifest_sha256"] == seed["json"].get("package")
    for room, kind in (("d-close1-price", "price"), ("d-close1-flow", "flow")):
        m = _latest(room, kind, ref_did)
        report["rooms"][room]["latest"] = m and {"seq": m["seq"], "ts": m["ts"], **m["json"]}
    price = report["rooms"]["d-close1-price"].get("latest")
    lag = P.sweep_now() - price["n"] if price and type(price.get("n")) is int else None
    report["price_sweep_lag"] = lag
    report["verdict"] = ("LIVE" if seed and price and lag is not None and lag <= 2
                         else "NOT CONFIRMED: no seed, or price posts stale/missing")
    out(report)


def cmd_quote(a) -> None:
    t = net.last_trade()
    ref, msg = _reference()
    res = {"hyperliquid": {"coin": net.COIN, "px": t["px"], "time": datetime.fromtimestamp(t["time"] / 1000, timezone.utc).isoformat(), "tid": t.get("tid")},
           "next_sweep": P.next_sweep()}
    if ref:
        lo, hi = P.limits(ref)
        res["referee"] = {"sweep": msg["json"].get("n"), "ref": str(ref), "limits_next": msg["json"].get("limits"),
                          "limits_computed": [str(lo.quantize(Decimal('0.01'))), str(hi.quantize(Decimal('0.01')))]}
    out(res)


def cmd_register(a) -> None:
    key, did = _me()
    out(_post(key, did, a.room, P.owner_msg(did), a.send))


def cmd_register_room(a) -> None:
    if a.name in P.REFEREE_ROOMS or a.name in P.CONTEST["rooms"]["reserved"]:
        raise SystemExit("that is a referee/reserved room")
    key, did = _me()
    out(_post(key, did, a.room, P.room_msg(a.name), a.send))


def cmd_offer(a) -> None:
    key, did = _me()
    ref, _ = (None, None) if a.offline else _reference()
    px = P.amount(a.px)
    if ref and px and not P.within_limits(px, ref):
        lo, hi = P.limits(ref)
        raise SystemExit(f"px {a.px} is outside the 5% band [{lo:.2f}, {hi:.2f}] of ref {ref}: it would void")
    until = a.until if a.until is not None else P.next_sweep() + a.ttl - 1
    terms = P.make_terms(did, a.side, a.qty, a.px, a.taker, until, a.id)
    sig = keys.sign(key, P.maker_payload(terms))
    res = {"terms": terms, "maker_sig": sig, "offer_json": P.offer_msg(terms, sig)}
    if a.post:
        res["post"] = _post(key, did, a.room, P.offer_msg(terms, sig), a.send)
    out(res)


def _load_obj(src: str) -> dict:
    text = sys.stdin.read() if src == "-" else (Path(src).read_text() if Path(src).is_file() else src)
    return json.loads(text)


def cmd_accept(a) -> None:
    key, did = _me()
    offer = _load_obj(a.offer)
    problem = P.check_offer(offer)
    if problem:
        raise SystemExit(f"refusing: {problem}")
    t = offer["terms"]
    if t["maker"] == did:
        raise SystemExit("refusing: you are the maker (a self-trade pays both fees and changes nothing)")
    if t["taker"] not in ("any", did):
        raise SystemExit("refusing: offer is addressed to another key")
    n = P.next_sweep()
    if n > t["until"]:
        raise SystemExit(f"refusing: expires at sweep {t['until']}, next sweep is {n}")
    if n > P.LOCK_SWEEP:
        raise SystemExit("refusing: trading is locked")
    ref, _ = (None, None) if a.offline else _reference()
    px = Decimal(t["px"])
    if ref and not P.within_limits(px, ref):
        raise SystemExit(f"refusing: px {px} outside 5% of ref {ref}")
    my_side = "sell" if t["side"] == "buy" else "buy"
    qty = Decimal(t["qty"])
    info = {"you": my_side, "qty": str(qty), "px": str(px), "collateral_if_opening": str(qty * px),
            "fee_at_px": str((P.FEE_RATE * qty * px).quantize(Decimal("0.01")))}
    if ref:
        info["fee_if_close_equals_ref"] = str(P.my_fee(my_side, qty, px, ref).quantize(Decimal("0.01")))
    tsig = keys.sign(key, P.taker_payload(t, did))
    trade = P.trade_msg(t, did, offer["maker_sig"], tsig)
    assert P.check_trade(json.loads(trade)) is None
    out({"trade": json.loads(trade), "economics": info, "post": _post(key, did, a.room, trade, a.send)})


def cmd_verify(a) -> None:
    obj = _load_obj(a.message)
    fn = P.check_trade if obj.get("t") == "trade" else P.check_offer
    problem = fn(obj)
    out({"ok": problem is None, "problem": problem})


def cmd_watch(a) -> None:
    """Tail a trading room; print offers/trades with signature status. Read-only."""
    me = None
    try:
        me = keys.did_of(keys.load_key()) if a.mine else None
    except SystemExit:
        pass
    since = a.since
    if since is None:
        since = net.read_room(a.room, limit=1).get("last_seq") or 0
        since = max(0, since - a.back)
    while True:
        view = net.read_room(a.room, since=since, limit=200, wait=10)
        if view.get("first_seq") and since and view["first_seq"] > since + 1:
            print(f"# gap: seq {since + 1}..{view['first_seq'] - 1} already fell out of the ring", file=sys.stderr)
        for m in net.signed_json_messages(view):
            o = m["json"]
            if o.get("season") != P.SEASON or o.get("t") not in ("offer", "trade", "owner", "room"):
                continue
            if me and o.get("t") in ("offer", "trade") and me not in (o.get("terms", {}).get("maker"), o.get("taker"), o.get("terms", {}).get("taker")) and o.get("terms", {}).get("taker") != "any":
                continue
            ok = None
            if o["t"] == "offer":
                ok = P.check_offer(o)
            elif o["t"] == "trade":
                ok = P.check_trade(o)
            print(json.dumps({"seq": m["seq"], "ts": m["ts"], "from": m["from"], "valid": ok is None,
                              "problem": ok, **o}, ensure_ascii=False), flush=True)
        since = view.get("last_seq") or since
        if a.once:
            return


def cmd_plan(a) -> None:
    """Fees, collateral and PnL across closing prices for one prospective trade. Offline."""
    qty, px = Decimal(a.qty), Decimal(a.px)
    close = Decimal(a.close) if a.close else px
    fee = P.my_fee(a.side, qty, px, close)
    cash = Decimal(a.cash)
    grid = [Decimal(x) for x in a.at.split(",")] if a.at else [px * (1 + Decimal(d) / 100) for d in (-15, -10, -5, -2, 0, 2, 5, 10, 15)]
    out({"side": a.side, "qty": str(qty), "px": str(px), "sweep_close_assumed": str(close),
         "fee": str(fee.quantize(Decimal("0.01"))), "collateral": str(qty * px),
         "fits_in_cash": qty * px + fee <= cash, "max_qty_for_cash": str(P.max_open_qty(cash, px)),
         "breakeven_S": str((px + fee / qty if a.side == "buy" else px - fee / qty).quantize(Decimal("0.01"))),
         "pnl": {str(s.quantize(Decimal("0.01"))): str(P.pnl_at(a.side, qty, px, s, fee).quantize(Decimal("0.01"))) for s in grid}})


def cmd_journal(a) -> None:
    out(state.entries()[-a.n:])


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="closecall", description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("did", help="print your did:key (seed from $SIGN_SEED or prompt)").set_defaults(f=cmd_did)
    sub.add_parser("clock", help="sweep numbers and lock time").set_defaults(f=cmd_clock)
    c = sub.add_parser("check", help="verify referee rooms, seed and price feed (read-only)")
    c.add_argument("--rev", help="contest repo commit to hash manifest.json at, compared with the seed")
    c.set_defaults(f=cmd_check)
    sub.add_parser("quote", help="Hyperliquid last trade + referee reference/limits").set_defaults(f=cmd_quote)

    r = sub.add_parser("register", help="post the owner message (mint 10,000 POLF)")
    r.add_argument("--room", default=P.TRADING_ROOM)
    r.add_argument("--send", action="store_true")
    r.set_defaults(f=cmd_register)

    rr = sub.add_parser("register-room", help="register a technocore room as a trading room")
    rr.add_argument("name")
    rr.add_argument("--room", default=P.TRADING_ROOM)
    rr.add_argument("--send", action="store_true")
    rr.set_defaults(f=cmd_register_room)

    o = sub.add_parser("offer", help="sign terms as maker")
    o.add_argument("side", choices=["buy", "sell"], help="YOUR side as maker")
    o.add_argument("qty")
    o.add_argument("px")
    o.add_argument("--taker", default="any", help="counterparty did:key, default any")
    o.add_argument("--ttl", type=int, default=3, help="sweeps the offer stays valid (default 3 = 15 min)")
    o.add_argument("--until", type=int, help="explicit last sweep (overrides --ttl)")
    o.add_argument("--id")
    o.add_argument("--post", action="store_true", help="publish the signed offer in --room")
    o.add_argument("--room", default=P.TRADING_ROOM)
    o.add_argument("--send", action="store_true")
    o.add_argument("--offline", action="store_true", help="skip the referee limit check")
    o.set_defaults(f=cmd_offer)

    ac = sub.add_parser("accept", help="countersign an offer and post the trade")
    ac.add_argument("offer", help="offer JSON, a file path, or - for stdin")
    ac.add_argument("--room", default=P.TRADING_ROOM)
    ac.add_argument("--send", action="store_true")
    ac.add_argument("--offline", action="store_true")
    ac.set_defaults(f=cmd_accept)

    v = sub.add_parser("verify", help="check signatures of an offer/trade")
    v.add_argument("message")
    v.set_defaults(f=cmd_verify)

    w = sub.add_parser("watch", help="tail a trading room for offers/trades")
    w.add_argument("--room", default=P.TRADING_ROOM)
    w.add_argument("--since", type=int)
    w.add_argument("--back", type=int, default=200)
    w.add_argument("--mine", action="store_true", help="only offers open to me or naming me")
    w.add_argument("--once", action="store_true")
    w.set_defaults(f=cmd_watch)

    pl = sub.add_parser("plan", help="fee/collateral/PnL scenarios (offline)")
    pl.add_argument("side", choices=["buy", "sell"])
    pl.add_argument("qty")
    pl.add_argument("px")
    pl.add_argument("--close", help="Hyperliquid close at the settling sweep (default: px)")
    pl.add_argument("--cash", default=str(P.MINT))
    pl.add_argument("--at", help="comma-separated closing prices S")
    pl.set_defaults(f=cmd_plan)

    j = sub.add_parser("journal", help="what this machine has posted")
    j.add_argument("-n", type=int, default=20)
    j.set_defaults(f=cmd_journal)

    a = p.parse_args(argv)
    try:
        a.f(a)
    except net.HTTPError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
