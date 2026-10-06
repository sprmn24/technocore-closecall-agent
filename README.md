# Close Call — join the Technocore NVDA contest from your browser

> **The contest has ended.** Trading locked on 4 October 2026 at 09:00 UTC. The app stays online so
> players can see their balance, statement and the referee's latest standings, and keep using the key
> they made here. Prizes are claimed later with that same key, so keep your recovery file.
> New DIDs can still be created; registering and trading for `close-1` are closed.

## ▶ [Open the app: sprmn24.github.io/technocore-closecall-agent](https://sprmn24.github.io/technocore-closecall-agent/)

Nothing to download or install. It runs in your browser on a phone or a computer.

Close Call (`close-1`) is FLOP Labs' free trading contest on [technocore.chat](https://technocore.chat).
Every player gets 10,000 play-money POLF and trades one NVIDIA future with other players,
settled against Hyperliquid's `xyz:NVDA`. The three best scores share 1,000,000 FLOP.
Trading closes on **2026-10-04 at 09:00 UTC**.

### How to join, step by step

1. **Open [the app](https://sprmn24.github.io/technocore-closecall-agent/).** It opens in your
   browser's language; you can switch at the top right.
2. **Start → Create a new DID.** Your key is made in your browser. Its seed (secret) is shown once:
   copy it or download the recovery file and keep it somewhere safe. Never share it with anyone.
   No one needs it to help you, and this site will never ask you for it.
3. **Register my key.** One click. The referee sends you **10,000 POLF** at the next sweep
   (within 5 minutes). **My account** shows when it arrives and what you have left.
4. **Trade.** On **Trade**, pick a waiting offer and press **Buy** or **Sell**, or publish your own
   price. **My account** shows every trade, the fees and your balance after each one.
5. **Follow your rank** on **Leaderboard**. Scores are final at the close on 4 October.

Already made a DID with Technocore's tools? Choose **I already have a DID** on **Start** and type
your public DID (the `z6Mk…` part is enough). For each action you choose: **sign in your terminal**
with a one-line command, so your seed never touches the browser, or **sign here** after loading
your key into the browser once. Only ever enter a seed at
`https://sprmn24.github.io/technocore-closecall-agent/`; no one needs your seed to help you.

| | |
|---|---|
| Português | [Abra o app](https://sprmn24.github.io/technocore-closecall-agent/) e escolha "Português (Brasil)" no canto superior direito. Nada para instalar. |
| 日本語 | [アプリを開き](https://sprmn24.github.io/technocore-closecall-agent/)、右上で「日本語」を選んでください。インストール不要です。 |
| 한국어 | [앱을 열고](https://sprmn24.github.io/technocore-closecall-agent/) 오른쪽 위에서 "한국어"를 선택하세요. 설치할 것이 없습니다. |
| العربية | [افتح التطبيق](https://sprmn24.github.io/technocore-closecall-agent/) واختر "العربية" أعلى الصفحة. لا حاجة لأي تثبيت. |
| Français | [Ouvrez l'app](https://sprmn24.github.io/technocore-closecall-agent/) et choisissez « Français » en haut à droite. Rien à installer. |
| Türkçe | [Uygulamayı aç](https://sprmn24.github.io/technocore-closecall-agent/) ve sağ üstten "Türkçe"yi seç. Kurulum yok. |

This repository also has a **command-line agent** for automation and power users (below).

> **Unofficial community tool.** Not affiliated with FLOP Labs, Technocore, Hyperliquid or
> trade.xyz. Built on the rules at
> [flop-labs/technocore-close-call-challenge@66c1da3](https://github.com/flop-labs/technocore-close-call-challenge/tree/66c1da3),
> the package the live referee's seed pins (`bae09812…6dafa`). Play money only; not financial advice.

## Web app

| Tab | What it does |
|---|---|
| **Start** | Two ways in. **Create a new DID**: one click, the seed is shown once with copy/download and clear warnings. **I already have a DID**: enter your public DID; the site shows your account and gives you a one-line `closecall` command for every action, so your seed stays in your own terminal. Then register and make a first trade |
| **Trade** | An order board of everyone waiting for a counterparty: best buyer, best seller, spread, and one-click **Buy**/**Sell** on any waiting offer, so nobody has to wait for a match. Publish your own offer (price, size, validity) with fee, collateral, break-even and P&L scenarios; the form points out offers that already match your price. Every offer gets a share link that opens straight to its accept screen, and you're told when yours is taken |
| **My account** | Your balance: the referee's 10,000 POLF grant (when it arrives), POLF still available, POLF tied up in positions, fees paid, account value and score, with a statement of every trade and the balance after it. Also your key and every message you signed with its referee outcome |
| **Leaderboard** | The referee's top 25 with prize places, tied keys grouped (ties share the places they span), your rank, search by did:key |
| **Market** | Live NVIDIA reference and ±5% band, players, open interest, leaderboard, largest positions, sweeps, recent trades with verified signatures |
| **Rules & help** | The game in plain language and an FAQ |

### How it is built, and why you can trust it

- **No server.** The page is static and runs on GitHub Pages. Your browser talks to
  `technocore.chat` and `api.hyperliquid.xyz` directly and checks every signature itself.
- **Keys stay where they were made.** A new DID's key is generated with WebCrypto and kept in
  IndexedDB as a *non-extractable* `CryptoKey`: it signs in this browser, but nothing can read it
  out, this site's own code included. The seed is shown once at creation, to copy or download,
  with warnings not to lose or share it. Restoring on a new device takes the backup file or the seed,
  read locally and never sent anywhere. There is no password.
- **Existing DIDs choose how to sign.** "I already have a DID" needs only the public DID. For each
  action (register, offer, accept) the person picks: **sign in my terminal**, a one-line
  `closecall … --as <did>` command where the CLI asks for the seed and refuses a seed of any other
  DID; or **sign here**, loading the key once from the recovery file or seed. That key is refused
  unless it matches the DID they entered, and is then stored like a key made here (non-extractable).
  The dialog warns to check the address bar, avoid shared computers, and that no one ever needs
  their seed. Web and CLI users trade with each other on the same offer board.
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

- The referee doesn't publish a balance for each key, and its flow posts are cut to fit one
  message, so they don't list every mint or settlement. "My account" replays the fold's rules
  (grant, FIFO lots, collateral, 1% minimum fee) over the trades you signed, and warns before you
  sign a trade the referee would void for lack of POLF. The referee's ledger is the final word.
- Anyone can re-post a public trade in `close1`. The referee settles a trade id once, in stamp
  order, and voids later copies with reason `settled`; the app never counts such a void against you.
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
closecall accept <offer-id> --send               # trade to close1 (+ copy to the desk)
closecall status                                 # mint and trade outcomes, where listed
```

Every write is a dry run unless you pass `--send`. Add `--as <did>` to make a command refuse to
sign with any other key (the web app's commands always include it). The seed is read from `$SIGN_SEED` or a
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
seed'ini (bir kez gösterilir, kopyala/indir) al, tek tıkla kayıt ol, teklif ver ya da bir teklifi kabul et.
Terminalde DID üretmiş olanlar "Zaten bir DID'im var" ile sadece açık DID'lerini girer; her işlem için
site tek satırlık bir komut verir ve seed kendi terminallerinde kalır. "Hesabım" sekmesinde hakemden gelen 10.000 POLF'un ne zaman geldiği, ne kadar
harcandığı ve ne kadar kaldığı, işlem işlem hesap dökümüyle görünür. Liderlik sekmesinde ödül sıraları ve kendi sıran görünür. Arayüz İngilizce, Portekizce (Brezilya), Japonca, Korece,
Arapça, Türkçe ve Fransızca. Sitenin sunucusu yok. Sadece oyun parası; yatırım tavsiyesi değildir.
