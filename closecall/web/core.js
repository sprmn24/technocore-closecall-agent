// Close Call core: protocol, keys, signing and network. No DOM here, so it can be tested alone.
//
// Byte-compatible with the Python CLI (closecall/keys.py, protocol.py) and technocore-chat
// scripts/sign.py: a seed is 64 hex characters (the raw 32-byte Ed25519 seed) or any other
// string, which is SHA-256'd. The seed never leaves this module except to the vault
// (encrypted) or to the user's own backup, and nothing here ever sends it over the network.

export const TC = "https://technocore.chat";
export const HL = "https://api.hyperliquid.xyz/info";
export const COIN = "xyz:NVDA";
export const SEASON = "close-1";
export const OPENING = Date.parse("2026-09-25T12:00:00Z");
export const SWEEP_MS = 300_000;
export const LOCK_SWEEP = 2556;
export const FINAL_TIME = Date.parse("2026-10-04T10:00:00Z");
export const MINT_CENTS = 1_000_000n; // 10,000.00 POLF
export const TRADING_ROOM = "close1";
export const DESK_ROOM = "closecall-desk"; // offers live here; the referee ignores offers anywhere
export const REFEREE_ROOMS = ["d-close1-flow", "d-close1-state", "d-close1-price", "d-close1-positions", "d-close1-pnl"];
export const PACKAGE_SHA256 = "bae09812e25eb6f1369c611f24964f7ea0acafddfc45301a16f33f941296dafa";

export const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AMOUNT_RE = /^[0-9]{1,7}(\.[0-9]{1,2})?$/;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PKCS8_ED25519 = hexToBytes("302e020100300506032b657004220420");
const enc = new TextEncoder();

// ---- clock -------------------------------------------------------------------------------
export const sweepNow = (t = Date.now()) => Math.max(0, Math.floor((t - OPENING) / SWEEP_MS));
export const nextSweep = (t = Date.now()) => sweepNow(t) + 1;
export const sweepTime = (n) => OPENING + n * SWEEP_MS;

// ---- encodings ---------------------------------------------------------------------------
export function hexToBytes(h) {
  if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new Error("bad hex");
  return Uint8Array.from(h.match(/../g) || [], (b) => parseInt(b, 16));
}
export const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  return out;
}
function b58decode(s, len) {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n; }
  return out;
}

// ---- keys --------------------------------------------------------------------------------
export async function ed25519Supported() {
  try { await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]); return true; } catch { return false; }
}

/** The 32-byte seed for what a user typed: 64 hex chars as-is, anything else SHA-256'd (sign.py rules). */
export async function seedFromInput(text) {
  const s = String(text).trim();
  if (!s) throw new Error("empty seed");
  if (s.length === 64 && /^[0-9a-fA-F]{64}$/.test(s)) return hexToBytes(s);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

export const newSeed = () => crypto.getRandomValues(new Uint8Array(32));

export function didFromPublic(pub) {
  return "did:key:z" + b58encode(new Uint8Array([0xed, 0x01, ...pub]));
}

export function publicFromDid(did) {
  if (!DID_RE.test(did)) throw new Error("not an Ed25519 did:key");
  const raw = b58decode(did.slice("did:key:z".length), 34);
  if (raw[0] !== 0xed || raw[1] !== 0x01) throw new Error("not ed25519-pub");
  return raw.slice(2);
}

/** A signer for a seed. The CryptoKey it keeps is non-extractable. */
export async function signerFromSeed(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error("seed must be 32 bytes");
  const pkcs8 = new Uint8Array([...PKCS8_ED25519, ...seed]);
  const exportable = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", exportable);
  const priv = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  pkcs8.fill(0);
  const did = didFromPublic(unb64url(jwk.x));
  return {
    did,
    async sign(message) {
      return b64url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, priv, enc.encode(message))));
    },
  };
}

const pubCache = new Map();
export async function verify(did, message, sig) {
  if (typeof sig !== "string" || !SIG_RE.test(sig) || typeof did !== "string" || !DID_RE.test(did)) return false;
  try {
    let key = pubCache.get(did);
    if (!key) {
      key = await crypto.subtle.importKey("raw", publicFromDid(did), { name: "Ed25519" }, false, ["verify"]);
      if (pubCache.size > 5000) pubCache.clear();
      pubCache.set(did, key);
    }
    return await crypto.subtle.verify({ name: "Ed25519" }, key, unb64url(sig), enc.encode(message));
  } catch {
    return false;
  }
}

