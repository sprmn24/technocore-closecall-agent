import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

os.environ["CLOSECALL_HOME"] = tempfile.mkdtemp()

from closecall import keys, protocol as P, state  # noqa: E402
import close_call_fold as fold  # noqa: E402

SIGN_PY = Path(os.environ.get("SIGN_PY", "/nonexistent"))
A = keys.key_from_seed("11" * 32)
B = keys.key_from_seed("alice passphrase")
DA, DB = keys.did_of(A), keys.did_of(B)


class Keys(unittest.TestCase):
    # Produced by flop-labs/technocore-chat@0e47f77 scripts/sign.py:
    #   sign.py say --seed <seed> close1 123 '{"a":1}'
    GOLDEN = [
        ("11" * 32, "did:key:z6MktULudTtAsAhRegYPiZ6631RV3viv12qd4GQF8z1xB22S",
         "Y5zTkL4o2FRJBhz7BN1Kp2RwWwTyzKWBu88_BLOIX4fbzAVVqIhCRavfMKrUsKzG2cocUBCFlsOGlSDVvYWHBw"),
        ("alice passphrase", "did:key:z6MknXamaMKvJQPsnZ7BkipJyxbpaJ9Fcmbnk4iQmyBF64MS",
         "LEFSIMqnJbv4ta-oZTDV1tBqHlXSyXXOvbjC4RknBNF8dCQ7mtpdzok0vzwTGSEj2W2v-t2xIhOsEinya-EwDw"),
    ]

    def test_matches_technocore_sign_py_vectors(self):
        for seed, did, sig in self.GOLDEN:
            k = keys.key_from_seed(seed)
            self.assertEqual(keys.did_of(k), did)
            self.assertEqual(keys.sign(k, 'close1|123|{"a":1}'), sig)
            self.assertTrue(keys.verify(did, 'close1|123|{"a":1}', sig))

    @unittest.skipUnless(SIGN_PY.exists(), "set SIGN_PY=<technocore-chat>/scripts/sign.py to cross-check live")
    def test_matches_technocore_sign_py_live(self):
        for seed in ("11" * 32, "alice passphrase"):
            r = subprocess.run([sys.executable, str(SIGN_PY), "say", "--seed", seed, "close1", "123", '{"a":1}'],
                               capture_output=True, text=True, check=True).stdout.split()
            k = keys.key_from_seed(seed)
            self.assertEqual(r[0], keys.did_of(k))
            self.assertEqual(r[1], keys.sign(k, 'close1|123|{"a":1}'))

    def test_verify_roundtrip_and_tamper(self):
        s = keys.sign(A, "x")
        self.assertEqual(len(s), 86)
        self.assertTrue(keys.verify(DA, "x", s))
        self.assertFalse(keys.verify(DA, "y", s))
        self.assertFalse(keys.verify(DB, "x", s))
        self.assertFalse(keys.verify(DA, "x", "bad"))


class Protocol(unittest.TestCase):
    def test_terms_canonical_matches_spec_example(self):
        t = {"id": "a7f3", "maker": DA, "px": "181.20", "qty": "2", "side": "sell", "taker": "any", "until": 1236}
        self.assertEqual(P.terms_string(t),
                         '{"id":"a7f3","maker":"%s","px":"181.20","qty":"2","side":"sell","taker":"any","until":1236}' % DA)
        self.assertTrue(P.maker_payload(t).startswith("close-1|terms|{"))
        self.assertTrue(P.taker_payload(t, DB).endswith("}|" + DB))

    def test_offer_accept_trade(self):
        t = P.make_terms(DA, "buy", "2.5", "180.00", "any", 100, "t1")
        msig = keys.sign(A, P.maker_payload(t))
        offer = json.loads(P.offer_msg(t, msig))
        self.assertIsNone(P.check_offer(offer))
        trade = json.loads(P.trade_msg(t, DB, msig, keys.sign(B, P.taker_payload(t, DB))))
        self.assertIsNone(P.check_trade(trade))
        # a different countersigner cannot reuse B's signature
        forged = dict(trade, taker=DA)
        self.assertIsNotNone(P.check_trade(forged))
        # changing the price breaks the maker signature
        bad = json.loads(json.dumps(trade))
        bad["terms"]["px"] = "170.00"
        self.assertEqual(P.check_trade(bad), "maker signature does not verify")

    def test_named_taker(self):
        t = P.make_terms(DA, "sell", "1", "180", DB, 10, "t2")
        msig = keys.sign(A, P.maker_payload(t))
        C = keys.key_from_seed("carol")
        DC = keys.did_of(C)
        trade = json.loads(P.trade_msg(t, DC, msig, keys.sign(C, P.taker_payload(t, DC))))
        self.assertEqual(P.check_trade(trade), "named taker is not the countersigner")

    def test_shape_rules(self):
        for bad in ({"qty": "0.09"}, {"px": "1.234"}, {"side": "long"}, {"id": "a b"}):
            args = dict(maker=DA, side="buy", qty="1", px="100", taker="any", until=5, tid="x")
            args.update({"tid" if k == "id" else k: v for k, v in bad.items()})
            with self.assertRaises(ValueError):
                P.make_terms(**args)

    def test_clock(self):
        self.assertEqual(P.sweep_time(1), datetime(2026, 9, 25, 12, 5, tzinfo=timezone.utc))
        self.assertEqual(P.sweep_time(P.LOCK_SWEEP), datetime(2026, 10, 4, 9, 0, tzinfo=timezone.utc))
        self.assertEqual(P.sweep_now(datetime(2026, 9, 25, 12, 4, 59, tzinfo=timezone.utc)), 0)
        self.assertEqual(P.next_sweep(datetime(2026, 9, 25, 12, 5, 0, tzinfo=timezone.utc)), 2)

    def test_fees_match_fold(self):
        f = fold.Fold()
        cases = [("buy", "2", "181.20", "180.40"), ("sell", "2", "181.20", "185.00"),
                 ("buy", "10", "170.00", "180.00"), ("sell", "0.1", "200.00", "150.00")]
        for side, q, px, close in cases:
            got = P.side_fees(side, Decimal(q), Decimal(px), Decimal(close))
            want = f.side_fees(1 if side == "buy" else -1, Decimal(q), Decimal(px), Decimal(close))
            self.assertEqual(got, want)

    def test_max_qty_is_fundable_under_fold(self):
        px = Decimal("187.33")
        q = P.max_open_qty(P.MINT, px)
        acc = fold.Account("k", P.MINT)
        self.assertGreaterEqual(acc.cash, acc.opening(1, q) * px + P.FEE_RATE * q * px)
        q2 = q + Decimal("0.01")
        self.assertLess(acc.cash, q2 * px + P.FEE_RATE * q2 * px)


