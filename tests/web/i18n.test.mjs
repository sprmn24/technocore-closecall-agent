import { STRINGS } from "../../closecall/web/i18n.js";
import fs from "fs";
const js = fs.readFileSync(new URL("../../closecall/web/app.js", import.meta.url), "utf8"), html = fs.readFileSync(new URL("../../closecall/web/index.html", import.meta.url), "utf8");
const used = new Set();
for (const m of js.matchAll(/\bt\("([a-z0-9_.]+)"/g)) used.add(m[1]);
for (const m of js.matchAll(/sec\(([^)]*)\)/g)) for (const k of m[1].matchAll(/"([a-z0-9_.]+)"/g)) used.add(k[1]);
for (const q of ["q1","q2","q3","q4","q5","q6","q7"]) { used.add("ln." + q); used.add("ln." + q + "a"); }
for (const m of html.matchAll(/data-i18n(?:-title)?="([^"]+)"/g)) used.add(m[1]);
const en = STRINGS.en; let bad = 0;
for (const k of used) if (!(k in en) && !["ln.", "reason."].includes(k)) { console.log("missing in en:", k); bad++; }
for (const [lang, d] of Object.entries(STRINGS)) {
  for (const k of Object.keys(en)) {
    if (!(k in d)) { console.log(`missing in ${lang}:`, k); bad++; continue; }
    const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map(x => x[1]).sort().join(",");
    if (ph(en[k]) !== ph(d[k])) { console.log(`placeholder mismatch ${lang}:`, k); bad++; }
  }
  for (const k of Object.keys(d)) if (!(k in en)) { console.log(`extra in ${lang}:`, k); bad++; }
}
const unused = Object.keys(en).filter(k => !used.has(k) && !k.startsWith("reason."));
console.log("keys used:", used.size, "en:", Object.keys(en).length, "problems:", bad);
if (bad) process.exitCode = 1;