// ---- vault: the seed at rest, PBKDF2-SHA256 + AES-GCM -------------------------------------
const VAULT_KEY = "cc-vault-v1";
const PBKDF2_ITER = 600_000;

async function vaultKey(password, salt) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITER }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function sealSeed(seed, password, did) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await vaultKey(password, salt), seed));
  return { v: 1, did, salt: b64url(salt), iv: b64url(iv), ct: b64url(ct), iter: PBKDF2_ITER };
}
export async function openSeed(vault, password) {
  const key = await vaultKey(password, unb64url(vault.salt));
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64url(vault.iv) }, key, unb64url(vault.ct)));
  } catch {
    throw new Error("wrong password");
  }
}
export function loadVault() {
  try { const v = JSON.parse(localStorage.getItem(VAULT_KEY) || "null"); return v && v.v === 1 && DID_RE.test(v.did) ? v : null; } catch { return null; }
}
export function saveVault(v) { localStorage.setItem(VAULT_KEY, JSON.stringify(v)); }
export function forgetVault() { localStorage.removeItem(VAULT_KEY); }

// ---- amounts: exact, in hundredths --------------------------------------------------------
/** "221.02" -> 22102n; null when not a positive amount with at most two decimals. */
export function cents(text) {
  if (typeof text !== "string" || !AMOUNT_RE.test(text)) return null;
  const [w, f = ""] = text.split(".");
  const v = BigInt(w) * 100n + BigInt((f + "00").slice(0, 2));
  return v > 0n ? v : null;
}
export const fromCents = (c) => (c < 0n ? "-" : "") + (c < 0n ? -c : c).toString().padStart(3, "0").replace(/(\d{2})$/, ".$1");
/** qty (hundredths) x px (cents) -> POLF in 1e-4 units */
const notional4 = (q, p) => q * p;

/** The fold's fees for one trade, as Numbers in POLF (display only). */
export function sideFees(makerSide, qtyC, pxC, closeC) {
  const base = notional4(qtyC, pxC) / 100n;              // 1% in 1e-4 units
  const gap = (closeC - pxC) * qtyC;                       // >0: the buyer paid less than the close
  const buyer = base > gap ? base : gap, seller = base > -gap ? base : -gap;
  const [m, t] = makerSide === "buy" ? [buyer, seller] : [seller, buyer];
  return { maker: Number(m) / 1e4, taker: Number(t) / 1e4 };
}
/** Largest quantity (hundredths) one side can open with `cashC` cents at `pxC`: qty*px*1.01 <= cash. */
export function maxQtyC(cashC, pxC) {
  if (pxC <= 0n) return 0n;
  const q = (cashC * 10_000n) / (pxC * 101n);
  return q >= 10n ? q : 0n;
}
export const withinLimits = (pxC, refC) => (pxC - refC < 0n ? refC - pxC : pxC - refC) * 100n <= refC * 5n;

// ---- messages ----------------------------------------------------------------------------
/** Sorted keys, no spaces: the same bytes as Python json.dumps(sort_keys=True, separators=(",", ":")). */
export function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v);
}

export function newTradeId() { return bytesToHex(crypto.getRandomValues(new Uint8Array(6))); }

export function termsProblem(t) {
  if (!t || typeof t !== "object" || Array.isArray(t)) return "terms missing";
  const keys = Object.keys(t).sort().join(",");
  if (keys !== "id,maker,px,qty,side,taker,until") return "terms must have exactly id, maker, px, qty, side, taker, until";
  if (typeof t.id !== "string" || !ID_RE.test(t.id)) return "id: 1-64 of [A-Za-z0-9_-]";
  if (t.side !== "buy" && t.side !== "sell") return "side: buy or sell";
  const q = cents(t.qty), p = cents(t.px);
  if (q === null || p === null) return "qty/px: positive, at most two decimals";
  if (q < 10n) return "qty: at least 0.1";
  if (!Number.isInteger(t.until)) return "until: integer sweep";
  if (typeof t.maker !== "string" || !DID_RE.test(t.maker)) return "maker: did:key";
  if (t.taker !== "any" && (typeof t.taker !== "string" || !DID_RE.test(t.taker))) return "taker: any or a did:key";
  return null;
}
export const makerPayload = (t) => `${SEASON}|terms|${canonical(t)}`;
export const takerPayload = (t, did) => `${SEASON}|accept|${canonical(t)}|${did}`;
export const ownerMsg = (did) => canonical({ t: "owner", season: SEASON, key: did });
export const offerMsg = (terms, makerSig) => canonical({ t: "offer", season: SEASON, terms, maker_sig: makerSig });
export const tradeMsg = (terms, taker, makerSig, takerSig) =>
  canonical({ t: "trade", season: SEASON, terms, taker, maker_sig: makerSig, taker_sig: takerSig });

