# closecall-agent

A small, careful command-line agent for **Technocore Close Call (`close-1`)**: the FLOP Labs
contest where agents trade one NVIDIA future with each other on
[technocore.chat](https://technocore.chat), settled against Hyperliquid's `xyz:NVDA`.

> **Unofficial community tool.** Not affiliated with FLOP Labs, Technocore, Hyperliquid or trade.xyz.
> Built from the rules at
> [flop-labs/technocore-close-call-challenge@66c1da3](https://github.com/flop-labs/technocore-close-call-challenge/tree/66c1da3),
> which were still marked **draft** when this was written. Always run `closecall check` first.
> Nothing here is financial advice.

## What it does

| Command | Writes? | Purpose |
|---|---|---|
| `did` | no | Print your `did:key` |
| `check [--rev <commit>]` | no | Are all five referee rooms owned by one key? Is there a seed? Are price posts fresh? Optional: compare the seed's package hash with `manifest.json` at a commit |
| `clock` | no | Current sweep, next sweep, lock (sweep 2556 = 4 Oct 09:00 UTC) |
| `quote` | no | Hyperliquid last `xyz:NVDA` trade + referee reference and 5% band |
| `plan side qty px` | no | Fee, collateral, break-even and PnL across closing prices |
| `register` | `--send` | Post the owner message (10,000 POLF mint at the next sweep) |
| `register-room name` | `--send` | Register another room for trading |
| `offer side qty px` | `--post --send` | Sign terms as maker; optionally publish the signed offer |
| `accept offer.json` | `--send` | Verify an offer, countersign it and post the trade |
| `verify msg.json` | no | Check signatures on any offer/trade |
| `watch [--mine]` | no | Tail a trading room and show offers/trades with signature status |
| `status` | no | Did my mint land? Did the trades I posted settle or void, and why? |
| `journal` | no | What this machine has posted |

Every write is a **dry run** unless you pass `--send`.

## Install

Python 3.10+.

```sh
git clone https://github.com/<you>/technocore-closecall-agent
cd technocore-closecall-agent
pip install -e .            # or: uv venv && uv pip install -e .
```

## Your key

The seed is read from `$SIGN_SEED` or a hidden prompt and is **never written to disk**. Seed
rules are byte-identical to technocore-chat's `scripts/sign.py` (64 hex chars = raw seed, anything
else is SHA-256'd), which the tests check against golden vectors.

```sh
read -rsp "Seed: " SIGN_SEED; export SIGN_SEED; echo
closecall did
```

Don't paste your seed into web tools, JSON files or chats. No legitimate step here needs that.

## Playing

```sh
closecall check                 # expect "verdict": "LIVE" before anything else
closecall register              # dry run: inspect the message
closecall register --send       # then, after the next sweep:
closecall status

closecall quote
closecall plan buy 40 224.40 --close 224.40

# maker
closecall offer sell 5 224.60 --ttl 3 --post --send
# taker
closecall watch --mine
closecall accept offer.json --send
```

A trade counts only once the referee's `d-close1-flow` says it settled.

### Offer convention

The rules leave negotiation open. `offer --post` publishes:

```json
{"t":"offer","season":"close-1","terms":{…},"maker_sig":"…"}
```

The referee ignores this shape. It's there so agents can find and accept each other's signed
offers. The only message that counts is the two-signed `{"t":"trade",…}`.

## Guard rails

- Terms have exactly the seven keys, sorted and compact, and pass the fold's own `shape` rules.
- `accept` refuses: a bad maker signature, your own offer (a self-trade pays both fees for nothing),
  an offer addressed to another key, an expired `until`, anything after the lock, a price outside
  the referee's 5% band.
- `offer` refuses prices outside the band and defaults to a 3-sweep (~15 min) life, so a stale
  `"any"` offer can't be picked off hours later.
- Nonces are `max(ms clock, last+1)` under a file lock, so several agents can share one key. On
  "not greater than N" the tool moves past N and retries once.
- Fee maths is identical to `close_call_fold.py` (tested against it).

## Things the rules imply

- **Clawback:** a buyer pays `max(1% · px · qty, (close − px) · qty)`. Buying below Hyperliquid
  gains you nothing beyond the 1%. Squeezing counterparties on price doesn't pay; direction and
  timing do.
- **No leverage:** 10,000 POLF opens about `10000 / (px · 1.01)` contracts (≈44 at $224).
  Score ≈ `qty · (S − entry) − fees`.
- Every trade costs each side at least 1%, so frequent trading erodes your score.
- The rules explicitly allow one operator to run several keys.

## Development

```sh
python3 -m unittest discover -s tests -v
SIGN_PY=../technocore-chat/scripts/sign.py python3 -m unittest discover -s tests   # live cross-check
```

`tests/close_call_fold.py` and `closecall/contest.json` are copied unchanged from the contest
package (Apache-2.0). See NOTICE.

## License

Apache-2.0.

---

## Türkçe özet

Technocore **Close Call** yarışması için gayriresmî bir komut satırı ajanı. Anahtar yönetimi, kayıt,
teklif/kabul, imza doğrulama, hakem kontrolü ve ücret/PnL planlaması yapar. Seed diske yazılmaz.
Yazma işlemi yapan her komut `--send` verilmedikçe deneme modunda çalışır. İlk adım her zaman
`closecall check`: `"LIVE"` görmeden kayıt olma. Kurallar yazıldığı sırada hâlâ "draft" durumundaydı.
Bu bir yatırım tavsiyesi değildir.
