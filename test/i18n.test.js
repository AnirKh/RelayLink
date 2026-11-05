/*
  Every word index.html asks i18n.js for, in both languages.

  t() and applyI18n() fall back quietly: a key missing from one language shows
  the Mongolian text left in the markup to an English reader, or the key's own
  name. Neither throws and neither looks broken on the side that was tested.

  Also here: the page opens straight to the lobby, the title row clear of the
  fixed language switcher. (What the page is for was once a dialog in front of
  every visit, then an "about" dropdown beside the title; both are gone now —
  the author's panel says who made it and why.)

  And: the page starts when the browser keeps nothing. With cookies blocked,
  or in an app's web view without storage, reading the saved language threw,
  I18N was never made, and the page looked normal with nothing working.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");
const vm     = require("node:vm");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const html = read("index.html");
const css  = read("style.css");
const I18N = new Function("localStorage", `${read("i18n.js")}; return I18N;`)({ getItem: () => null });

const withoutCssComments = src => src.replace(/\/\*[\s\S]*?\*\//g, "");

test("both languages have the same keys, of the same kind", () => {
  /* A key missing from one language shows "undefined" in that language only —
     the one nobody tested in. */
  const mn = Object.keys(I18N.mn).sort(), en = Object.keys(I18N.en).sort();
  assert.deepEqual(mn, en);
  for (const key of mn) {
    assert.equal(typeof I18N.mn[key], typeof I18N.en[key], `${key} is a ${typeof I18N.mn[key]} in mn, a ${typeof I18N.en[key]} in en`);
  }
});

test("every key app.js asks for by name exists in both languages", () => {
  const app = read("app.js");
  const keys = new Set([
    ...[...app.matchAll(/\bt\("([A-Za-z0-9_]+)"\)/g)].map(m => m[1]),
    ...[...app.matchAll(/I18N\[LANG\]\.([A-Za-z0-9_]+)/g)].map(m => m[1])
  ]);
  assert.ok(keys.size > 50, `expected app.js's keys, found ${keys.size}`);
  for (const key of keys) {
    for (const lang of ["mn", "en"]) assert.ok(key in I18N[lang], `${lang}.${key} is missing`);
  }
});

test("every key the page names exists in both languages", () => {
  const keys = new Set();
  for (const attr of ["data-i18n", "data-i18n-ph", "data-i18n-aria"]) {
    for (const m of html.matchAll(new RegExp(`${attr}="([^"]+)"`, "g"))) keys.add(m[1]);
  }
  assert.ok(keys.size > 20, `expected the page's keys, found ${keys.size}`);
  for (const key of keys) {
    for (const lang of ["mn", "en"]) {
      /* leaveHint is the one function, sized at run time — see applyI18n. */
      const kind = key === "leaveHint" ? "function" : "string";
      assert.equal(typeof I18N[lang][key], kind, `${lang}.${key} is missing`);
    }
  }
});

/* ══════════════════════════════════════════
   A browser that keeps nothing
══════════════════════════════════════════ */

/** i18n.js run as the page runs it, with `localStorage` as the given getter. */
function loadI18n(getStorage) {
  const sandbox = {};
  Object.defineProperty(sandbox, "localStorage", { get: getStorage });
  vm.createContext(sandbox);
  const { LANG, made } = vm.runInContext(`${read("i18n.js")}\n;({ LANG, made: typeof I18N === "object" && "en" in I18N })`, sandbox);
  return { LANG, made };      // out of the sandbox, so deepEqual compares like with like
}

test("storage blocked or missing: the page still starts, in Mongolian — it used to be dead", () => {
  /* Cookies blocked: reading the property throws, as Chrome, Edge, Firefox and
     Safari all do. An app's web view that never switched storage on: null. */
  const denied = () => { throw Object.assign(new Error("Access is denied for this document."), { name: "SecurityError" }); };
  assert.deepEqual(loadI18n(denied), { LANG: "mn", made: true });
  assert.deepEqual(loadI18n(() => null), { LANG: "mn", made: true });
  assert.deepEqual(loadI18n(() => ({ getItem() { throw new Error("quota"); } })), { LANG: "mn", made: true });
});

test("the language picked last time still comes back, and nothing else is believed", () => {
  const stored = value => () => ({ getItem: key => (key === "lang" ? value : null) });
  assert.equal(loadI18n(stored("en")).LANG, "en");
  assert.equal(loadI18n(stored("mn")).LANG, "mn");
  assert.equal(loadI18n(stored(null)).LANG, "mn", "nothing picked yet");
  assert.equal(loadI18n(stored("xx")).LANG, "mn", "a language this page does not have would leave I18N[LANG] undefined");
});

test("switching language works with storage blocked; it is only not remembered", () => {
  const app = read("app.js").replace(/\r\n/g, "\n");
  const a = app.indexOf("/* ── Language switcher"), b = app.indexOf("/* ── DOM refs");
  assert.ok(a > 0 && b > a, "language switcher block not found");
  const enBtn = { dataset: { lang: "en" } };
  const seen = new Function("document", "localStorage", "applyI18n", `
    let LANG = "mn";
    ${app.slice(a, b)}
    document.buttons[0].onclick();
    return LANG;`
  )({ querySelectorAll: () => [enBtn], buttons: [enBtn] },
    { setItem() { throw Object.assign(new Error("denied"), { name: "SecurityError" }); } }, () => {});
  assert.equal(seen, "en");
});

test("the page opens straight to the lobby", () => {
  assert.ok(!/id="approveBtn"/.test(html), "the approve dialog is back");
  assert.ok(!/id="overlay"/.test(html), "the approve dialog is back");
});

test("the lobby title row starts below the language switcher on a phone", () => {
  /* The switcher is fixed in the top-right corner, and below 480px the title
     row reaches it: the title sat underneath it. Measured clear at 320, 360,
     375 and 414px wide. */
  const phone = withoutCssComments(css).match(/@media \(max-width: 480px\) \{([\s\S]*?)\n\}/);
  assert.ok(phone, "phone media query not found");
  assert.match(phone[1], /\.lobby-head\s*\{[^}]*margin-top:\s*28px/);
});