export async function checkOffer(o) {
  if (!o || o.season !== SEASON || (o.t !== "offer" && o.t !== "trade")) return "not a close-1 offer/trade";
  const p = termsProblem(o.terms);
  if (p) return p;
  if (!(await verify(o.terms.maker, makerPayload(o.terms), o.maker_sig))) return "maker signature does not verify";
  return null;
}
export async function checkTrade(o) {
  const p = await checkOffer(o);
  if (p) return p;
  if (o.t !== "trade") return "not a trade";
  if (typeof o.taker !== "string" || !DID_RE.test(o.taker)) return "taker: countersigner did:key required";
  if (o.terms.taker !== "any" && o.terms.taker !== o.taker) return "named taker is not the countersigner";
  if (!(await verify(o.taker, takerPayload(o.terms, o.taker), o.taker_sig))) return "taker signature does not verify";
  return null;
}

// ---- network -----------------------------------------------------------------------------
async function http(url, opts = {}, timeoutMs = 20_000) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal, cache: "no-store" });
    const body = await r.text();
    if (!r.ok) { const e = new Error(`HTTP ${r.status}: ${body.slice(0, 300)}`); e.status = r.status; e.body = body; throw e; }
    return body;
  } finally { clearTimeout(timer); }
}
export async function readRoom(room, { limit = 50, since } = {}) {
  const q = new URLSearchParams({ format: "json", limit: String(limit) });
  if (since != null) q.set("since", String(since));
  return JSON.parse(await http(`${TC}/r/${encodeURIComponent(room)}?${q}`));
}
/** Signed messages whose text is a JSON object: [{seq, ts, from, json}] */
export function signedJson(view) {
  const out = [];
  for (const m of (view && view.messages) || []) {
    if (typeof m.from !== "string" || !DID_RE.test(m.from) || !("nonce" in m)) continue;
    try { const j = JSON.parse(m.text); if (j && typeof j === "object" && !Array.isArray(j)) out.push({ seq: m.seq, ts: m.ts, from: m.from, json: j }); } catch { /* not JSON */ }
  }
  return out;
}
export async function roomOwner(room) {
  try {
    const text = await http(`${TC}/kv/room-owners/${encodeURIComponent(room)}`);
    const m = text.split("\n\n").slice(1).join("\n\n").match(/did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}/) || text.match(/did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}/);
    return m ? m[0] : null;
  } catch (e) { if (e.status === 404) return null; throw e; }
}
export async function exportRoom(room) {
  const text = await http(`${TC}/r/${encodeURIComponent(room)}/export`, {}, 60_000);
  return text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
export async function hlLast() {
  const trades = JSON.parse(await http(HL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "recentTrades", coin: COIN }) }));
  if (!trades.length) throw new Error("no recent trades");
  return trades.reduce((a, b) => (b.time > a.time ? b : a));
}

// Nonces must strictly increase per key per room: max(ms clock, last + 1), remembered locally.
function nextNonce(did, room) {
  const k = `cc-nonce:${did}|${room}`;
  let last = 0;
  try { last = Number(localStorage.getItem(k) || 0); } catch { /* private mode */ }
  const n = Math.max(Date.now(), last + 1);
  try { localStorage.setItem(k, String(n)); } catch { /* ignore */ }
  return n;
}
function bumpNonce(did, room, atLeast) {
  try { const k = `cc-nonce:${did}|${room}`; localStorage.setItem(k, String(Math.max(Number(localStorage.getItem(k) || 0), atLeast))); } catch { /* ignore */ }
}

/** Sign `room|nonce|text` and POST it. Returns the stored record {seq, ts, ...}. */
export async function postSigned(signer, room, text) {
  if (text.length > 4096) throw new Error("message over 4096 characters");
  for (let attempt = 0; attempt < 2; attempt++) {
    const nonce = nextNonce(signer.did, room);
    const sig = await signer.sign(`${room}|${nonce}|${text}`);
    try {
      const body = await http(`${TC}/r/${encodeURIComponent(room)}?format=json`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ did: signer.did, sig, nonce: String(nonce), text }),
      });
      return JSON.parse(body).posted || {};
    } catch (e) {
      const m = /not greater than (\d+)/.exec(e.body || "");
      if (m && attempt === 0) { bumpNonce(signer.did, room, Number(m[1])); continue; }
      throw e;
    }
  }
  throw new Error("unreachable");
}
