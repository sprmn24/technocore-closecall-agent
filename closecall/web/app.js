// Close Call web app. Every string that comes from the network is rendered with textContent.
import * as C from "./core.js";
import { STRINGS, HTML_LANG, RTL } from "./i18n.js";

// ---- state -------------------------------------------------------------------------------
const S = {
  lang: "en",
  signer: null,           // {did, sign} for a key held in this browser
  watchDid: null,         // a DID used from the terminal (DID mode)
  vault: C.loadVault(),
  price: null,            // latest referee price post
  hl: null,               // latest Hyperliquid trade
  live: null,             // referee looks live?
  desk: { offers: [], filled: new Set(), at: 0, error: null },
  flowIndex: new Map(),   // trade id -> {outcome, reason, n}
  market: null,
  leaders: null,          // latest referee pnl post
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
    // a close event still queued from the previous modal arrives while this one is open: ignore it
    dlg.onclose = () => { if (!done && !dlg.open) { done = true; resolve(undefined); } };
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
const jKey = () => `cc-journal:${myDid() || "-"}`;
function journal() { try { return JSON.parse(localStorage.getItem(jKey()) || "[]"); } catch { return []; } }
function journalAdd(e) {
  const j = journal();
  const had = e.id ? j.find((x) => x.kind === e.kind && x.id === e.id && x.role === e.role) : null;
  if (had) {
    // entries saved before stamps were recorded: take the room's stamp and sweep once it is seen
    if (had.at != null || e.at == null) return;
    had.at = e.at; had.sweep = C.nextSweep(e.at);
  } else j.push({ ts: Date.now(), ...e });
  try { localStorage.setItem(jKey(), JSON.stringify(j.slice(-500))); } catch { /* full */ }
}
const registered = () => journal().some((e) => e.kind === "owner");
const myDid = () => (S.signer ? S.signer.did : S.vault ? S.vault.did : S.watchDid);

// ---- key management ----------------------------------------------------------------------
// ---- key management ----------------------------------------------------------------------
// The key lives in IndexedDB as a non-extractable CryptoKey: it signs in this browser, nothing
// can read it out, and there is no password. The recovery file, downloaded once at creation,
// is the only backup. Old password vaults (cc-vault-v1) are unlocked once and moved over.
async function adopt(seed) {
  const signer = await C.signerFromSeed(seed);
  seed.fill(0);
  await C.storeDeviceKey(signer);
  if (S.vault && S.vault.did === signer.did) { C.forgetVault(); S.vault = null; }
  S.signer = signer;
  setWatch(null);
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
  const signer = await C.signerFromSeed(C.hexToBytes(m[1]));
  const d = /^did:\s*(did:key:\S+)\s*$/m.exec(text);
  if (d && d[1] !== signer.did) { seed.fill(0); throw new Error(t("key.badfile")); }
  return { seed, did: signer.did };
}

async function createKeyFlow() {
  const seed = C.newSeed();
  const signer = await C.signerFromSeed(C.hexToBytes(C.bytesToHex(seed)));
  const seedHex = C.bytesToHex(seed);
  const ok = await modal((close) => {
    const err = el("p", { class: "hint bad" });
    const saved = el("input", { type: "checkbox" });
    const finish = el("button", { class: "btn primary", type: "button", disabled: true }, t("key.finish"));
    saved.addEventListener("change", () => { finish.disabled = !saved.checked; });
    finish.addEventListener("click", async () => {
      busy(finish, true, t("ui.working"));
      try { await adopt(seed); close(true); } catch (e) { err.textContent = errText(e); busy(finish, false); }
    });
    return [
      el("h2", {}, t("key.newdid")),
      el("p", { class: "muted" }, t("key.newdiddesc")),
      el("div", { class: "label" }, t("key.yourdid")),
      el("div", { class: "row" }, el("span", { class: "mono grow" }, signer.did), el("button", { class: "btn small", type: "button", onclick: () => copy(signer.did) }, t("ac.copydid"))),
      el("div", { class: "label" }, t("key.seedlabel")),
      el("div", { class: "secret" }, seedHex),
      el("div", { class: "row" },
        el("button", { class: "btn primary", type: "button", onclick: () => copy(seedHex) }, t("key.copyseed")),
        el("button", { class: "btn", type: "button", onclick: () => download(recoveryName(signer.did), recoveryText(seedHex, signer.did)) }, "⭳ " + t("key.download"))),
      el("div", { class: "callout bad warnlist" },
        el("b", {}, t("key.warntitle")),
        el("ul", {}, el("li", {}, t("key.warn1")), el("li", {}, t("key.warn2")), el("li", {}, t("key.warn3")))),
      el("label", { class: "check" }, saved, el("span", {}, t("key.savedseed"))),
      err,
      el("div", { class: "modal-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => close(false) }, t("ui.cancel")), finish),
    ];
  });
  if (!ok) seed.fill(0);
  if (ok) { toast(t("key.ready")); renderAll(); }
}

/**
 * Load a key into this browser from the recovery file or the seed. With `expect` (a DID someone
 * already uses through the terminal) the page says so, warns first, and refuses any other key.
 * Resolves true once the key is stored.
 */
async function importKeyFlow(expect) {
  const ok = await modal((close) => {
    // The native file button is labelled in the browser's language, not the page's: hide it behind our own.
    const file = el("input", { class: "sr", type: "file", accept: ".txt,text/plain", id: "recovery-file" });
    const fname = el("span", { class: "hint" }, t("key.nofilechosen"));
    const picker = el("div", { class: "row" }, el("label", { class: "btn", for: "recovery-file" }, t("key.pickfile")), fname);
    const ta = el("textarea", { class: "input mono", autocomplete: "off", spellcheck: "false", autocapitalize: "off", placeholder: t("key.seedph") });
    const preview = el("div", { class: "hint mono" });
    const err = el("p", { class: "hint bad" });
    let found = null, timer;
    const show = (f) => {
      found = f; preview.textContent = f ? t("key.willbe") + " " + f.did : "";
      if (f && expect && f.did !== expect) { found = null; preview.textContent = ""; err.textContent = t("sh.mismatch", { got: f.did }); }
    };
    file.addEventListener("change", async () => {
      show(null); err.textContent = ""; ta.value = "";
      const f = file.files && file.files[0];
      fname.textContent = f ? f.name : t("key.nofilechosen");
      if (!f) return;
      if (f.size > 20_000) { err.textContent = t("key.badfile"); return; }
      try { show(await seedFromRecovery(await f.text())); } catch (e) { err.textContent = e.message; }
    });
    ta.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        err.textContent = ""; const v = ta.value.trim();
        if (!v) { show(null); return; }
        try { const seed = await C.seedFromInput(v); const sg = await C.signerFromSeed(C.hexToBytes(C.bytesToHex(seed))); show({ seed, did: sg.did }); }
        catch (e) { show(null); err.textContent = errText(e); }
      }, 250);
    });
    const go = el("button", { class: "btn primary", type: "button" }, expect ? t("sh.go") : t("key.restore"));
    go.addEventListener("click", async () => {
      if (!found) { if (!err.textContent) err.textContent = t("key.nofile"); return; }
      busy(go, true, t("ui.working"));
      try { ta.value = ""; await adopt(found.seed); close(true); } catch (e) { err.textContent = errText(e); busy(go, false); }
    });
    const url = location.origin + location.pathname;
    return [
      el("h2", {}, expect ? t("sh.title") : t("key.restoretitle")),
      el("p", { class: "muted" }, expect ? t("sh.desc") : t("key.restoredesc")),
      expect ? el("div", { class: "kvlist" }, el("div", {}, el("span", {}, t("key.yourdid")), el("span", { class: "mono" }, didEl(expect)))) : null,
      expect ? el("div", { class: "callout bad warnlist" }, el("ul", {},
        el("li", {}, t("sh.warn1", { url })), el("li", {}, t("sh.warn2")), el("li", {}, t("sh.warn3")))) : null,
      el("div", { class: "field" }, el("span", { class: "label" }, t("key.choosefile")), file, picker),
      el("div", { class: "field" }, el("span", { class: "label" }, t("key.orseed")), ta),
      preview,
      expect ? null : el("div", { class: "callout info" }, t("key.restorenote")),
      err,
      el("div", { class: "modal-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => close(false) }, t("ui.cancel")), go),
    ];
  });
  if (ok) { toast(expect ? t("sh.done") : t("key.ready")); renderAll(); }
  return !!ok;
}
const restoreFlow = () => importKeyFlow();

// ---- DID mode: a DID someone already has; signing happens in their own terminal ----------
const DM_KEY = "cc-did-mode";
function loadWatch() { try { const v = localStorage.getItem(DM_KEY); return v && C.DID_RE.test(v) ? v : null; } catch { return null; } }
function setWatch(did) { try { did ? localStorage.setItem(DM_KEY, did) : localStorage.removeItem(DM_KEY); } catch { /* ignore */ } S.watchDid = did; }

async function haveDidFlow() {
  const ok = await modal((close) => {
    const inp = el("input", { class: "input mono", placeholder: "did:key:z6Mk…", autocomplete: "off", spellcheck: "false" });
    const err = el("p", { class: "hint bad" });
    const go = el("button", { class: "btn primary", type: "button" }, t("dm.go"));
    const submit = () => {
      const v = C.normalizeDid(inp.value);
      if (!C.DID_RE.test(v)) { err.textContent = t("dm.bad"); return; }
      setWatch(v); close(true);
    };
    go.addEventListener("click", submit);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    return [
      el("h2", {}, t("dm.title")),
      el("p", { class: "muted" }, t("dm.desc")),
      el("div", { class: "field" }, el("label", {}, t("dm.input")), inp),
      el("div", { class: "callout info" }, t("dm.how"), " ", t("sh.later")),
      err,
      el("div", { class: "modal-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => close(false) }, t("ui.cancel")), go),
    ];
  });
  if (ok) { toast(t("dm.ready")); renderAll(); }
}

const INSTALL_CMD = 'pip install "git+https://github.com/sprmn24/technocore-closecall-agent"';
function cmdBox(cmd) {
  // One unbreakable span per argument (a browser would otherwise wrap "--send" after its first "-");
  // only a long did:key may break inside. The copy button copies the exact string.
  const parts = cmd.split(" ").flatMap((tok, i) => [i ? " " : null, el("span", { class: tok.length > 30 ? "tok long" : "tok" }, tok)]);
  return el("div", { class: "cmd" }, el("code", { class: "mono" }, parts),
    el("button", { class: "btn small", type: "button", onclick: () => copy(cmd) }, t("dm.copycmd")));
}
function setupSteps() {
  return el("details", { class: "setup" }, el("summary", {}, t("dm.setup")),
    el("ol", { class: "setup-list" },
      el("li", {}, t("dm.step1"), cmdBox(INSTALL_CMD)),
      el("li", {}, t("dm.step2"), cmdBox(`closecall did`), el("p", { class: "hint" }, t("dm.step2note")))),
    el("p", { class: "hint" }, t("dm.win")));
}
/** Show the one command that does `what` in the user's terminal. */
/**
 * An action for a DID used through the terminal. With `retry`, the person first picks how to sign:
 * in their terminal (the command below) or here, after loading their key once (then `retry` runs).
 */
async function terminalModal({ title, lead, warn, termDesc, cmd, onRan, retry }) {
  const act = await modal((close) => {
    const term = el("div", { class: "term-box" }, el("p", { class: "muted" }, termDesc), cmdBox(cmd),
      el("div", { class: "callout info" }, t("dm.seedprompt")), setupSteps(), el("p", { class: "hint" }, t("dm.after")));
    const ran = onRan ? el("button", { class: "btn primary", type: "button", onclick: () => { onRan(); close(); } }, t("dm.ran")) : null;
    let choice = null;
    if (retry) {
      term.hidden = true;
      if (ran) ran.hidden = true;
      const termCard = el("button", { type: "button", class: "choice-card", "aria-expanded": "false" }, el("b", {}, t("sh.term")), el("span", {}, t("sh.termdesc")));
      termCard.addEventListener("click", () => {
        term.hidden = false; if (ran) ran.hidden = false;
        termCard.classList.add("on"); termCard.setAttribute("aria-expanded", "true");
      });
      choice = el("div", { class: "choice" }, termCard,
        el("button", { type: "button", class: "choice-card", onclick: () => close("here") }, el("b", {}, t("sh.here")), el("span", {}, t("sh.heredesc"))));
    }
    return [
      el("h2", {}, title),
      lead ? (lead instanceof Node ? lead : el("p", { class: "muted" }, lead)) : null,
      warn ? el("div", { class: "callout bad" }, warn) : null,
      retry ? el("p", {}, el("b", {}, t("sh.choose"))) : null,
      choice, term,
      el("div", { class: "modal-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => close() }, t("ui.close")), ran),
    ];
  });
  if (act === "here" && retry && await importKeyFlow(S.watchDid)) retry();
}

/** Old password vault from an earlier version: unlock once, then it becomes a device key. */
async function unlockLegacy(password, btn, errNode) {
  busy(btn, true, t("key.unlocking"));
  try {
    const seed = await C.openSeed(S.vault, password);
    const probe = await C.signerFromSeed(C.hexToBytes(C.bytesToHex(seed)));
    if (probe.did !== S.vault.did) throw new Error("vault mismatch");
    await adopt(seed);
    toast(t("key.unlocked")); renderAll();
  } catch (e) { errNode.textContent = e.message === "wrong password" ? t("key.wrongpw") : errText(e); busy(btn, false); }
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
  await C.forgetDeviceKey().catch(() => {});
  C.forgetVault(); S.vault = null; S.signer = null; toast(t("key.forgotten")); renderAll();
}

// ---- actions -----------------------------------------------------------------------------
/** true: sign here; "terminal": DID mode, hand the user a command; false: no identity yet. */
function needKey() {
  if (S.signer) return true;
  if (S.watchDid) return "terminal";
  toast(S.vault ? t("key.needunlock") : t("key.needkey"), true);
  location.hash = "#start";
  return false;
}

async function register(btn) {
  const mode = needKey();
  if (!mode) return;
  if (mode === "terminal") {
    await terminalModal({ title: t("s2.title"), termDesc: t("dm.regdesc"), cmd: `closecall register --send --as ${S.watchDid}`,
      onRan: () => { journalAdd({ kind: "owner", room: "terminal", sweep: C.nextSweep() }); renderAll(); }, retry: () => register(btn) });
    return;
  }
  busy(btn, true, t("ui.signing"));
  try {
    const rec = await C.postSigned(S.signer, C.TRADING_ROOM, C.ownerMsg(S.signer.did));
    const at = Date.parse(rec && rec.ts) || Date.now();
    journalAdd({ kind: "owner", room: C.TRADING_ROOM, seq: rec.seq, at, sweep: C.nextSweep(at) });
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

/** Why the referee would void this trade for lack of POLF, going by my account book; else null. */
function fundsProblem(mySide, qC, pC) {
  const book = accountBook();
  if (!book.grant) return null;
  const side = mySide === "buy" ? 1n : -1n, held = -side * book.pos;
  const closing = held > 0n ? (held < qC ? held : qC) : 0n;
  const need = (qC - closing) * pC + qC * pC / 100n;
  return book.cash < need ? t("bal.funds", { have: fmt(P4(book.cash)), need: fmt(P4(need)) }) : null;
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
  const mode = needKey();
  if (!mode) return;
  const f = S.form, qC = C.cents(f.qty), pC = C.cents(f.px);
  const taker = C.normalizeDid(f.taker) || "any";
  let terms;
  try {
    if (!qC || !pC) throw new Error(t("tr.badnum"));
    if (taker !== "any" && !C.DID_RE.test(taker)) throw new Error(t("tr.badtaker"));
    terms = { id: C.newTradeId(), maker: myDid(), px: C.fromCents(pC), qty: C.fromCents(qC), side: f.side, taker, until: C.nextSweep() + Number(f.ttl) - 1 };
    const p = C.termsProblem(terms); if (p) throw new Error(p);
  } catch (e) { toast(e.message, true); return; }
  const band = bandProblem(pC), funds = fundsProblem(f.side, qC, pC);
  if (mode === "terminal") {
    const cmd = `closecall offer ${f.side} ${terms.qty} ${terms.px} --ttl ${Number(f.ttl)}${taker !== "any" ? " --taker " + taker : ""} --post --send --as ${S.watchDid}`;
    await terminalModal({ title: t("tr.confirmoffer"), lead: econNodes(f.side, qC, pC), warn: band || funds, termDesc: t("dm.offerdesc"), cmd, retry: () => publishOffer(btn) });
    return;
  }
  const ok = await modal((close) => [
    el("h2", {}, t("tr.confirmoffer")),
    econNodes(f.side, qC, pC),
    el("div", { class: "kvlist" },
      el("div", {}, el("span", {}, t("tr.validuntil")), el("span", {}, utc(C.sweepTime(terms.until)) + " · " + t("tr.sweep") + " " + terms.until)),
      el("div", {}, el("span", {}, t("tr.counterparty")), el("span", {}, taker === "any" ? t("tr.anyone") : didEl(taker)))),
    band && el("div", { class: "callout bad" }, band),
    funds && el("div", { class: "callout bad" }, funds),
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
    shareModal(terms);
  } catch (e) { toast(t("ui.failed") + ": " + errText(e), true); }
  busy(btn, false); renderTrade();
}

async function acceptOffer(o) {
  const mode = needKey();
  if (!mode) return;
  const terms = o.terms, mySide = terms.side === "buy" ? "sell" : "buy";
  if (C.nextSweep() > terms.until) { toast(t("tr.expired"), true); return; }
  if (mode === "terminal") {
    const funds = fundsProblem(mySide, C.cents(terms.qty), C.cents(terms.px));
    await terminalModal({ title: t("tr.confirmaccept"), lead: t("tr.acceptdesc", { qty: terms.qty, px: terms.px }), warn: funds,
      termDesc: t("dm.acceptdesc"), cmd: `closecall accept ${terms.id} --send --as ${S.watchDid}`, retry: () => acceptOffer(o) });
    return;
  }
  const qC = C.cents(terms.qty), pC = C.cents(terms.px);
  const band = bandProblem(pC), funds = fundsProblem(mySide, qC, pC);
  const ok = await modal((close) => [
    el("h2", {}, t("tr.confirmaccept")),
    el("p", { class: "muted" }, t("tr.acceptdesc", { qty: terms.qty, px: terms.px })),
    econNodes(mySide, qC, pC),
    el("div", { class: "kvlist" }, el("div", {}, el("span", {}, t("tr.maker")), didEl(terms.maker)),
      el("div", {}, el("span", {}, t("tr.settlesby")), el("span", {}, utc(C.sweepTime(terms.until))))),
    band && el("div", { class: "callout bad" }, band),
    funds && el("div", { class: "callout bad" }, funds),
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
    const at = Date.parse(rec && rec.ts) || Date.now();
    journalAdd({ kind: "trade", id: terms.id, room: C.TRADING_ROOM, seq: rec.seq, at, terms, taker: S.signer.did, role: "taker", sweep: C.nextSweep(at) });
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
  if (S.view === "account") renderAccount();
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
          if (myDid() && o.terms.maker === myDid()) journalAdd({ kind: "trade", id: o.terms.id, room: C.DESK_ROOM, seq: m.seq, at: Date.parse(m.ts) || undefined, sweep: C.nextSweep(Date.parse(m.ts) || Date.now()), terms: o.terms, taker: o.taker, role: "maker" });
          if (myDid() && o.taker === myDid()) journalAdd({ kind: "trade", id: o.terms.id, room: C.DESK_ROOM, seq: m.seq, at: Date.parse(m.ts) || undefined, sweep: C.nextSweep(Date.parse(m.ts) || Date.now()), terms: o.terms, taker: o.taker, role: "taker" });
        }
      } else if (o.t === "offer") {
        if (m.from !== o.terms?.maker) continue; // posted by someone else than the maker: ignore
        if ((await C.checkOffer(o)) === null) {
          offers.push({ ...o, seq: m.seq, ts: m.ts });
          if (myDid() && o.terms.maker === myDid()) journalAdd({ kind: "offer", id: o.terms.id, room: C.DESK_ROOM, seq: m.seq, terms: o.terms, maker_sig: o.maker_sig, role: "maker" });
        }
      }
    }
    const me = myDid();
    if (S.desk.at && me) {
      for (const e of journal()) {
        if (e.kind === "offer" && e.terms && e.terms.maker === me && filled.has(e.id) && !S.desk.filled.has(e.id)) {
          toast(t("bk.filled", { qty: e.terms.qty, px: e.terms.px }));
          if (document.hidden) document.title = "● " + t("doc.title");
        }
      }
    }
    S.desk = { offers, filled, at: Date.now(), error: null };
  } catch (e) {
    S.desk.error = e.status === 404 ? null : errText(e);
    if (e.status === 404) S.desk = { offers: [], filled: S.desk.filled, at: Date.now(), error: null };
  }
  renderTrade(); renderStart(); renderWallet();
  if (S.pendingOffer) {
    const id = S.pendingOffer; S.pendingOffer = null;
    history.replaceState(null, "", "#trade");
    const o = openOffers().find((x) => x.terms.id === id && x.terms.maker !== myDid());
    if (o) acceptOffer(o); else toast(t("bk.notfound"), true);
  }
}

async function loadFlow(limit = 50) {
  try {
    const view = await C.readRoom("d-close1-flow", { limit });
    const referee = S.price && S.price._from;
    for (const m of C.signedJson(view)) {
      if (m.json.t !== "flow" || (referee && m.from !== referee)) continue;
      for (const e of m.json.settled || []) { const id = Array.isArray(e) ? e[0] : typeof e === "string" ? e : e && e.id; if (id) S.flowIndex.set(id, { outcome: "settled", n: m.json.n }); }
      for (const e of m.json.void || []) {
        if (!Array.isArray(e) || typeof e[0] !== "string") continue;
        const reason = String(e[1] ?? ""), had = S.flowIndex.get(e[0]);
        // "settled" voids a later copy of an id that already settled (anyone may re-post a public
        // trade): the id itself settled, so it must not overwrite that.
        if (reason === "settled") { if (!had) S.flowIndex.set(e[0], { outcome: "settled", n: m.json.n, copies: true }); continue; }
        if (!had || had.outcome !== "settled") S.flowIndex.set(e[0], { outcome: "void", reason, n: m.json.n });
      }
    }
  } catch { /* shown as pending */ }
  renderWallet();
}

async function loadLeaders() {
  try {
    const referee = S.price && S.price._from;
    const posts = C.signedJson(await C.readRoom("d-close1-pnl", { limit: 3 })).filter((m) => m.json.t === "pnl" && (!referee || m.from === referee));
    if (posts.length) S.leaders = { ...posts[posts.length - 1].json, _ts: Date.parse(posts[posts.length - 1].ts) };
  } catch { /* keep the last one */ }
  renderLeaders(); renderStartLeader();
}

/** Rows of the referee's top list, identical scores grouped; places are 1-based. */
function leaderGroups(top) {
  const groups = [];
  top.forEach((e, i) => {
    if (!Array.isArray(e) || typeof e[0] !== "string") return;
    const last = groups[groups.length - 1];
    if (last && last.v === String(e[1])) { last.keys.push(e[0]); last.end = i + 1; }
    else groups.push({ v: String(e[1]), keys: [e[0]], start: i + 1, end: i + 1 });
  });
  return groups;
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
  w.onclick = accountMenu;
  w.title = t("am.title");
  // a shorter form of the DID takes over when the header gets tight
  const chipDid = (did) => el("span", { class: "mono chip-did" },
    el("span", { class: "dl" }, did.slice(8, 16) + "…" + did.slice(-6)), el("span", { class: "ds" }, "…" + did.slice(-6)));
  const bal = () => {
    const b = registered() ? accountBook() : null;
    return b ? el("span", { class: "chip-bal num" }, fmt(P4(b.cash)) + " POLF") : null;
  };
  if (S.signer) w.append(el("span", { class: "dot good" }), chipDid(S.signer.did), bal() || "");
  else if (S.watchDid) w.append(el("span", { class: "dot good" }), chipDid(S.watchDid), el("span", { class: "term-badge", title: t("dm.chip"), "aria-label": t("dm.chip") }, "›_"), bal() || "");
  else if (S.vault) w.append(el("span", { class: "dot warn" }), t("wl.locked"));
  else w.append(el("span", { class: "dot" }), t("wl.none"));
}

/** The header chip's menu: the whole DID, copy it, the balance, and signing out. */
async function accountMenu() {
  const did = S.signer ? S.signer.did : S.watchDid;
  if (!did) { location.hash = "#start"; return; }
  const b = registered() ? accountBook() : null;
  const act = await modal((close) => [
    el("h2", {}, t("am.title")),
    el("div", { class: "am-did mono" }, did),
    el("p", { class: "hint" }, S.signer ? t("am.here") : t("am.term")),
    b ? el("div", { class: "kvlist" }, el("div", {}, el("span", {}, t("bal.available")), el("b", { class: "num" }, fmt(P4(b.cash)) + " POLF"))) : null,
    el("div", { class: "row" },
      el("button", { class: "btn small", type: "button", onclick: () => copy(did) }, t("ac.copydid")),
      el("button", { class: "btn small", type: "button", onclick: () => close("account") }, t("nav.account"))),
    el("hr", { class: "am-sep" }),
    el("p", { class: "hint" }, S.signer ? t("am.signoutkey") : t("am.signoutdid")),
    el("div", { class: "modal-actions" },
      el("button", { class: "btn ghost", type: "button", onclick: () => close() }, t("ui.cancel")),
      el("button", { class: "btn " + (S.signer ? "danger" : "primary"), type: "button", onclick: () => close("out") }, t("am.signout"))),
  ]);
  if (act === "account") { location.hash = "#account"; return; }
  if (act !== "out") return;
  if (S.signer) { await forgetKey(); if (S.signer) return; }
  else { setWatch(null); toast(t("am.signedout")); }
  location.hash = "#start";
  renderAll();
}

// ---- rendering: start --------------------------------------------------------------------
function statusNode(ok, text) { return el("span", { class: "status" + (ok ? " ok" : "") }, ok ? "✓ " + text : text); }

function renderStart() {
  $("start-lock").textContent = dur(C.sweepTime(C.LOCK_SWEEP) - Date.now());
  // step 1
  const s1 = clear($("s1-body")), s1s = clear($("s1-status"));
  $("step-key").classList.toggle("done", !!(S.signer || S.watchDid));
  if (S.signer) {
    s1s.append(statusNode(true, t("s1.ready")));
    s1.append(el("div", { class: "kvlist" }, el("div", {}, el("span", {}, t("key.yourdid")), didEl(S.signer.did))),
      el("p", { class: "hint" }, t("ac.recoverynote")));
  } else if (S.vault) {
    s1s.append(statusNode(false, t("wl.locked")));
    const pw = el("input", { class: "input", type: "password", autocomplete: "current-password", placeholder: t("key.pw") });
    const err = el("p", { class: "hint bad" });
    const go = el("button", { class: "btn primary", type: "button" }, t("key.unlock"));
    go.addEventListener("click", () => unlockLegacy(pw.value, go, err));
    pw.addEventListener("keydown", (e) => { if (e.key === "Enter") unlockLegacy(pw.value, go, err); });
    s1.append(el("p", { class: "muted" }, t("key.lockeddesc"), " ", didEl(S.vault.did)), el("div", { class: "row" }, el("div", { class: "field" }, pw), go), err,
      el("div", { class: "row alt" }, el("button", { class: "btn small ghost", type: "button", onclick: restoreFlow }, t("key.have")),
        el("button", { class: "btn small ghost", type: "button", onclick: forgetKey }, t("key.other"))));
  } else if (S.watchDid) {
    s1s.append(statusNode(true, t("dm.using")));
    s1.append(el("div", { class: "kvlist" }, el("div", {}, el("span", {}, t("key.yourdid")), didEl(S.watchDid))),
      el("p", { class: "hint" }, t("dm.usingdesc")), setupSteps(),
      el("div", { class: "row alt" },
        el("button", { class: "btn small", type: "button", disabled: !S.ed25519, onclick: () => importKeyFlow(S.watchDid) }, t("sh.startbtn")),
        el("button", { class: "btn small ghost", type: "button", onclick: () => { setWatch(null); renderAll(); } }, t("dm.other"))));
  } else {
    s1s.append(statusNode(false, t("s1.todo")));
    s1.append(
      el("div", { class: "choice" },
        el("button", { type: "button", class: "choice-card primary-card", onclick: createKeyFlow, disabled: !S.ed25519 },
          el("b", {}, t("key.createbtn")), el("span", {}, t("key.createbtndesc"))),
        el("button", { type: "button", class: "choice-card", onclick: haveDidFlow },
          el("b", {}, t("key.havedid")), el("span", {}, t("key.havediddesc")))),
      el("div", { class: "row alt" }, el("button", { class: "btn ghost small", type: "button", onclick: restoreFlow, disabled: !S.ed25519 }, t("key.have")), el("span", { class: "hint" }, t("key.havedesc"))));
  }
  // step 2
  const s2 = clear($("s2-body")), s2s = clear($("s2-status"));
  const reg = registered();
  const who = S.signer || S.watchDid;
  $("step-register").classList.toggle("done", reg && !!who);
  $("step-register").classList.toggle("locked", !who);
  if (!who) { s2s.append(statusNode(false, t("s2.needkey"))); }
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
  $("step-trade").classList.toggle("done", traded && !!who);
  $("step-trade").classList.toggle("locked", !reg || !who);
  clear($("s3-status")).append(statusNode(traded, traded ? t("s3.done") : t("s3.todo")));
}

// ---- rendering: trade --------------------------------------------------------------------
function renderOfferForm() {
  const box = clear($("offer-form"));
  const f = S.form, r = refC();
  if (!f.px && r) f.px = C.fromCents(r);
  const book = accountBook(), cash = book.grant ? book.freeC : C.MINT_CENTS;
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
    go.disabled = !(S.signer || S.watchDid);
    const hits = instantMatches(f.side, pc);
    if (hits.length) {
      const best = hits[0];
      summary.append(el("div", { class: "callout good instant" },
        el("span", {}, t("bk.instant", { n: hits.length, qty: best.terms.qty, px: best.terms.px })),
        el("button", { class: "btn small " + f.side, type: "button", onclick: () => acceptOffer(best) }, t("bk.instantgo"))));
    }
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
    ...(S.signer || S.watchDid ? [] : [el("p", { class: "hint" }, t("key.needkey"))]),
    ...(S.watchDid && !S.signer ? [el("p", { class: "hint" }, t("dm.formhint"))] : []),
  );
  update();
}

/** Offers anyone could still take (or my own, marked), deduplicated by id. */
function openOffers() {
  const n = C.nextSweep(), me = myDid(), byId = new Map();
  for (const o of S.desk.offers) {
    if (o.terms.until < n || S.desk.filled.has(o.terms.id)) continue;
    if (!(o.terms.taker === "any" || o.terms.taker === me || o.terms.maker === me)) continue;
    byId.set(o.terms.id, o);
  }
  return [...byId.values()];
}
const pxOf = (o) => Number(o.terms.px);
function bookRow(o, me) {
  const mine = o.terms.maker === me, youSide = o.terms.side === "buy" ? "sell" : "buy";
  const action = mine
    ? el("span", {}, el("span", { class: "badge ok" }, t("bk.yours")), " ", el("button", { class: "btn small ghost", type: "button", onclick: () => shareModal(o.terms) }, t("bk.share")))
    : el("button", { class: "btn small " + youSide, type: "button", onclick: () => acceptOffer(o), disabled: !(S.signer || S.watchDid) }, youSide === "buy" ? t("bk.buyfrom") : t("bk.sellto"));
  return el("tr", { class: mine ? "mine-row" : null },
    el("td", { class: "num px" }, fmt(pxOf(o))), el("td", { class: "r num" }, o.terms.qty),
    el("td", { class: "num" }, dur(C.sweepTime(o.terms.until) - Date.now())), el("td", {}, didEl(o.terms.maker)), el("td", { class: "r" }, action));
}
function bookTable(rows, me) {
  if (!rows.length) return el("div", { class: "empty" }, S.desk.at ? t("bk.none") : t("ui.loading"));
  return el("div", { class: "scroll" }, el("table", {},
    el("thead", {}, el("tr", {}, [t("bk.pricecol"), t("tr.qty"), t("tr.expires"), t("tr.maker"), ""].map((h, i) => el("th", { class: i === 1 || i === 4 ? "r" : null }, h)))),
    el("tbody", {}, rows.map((o) => bookRow(o, me)))));
}
function renderBoard() {
  const me = myDid(), open = openOffers();
  const buyers = open.filter((o) => o.terms.side === "buy").sort((a, b) => pxOf(b) - pxOf(a) || a.seq - b.seq);
  const sellers = open.filter((o) => o.terms.side === "sell").sort((a, b) => pxOf(a) - pxOf(b) || a.seq - b.seq);
  const sum = clear($("book-summary"));
  if (S.desk.error) sum.append(el("div", { class: "callout bad" }, S.desk.error));
  const bb = buyers[0] ? pxOf(buyers[0]) : null, ba = sellers[0] ? pxOf(sellers[0]) : null, r = refC();
  const qty = open.reduce((a, o) => a + Number(o.terms.qty), 0);
  const cell = (k, v, cls) => el("div", {}, el("div", { class: "k" }, k), el("div", { class: "v num " + (cls || "") }, v));
  sum.append(
    cell(t("bk.bestbid"), bb != null ? fmt(bb) : "–", "buy-t"),
    cell(t("bk.bestask"), ba != null ? fmt(ba) : "–", "sell-t"),
    cell(t("bk.spread"), bb != null && ba != null ? fmt(ba - bb) : "–"),
    cell(t("tk.ref"), r ? C.fromCents(r) : "–"),
    cell(t("bk.waitingk"), t("bk.waiting", { n: open.length, q: fmt(qty) }), "small-v"),
  );
  clear($("book-buyers")).append(bookTable(buyers, me));
  clear($("book-sellers")).append(bookTable(sellers, me));

  const mineBox = clear($("my-offers"));
  const mineRows = journal().filter((e) => e.kind === "offer" && e.terms).reverse().slice(0, 20);
  if (!mineRows.length) { mineBox.append(el("div", { class: "empty" }, t("tr.nomine"))); return; }
  mineBox.append(el("div", { class: "scroll" }, el("table", {},
    el("thead", {}, el("tr", {}, [t("tr.side"), t("tr.qty"), t("tr.price"), t("tr.status"), ""].map((h, i) => el("th", { class: i === 1 || i === 2 ? "r" : null }, h)))),
    el("tbody", {}, mineRows.map((e) => {
      const filled = S.desk.filled.has(e.id) || journal().some((x) => x.kind === "trade" && x.id === e.id);
      const expired = C.nextSweep() > e.terms.until;
      const st = filled ? el("span", { class: "badge ok" }, t("st.filled")) : expired ? el("span", { class: "badge neutral" }, t("st.expired")) : el("span", { class: "badge warn" }, t("st.open") + " · " + dur(C.sweepTime(e.terms.until) - Date.now()));
      return el("tr", {}, el("td", {}, el("span", { class: e.terms.side + "-t" }, e.terms.side === "buy" ? t("tr.buy") : t("tr.sell"))), el("td", { class: "r num" }, e.terms.qty), el("td", { class: "r num" }, e.terms.px), el("td", {}, st),
        el("td", {}, !filled && !expired ? el("button", { class: "btn small ghost", type: "button", onclick: () => shareModal(e.terms) }, t("bk.share")) : ""));
    })))));
}

/** Offers on the other side that already match a price I am about to post: trade now instead of waiting. */
function instantMatches(side, pxC) {
  const me = myDid(), px = Number(pxC) / 100;
  return openOffers().filter((o) => o.terms.maker !== me && o.terms.side !== side && (side === "buy" ? pxOf(o) <= px : pxOf(o) >= px))
    .sort((a, b) => (side === "buy" ? pxOf(a) - pxOf(b) : pxOf(b) - pxOf(a)) || a.seq - b.seq);
}

const offerLink = (id) => `${location.origin}${location.pathname}#trade/o/${encodeURIComponent(id)}`;
async function shareModal(terms) {
  const link = offerLink(terms.id);
  const text = t("bk.tweet", { side: terms.side === "buy" ? t("tr.buy") : t("tr.sell"), qty: terms.qty, px: terms.px });
  const x = "https://twitter.com/intent/tweet?" + new URLSearchParams({ text, url: link }).toString();
  await modal((close) => [
    el("h2", {}, t("bk.sharetitle")),
    el("p", { class: "muted" }, t("bk.sharedesc")),
    el("div", { class: "share-link" }, el("code", { class: "mono" }, link), el("button", { class: "btn small", type: "button", onclick: () => copy(link) }, t("bk.copylink"))),
    el("div", { class: "modal-actions" }, el("button", { class: "btn ghost", type: "button", onclick: () => close() }, t("ui.close")),
      el("a", { class: "btn primary", href: x, target: "_blank", rel: "noopener noreferrer" }, t("bk.sharex"))),
  ]);
}

function renderTrade() { if (S.view !== "trade") return; renderOfferForm(); renderBoard(); }

// ---- rendering: account ------------------------------------------------------------------
const P4 = (v) => Number(v) / 1e4; // 1e-4 POLF units -> POLF
const polf = (v, signed) => (signed && v > 0n ? "+" : "") + fmt(P4(v));
const lastSweepDone = () => (S.price && Number.isInteger(S.price.n) ? S.price.n : C.sweepNow());
/** The sweep that picks up a message stamped at `ms`. */
const entrySweep = (e) => e.sweep ?? C.nextSweep(e.at ?? e.ts);

/** When the referee's 10,000 POLF arrives, from this browser's registration entry. */
function grantInfo() {
  const e = journal().find((x) => x.kind === "owner");
  if (!e) return null;
  const sweep = e.room === "elsewhere" && e.sweep == null ? null : entrySweep(e);
  return { sweep, at: e.at ?? e.ts, done: sweep == null || lastSweepDone() >= sweep };
}

/**
 * My account replayed with the fold's rules (tests/close_call_fold.py): the grant, then my trades in
 * sweep order, FIFO lots, collateral = price per opened contract, 1% fee per side. Amounts are
 * BigInt in 1e-4 POLF. An estimate: the referee publishes no per-key balances.
 */
function accountBook() {
  const MINT = C.MINT_CENTS * 100n, g = grantInfo(), done = lastSweepDone();
  const items = [{ kind: "mint", sweep: g ? g.sweep ?? -1 : -1, at: g ? g.at : 0, status: !g ? "none" : g.done ? "received" : "coming" }];
  const seen = new Set();
  for (const e of journal()) {
    if (e.kind !== "trade" || !e.terms || seen.has(e.id)) continue;
    seen.add(e.id);
    items.push({ kind: "trade", e, sweep: entrySweep(e), at: e.at ?? e.ts });
  }
  items.sort((a, b) => a.sweep - b.sweep || (a.kind === "mint" ? -1 : b.kind === "mint" ? 1 : a.at - b.at));
  let cash = 0n, fees = 0n, count = 0;
  const lots = [], rows = []; // lots: [qtyC signed, pxC]
  for (const it of items) {
    if (it.kind === "mint") {
      const delta = it.status === "none" ? 0n : MINT;
      cash += delta;
      rows.push({ ...it, delta, fee: 0n, after: cash });
      continue;
    }
    const e = it.e, mySide = e.role === "maker" ? e.terms.side : e.terms.side === "buy" ? "sell" : "buy";
    const qC = C.cents(e.terms.qty), pC = C.cents(e.terms.px);
    if (!qC || !pC) continue;
    const f = S.flowIndex.get(e.id);
    let status = f ? f.outcome : it.sweep > done ? "pending" : "assumed", reason = f ? f.reason : null;
    if (status !== "void" && (!g || (g.sweep != null && it.sweep < g.sweep))) { status = "void"; reason = "not_owner"; }
    const row = { kind: "trade", at: it.at, sweep: it.sweep, id: e.id, side: mySide, qty: e.terms.qty, px: e.terms.px, status, reason, n: f && f.n, delta: 0n, fee: 0n };
    if (status !== "void") {
      const before = cash, fee = qC * pC / 100n;
      if (e.terms.maker === e.taker) { cash -= 2n * fee; fees += 2n * fee; row.fee = 2n * fee; }
      else {
        const side = mySide === "buy" ? 1n : -1n;
        cash -= fee; fees += fee; row.fee = fee;
        let left = qC;
        while (left > 0n && lots.length && lots[0][0] * side < 0n) {
          const [lq, lp] = lots[0], held = lq < 0n ? -lq : lq, size = left < held ? left : held;
          cash += side < 0n ? size * pC : size * (2n * lp - pC);
          left -= size;
          if (size === held) lots.shift(); else lots[0][0] = lq + side * size;
        }
        if (left > 0n) { cash -= left * pC; lots.push([side * left, pC]); }
      }
      row.delta = cash - before; count++;
    }
    row.after = cash;
    rows.push(row);
  }
  const abs = (x) => (x < 0n ? -x : x);
  const pos = lots.reduce((a, [q]) => a + q, 0n);
  const locked = lots.reduce((a, [q, p]) => a + abs(q) * p, 0n);
  const r = refC();
  const value = r ? cash + lots.reduce((a, [q, p]) => a + (q > 0n ? q * r : -q * (2n * p - r)), 0n) : null;
  const granted = g ? MINT : 0n;
  const realized = cash + locked + fees - granted;
  const avg = lots.length ? lots.reduce((a, [q, p]) => a + abs(q) * p, 0n) / (abs(pos) || 1n) : null;
  return {
    grant: g, rows, cash, locked, fees, count, pos, avg, value, realized,
    unrealized: value != null ? value - cash - locked : null,
    score: value != null && g ? value - MINT : null,
    freeC: cash > 0n ? cash / 100n : 0n,
    pnl: value != null && g ? value - MINT : null,
  };
}
function tradeStatus(e) {
  const f = S.flowIndex.get(e.id);
  if (f && f.outcome === "settled") return el("span", { class: "badge ok" }, t("st.settled") + " · #" + f.n);
  if (f && f.outcome === "void") return el("span", { class: "badge bad", title: f.reason }, t("st.void") + ": " + rsn(f.reason));
  if (e.terms && C.sweepNow() > e.terms.until) return el("span", { class: "badge neutral", title: t("st.unlistedtip") }, t("st.unlisted"));
  return el("span", { class: "badge warn" }, t("st.pending"));
}

function balanceStatus(r) {
  if (r.kind === "mint") {
    if (r.status === "received") return el("span", { class: "badge ok" }, t("bal.st.received"));
    if (r.status === "coming") return el("span", { class: "badge warn" }, t("bal.st.coming"));
    return el("span", { class: "badge neutral" }, t("bal.st.none"));
  }
  if (r.status === "settled") return el("span", { class: "badge ok" }, t("st.settled") + (r.n != null ? " · #" + r.n : ""));
  if (r.status === "void") return el("span", { class: "badge bad", title: r.reason || "" }, t("st.void") + ": " + rsn(r.reason));
  if (r.status === "assumed") return el("span", { class: "badge neutral", title: t("bal.st.assumedtip") }, t("bal.st.assumed"));
  return el("span", { class: "badge warn" }, t("st.pending"));
}

function renderBalance(B) {
  const box = clear($("acct-balance"));
  box.append(el("h2", {}, t("bal.title")), el("p", { class: "muted" }, t("bal.desc")));
  const g = B.grant;
  if (!g) {
    box.append(el("div", { class: "callout info" }, t("bal.grantnone"), " ", el("a", { href: "#start" }, t("nav.start"))));
    return;
  }
  const when = g.sweep != null ? utc(C.sweepTime(g.sweep)) : "";
  box.append(el("div", { class: "callout " + (g.done ? "good" : "warn") + " bal-grant" },
    g.sweep == null ? t("bal.grantmarked")
      : g.done ? t("bal.grantdone", { n: g.sweep, time: when })
        : t("bal.grantpending", { n: g.sweep, time: when, left: dur(C.sweepTime(g.sweep) - Date.now()) })));
  const pos = Number(B.pos) / 100, r = refC();
  const sgn = (v) => (v == null ? "" : v > 0n ? " buy-t" : v < 0n ? " sell-t" : "");
  const tileC = (label, value, foot, cls, id) => el("div", { class: "card tile" + (id ? " " + id : "") }, el("div", { class: "label" }, label),
    el("div", { class: "value num" + (cls || "") }, value), el("div", { class: "foot num" }, foot || ""));
  box.append(el("div", { class: "tiles bal-tiles" },
    tileC(t("bal.available"), fmt(P4(B.cash)), t("bal.availablefoot"), "", "bal-main"),
    tileC(t("bal.locked"), fmt(P4(B.locked)), pos ? t("bal.contracts", { q: fmt(Math.abs(pos)) }) + " · " + (pos > 0 ? t("ec.long") : t("ec.short")) : t("bal.flat")),
    tileC(t("bal.fees"), fmt(P4(B.fees)), t("bal.feesfoot", { n: B.count })),
    tileC(t("bal.total"), B.value != null ? fmt(P4(B.value)) : "–", r ? t("bal.valuefoot", { px: C.fromCents(r) }) : ""),
    tileC(t("bal.score"), B.score != null ? polf(B.score, true) : "–",
      B.unrealized != null ? t("bal.scorefoot", { r: polf(B.realized - B.fees, true), u: polf(B.unrealized, true) }) : "", sgn(B.score))));
  const tb = el("table", { id: "t-statement" });
  tb.append(el("thead", {}, el("tr", {}, [t("ac.time"), t("tr.sweep"), t("bal.col.item"), t("bal.col.fee"), t("bal.col.change"), t("bal.col.after"), t("tr.status")]
    .map((h, i) => el("th", { class: i >= 3 && i <= 5 ? "r" : null }, h)))));
  const body = el("tbody");
  for (const row of B.rows.slice().reverse()) {
    const item = row.kind === "mint" ? t("bal.row.mint")
      : el("span", { class: row.side + "-t" }, t(row.side === "buy" ? "bal.row.buy" : "bal.row.sell", { qty: row.qty, px: row.px }));
    const off = row.status === "void" || row.status === "none";
    body.append(el("tr", { class: off ? "off" : null },
      el("td", { class: "num" }, row.at ? utcFull(row.at) : "–"),
      el("td", { class: "num" }, row.sweep >= 0 ? "#" + row.sweep : "–"),
      el("td", {}, item),
      el("td", { class: "r num", title: row.fee ? t("bal.feetip") : "" }, row.fee ? fmt(P4(row.fee)) : "–"),
      el("td", { class: "r num" + sgn(row.delta) }, row.delta ? polf(row.delta, true) : "0"),
      el("td", { class: "r num" }, fmt(P4(row.after))),
      el("td", {}, balanceStatus(row))));
  }
  tb.append(body);
  box.append(el("h3", {}, t("bal.statement")), el("p", { class: "hint" }, t("bal.statementdesc")), el("div", { class: "scroll" }, tb),
    el("p", { class: "hint" }, t("bal.note")));
}

function renderAccount() {
  if (S.view !== "account") return;
  const k = clear($("acct-key")), s = clear($("acct-summary"));
  k.append(el("h2", {}, t("ac.key")));
  const did = myDid();
  if (!did) { k.append(el("p", { class: "muted" }, t("key.needkey")), el("a", { class: "btn primary", href: "#start" }, t("nav.start"))); }
  else {
    k.append(el("div", { class: "kvlist" }, el("div", {}, el("span", {}, "DID"), el("span", { class: "mono" }, did)),
      el("div", {}, el("span", {}, t("ac.state")), el("span", {}, S.signer ? t("s1.ready") : S.watchDid ? t("dm.using") : t("wl.locked")))),
      el("p", { class: "hint" }, S.watchDid && !S.signer ? t("dm.usingdesc") : t("ac.recoverynote")),
      el("div", { class: "row" }, el("button", { class: "btn small", type: "button", onclick: () => copy(did) }, t("ac.copydid")),
        S.signer || S.watchDid ? null : el("a", { class: "btn small primary", href: "#start" }, t("key.unlock")),
        S.watchDid && !S.signer ? el("button", { class: "btn small", type: "button", disabled: !S.ed25519, onclick: () => importKeyFlow(S.watchDid) }, t("sh.startbtn")) : null,
        S.watchDid && !S.signer ? el("button", { class: "btn small ghost", type: "button", onclick: () => { setWatch(null); renderAll(); } }, t("dm.other"))
          : el("button", { class: "btn small danger ghost", type: "button", onclick: forgetKey }, t("key.forget"))));
  }
  const L = accountBook();
  renderBalance(L);
  const pos = Number(L.pos) / 100;
  s.append(el("h2", {}, t("ac.summary")), el("p", { class: "muted" }, t("ac.estimate")),
    el("div", { class: "kvlist" },
      el("div", {}, el("span", {}, t("ac.registered")), el("span", {}, registered() ? "✓" : "—")),
      el("div", {}, el("span", {}, t("ac.position")), el("span", { class: "num " + (pos > 0 ? "buy-t" : pos < 0 ? "sell-t" : "") }, fmt(pos) + (pos ? " (" + (pos > 0 ? t("ec.long") : t("ec.short")) + ")" : ""))),
      el("div", {}, el("span", {}, t("ac.avg")), el("span", { class: "num" }, L.avg != null ? "$" + C.fromCents(L.avg) : "–")),
      el("div", {}, el("span", {}, t("ac.pnl")), el("span", { class: "num " + (L.pnl > 0n ? "buy-t" : L.pnl < 0n ? "sell-t" : "") }, L.pnl != null ? polf(L.pnl, true) + " POLF" : "–"))));

  const rows = journal().slice().reverse();
  const tb = clear($("t-activity"));
  tb.append(el("thead", {}, el("tr", {}, [t("ac.time"), t("ac.what"), t("tr.side"), t("tr.qty"), t("tr.price"), t("tr.status")].map((h, i) => el("th", { class: i === 3 || i === 4 ? "r" : null }, h)))));
  const body = el("tbody");
  if (!rows.length) body.append(el("tr", {}, el("td", { colspan: "6", class: "empty" }, t("ac.none"))));
  for (const e of rows) {
    const mySide = e.terms ? (e.role === "maker" ? e.terms.side : e.terms.side === "buy" ? "sell" : "buy") : null;
    const what = e.kind === "owner" ? t("ac.k.owner") : e.kind === "offer" ? t("ac.k.offer") : e.role === "maker" ? t("ac.k.filled") : t("ac.k.accepted");
    const booked = e.kind === "trade" ? L.rows.find((r) => r.kind === "trade" && r.id === e.id) : null;
    const status = e.kind === "trade" ? (booked ? balanceStatus(booked) : tradeStatus(e)) : e.kind === "offer" ? (S.desk.filled.has(e.id) ? el("span", { class: "badge ok" }, t("st.filled")) : C.nextSweep() > e.terms.until ? el("span", { class: "badge neutral" }, t("st.expired")) : el("span", { class: "badge warn" }, t("st.open"))) : el("span", { class: "badge ok" }, t("st.posted"));
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

// ---- rendering: leaderboard -------------------------------------------------------------
function rankLabel(g) { return g.start === g.end ? "#" + g.start : `#${g.start}–${g.end}`; }
function renderStartLeader() {
  const n = $("start-leader"); if (!n) return;
  const top = S.leaders && Array.isArray(S.leaders.top) ? S.leaders.top : [];
  n.textContent = top.length ? (Number(top[0][1]) >= 0 ? "+" : "") + fmt(top[0][1]) + " POLF" : "–";
}
function renderLeaders() {
  if (S.view !== "leaders") return;
  const L = S.leaders, top = L && Array.isArray(L.top) ? L.top : [];
  const groups = leaderGroups(top), me = myDid();
  const mine = me ? groups.find((g) => g.keys.includes(me)) : null;
  const tiles = clear($("lb-tiles"));
  tiles.append(
    tile(t("lb.prize"), "1,000,000 FLOP", t("lb.prizefoot")),
    tile(t("lb.leader"), groups.length ? (Number(groups[0].v) >= 0 ? "+" : "") + fmt(groups[0].v) + " POLF" : "–", groups.length && groups[0].keys.length > 1 ? t("lb.nkeys", { n: groups[0].keys.length }) : ""),
    tile(t("lb.you"), mine ? rankLabel(mine) : me ? t("lb.notin") : t("lb.nokey"), mine ? fmt(mine.v) + " POLF" : ""),
    tile(t("lb.asof"), L ? t("tr.sweep") + " " + L.n : "–", L ? t("lb.asoffoot", { mark: L.mark }) : ""),
  );
  $("lb-search").placeholder = t("lb.search");
  const q = C.normalizeDid($("lb-search").value), found = clear($("lb-found"));
  if (q) {
    const g = groups.find((x) => x.keys.includes(q));
    found.append(g ? t("lb.found", { rank: rankLabel(g), v: fmt(g.v) }) : C.DID_RE.test(q) ? t("lb.notfound") : t("tr.badtaker"));
  }
  const tb = clear($("t-leaders"));
  tb.append(el("thead", {}, el("tr", {}, el("th", {}, t("lb.rank")), el("th", {}, t("lb.player")), el("th", { class: "r" }, t("lb.pnl")), el("th", {}, t("lb.prizecol")))));
  const body = el("tbody");
  if (!groups.length) body.append(el("tr", {}, el("td", { colspan: "4", class: "empty" }, L ? t("lb.empty") : t("ui.loading"))));
  for (const g of groups) {
    const isMe = me && g.keys.includes(me), prize = g.start <= 3;
    const who = g.keys.length === 1
      ? el("span", {}, didEl(g.keys[0]), isMe ? el("span", { class: "badge ok" }, t("mk.you")) : "")
      : el("details", { class: "group", open: isMe || null }, el("summary", {}, t("lb.nkeys", { n: g.keys.length }), isMe ? el("span", { class: "badge ok" }, t("mk.you")) : ""),
          el("div", { class: "group-list" }, g.keys.map((k) => el("div", {}, didEl(k), k === me ? el("span", { class: "badge ok" }, t("mk.you")) : ""))));
    const pl = prize ? (g.start === Math.min(g.end, 3) ? t("lb.place", { a: g.start }) : t("lb.places", { a: g.start, b: Math.min(g.end, 3) })) : "";
    body.append(el("tr", { class: (isMe ? "you-row " : "") + (prize ? "prize-row" : "") },
      el("td", {}, prize && g.start === g.end ? el("span", { class: "medal m" + g.start }, String(g.start)) : rankLabel(g)),
      el("td", {}, who),
      el("td", { class: "r num " + (Number(g.v) >= 0 ? "buy-t" : "sell-t") }, (Number(g.v) >= 0 ? "+" : "") + fmt(g.v)),
      el("td", {}, pl ? el("span", { class: "badge warn" }, pl) : "")));
  }
  tb.append(body);
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
    ...["q8", "q9", "q1", "q2", "q3", "q4", "q5", "q6", "q7"].map((q) => el("details", {}, el("summary", {}, t("ln." + q)), el("p", {}, t("ln." + q + "a")))),
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
  if (S.view === "leaders") renderLeaders();
  renderStartLeader();
}
function route() {
  const [v, k, id] = (location.hash || "#start").slice(1).split("/");
  if (v === "trade" && k === "o" && id) S.pendingOffer = decodeURIComponent(id);
  S.view = ["start", "trade", "account", "leaders", "market", "learn"].includes(v) ? v : "start";
  document.querySelectorAll(".view").forEach((n) => { n.hidden = n.id !== "view-" + S.view; });
  document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.view === S.view));
  renderAll();
  if (S.view === "trade") loadDesk();
  if (S.view === "market") loadMarket();
  if (S.view === "leaders" || S.view === "start") loadLeaders();
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
  $("lb-search").addEventListener("input", renderLeaders);
  S.ed25519 = await C.ed25519Supported();
  S.signer = await C.loadDeviceKey();
  S.watchDid = S.signer ? null : loadWatch();
  addEventListener("hashchange", route);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) document.title = t("doc.title"); });
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
  setInterval(() => { if (!document.hidden && (S.view === "leaders" || S.view === "start")) loadLeaders(); }, 60_000);
  setInterval(() => { if (!document.hidden && S.view === "account") Promise.all([loadFlow(), loadDesk()]).then(renderAccount); }, 60_000);
}
boot();
