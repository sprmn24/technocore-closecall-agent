// Close Call web app. Every string that comes from the network is rendered with textContent.
import * as C from "./core.js";
import { STRINGS, HTML_LANG, RTL } from "./i18n.js";

// ---- state -------------------------------------------------------------------------------
const S = {
  lang: "en",
  signer: null,           // {did, sign} while unlocked
  vault: C.loadVault(),
  price: null,            // latest referee price post
  hl: null,               // latest Hyperliquid trade
  live: null,             // referee looks live?
  desk: { offers: [], filled: new Set(), at: 0, error: null },
  flowIndex: new Map(),   // trade id -> {outcome, reason, n}
  market: null,
  trust: null,
  view: "start",
  form: { side: "buy", qty: "1", px: "", ttl: 6, taker: "" },
  ed25519: true,
};

// ---- i18n --------------------------------------------------------------------------------
function t(key, vars) {
  let s = (STRINGS[S.lang] && STRINGS[S.lang][key]) ?? STRINGS.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split("{" + k + "}").join(String(v));
  return s;
}
const rsn = (k) => (STRINGS.en["reason." + k] ? t("reason." + k) : String(k));
function applyStatic() {
  document.documentElement.lang = HTML_LANG[S.lang] || S.lang;
  document.documentElement.dir = RTL.has(S.lang) ? "rtl" : "ltr";
  document.querySelectorAll("[data-i18n]").forEach((n) => { n.textContent = t(n.dataset.i18n); });
  document.querySelectorAll("[data-i18n-title]").forEach((n) => { n.title = t(n.dataset.i18nTitle); });
  document.title = t("doc.title");
}

// ---- dom helpers -------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "value") n.value = v;
    else if (v === true) n.setAttribute(k, "");
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}
const svgEl = (tag, attrs) => { const n = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v); return n; };
const clear = (n) => { n.textContent = ""; return n; };
const NF = (d) => new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt = (x, d = 2) => (x == null || Number.isNaN(+x) ? "–" : NF(d).format(+x));
const fmtInt = (x) => (x == null || Number.isNaN(+x) ? "–" : NF(0).format(+x));
const compact = (x) => (x == null || Number.isNaN(+x) ? "–" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(+x));
const utc = (ms) => { const d = new Date(ms); return Number.isNaN(+d) ? "–" : d.toISOString().slice(11, 16) + " UTC"; };
const utcFull = (ms) => { const d = new Date(ms); return Number.isNaN(+d) ? "–" : d.toISOString().replace("T", " ").slice(0, 16) + " UTC"; };
function dur(ms) {
  if (!(ms > 0)) return "0" + t("u.s");
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}${t("u.d")} ${h}${t("u.h")} ${m}${t("u.m")}`;
  if (h) return `${h}${t("u.h")} ${m}${t("u.m")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
function didEl(did, full) {
  if (typeof did !== "string") return el("span", { class: "mono" }, "–");
  const short = full ? did : C.DID_RE.test(did) ? did.slice(8, 16) + "…" + did.slice(-6) : did.slice(0, 14);
  return el("span", { class: "mono did", title: did, onclick: () => copy(did) }, short);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast(t("ui.copied")); } catch { toast(t("ui.copyfail"), true); }
}
let toastTimer;
function toast(msg, bad) {
  const n = $("toast"); n.textContent = msg; n.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { n.className = "toast"; }, 3200);
}
function errText(e) {
  const s = String((e && (e.body || e.message)) || e);
  if (/Failed to fetch|NetworkError|aborted/i.test(s)) return t("err.network");
  return s.split("\n")[0].slice(0, 220);
}
/** A modal; `build(close)` returns its content nodes. Resolves with whatever close() is given. */
function modal(build) {
  const dlg = $("modal"), box = clear($("modal-in"));
  return new Promise((resolve) => {
    let done = false;
    const close = (v) => { if (done) return; done = true; dlg.close(); resolve(v); };
    dlg.onclose = () => { if (!done) { done = true; resolve(undefined); } };
    box.append(...[build(close)].flat(Infinity).filter((x) => x != null && x !== false));
    dlg.showModal();
    const f = box.querySelector("input,textarea,button.primary"); if (f) f.focus();
  });
}
function download(name, text) {
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type: "text/plain" })), download: name });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || t("ui.working"); btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
}

// ---- journal: what this browser signed ----------------------------------------------------
const jKey = () => `cc-journal:${S.signer ? S.signer.did : S.vault ? S.vault.did : "-"}`;
function journal() { try { return JSON.parse(localStorage.getItem(jKey()) || "[]"); } catch { return []; } }
function journalAdd(e) {
  const j = journal();
  if (e.id && j.some((x) => x.kind === e.kind && x.id === e.id && x.role === e.role)) return;
  j.push({ ts: Date.now(), ...e });
  try { localStorage.setItem(jKey(), JSON.stringify(j.slice(-500))); } catch { /* full */ }
}
const registered = () => journal().some((e) => e.kind === "owner");
const myDid = () => (S.signer ? S.signer.did : S.vault ? S.vault.did : null);

// ---- key management ----------------------------------------------------------------------
function passwordFields(withConfirm) {
  const p1 = el("input", { class: "input", type: "password", autocomplete: "new-password", minlength: "8" });
  const p2 = withConfirm ? el("input", { class: "input", type: "password", autocomplete: "new-password" }) : null;
  const nodes = [el("div", { class: "field" }, el("label", {}, t("key.pw")), p1, el("span", { class: "hint" }, t("key.pwhint")))];
  if (p2) nodes.push(el("div", { class: "field" }, el("label", {}, t("key.pw2")), p2));
  const check = () => {
    if (p1.value.length < 8) return t("key.pwshort");
    if (p2 && p1.value !== p2.value) return t("key.pwmismatch");
    return null;
  };
  return { nodes, p1, check };
}

async function activate(seed, password) {
  const signer = await C.signerFromSeed(seed);
  const vault = await C.sealSeed(seed, password, signer.did);
  C.saveVault(vault);
  S.vault = vault; S.signer = signer;
  seed.fill(0);
}

function recoveryText(seedHex, did) {
  return [
    "Close Call recovery file",
    "KEEP THIS FILE PRIVATE. Anyone who has it controls this contest account.",
    "No one from the contest will ever ask for it. Never paste its contents into a website.",
    "",
    "Restore: open Close Call, choose \"Restore from recovery file\" and pick this file.",
    "",
    `did:  ${did}`,
    `seed: ${seedHex}`,
    "",
    "Command-line tool (optional): SIGN_SEED=<seed> closecall did",
    `Created: ${new Date().toISOString()}`,
  ].join("\n");
}
const recoveryName = (did) => `close-call-recovery-${did.slice(-8)}.txt`;

/** The seed in a recovery file this site wrote: its "seed:" line, checked against its "did:" line. */
async function seedFromRecovery(text) {
  const m = /^seed:\s*([0-9a-fA-F]{64})\s*$/m.exec(text);
  if (!m) throw new Error(t("key.badfile"));
  const seed = C.hexToBytes(m[1]);
  const signer = await C.signerFromSeed(seed);
  const d = /^did:\s*(did:key:\S+)\s*$/m.exec(text);
  if (d && d[1] !== signer.did) { seed.fill(0); throw new Error(t("key.badfile")); }
  return { seed, did: signer.did };
}

