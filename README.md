# Close Call — join the Technocore NVDA contest from your browser

**App:** https://sprmn24.github.io/technocore-closecall-agent/

Close Call (`close-1`) is FLOP Labs' free trading contest on [technocore.chat](https://technocore.chat).
Every player gets 10,000 play-money POLF and trades one NVIDIA future with other players,
settled against Hyperliquid's `xyz:NVDA`. The three best scores share 1,000,000 FLOP.

This repository gives anyone a way in, including people who have never touched Technocore:

- **A web app**: one click to get a contest key, one to register, then trade from the browser.
  It never asks anyone to type or paste a seed. Available in English, Português (Brasil), 日本語,
  한국어, العربية, Türkçe and Français.
- **A command-line agent** for automation and power users.

> **Unofficial community tool.** Not affiliated with FLOP Labs, Technocore, Hyperliquid or
> trade.xyz. Built on the rules at
> [flop-labs/technocore-close-call-challenge@66c1da3](https://github.com/flop-labs/technocore-close-call-challenge/tree/66c1da3),
> the package the live referee's seed pins (`bae09812…6dafa`). Play money only; not financial advice.

## Web app

| Tab | What it does |
|---|---|
| **Start** | Three steps: "Start playing" (one click: a key and a recovery file), register, make a first trade |
| **Trade** | Publish a signed offer (buy/sell, price, size, validity) with fee, collateral, break-even and P&L scenarios; browse the offer board and accept other players' offers |
| **My account** | Your key, an estimated position and P&L, and every message you signed with its referee outcome |
| **Leaderboard** | The referee's top 25 with prize places, tied keys grouped (ties share the places they span), your rank, search by did:key |
| **Market** | Live NVIDIA reference and ±5% band, players, open interest, leaderboard, largest positions, sweeps, recent trades with verified signatures |
| **Rules & help** | The game in plain language and an FAQ |

### How it is built, and why you can trust it

- **No server.** The page is static and runs on GitHub Pages. Your browser talks to
  `technocore.chat` and `api.hyperliquid.xyz` directly and checks every signature itself.
- **No password, no seed entry.** The key is generated with WebCrypto and kept in IndexedDB as a
  *non-extractable* `CryptoKey`: it signs in this browser, but nothing can read it out, this site's
  own code included. The only backup is a recovery file downloaded once at creation (Safari clears
  site data after 7 days without a visit, so the file matters). Restoring means picking that file,
  which is read locally and never uploaded. The site has no field for pasting a seed or private key,
  so "paste your seed" is always a scam signal. Players with an existing Technocore key don't need
  it, since any `did:key` can play; if they want to use it, the CLI keeps it in their own terminal.
  Password vaults from earlier versions are unlocked once and moved over.
- **Locked down.** The Content-Security-Policy allows scripts only from the site itself and
  network requests only to technocore.chat and Hyperliquid. Every string from the network is
  rendered as text, never as HTML.
- **Same keys everywhere.** The secret key in a recovery file works with the CLI below and with
  technocore-chat's `scripts/sign.py`. The tests check the browser against the same golden vectors
  and against a real trade captured from `close1`.

Only use the app at its official address. A copy hosted elsewhere could steal keys.

### The offer board

The contest has no order book. The app publishes signed offers to the `closecall-desk` room:

```json
{"t":"offer","season":"close-1","terms":{…},"maker_sig":"…"}
```

The referee ignores this room, so an offer there never counts on its own. When someone accepts
an offer, the two-signed `{"t":"trade",…}` goes to `close1`, where it counts. A copy also goes
to the desk so the maker sees the fill. The CLI uses the same room, so web and CLI users can
trade with each other.

### Limits worth knowing

- The referee's public flow posts are cut to fit one message, so they don't list every mint or
  settlement. "My account" shows an estimate built from the trades you signed. The referee's
  ledger is the final word.
- A published offer cannot be withdrawn before it expires. Keep validity short when the price moves fast.
- The app depends on technocore.chat answering browser requests from other sites, which it does
  today. If that changes, the CLI keeps working.

### Run it locally

```sh
pip install -e .
closecall web            # http://127.0.0.1:8787
```

## Command-line agent

```sh
pip install -e .
read -rsp "Seed: " SIGN_SEED; export SIGN_SEED; echo
closecall check          # referee rooms, seed, price feed → "LIVE"
closecall register --send
closecall quote
closecall plan buy 40 224.40
closecall offer sell 5 224.60 --post --send      # to closecall-desk
closecall watch --mine                           # offers/trades on the desk
closecall accept offer.json --send               # trade to close1 (+ copy to the desk)
closecall status                                 # mint and trade outcomes, where listed
```

Every write is a dry run unless you pass `--send`. The seed is read from `$SIGN_SEED` or a
hidden prompt and is never written to disk.

## Development

```sh
python3 -m unittest discover -s tests -v        # Python: protocol, signing, fees vs the fold, network mocks
node tests/web/core.test.mjs                    # browser core: golden vectors, live trade, fees, vault
node tests/web/i18n.test.mjs                    # every UI string in all seven languages
```

`.github/workflows/pages.yml` publishes `closecall/web` to GitHub Pages on every push to `main`
(Settings → Pages → Source: GitHub Actions).

`tests/close_call_fold.py` and `closecall/contest.json` are copied unchanged from the contest
package (Apache-2.0); see NOTICE.

The CSP in `closecall/web/index.html` is what keeps the page from talking to anything but
technocore.chat and Hyperliquid, so any change that widens it needs a stated reason.

## License

Apache-2.0.

---

## Türkçe

**Uygulama:** https://sprmn24.github.io/technocore-closecall-agent/

Technocore **Close Call** yarışmasına tarayıcıdan katılmak için gayriresmî ve açık kaynak bir araç.
Technocore'u hiç kullanmamış biri de şu adımlarla katılabilir: "Oynamaya başla" ile tek tıkta anahtar ve
kurtarma dosyası oluştur, tek tıkla kayıt ol, teklif ver ya da bir teklifi kabul et. Şifre yok; site
hiçbir zaman seed ya da özel anahtar istemez. Liderlik sekmesinde ödül sıraları ve kendi sıran görünür. Arayüz İngilizce, Portekizce (Brezilya), Japonca, Korece,
Arapça, Türkçe ve Fransızca. Sitenin sunucusu yok. Sadece oyun parası; yatırım tavsiyesi değildir.
