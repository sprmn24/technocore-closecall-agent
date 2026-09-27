// UI strings, one module per language under i18n/. English is the source; every other
// language must cover every key (tests/web/i18n.test.mjs). Values are plain text, never HTML.
import en from "./i18n/en.js";
import tr from "./i18n/tr.js";
import fr from "./i18n/fr.js";
import ar from "./i18n/ar.js";
import pt from "./i18n/pt.js";
import ja from "./i18n/ja.js";
import ko from "./i18n/ko.js";

export const STRINGS = { en, pt, ja, ko, ar, tr, fr };
/** BCP-47 tag for <html lang> */
export const HTML_LANG = { en: "en", pt: "pt-BR", ja: "ja", ko: "ko", ar: "ar", tr: "tr", fr: "fr" };
export const RTL = new Set(["ar"]);
