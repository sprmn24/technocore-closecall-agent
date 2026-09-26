import * as C from "../../closecall/web/core.js";
import fs from "fs";
const eq = (a, b, m) => { if (a !== b) { console.error("FAIL", m, a, "!=", b); process.exitCode = 1; } else console.log("ok", m); };
const golden = [["11".repeat(32), "did:key:z6MktULudTtAsAhRegYPiZ6631RV3viv12qd4GQF8z1xB22S", "Y5zTkL4o2FRJBhz7BN1Kp2RwWwTyzKWBu88_BLOIX4fbzAVVqIhCRavfMKrUsKzG2cocUBCFlsOGlSDVvYWHBw"],
  ["alice passphrase", "did:key:z6MknXamaMKvJQPsnZ7BkipJyxbpaJ9Fcmbnk4iQmyBF64MS", "LEFSIMqnJbv4ta-oZTDV1tBqHlXSyXXOvbjC4RknBNF8dCQ7mtpdzok0vzwTGSEj2W2v-t2xIhOsEinya-EwDw"]];
for (const [seed, did, sig] of golden) {
  const s = await C.signerFromSeed(await C.seedFromInput(seed));
  eq(s.did, did, "did " + seed.slice(0, 8));
  eq(await s.sign('close1|123|{"a":1}'), sig, "sig " + seed.slice(0, 8));
  eq(await C.verify(did, 'close1|123|{"a":1}', sig), true, "verify");
  eq(await C.verify(did, 'close1|124|{"a":1}', sig), false, "verify tampered");
}
const real = JSON.parse(fs.readFileSync(new URL("../live_trade_close1_seq3011939.json", import.meta.url), "utf8"));
eq(await C.checkTrade(real), null, "real live trade verifies");
const bad = structuredClone(real); bad.terms.px = "200.00";
eq(await C.checkTrade(bad), "maker signature does not verify", "tampered real trade");
eq(C.canonical({ t: "owner", season: "close-1", key: "k" }), '{"key":"k","season":"close-1","t":"owner"}', "canonical");
eq(C.maxQtyC(1_000_000n, 22440n), 4412n, "max qty at 224.40");
const f = C.sideFees("buy", 200n, 18120n, 18040n); eq(f.maker, 3.624, "fee buyer"); eq(f.taker, 3.624, "fee seller");
const g = C.sideFees("buy", 1000n, 17000n, 18000n); eq(g.maker, 100, "clawback buyer"); eq(g.taker, 17, "seller base");
eq(C.withinLimits(23560n, 22439n), true, "limit hi in"); eq(C.withinLimits(23562n, 22439n), false, "limit hi out");
eq(C.sweepTime(2556), Date.parse("2026-10-04T09:00:00Z"), "lock");
const v = await C.sealSeed(await C.seedFromInput("11".repeat(32)), "correct horse", golden[0][1]);
eq(C.bytesToHex(await C.openSeed(v, "correct horse")), "11".repeat(32), "vault roundtrip");
try { await C.openSeed(v, "wrong"); eq(1, 0, "vault wrong pw"); } catch (e) { eq(e.message, "wrong password", "vault wrong pw"); }

if (process.exitCode) console.error("FAILED"); else console.log("all core tests passed");