class Nonces(unittest.TestCase):
    def test_strictly_increasing_and_bump(self):
        a = state.next_nonce(DA, "close1")
        b = state.next_nonce(DA, "close1")
        self.assertGreater(b, a)
        state.bump_nonce(DA, "close1", b + 10**9)
        self.assertGreater(state.next_nonce(DA, "close1"), b + 10**9)


if __name__ == "__main__":
    unittest.main()


class Network(unittest.TestCase):
    """cli against a fake technocore: no real network."""

    def setUp(self):
        from closecall import cli, net
        self.cli, self.net = cli, net
        self.saved = {k: getattr(net, k) for k in ("room_owner", "read_room", "export_room", "post_signed")}
        self.ref = keys.key_from_seed("referee")
        self.rd = keys.did_of(self.ref)

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(self.net, k, v)

    def _msg(self, seq, obj, did=None):
        return {"seq": seq, "ts": "t", "from": did or self.rd, "nonce": seq, "text": json.dumps(obj)}

    def test_check_finds_seed_outside_tail(self):
        import io
        from contextlib import redirect_stdout
        n = P.sweep_now()
        seed = self._msg(1, {"t": "seed", "season": "close-1", "price": "180.00", "package": "abc"})
        tail = [self._msg(1000, {"t": "price", "n": n, "ref": {"px": "181.00"}}),
                self._msg(1001, {"t": "flow", "n": n})]
        self.net.room_owner = lambda room: self.rd
        self.net.read_room = lambda room, **kw: {"messages": tail}
        self.net.export_room = lambda room: [seed] + tail
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.cli.main(["check"])
        rep = json.loads(buf.getvalue())
        self.assertEqual(rep["verdict"], "LIVE")
        self.assertEqual(rep["seed"]["package"], "abc")

    def test_check_rejects_mixed_owners(self):
        import io
        from contextlib import redirect_stdout
        self.net.room_owner = lambda room: self.rd if room != "d-close1-pnl" else DA
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.cli.main(["check"])
        self.assertTrue(json.loads(buf.getvalue())["verdict"].startswith("NOT READY"))

    def test_post_retries_once_on_stale_nonce(self):
        calls = []

        def fake(room, did, sig, nonce, text):
            calls.append(nonce)
            if len(calls) == 1:
                raise self.net.HTTPError(403, f"nonce {nonce} is not greater than {nonce + 10**12}, the last one")
            self.assertTrue(keys.verify(did, f"{room}|{nonce}|{text}", sig))
            return {"posted": {"seq": 7, "ts": "t"}}
        self.net.post_signed = fake
        res = self.cli._post(A, DA, "close1", '{"x":1}', send=True)
        self.assertEqual(res["seq"], 7)
        self.assertGreater(calls[1], calls[0] + 10**12)


class Status(unittest.TestCase):
    """`status` against flow posts shaped like the live referee's (void = [id, reason] pairs)."""

    def setUp(self):
        from closecall import cli, net
        self.cli, self.net = cli, net
        self.saved = {k: getattr(net, k) for k in ("room_owner", "read_room")}
        self.rd = keys.did_of(keys.key_from_seed("referee"))

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(self.net, k, v)

    def test_mint_and_outcomes(self):
        import io
        from contextlib import redirect_stdout
        posts = [
            {"t": "flow", "n": 397, "mints": [DA], "settled": [], "void": [["x1", "funds"], ["mine-b", "expired"]],
             "omitted": {"mints": 5}},
            {"t": "flow", "n": 398, "mints": [], "settled": ["mine-a"], "void": []},
        ]
        msgs = [{"seq": i, "ts": "t", "from": self.rd, "nonce": i, "text": json.dumps(p)} for i, p in enumerate(posts, 1)]
        self.net.room_owner = lambda room: self.rd
        self.net.read_room = lambda room, **kw: {"messages": msgs, "first_seq": 1}
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.cli.main(["status", "--did", DA, "--id", "mine-a", "--id", "mine-b", "--id", "mine-c"])
        r = json.loads(buf.getvalue())
        self.assertEqual(r["minted_at_sweep"], 397)
        self.assertEqual(r["trades"]["mine-a"]["outcome"], "settled")
        self.assertEqual(r["trades"]["mine-b"]["entry"], ["mine-b", "expired"])
        self.assertEqual(r["pending_or_unseen"], ["mine-c"])

    def test_summary_tallies_void_reasons(self):
        s = self.cli._summary({"t": "flow", "void": [["a", "funds"], ["b", "funds"], ["c", "expired"]],
                               "limits": ["1", "2"]})
        self.assertEqual(s["void"], {"count": 3, "by_reason": {"funds": 2, "expired": 1}})
        self.assertEqual(s["limits"], ["1", "2"])