async function createKeyFlow() {
  // Stage 1: a password. Stage 2: the recovery file. The seed is never typed or pasted.
  const seed = C.newSeed();
  const signer = await C.signerFromSeed(seed);
  const seedHex = C.bytesToHex(seed);
  const ok = await modal((close) => {
    const box = el("div", { class: "modal-in-flow" });
    const pw = passwordFields(true);
    const err = el("p", { class: "hint bad" });
    const next = el("button", { class: "btn primary", type: "button" }, t("key.makekey"));
    const stage2 = () => {
      const saved = el("input", { type: "checkbox" });
      const finish = el("button", { class: "btn primary", type: "button", disabled: true }, t("key.finish"));
      saved.addEventListener("change", () => { finish.disabled = !saved.checked; });
      const dl = el("button", { class: "btn primary big wide", type: "button" }, "⭳ " + t("key.download"));
      dl.addEventListener("click", () => { download(recoveryName(signer.did), recoveryText(seedHex, signer.did)); saved.checked = true; finish.disabled = false; });
      finish.addEventListener("click", async () => {
        busy(finish, true, t("key.securing"));
        try { await activate(seed, pw.p1.value); close(true); } catch (e) { err.textContent = errText(e); busy(finish, false); }
      });
      clear(box).append(
        el("h2", {}, t("key.savetitle")),
        el("p", { class: "muted" }, t("key.savedesc")),
        el("div", { class: "kvlist" }, el("div", {}, el("span", {}, t("key.yourdid")), el("span", { class: "mono" }, signer.did))),
        dl,
        el("div", { class: "callout warn" }, t("key.seedwarn")),
        el("label", { class: "check" }, saved, el("span", {}, t("key.saved"))),
        el("details", {}, el("summary", { class: "hint" }, t("key.advanced")),
          el("p", { class: "hint" }, t("key.yourseed")), el("div", { class: "secret" }, seedHex),
          el("button", { class: "btn small", type: "button", onclick: () => copy(seedHex) }, t("key.copyseed"))),
        err,
        el("div", { class: "modal-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => close(false) }, t("ui.cancel")), finish),
      );
      dl.focus();
    };
    next.addEventListener("click", () => { const p = pw.check(); if (p) { err.textContent = p; return; } err.textContent = ""; stage2(); });
    box.append(
      el("h2", {}, t("key.newtitle")),
      el("p", { class: "muted" }, t("key.newdesc")),
      ...pw.nodes, err,
      el("div", { class: "modal-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => close(false) }, t("ui.cancel")), next),
    );
    return box;
  });
  if (!ok) seed.fill(0);
  if (ok) { toast(t("key.ready")); renderAll(); }
}

async function restoreFlow() {
  const ok = await modal((close) => {
    // The native file button is labelled in the browser's language, not the page's: hide it behind our own.
    const file = el("input", { class: "sr", type: "file", accept: ".txt,text/plain", id: "recovery-file" });
    const fname = el("span", { class: "hint" }, t("key.nofilechosen"));
    const picker = el("div", { class: "row" }, el("label", { class: "btn", for: "recovery-file" }, t("key.pickfile")), fname);
    const preview = el("div", { class: "hint" });
    const pw = passwordFields(true);
    const err = el("p", { class: "hint bad" });
    let found = null;
    file.addEventListener("change", async () => {
      found = null; preview.textContent = ""; err.textContent = "";
      const f = file.files && file.files[0];
      fname.textContent = f ? f.name : t("key.nofilechosen");
      if (!f) return;
      if (f.size > 20_000) { err.textContent = t("key.badfile"); return; }
      try { found = await seedFromRecovery(await f.text()); preview.textContent = t("key.willbe") + " " + found.did; }
      catch (e) { err.textContent = e.message; }
    });
    const go = el("button", { class: "btn primary", type: "button" }, t("key.restore"));
    go.addEventListener("click", async () => {
      if (!found) { err.textContent = t("key.nofile"); return; }
      const p = pw.check(); if (p) { err.textContent = p; return; }
      busy(go, true, t("key.securing"));
      try { await activate(found.seed, pw.p1.value); close(true); } catch (e) { err.textContent = errText(e); busy(go, false); }
    });
    return [
      el("h2", {}, t("key.restoretitle")),
      el("p", { class: "muted" }, t("key.restoredesc")),
      el("div", { class: "field" }, el("span", { class: "label" }, t("key.choosefile")), file, picker, preview),
      ...pw.nodes, err,
      el("div", { class: "modal-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => close(false) }, t("ui.cancel")), go),
    ];
  });
  if (ok) { toast(t("key.ready")); renderAll(); }
}

async function unlock(password, btn, errNode) {
  busy(btn, true, t("key.unlocking"));
  try {
    const seed = await C.openSeed(S.vault, password);
    S.signer = await C.signerFromSeed(seed); seed.fill(0);
    if (S.signer.did !== S.vault.did) throw new Error("vault mismatch");
    toast(t("key.unlocked")); renderAll();
  } catch (e) { errNode.textContent = e.message === "wrong password" ? t("key.wrongpw") : errText(e); busy(btn, false); }
}

function lock() { S.signer = null; toast(t("key.locked")); renderAll(); }

async function revealBackup() {
  await modal((close) => {
    const pw = el("input", { class: "input", type: "password", autocomplete: "current-password" });
    const out = el("div"), err = el("p", { class: "hint bad" });
    const go = el("button", { class: "btn primary", type: "button" }, "⭳ " + t("key.download"));
    go.addEventListener("click", async () => {
      try {
        const seed = await C.openSeed(S.vault, pw.value), hex = C.bytesToHex(seed); seed.fill(0);
        download(recoveryName(S.vault.did), recoveryText(hex, S.vault.did));
        clear(out).append(el("div", { class: "callout good" }, t("key.downloaded")),
          el("details", {}, el("summary", { class: "hint" }, t("key.advanced")), el("p", { class: "hint" }, t("key.yourseed")),
            el("div", { class: "secret" }, hex), el("button", { class: "btn small", type: "button", onclick: () => copy(hex) }, t("key.copyseed"))));
        go.remove();
      } catch { err.textContent = t("key.wrongpw"); }
    });
    return [el("h2", {}, t("key.backuptitle")), el("p", { class: "muted" }, t("key.savedesc")), el("div", { class: "callout warn" }, t("key.seedwarn")),
      el("div", { class: "field" }, el("label", {}, t("key.pw")), pw), err, out,
      el("div", { class: "modal-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => close() }, t("ui.close")), go)];
  });
}

async function forgetKey() {
  const ok = await modal((close) => {
    const cb = el("input", { type: "checkbox" });
    const go = el("button", { class: "btn danger", type: "button", disabled: true, onclick: () => close(true) }, t("key.forget"));
    cb.addEventListener("change", () => { go.disabled = !cb.checked; });
    return [el("h2", {}, t("key.forgettitle")), el("p", { class: "muted" }, t("key.forgetdesc")),
      el("label", { class: "check" }, cb, el("span", {}, t("key.forgetack"))),
      el("div", { class: "modal-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => close(false) }, t("ui.cancel")), go)];
  });
  if (!ok) return;
  C.forgetVault(); S.vault = null; S.signer = null; toast(t("key.forgotten")); renderAll();
}

// ---- actions -----------------------------------------------------------------------------
function needKey() {
  if (S.signer) return true;
  toast(S.vault ? t("key.needunlock") : t("key.needkey"), true);
  location.hash = "#start";
  return false;
}

async function register(btn) {
  if (!needKey()) return;
  busy(btn, true, t("ui.signing"));
  try {
    const rec = await C.postSigned(S.signer, C.TRADING_ROOM, C.ownerMsg(S.signer.did));
    journalAdd({ kind: "owner", room: C.TRADING_ROOM, seq: rec.seq, sweep: C.nextSweep() });
    toast(t("reg.done"));
  } catch (e) { toast(t("ui.failed") + ": " + errText(e), true); }
  busy(btn, false); renderAll();
}

function refC() {
  const px = S.price && S.price.ref && S.price.ref.px;
  return px ? C.cents(String(px)) : S.hl ? C.cents(Number(S.hl.px).toFixed(2)) : null;
}
function limitsC() {
  const l = S.price && S.price.limits;
  return Array.isArray(l) && l.length === 2 ? [C.cents(String(l[0])), C.cents(String(l[1]))] : null;
}
function bandProblem(pxC) {
  const l = limitsC();
  if (!l || !l[0] || !l[1]) return null;
  if (pxC < l[0] || pxC > l[1]) return t("tr.outofband", { lo: C.fromCents(l[0]), hi: C.fromCents(l[1]) });
  return null;
}

/** Fee, collateral, break-even and P&L scenarios for my side of a trade. */
function economics(mySide, qC, pC) {
  const close = refC() || pC;
  const fees = C.sideFees(mySide, qC, pC, close);
  const fee = fees.maker; // maker == me here
  const q = Number(qC) / 100, p = Number(pC) / 100;
  const coll = q * p;
  const be = mySide === "buy" ? p + fee / q : p - fee / q;
  const scen = [-10, -5, 5, 10].map((d) => { const s = p * (1 + d / 100); return { d, s, pnl: (mySide === "buy" ? s - p : p - s) * q - fee }; });
  return { fee, coll, be, scen };
}
function econNodes(mySide, qC, pC) {
  const e = economics(mySide, qC, pC);
  return el("div", { class: "summary" },
    el("div", { class: "kv" }, el("span", {}, t("ec.side")), el("span", { class: mySide === "buy" ? "buy-t" : "sell-t" }, mySide === "buy" ? t("ec.long") : t("ec.short"))),
    el("div", { class: "kv" }, el("span", {}, t("ec.coll")), el("span", { class: "num" }, fmt(e.coll) + " POLF")),
    el("div", { class: "kv" }, el("span", {}, t("ec.fee")), el("span", { class: "num" }, "≈ " + fmt(e.fee) + " POLF")),
    el("div", { class: "kv" }, el("span", {}, t("ec.be")), el("span", { class: "num" }, "$" + fmt(e.be))),
    el("div", { class: "label" }, t("ec.scen")),
    el("div", { class: "pnl-grid" }, e.scen.map((x) => el("div", { class: x.pnl >= 0 ? "pos" : "neg" },
      el("div", { class: "num ltr" }, (x.d > 0 ? "+" : "") + x.d + "% · $" + fmt(x.s)), el("b", { class: "num ltr" }, (x.pnl >= 0 ? "+" : "") + fmt(x.pnl))))),
  );
}

async function publishOffer(btn) {
  if (!needKey()) return;
  const f = S.form, qC = C.cents(f.qty), pC = C.cents(f.px);
  const taker = f.taker.trim() || "any";
  let terms;
  try {
    if (!qC || !pC) throw new Error(t("tr.badnum"));
    if (taker !== "any" && !C.DID_RE.test(taker)) throw new Error(t("tr.badtaker"));
    terms = { id: C.newTradeId(), maker: S.signer.did, px: C.fromCents(pC), qty: C.fromCents(qC), side: f.side, taker, until: C.nextSweep() + Number(f.ttl) - 1 };
    const p = C.termsProblem(terms); if (p) throw new Error(p);
  } catch (e) { toast(e.message, true); return; }
  const band = bandProblem(pC);
  const ok = await modal((close) => [
    el("h2", {}, t("tr.confirmoffer")),
    econNodes(f.side, qC, pC),
    el("div", { class: "kvlist" },
      el("div", {}, el("span", {}, t("tr.validuntil")), el("span", {}, utc(C.sweepTime(terms.until)) + " · " + t("tr.sweep") + " " + terms.until)),
      el("div", {}, el("span", {}, t("tr.counterparty")), el("span", {}, taker === "any" ? t("tr.anyone") : didEl(taker)))),
    band && el("div", { class: "callout bad" }, band),
    el("div", { class: "callout info" }, t("tr.offernote")),
    el("div", { class: "modal-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => close(false) }, t("ui.cancel")),
      el("button", { class: "btn primary", type: "button", onclick: () => close(true) }, t("tr.signpublish"))),
  ]);
  if (!ok) return;
  busy(btn, true, t("ui.signing"));
  try {
    const sig = await S.signer.sign(C.makerPayload(terms));
    const rec = await C.postSigned(S.signer, C.DESK_ROOM, C.offerMsg(terms, sig));
    journalAdd({ kind: "offer", id: terms.id, room: C.DESK_ROOM, seq: rec.seq, terms, maker_sig: sig, role: "maker" });
    toast(t("tr.published"));
    loadDesk();
  } catch (e) { toast(t("ui.failed") + ": " + errText(e), true); }
  busy(btn, false); renderTrade();
}

async function acceptOffer(o) {
  if (!needKey()) return;
  const terms = o.terms, mySide = terms.side === "buy" ? "sell" : "buy";
  if (C.nextSweep() > terms.until) { toast(t("tr.expired"), true); return; }
  const qC = C.cents(terms.qty), pC = C.cents(terms.px);
  const band = bandProblem(pC);
  const ok = await modal((close) => [
    el("h2", {}, t("tr.confirmaccept")),
    el("p", { class: "muted" }, t("tr.acceptdesc", { qty: terms.qty, px: terms.px })),
    econNodes(mySide, qC, pC),
    el("div", { class: "kvlist" }, el("div", {}, el("span", {}, t("tr.maker")), didEl(terms.maker)),
      el("div", {}, el("span", {}, t("tr.settlesby")), el("span", {}, utc(C.sweepTime(terms.until))))),
    band && el("div", { class: "callout bad" }, band),
    el("div", { class: "callout warn" }, t("tr.acceptwarn")),
    el("div", { class: "modal-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => close(false) }, t("ui.cancel")),
      el("button", { class: "btn primary", type: "button", onclick: () => close(true) }, t("tr.signaccept"))),
  ]);
  if (!ok) return;
  try {
    const takerSig = await S.signer.sign(C.takerPayload(terms, S.signer.did));
    const msg = C.tradeMsg(terms, S.signer.did, o.maker_sig, takerSig);
    const problem = await C.checkTrade(JSON.parse(msg));
    if (problem) throw new Error(problem);
    const rec = await C.postSigned(S.signer, C.TRADING_ROOM, msg);
    journalAdd({ kind: "trade", id: terms.id, room: C.TRADING_ROOM, seq: rec.seq, terms, taker: S.signer.did, role: "taker", sweep: C.nextSweep() });
    C.postSigned(S.signer, C.DESK_ROOM, msg).catch(() => {}); // let the maker see the fill; best effort
    S.desk.filled.add(terms.id);
    toast(t("tr.accepted"));
  } catch (e) { toast(t("ui.failed") + ": " + errText(e), true); }
  renderTrade();
}

// ---- data loading ------------------------------------------------------------------------
let tickerFails = 0;
async function loadTicker() {
  const [p, h] = await Promise.allSettled([C.readRoom("d-close1-price", { limit: 3 }), C.hlLast()]);
  if (p.status === "fulfilled") {
    const posts = C.signedJson(p.value).filter((m) => m.json.t === "price");
    if (posts.length) { S.price = { ...posts[posts.length - 1].json, _from: posts[posts.length - 1].from, _ts: posts[posts.length - 1].ts }; }
    tickerFails = 0;
  } else tickerFails++;
  if (h.status === "fulfilled") S.hl = h.value;
  S.live = S.price ? C.sweepNow() - (S.price.n ?? -99) <= 2 : false;
  renderBanner(); renderTicker();
}

async function loadDesk() {
  try {
    const view = await C.readRoom(C.DESK_ROOM, { limit: 200 });
    const msgs = C.signedJson(view), offers = [], filled = new Set(S.desk.filled);
    for (const m of msgs) {
      const o = m.json;
      if (o.season !== C.SEASON) continue;
      if (o.t === "trade" && o.terms && typeof o.terms.id === "string") {
        if ((await C.checkTrade(o)) === null) {
          filled.add(o.terms.id);
          if (myDid() && o.terms.maker === myDid()) journalAdd({ kind: "trade", id: o.terms.id, room: C.DESK_ROOM, seq: m.seq, terms: o.terms, taker: o.taker, role: "maker" });
        }
      } else if (o.t === "offer") {
        if (m.from !== o.terms?.maker) continue; // posted by someone else than the maker: ignore
        if ((await C.checkOffer(o)) === null) offers.push({ ...o, seq: m.seq, ts: m.ts });
      }
    }
    S.desk = { offers, filled, at: Date.now(), error: null };
  } catch (e) {
    S.desk.error = e.status === 404 ? null : errText(e);
    if (e.status === 404) S.desk = { offers: [], filled: S.desk.filled, at: Date.now(), error: null };
  }
  renderTrade(); renderStart();
}

async function loadFlow(limit = 50) {
  try {
    const view = await C.readRoom("d-close1-flow", { limit });
    const referee = S.price && S.price._from;
    for (const m of C.signedJson(view)) {
      if (m.json.t !== "flow" || (referee && m.from !== referee)) continue;
      for (const e of m.json.settled || []) { const id = Array.isArray(e) ? e[0] : typeof e === "string" ? e : e && e.id; if (id) S.flowIndex.set(id, { outcome: "settled", n: m.json.n }); }
      for (const e of m.json.void || []) { if (Array.isArray(e) && typeof e[0] === "string") S.flowIndex.set(e[0], { outcome: "void", reason: String(e[1] ?? ""), n: m.json.n }); }
    }
  } catch { /* shown as pending */ }
}

async function loadMarket() {
  const read = (room, limit) => C.readRoom(room, { limit }).then(C.signedJson).catch(() => []);
  const [price, state, pos, pnl, flow, feed] = await Promise.all([
    read("d-close1-price", 200), read("d-close1-state", 200), read("d-close1-positions", 200), read("d-close1-pnl", 2), read("d-close1-flow", 12), read(C.TRADING_ROOM, 200),
  ]);
  const referee = S.price && S.price._from;
  const pick = (arr, kind) => arr.filter((m) => m.json.t === kind && (!referee || m.from === referee)).map((m) => ({ ...m.json, _ts: Date.parse(m.ts) }));
  const trades = [];
  for (const m of feed.slice(-120)) {
    const o = m.json;
    if (o.season !== C.SEASON || o.t !== "trade") continue;
    trades.push({ ts: Date.parse(m.ts), o, problem: await C.checkTrade(o) });
  }
  const counts = {};
  for (const m of feed) if (m.json.season === C.SEASON) counts[m.json.t] = (counts[m.json.t] || 0) + 1;
  S.market = { price: pick(price, "price"), state: pick(state, "state"), pos: pick(pos, "positions"), pnl: pick(pnl, "pnl"), flow: pick(flow, "flow"), trades, counts, scanned: feed.length, at: Date.now() };
  renderMarket();
  if (!S.trust) loadTrust();
}

async function loadTrust() {
  S.trust = { pending: true };
  const owners = await Promise.all(C.REFEREE_ROOMS.map((r) => C.roomOwner(r).catch(() => null)));
  const same = owners.every((o) => o && o === owners[0]);
  let seed = null;
  try {
    for (const rec of await C.exportRoom("d-close1-price")) {
      try { const j = JSON.parse(rec.text); if (rec.from === owners[0] && j.t === "seed") { seed = j; break; } } catch { /* skip */ }
    }
  } catch { /* leave null */ }
  S.trust = { owners, same, referee: owners[0], seed };
  renderMarket();
}

// ---- rendering: header -------------------------------------------------------------------
function renderBanner() {
  const b = clear($("banner"));
  if (!S.ed25519) b.append(el("div", { class: "callout bad" }, t("err.browser")));
  if (tickerFails >= 2) b.append(el("div", { class: "callout bad" }, t("err.tc")));
  else if (S.live === false && S.price) b.append(el("div", { class: "callout warn" }, t("err.stale")));
  if (C.nextSweep() > C.LOCK_SWEEP) b.append(el("div", { class: "callout info" }, t("err.locked")));
}
function renderTicker() {
  const tk = clear($("ticker"));
  const ref = S.price && S.price.ref;
  const now = Date.now(), next = C.sweepTime(C.nextSweep(now));
  tk.append(
    el("span", {}, el("span", { class: "dot " + (S.live ? "good" : S.live === false ? "bad" : "") }), " ", S.live ? t("tk.live") : S.live === false ? t("tk.late") : t("tk.checking")),
    el("span", {}, "NVDA ", el("b", { class: "num" }, S.hl ? "$" + fmt(S.hl.px) : "–")),
    el("span", {}, t("tk.ref") + " ", el("b", { class: "num" }, ref ? fmt(ref.px) : "–"), S.price && S.price.limits ? el("span", { class: "num ltr" }, ` [${S.price.limits[0]} – ${S.price.limits[1]}]`) : ""),
    el("span", {}, t("tk.next") + " ", el("b", { class: "num", id: "tk-next" }, dur(next - now))),
    el("span", {}, t("tk.lock") + " ", el("b", { class: "num", id: "tk-lock" }, dur(C.sweepTime(C.LOCK_SWEEP) - now))),
  );
}
function renderWallet() {
  const w = clear($("wallet-chip"));
  if (S.signer) w.append(el("span", { class: "dot good" }), didEl(S.signer.did));
  else if (S.vault) w.append(el("span", { class: "dot warn" }), t("wl.locked"));
  else w.append(el("span", { class: "dot" }), t("wl.none"));
}

// ---- rendering: start --------------------------------------------------------------------
function statusNode(ok, text) { return el("span", { class: "status" + (ok ? " ok" : "") }, ok ? "✓ " + text : text); }

function renderStart() {
  $("start-lock").textContent = dur(C.sweepTime(C.LOCK_SWEEP) - Date.now());
  // step 1
  const s1 = clear($("s1-body")), s1s = clear($("s1-status"));
  $("step-key").classList.toggle("done", !!S.signer);
  if (S.signer) {
    s1s.append(statusNode(true, t("s1.ready")));
    s1.append(el("div", { class: "kvlist" }, el("div", {}, el("span", {}, t("key.yourdid")), didEl(S.signer.did))),
      el("div", { class: "row" }, el("button", { class: "btn small", type: "button", onclick: revealBackup }, t("key.backup")),
        el("button", { class: "btn small ghost", type: "button", onclick: lock }, t("key.lock"))));
  } else if (S.vault) {
    s1s.append(statusNode(false, t("wl.locked")));
    const pw = el("input", { class: "input", type: "password", autocomplete: "current-password", placeholder: t("key.pw") });
    const err = el("p", { class: "hint bad" });
    const go = el("button", { class: "btn primary", type: "button" }, t("key.unlock"));
    go.addEventListener("click", () => unlock(pw.value, go, err));
    pw.addEventListener("keydown", (e) => { if (e.key === "Enter") unlock(pw.value, go, err); });
    s1.append(el("p", { class: "muted" }, t("key.lockeddesc"), " ", didEl(S.vault.did)), el("div", { class: "row" }, el("div", { class: "field" }, pw), go), err,
      el("div", { class: "row alt" }, el("button", { class: "btn small ghost", type: "button", onclick: restoreFlow }, t("key.have")),
        el("button", { class: "btn small ghost", type: "button", onclick: forgetKey }, t("key.other"))));
  } else {
    s1s.append(statusNode(false, t("s1.todo")));
    s1.append(
      el("button", { class: "btn primary big", type: "button", onclick: createKeyFlow, disabled: !S.ed25519 }, t("key.create")),
      el("p", { class: "hint cta-hint" }, t("key.createdesc")),
      el("div", { class: "row alt" }, el("button", { class: "btn ghost small", type: "button", onclick: restoreFlow, disabled: !S.ed25519 }, t("key.have")), el("span", { class: "hint" }, t("key.havedesc"))),
      el("details", { class: "cli-note" }, el("summary", { class: "hint" }, t("key.clisum")), el("p", { class: "hint" }, t("key.clinote"))));
  }
  // step 2
  const s2 = clear($("s2-body")), s2s = clear($("s2-status"));
  const reg = registered();
  $("step-register").classList.toggle("done", reg && !!S.signer);
  $("step-register").classList.toggle("locked", !S.signer);
  if (!S.signer) { s2s.append(statusNode(false, t("s2.needkey"))); }
  else if (reg) {
    const e = journal().find((x) => x.kind === "owner");
    s2s.append(statusNode(true, t("s2.done")));
    s2.append(el("p", { class: "muted" }, e && e.seq ? t("s2.posted", { seq: e.seq, sweep: e.sweep ?? "–" }) : t("s2.marked")),
      el("div", { class: "callout info" }, t("s2.mintnote")));
  } else {
    s2s.append(statusNode(false, t("s2.todo")));
    const go = el("button", { class: "btn primary", type: "button" }, t("s2.go"));
    go.addEventListener("click", () => register(go));
    s2.append(el("div", { class: "row" }, go,
      el("button", { class: "btn ghost", type: "button", onclick: () => { journalAdd({ kind: "owner", room: "elsewhere" }); renderAll(); } }, t("s2.already"))),
      el("p", { class: "hint" }, t("s2.hint")));
  }
  // step 3
  const traded = journal().some((x) => x.kind === "offer" || x.kind === "trade");
  $("step-trade").classList.toggle("done", traded && !!S.signer);
  $("step-trade").classList.toggle("locked", !reg || !S.signer);
  clear($("s3-status")).append(statusNode(traded, traded ? t("s3.done") : t("s3.todo")));
}

// ---- rendering: trade --------------------------------------------------------------------
function renderOfferForm() {
  const box = clear($("offer-form"));
  const f = S.form, r = refC();
  if (!f.px && r) f.px = C.fromCents(r);
  const cash = estimateLedger().freeC;
  const pC = C.cents(f.px) || r || 0n;
  const maxQ = pC ? C.maxQtyC(cash, pC) : 0n;

  const sideBtn = (side, title, desc) => el("button", { type: "button", class: (f.side === side ? "on " : "") + side, onclick: () => { f.side = side; renderOfferForm(); } }, el("b", {}, title), el("span", {}, desc));
  const px = el("input", { class: "input num", inputmode: "decimal", value: f.px });
  const qty = el("input", { class: "input num", inputmode: "decimal", value: f.qty });
  const slider = el("input", { type: "range", min: "10", max: String(Math.max(10, Number(maxQ))), step: "1", value: String(C.cents(f.qty) || 100n) });
  const ttl = el("select", { class: "select" }, [[3, "15" + t("u.m")], [6, "30" + t("u.m")], [12, "1" + t("u.h")], [24, "2" + t("u.h")], [72, "6" + t("u.h")]].map(([v, l]) => el("option", { value: String(v), selected: Number(f.ttl) === v }, l)));
  const taker = el("input", { class: "input mono", placeholder: "did:key:z6Mk… (" + t("tr.optional") + ")", value: f.taker, spellcheck: "false" });
  const summary = el("div"), warn = el("div");
  const go = el("button", { class: "btn primary wide", type: "button" }, t("tr.signpublish"));
  const update = () => {
    const qC = C.cents(qty.value), pc = C.cents(px.value);
    f.qty = qty.value; f.px = px.value; f.ttl = ttl.value; f.taker = taker.value;
    clear(summary); clear(warn);
    if (!qC || !pc || qC < 10n) { warn.append(el("div", { class: "hint bad" }, t("tr.badnum"))); go.disabled = true; return; }
    go.disabled = !S.signer;
    summary.append(econNodes(f.side, qC, pc));
    const b = bandProblem(pc); if (b) warn.append(el("div", { class: "callout bad" }, b));
    const need = qC * pc * 101n / 10_000n;
    if (need > cash) warn.append(el("div", { class: "callout warn" }, t("tr.funds", { free: C.fromCents(cash) })));
  };
  px.addEventListener("input", update);
  qty.addEventListener("input", () => { const c = C.cents(qty.value); if (c) slider.value = String(c); update(); });
  slider.addEventListener("input", () => { qty.value = C.fromCents(BigInt(slider.value)); update(); });
  ttl.addEventListener("change", update); taker.addEventListener("input", update);
  go.addEventListener("click", () => publishOffer(go));

  box.append(
    el("div", { class: "seg" }, sideBtn("buy", t("tr.buy"), t("tr.buydesc")), sideBtn("sell", t("tr.sell"), t("tr.selldesc"))),
    el("div", { class: "row" },
      el("div", { class: "field" }, el("label", {}, t("tr.price")), px,
        el("span", { class: "hint" }, r ? t("tr.pricehint", { ref: C.fromCents(r) }) : "", " ", r ? el("a", { href: "#trade", onclick: (e) => { e.preventDefault(); f.px = C.fromCents(r); renderOfferForm(); } }, t("tr.usecurrent")) : "")),
      el("div", { class: "field" }, el("label", {}, t("tr.qty")), qty, el("span", { class: "hint" }, t("tr.qtyhint", { max: C.fromCents(maxQ) })))),
    slider,
    el("div", { class: "row" }, el("div", { class: "field" }, el("label", {}, t("tr.valid")), ttl)),
    el("details", {}, el("summary", { class: "hint" }, t("tr.advanced")), el("div", { class: "field" }, el("label", {}, t("tr.onlyfor")), taker)),
    summary, warn, go,
    ...(S.signer ? [] : [el("p", { class: "hint" }, t("key.needkey"))]),
  );
  update();
}

function renderBoard() {
  const box = clear($("board"));
  if (S.desk.error) box.append(el("div", { class: "callout bad" }, S.desk.error));
  const n = C.nextSweep(), me = myDid();
  const open = S.desk.offers.filter((o) => o.terms.until >= n && !S.desk.filled.has(o.terms.id) && o.terms.maker !== me && (o.terms.taker === "any" || o.terms.taker === me));
  const byId = new Map(); for (const o of open) byId.set(o.terms.id, o);
  const rows = [...byId.values()].sort((a, b) => b.seq - a.seq);
  if (!rows.length) { box.append(el("div", { class: "empty" }, S.desk.at ? t("tr.noffers") : t("ui.loading"))); }
  else box.append(el("div", { class: "scroll" }, el("table", {},
    el("thead", {}, el("tr", {}, [t("tr.maker"), t("tr.youwould"), t("tr.qty"), t("tr.price"), t("tr.expires"), ""].map((h, i) => el("th", { class: i === 2 || i === 3 ? "r" : null }, h)))),
    el("tbody", {}, rows.map((o) => {
      const mine = o.terms.side === "buy" ? "sell" : "buy";
      return el("tr", {}, el("td", {}, didEl(o.terms.maker)), el("td", {}, el("span", { class: mine + "-t" }, mine === "buy" ? t("tr.buy") : t("tr.sell"))),
        el("td", { class: "r num" }, o.terms.qty), el("td", { class: "r num" }, o.terms.px),
        el("td", { class: "num" }, dur(C.sweepTime(o.terms.until) - Date.now())),
        el("td", {}, el("button", { class: "btn small primary", type: "button", onclick: () => acceptOffer(o), disabled: !S.signer }, t("tr.accept"))));
    })))));
  const mineBox = clear($("my-offers"));
  const mineRows = journal().filter((e) => e.kind === "offer" && e.terms).reverse().slice(0, 20);
  if (!mineRows.length) { mineBox.append(el("div", { class: "empty" }, t("tr.nomine"))); return; }
  mineBox.append(el("div", { class: "scroll" }, el("table", {},
    el("thead", {}, el("tr", {}, [t("tr.side"), t("tr.qty"), t("tr.price"), t("tr.status")].map((h, i) => el("th", { class: i === 1 || i === 2 ? "r" : null }, h)))),
    el("tbody", {}, mineRows.map((e) => {
      const filled = S.desk.filled.has(e.id) || journal().some((x) => x.kind === "trade" && x.id === e.id);
      const expired = C.nextSweep() > e.terms.until;
      const st = filled ? el("span", { class: "badge ok" }, t("st.filled")) : expired ? el("span", { class: "badge neutral" }, t("st.expired")) : el("span", { class: "badge warn" }, t("st.open") + " · " + dur(C.sweepTime(e.terms.until) - Date.now()));
      return el("tr", {}, el("td", {}, el("span", { class: e.terms.side + "-t" }, e.terms.side === "buy" ? t("tr.buy") : t("tr.sell"))), el("td", { class: "r num" }, e.terms.qty), el("td", { class: "r num" }, e.terms.px), el("td", {}, st));
    })))));
}
function renderTrade() { if (S.view !== "trade") return; renderOfferForm(); renderBoard(); }

// ---- rendering: account ------------------------------------------------------------------
/** Replays my known trades with the fold's lot rules: an estimate, never the referee's word. */
function estimateLedger() {
  let cash = C.MINT_CENTS * 100n; // 1e-4 POLF units
  const lots = []; // [qtyC signed, pxC]
  let fees = 0n, count = 0;
  const trades = journal().filter((e) => e.kind === "trade" && e.terms);
  const seen = new Set();
  for (const e of trades) {
    if (seen.has(e.id)) continue; seen.add(e.id);
    const f = S.flowIndex.get(e.id);
    if (f && f.outcome === "void") continue;
    const mySide = e.role === "maker" ? e.terms.side : e.terms.side === "buy" ? "sell" : "buy";
    const side = mySide === "buy" ? 1n : -1n, qC = C.cents(e.terms.qty), pC = C.cents(e.terms.px);
    if (!qC || !pC) continue;
    const fee = qC * pC / 100n; fees += fee; cash -= fee; count++;
    let left = qC;
    while (left > 0n && lots.length && lots[0][0] * side < 0n) {
      const [lq, lp] = lots[0], size = left < (lq < 0n ? -lq : lq) ? left : (lq < 0n ? -lq : lq);
      cash += side < 0n ? size * pC : size * (2n * lp - pC);
      left -= size;
      if (size === (lq < 0n ? -lq : lq)) lots.shift(); else lots[0][0] = lq + side * size;
    }
    if (left > 0n) { cash -= left * pC; lots.push([side * left, pC]); }
  }
  const pos = lots.reduce((a, [q]) => a + q, 0n);
  const r = refC();
  const value = r ? cash + lots.reduce((a, [q, p]) => a + (q > 0n ? q * r : -q * (2n * p - r)), 0n) : null;
  const freeC = cash / 100n > 0n ? cash / 100n : 0n;
  const avg = lots.length ? lots.reduce((a, [q, p]) => a + (q < 0n ? -q : q) * p, 0n) / (pos < 0n ? -pos : pos || 1n) : null;
  return { freeC, pos, avg, fees, count, pnl: value != null ? value - C.MINT_CENTS * 100n : null };
}

function tradeStatus(e) {
  const f = S.flowIndex.get(e.id);
  if (f && f.outcome === "settled") return el("span", { class: "badge ok" }, t("st.settled") + " · #" + f.n);
  if (f && f.outcome === "void") return el("span", { class: "badge bad", title: f.reason }, t("st.void") + ": " + rsn(f.reason));
  if (e.terms && C.sweepNow() > e.terms.until) return el("span", { class: "badge neutral", title: t("st.unlistedtip") }, t("st.unlisted"));
  return el("span", { class: "badge warn" }, t("st.pending"));
}

function renderAccount() {
  if (S.view !== "account") return;
  const k = clear($("acct-key")), s = clear($("acct-summary"));
  k.append(el("h2", {}, t("ac.key")));
  if (!S.vault) { k.append(el("p", { class: "muted" }, t("key.needkey")), el("a", { class: "btn primary", href: "#start" }, t("nav.start"))); }
  else {
    k.append(el("div", { class: "kvlist" }, el("div", {}, el("span", {}, "DID"), el("span", { class: "mono" }, S.vault.did)),
      el("div", {}, el("span", {}, t("ac.state")), el("span", {}, S.signer ? t("s1.ready") : t("wl.locked")))),
      el("div", { class: "row" }, el("button", { class: "btn small", type: "button", onclick: () => copy(S.vault.did) }, t("ac.copydid")),
        el("button", { class: "btn small", type: "button", onclick: revealBackup }, t("key.backup")),
        S.signer ? el("button", { class: "btn small ghost", type: "button", onclick: lock }, t("key.lock")) : el("a", { class: "btn small primary", href: "#start" }, t("key.unlock")),
        el("button", { class: "btn small danger ghost", type: "button", onclick: forgetKey }, t("key.forget"))));
  }
  const L = estimateLedger();
  const pos = Number(L.pos) / 100;
  s.append(el("h2", {}, t("ac.summary")), el("p", { class: "muted" }, t("ac.estimate")),
    el("div", { class: "kvlist" },
      el("div", {}, el("span", {}, t("ac.registered")), el("span", {}, registered() ? "✓" : "—")),
      el("div", {}, el("span", {}, t("ac.position")), el("span", { class: "num " + (pos > 0 ? "buy-t" : pos < 0 ? "sell-t" : "") }, fmt(pos) + (pos ? " (" + (pos > 0 ? t("ec.long") : t("ec.short")) + ")" : ""))),
      el("div", {}, el("span", {}, t("ac.avg")), el("span", { class: "num" }, L.avg != null ? "$" + C.fromCents(L.avg) : "–")),
      el("div", {}, el("span", {}, t("ac.pnl")), el("span", { class: "num " + (L.pnl > 0n ? "buy-t" : L.pnl < 0n ? "sell-t" : "") }, L.pnl != null ? fmt(Number(L.pnl) / 1e4) + " POLF" : "–")),
      el("div", {}, el("span", {}, t("ac.fees")), el("span", { class: "num" }, fmt(Number(L.fees) / 1e4) + " POLF")),
      el("div", {}, el("span", {}, t("ac.free")), el("span", { class: "num" }, C.fromCents(L.freeC) + " POLF"))));

  const rows = journal().slice().reverse();
  const tb = clear($("t-activity"));
  tb.append(el("thead", {}, el("tr", {}, [t("ac.time"), t("ac.what"), t("tr.side"), t("tr.qty"), t("tr.price"), t("tr.status")].map((h, i) => el("th", { class: i === 3 || i === 4 ? "r" : null }, h)))));
  const body = el("tbody");
  if (!rows.length) body.append(el("tr", {}, el("td", { colspan: "6", class: "empty" }, t("ac.none"))));
  for (const e of rows) {
    const mySide = e.terms ? (e.role === "maker" ? e.terms.side : e.terms.side === "buy" ? "sell" : "buy") : null;
    const what = e.kind === "owner" ? t("ac.k.owner") : e.kind === "offer" ? t("ac.k.offer") : e.role === "maker" ? t("ac.k.filled") : t("ac.k.accepted");
    const status = e.kind === "trade" ? tradeStatus(e) : e.kind === "offer" ? (S.desk.filled.has(e.id) ? el("span", { class: "badge ok" }, t("st.filled")) : C.nextSweep() > e.terms.until ? el("span", { class: "badge neutral" }, t("st.expired")) : el("span", { class: "badge warn" }, t("st.open"))) : el("span", { class: "badge ok" }, t("st.posted"));
    body.append(el("tr", {}, el("td", { class: "num" }, utcFull(e.ts)), el("td", {}, what),
      el("td", {}, mySide ? el("span", { class: mySide + "-t" }, mySide === "buy" ? t("tr.buy") : t("tr.sell")) : "–"),
      el("td", { class: "r num" }, e.terms ? e.terms.qty : "–"), el("td", { class: "r num" }, e.terms ? e.terms.px : "–"), el("td", {}, status)));
  }
  tb.append(body);
}

// ---- rendering: market -------------------------------------------------------------------
function niceTicks(lo, hi, count = 4) {
  if (!(hi > lo)) hi = lo + 1;
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}
function lineChart(host, { rows, series, band, height = 260, yfmt = (v) => fmt(v), label = true }) {
  clear(host);
  const pts = rows.filter((r) => series.some((s) => r[s.key] != null));
  if (pts.length < 2) { host.append(el("div", { class: "empty" }, t("ui.nodata"))); return; }
  const W = Math.max(280, host.clientWidth || 600), H = height;
  const m = { l: W < 480 ? 46 : 56, r: label ? (W < 480 ? 76 : 118) : 14, t: 10, b: 26 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  let lo = Infinity, hi = -Infinity;
  for (const r of pts) {
    for (const s of series) if (r[s.key] != null) { lo = Math.min(lo, r[s.key]); hi = Math.max(hi, r[s.key]); }
    if (band && r[band.lo] != null) { lo = Math.min(lo, r[band.lo]); hi = Math.max(hi, r[band.hi]); }
  }
  const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.01 || 1; lo -= pad; hi += pad;
  const x = (i) => m.l + (i / (pts.length - 1)) * iw, y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * ih;
  const cs = getComputedStyle(document.documentElement), col = (v) => cs.getPropertyValue(v).trim();
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img" });
  for (const tk of niceTicks(lo, hi)) {
    if (tk < lo || tk > hi) continue;
    svg.append(svgEl("line", { x1: m.l, x2: m.l + iw, y1: y(tk), y2: y(tk), stroke: col("--grid") }));
    const tx = svgEl("text", { x: m.l - 8, y: y(tk) + 4, "text-anchor": "end" }); tx.textContent = yfmt(tk); svg.append(tx);
  }
  const nx = Math.min(6, pts.length, Math.max(2, Math.floor(iw / 72)));
  for (let k = 0; k < nx; k++) {
    const i = Math.round((k * (pts.length - 1)) / Math.max(1, nx - 1));
    const tx = svgEl("text", { x: x(i), y: H - 6, "text-anchor": k === 0 ? "start" : k === nx - 1 ? "end" : "middle" });
    tx.textContent = utc(pts[i]._ts).replace(" UTC", ""); svg.append(tx);
  }
  if (band) {
    const top = [], bot = [];
    pts.forEach((r, i) => { if (r[band.lo] != null && r[band.hi] != null) { top.push(`${x(i)},${y(r[band.hi])}`); bot.unshift(`${x(i)},${y(r[band.lo])}`); } });
    if (top.length > 1) svg.append(svgEl("polygon", { points: top.concat(bot).join(" "), fill: col("--band") }));
  }
  const ends = [];
  for (const s of series) {
    let d = "", pen = false;
    pts.forEach((r, i) => { const v = r[s.key]; if (v == null) { pen = false; return; } d += (pen ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1); pen = true; });
    svg.append(svgEl("path", { d, fill: "none", stroke: col(s.color), "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    let li = -1; pts.forEach((r, i) => { if (r[s.key] != null) li = i; });
    if (li >= 0) ends.push({ s, v: pts[li][s.key], yy: y(pts[li][s.key]), xx: x(li) });
  }
  if (label) {
    ends.sort((a, b) => a.yy - b.yy);
    for (let k = 1; k < ends.length; k++) if (ends[k].yy - ends[k - 1].yy < 26) ends[k].yy = ends[k - 1].yy + 26;
    for (const e of ends) {
      svg.append(svgEl("circle", { cx: e.xx, cy: y(e.v), r: 4, fill: col(e.s.color), stroke: col("--surface"), "stroke-width": 2 }));
      const a = svgEl("text", { x: e.xx + 10, y: e.yy - 1, class: "lab-v" }); a.textContent = yfmt(e.v);
      const b = svgEl("text", { x: e.xx + 10, y: e.yy + 12 }); b.textContent = e.s.name;
      svg.append(a, b);
    }
  }
  const cross = svgEl("line", { y1: m.t, y2: m.t + ih, stroke: col("--muted"), "stroke-dasharray": "3 3", visibility: "hidden" });
  const dots = series.map((s) => svgEl("circle", { r: 4.5, fill: col(s.color), stroke: col("--surface"), "stroke-width": 2, visibility: "hidden" }));
  const hit = svgEl("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" });
  svg.append(cross, ...dots, hit);
  const tip = el("div", { class: "tip" });
  host.append(svg, tip);
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); tip.classList.remove("show"); });
  hit.addEventListener("pointermove", (ev) => {
    const rect = svg.getBoundingClientRect(), sx = ((ev.clientX - rect.left) * W) / rect.width;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((sx - m.l) / iw) * (pts.length - 1)))), r = pts[i];
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
    series.forEach((s, k) => { if (r[s.key] == null) return dots[k].setAttribute("visibility", "hidden"); dots[k].setAttribute("cx", x(i)); dots[k].setAttribute("cy", y(r[s.key])); dots[k].setAttribute("visibility", "visible"); });
    clear(tip).append(el("div", {}, el("b", {}, `${t("tr.sweep")} ${r.n ?? "–"}`), el("span", { class: "k" }, "  " + utcFull(r._ts))));
    for (const s of series) tip.append(el("div", { class: "num" }, el("span", { class: "k" }, s.name + ": "), yfmt(r[s.key])));
    if (band && r[band.lo] != null) tip.append(el("div", { class: "num" }, el("span", { class: "k" }, t("mk.band") + ": "), `${yfmt(r[band.lo])} – ${yfmt(r[band.hi])}`));
    tip.classList.add("show");
    const px = (x(i) * rect.width) / W, tw = tip.offsetWidth;
    tip.style.left = Math.max(0, Math.min(rect.width - tw, px + 12 > rect.width - tw ? px - tw - 12 : px + 12)) + "px";
  });
}

function table(id, head, rows, empty) {
  const tb = clear($(id));
  tb.append(el("thead", {}, el("tr", {}, head.map((h) => el("th", { class: h.r ? "r" : null }, h.t)))));
  const body = el("tbody");
  if (!rows.length) body.append(el("tr", {}, el("td", { colspan: String(head.length), class: "empty" }, empty || t("ui.nodata"))));
  for (const r of rows) body.append(el("tr", {}, r.map((c, i) => el("td", { class: head[i].r ? "r num" : null }, c))));
  tb.append(body);
}
const tile = (label, value, foot) => el("div", { class: "card tile" }, el("div", { class: "label" }, label), el("div", { class: "value num" }, value), el("div", { class: "foot num" }, foot || ""));
const num = (x) => { const v = parseFloat(x); return Number.isFinite(v) ? v : null; };

function renderCharts() {
  const M = S.market; if (!M) return;
  const pr = M.price.map((p) => ({ n: p.n, _ts: p._ts, ref: num(p.ref && p.ref.px), lo: num(p.limits && p.limits[0]), hi: num(p.limits && p.limits[1]), global: num(p.global) }));
  lineChart($("ch-price"), { rows: pr, series: [{ key: "ref", name: t("mk.ref"), color: "--series-1" }, { key: "global", name: t("mk.global"), color: "--series-2" }], band: { lo: "lo", hi: "hi" }, height: 280 });
  lineChart($("ch-owners"), { rows: M.state.map((s) => ({ n: s.n, _ts: s._ts, v: num(s.owners) })), series: [{ key: "v", name: t("mk.owners"), color: "--series-1" }], height: 190, yfmt: compact, label: false });
  lineChart($("ch-oi"), { rows: M.pos.map((s) => ({ n: s.n, _ts: s._ts, v: num(s.open) })), series: [{ key: "v", name: t("mk.oi"), color: "--series-1" }], height: 190, yfmt: compact, label: false });
}

function renderMarket() {
  if (S.view !== "market") return;
  const M = S.market;
  const tiles = clear($("tiles"));
  if (!M) { tiles.append(el("div", { class: "empty" }, t("ui.loading"))); return; }
  const p = M.price[M.price.length - 1] || {}, st = M.state[M.state.length - 1] || {}, pos = M.pos[M.pos.length - 1] || {}, pnl = M.pnl[M.pnl.length - 1] || {};
  tiles.append(
    tile(t("mk.hl"), S.hl ? "$" + fmt(S.hl.px) : "–", S.hl ? utc(S.hl.time) : ""),
    tile(t("mk.ref"), p.ref ? fmt(p.ref.px) : "–", p.limits ? `${p.limits[0]} – ${p.limits[1]}` : ""),
    tile(t("mk.mark"), pnl.mark ? fmt(pnl.mark) : "–", p.global ? t("mk.global") + " " + p.global : ""),
    tile(t("mk.owners"), fmtInt(st.owners), st.rooms != null ? t("mk.rooms", { n: st.rooms }) : ""),
    tile(t("mk.oi"), pos.open ? compact(pos.open) + " POLF" : "–", pos.longs != null ? t("mk.ls", { l: fmtInt(pos.longs), s: fmtInt(pos.shorts) }) : ""),
  );
  renderCharts();
  const top = Array.isArray(pnl.top) ? pnl.top : [];
  let rank = 0, prev = null;
  $("lb-desc").textContent = pnl.n != null ? t("mk.lbdesc", { n: pnl.n, mark: pnl.mark }) : "";
  const me = S.signer ? S.signer.did : S.vault ? S.vault.did : null;
  table("t-lb", [{ t: "#" }, { t: t("mk.key") }, { t: "PnL (POLF)", r: 1 }],
    top.map((e, i) => { const v = Array.isArray(e) ? e[1] : null; if (v !== prev) { rank = i + 1; prev = v; } return [String(rank), el("span", {}, didEl(Array.isArray(e) ? e[0] : null), me && e[0] === me ? el("span", { class: "badge ok" }, t("mk.you")) : ""), v != null ? fmt(v) : "–"]; }));
  const ptop = Array.isArray(pos.top) ? pos.top : [];
  table("t-pos", [{ t: t("mk.key") }, { t: t("mk.contracts"), r: 1 }, { t: t("tr.side") }],
    ptop.map((e) => { const q = Array.isArray(e) ? num(e[1]) : null; return [didEl(Array.isArray(e) ? e[0] : null), fmt(q), el("span", { class: q < 0 ? "sell-t" : "buy-t" }, q < 0 ? t("ec.short") : t("ec.long"))]; }));
  table("t-flow", [{ t: t("tr.sweep") }, { t: t("ac.time") }, { t: t("mk.settled"), r: 1 }, { t: t("mk.void"), r: 1 }, { t: t("mk.reasons") }, { t: t("mk.notlisted") }],
    M.flow.slice().reverse().map((f) => {
      const reasons = {}; for (const e of f.void || []) { const r = Array.isArray(e) ? String(e[1]) : "?"; reasons[r] = (reasons[r] || 0) + 1; }
      return [String(f.n), utc(f._ts), fmtInt((f.settled || []).length), fmtInt((f.void || []).length),
        Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => el("span", { class: "pill" }, `${rsn(k)} ${v}`)),
        Object.entries(f.omitted || {}).map(([k, v]) => el("span", { class: "pill" }, `${k} ${fmtInt(v)}`))];
    }));
  const c = M.counts;
  $("feed-desc").textContent = t("mk.feeddesc", { n: fmtInt(M.scanned), o: fmtInt(c.owner || 0), tr: fmtInt(c.trade || 0) });
  table("t-feed", [{ t: t("ac.time") }, { t: "Id" }, { t: t("tr.maker") }, { t: t("tr.side") }, { t: t("tr.qty"), r: 1 }, { t: t("tr.price"), r: 1 }, { t: t("mk.taker") }, { t: t("mk.sigs") }],
    M.trades.slice().reverse().map(({ ts, o, problem }) => [utc(ts), el("span", { class: "mono" }, String(o.terms && o.terms.id || "–").slice(0, 24)), didEl(o.terms && o.terms.maker),
      el("span", { class: (o.terms && o.terms.side) === "buy" ? "buy-t" : "sell-t" }, !o.terms ? "–" : o.terms.side === "buy" ? t("tr.buy") : t("tr.sell")), o.terms ? o.terms.qty : "–", o.terms ? o.terms.px : "–", didEl(o.taker),
      problem ? el("span", { class: "badge bad", title: problem }, "✗ " + String(problem).slice(0, 32)) : el("span", { class: "badge ok" }, "✓ " + t("mk.valid"))]));
  const tr = clear($("trust"));
  if (!S.trust || S.trust.pending) { tr.append(el("li", { class: "muted" }, t("ui.loading"))); return; }
  const mark = (ok, ...text) => el("li", {}, el("span", { class: "badge " + (ok ? "ok" : "bad") }, ok ? "✓" : "✗"), " ", ...text);
  const seed = S.trust.seed || {};
  tr.append(mark(S.trust.same, t("mk.t1"), " ", didEl(S.trust.referee)),
    mark(seed.package === C.PACKAGE_SHA256, seed.package ? t("mk.t2", { h: seed.package.slice(0, 12) }) : t("mk.t2no")),
    mark(!!seed.price, seed.price ? t("mk.t3", { p: seed.price }) : t("mk.t3no")),
    el("li", { class: "muted" }, t("mk.t4")));
}

// ---- rendering: learn --------------------------------------------------------------------
function renderLearn() {
  const box = clear($("learn"));
  const sec = (h, ...ps) => [el("h2", {}, t(h)), ...ps.map((p) => el("p", {}, t(p)))];
  box.append(
    ...sec("ln.h1", "ln.p1a", "ln.p1b"),
    ...sec("ln.h2", "ln.p2a", "ln.p2b", "ln.p2c"),
    ...sec("ln.h3", "ln.p3a", "ln.p3b"),
    el("h2", {}, t("ln.faq")),
    ...["q8", "q1", "q2", "q3", "q4", "q5", "q6", "q7"].map((q) => el("details", {}, el("summary", {}, t("ln." + q)), el("p", {}, t("ln." + q + "a")))),
    el("h2", {}, t("ln.h4")), el("p", {}, t("ln.p4")),
    el("p", {}, el("a", { href: "https://github.com/sprmn24/technocore-closecall-agent" }, "github.com/sprmn24/technocore-closecall-agent")),
  );
}

// ---- routing + loop ----------------------------------------------------------------------
function renderAll() {
  renderWallet(); renderBanner(); renderTicker(); renderStart();
  if (S.view === "trade") renderTrade();
  if (S.view === "account") renderAccount();
  if (S.view === "market") renderMarket();
  if (S.view === "learn") renderLearn();
}
function route() {
  const v = (location.hash || "#start").slice(1);
  S.view = ["start", "trade", "account", "market", "learn"].includes(v) ? v : "start";
  document.querySelectorAll(".view").forEach((n) => { n.hidden = n.id !== "view-" + S.view; });
  document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.view === S.view));
  renderAll();
  if (S.view === "trade") loadDesk();
  if (S.view === "market") loadMarket();
  if (S.view === "account") Promise.all([loadFlow(), loadDesk()]).then(renderAccount);
  window.scrollTo(0, 0);
}

function setLang(l) {
  S.lang = STRINGS[l] ? l : "en";
  try { localStorage.setItem("cc-lang", S.lang); } catch { /* ignore */ }
  $("lang").value = S.lang;
  applyStatic(); renderAll();
}

async function boot() {
  let saved = null;
  try { saved = localStorage.getItem("cc-lang"); } catch { /* ignore */ }
  const prefs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"]).map((l) => String(l).slice(0, 2).toLowerCase());
  setLang(saved || prefs.find((l) => STRINGS[l]) || "en");
  $("lang").addEventListener("change", (e) => setLang(e.target.value));
  let theme = null; try { theme = localStorage.getItem("cc-theme"); } catch { /* ignore */ }
  if (theme) document.documentElement.dataset.theme = theme;
  $("theme").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("cc-theme", document.documentElement.dataset.theme); } catch { /* ignore */ }
    if (S.view === "market") renderCharts();
  });
  $("desk-refresh").addEventListener("click", loadDesk);
  S.ed25519 = await C.ed25519Supported();
  addEventListener("hashchange", route);
  let rz; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => S.view === "market" && renderCharts(), 150); });
  route();
  await loadTicker();
  if (S.view === "trade") renderTrade();
  setInterval(() => {
    const now = Date.now();
    const a = document.getElementById("tk-next"), b = document.getElementById("tk-lock");
    if (a) a.textContent = dur(C.sweepTime(C.nextSweep(now)) - now);
    if (b) b.textContent = dur(C.sweepTime(C.LOCK_SWEEP) - now);
    const sl = $("start-lock"); if (sl) sl.textContent = dur(C.sweepTime(C.LOCK_SWEEP) - now);
  }, 1000);
  setInterval(() => { if (!document.hidden) loadTicker(); }, 30_000);
  setInterval(() => { if (!document.hidden && S.view === "trade") loadDesk(); }, 20_000);
  setInterval(() => { if (!document.hidden && S.view === "market") loadMarket(); }, 90_000);
  setInterval(() => { if (!document.hidden && S.view === "account") Promise.all([loadFlow(), loadDesk()]).then(renderAccount); }, 60_000);
}
boot();
