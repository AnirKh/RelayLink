/*
  Opened inside another app's browser — Facebook's, Instagram's, Messenger's.

  A link sent through those apps opens in their own built-in browser, which
  the app runs: it can add its own code to the page, it often may not use the
  camera or microphone, and it closes, chat and all, when the app is left.
  The page now says so first and offers the ways out — and, while it does,
  keeps the invite in the address (so the app's "Open in browser" carries it)
  and joins nothing (so the seat goes to the browser the friend opens next).

  G.inAppBrowser, G.inAppAdvice, G.safariUrl and G.androidIntentUrl are the
  rules, checked against the user agents those apps really send. The two
  pieces of app.js — the hold at load, and the notice — are lifted out and run
  against stand-ins.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");
const G      = require("../guards.js");

const read = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\r\n/g, "\n");
const app  = read("app.js");
const I18N = new Function("localStorage", `${read("i18n.js")}; return I18N;`)({ getItem: () => null });
const between = (from, to) => {
  const a = app.indexOf(from), b = app.indexOf(to, a);
  assert.ok(a > 0 && b > a, `${from} … ${to} not found in app.js`);
  return app.slice(a, b);
};

const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID_WV = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UD1A.230803.041; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.6422.165 Mobile Safari/537.36";
const APPS = {
  "Instagram (iPhone)": [`${IOS} Instagram 337.0.3.23.54 (iPhone14,5; iOS 17_5; en_US; en; scale=3.00; 1170x2532; 618268209; IABMV/1)`, "Instagram", "ios"],
  "Facebook (iPhone)":  [`${IOS} [FBAN/FBIOS;FBAV/470.0.0.37.104;FBBV/642191052;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]`, "Facebook", "ios"],
  "Messenger (iPhone)": [`${IOS} [FBAN/MessengerForiOS;FBAV/470.0.0.37.104;FBBV/642191052;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBCR/;FBID/phone;FBLC/en_US;FBOP/5]`, "Messenger", "ios"],
  "Facebook (Android)": [`${ANDROID_WV} [FB_IAB/FB4A;FBAV/470.0.0.43.108;]`, "Facebook", "android"],
  "Messenger (Android)": [`${ANDROID_WV} [FB_IAB/Orca-Android;FBAV/470.0.0.18.108;]`, "Messenger", "android"],
  "Instagram (Android)": [`${ANDROID_WV} Instagram 337.0.0.35.102 Android (34/14; 420dpi; 1080x2400; Google/google; Pixel 8; shiba; shiba; en_US; 618254306)`, "Instagram", "android"],
  "TikTok": [`${ANDROID_WV} musical_ly_2023405030 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/musical_ly`, "TikTok", "android"],
  "LINE": [`${IOS} Safari Line/14.8.0`, "LINE", "ios"],
  "Snapchat": [`${IOS} Snapchat/12.90.0.46 (like Safari/8618.2.12.10.4, panda)`, "Snapchat", "ios"],
  "WeChat": [`${IOS} MicroMessenger/8.0.49(0x18003133) NetType/WIFI Language/zh_CN`, "WeChat", "ios"]
};
const BROWSERS = {
  "Safari (iPhone)": `${IOS.replace("Mobile/15E148", "Version/17.5 Mobile/15E148")} Safari/604.1`,
  "Chrome (iPhone)": `${IOS.replace("Mobile/15E148", "CriOS/125.0.6422.80 Mobile/15E148")} Safari/604.1`,
  "Firefox (iPhone)": `${IOS.replace("Mobile/15E148", "FxiOS/127.0 Mobile/15E148")} Safari/605.1.15`,
  "Chrome (Android)": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  "Samsung Internet": "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  "Chrome (Windows)": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Safari (Mac)": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"
};

/* ══════════════════════════════════════════
   The rules
══════════════════════════════════════════ */

for (const [name, [userAgent, appName, os]] of Object.entries(APPS)) {
  test(`${name}: recognised, by name`, () => {
    assert.deepEqual(G.inAppBrowser({ userAgent, maxTouchPoints: os === "ios" ? 5 : 0 }), { app: appName, os });
  });
}

test("an app's browser with no name we know is still recognised — on Android and on an iPhone", () => {
  assert.deepEqual(G.inAppBrowser({ userAgent: ANDROID_WV, maxTouchPoints: 5 }), { app: null, os: "android" });
  assert.deepEqual(G.inAppBrowser({ userAgent: IOS, maxTouchPoints: 5 }), { app: null, os: "ios" });
});

for (const [name, userAgent] of Object.entries(BROWSERS)) {
  test(`${name}: a real browser, left alone`, () => {
    assert.equal(G.inAppBrowser({ userAgent, maxTouchPoints: /iPhone|Android/.test(userAgent) ? 5 : 0 }), null);
  });
}

test("our own app, installed on an iPhone's home screen, is never taken for one — its user agent does not say Safari either", () => {
  assert.equal(G.inAppBrowser({ userAgent: IOS, maxTouchPoints: 5, standalone: true }), null);
  assert.equal(G.inAppBrowser({ userAgent: "", maxTouchPoints: 5 }), null);
  assert.equal(G.inAppBrowser(undefined), null);
});

test("the ways out: Safari on an iPhone; the default browser on Android, but only with no invite to carry", () => {
  assert.deepEqual(G.inAppAdvice({ inApp: { app: "Instagram", os: "ios" }, hasInvite: true }), { safari: true, openDefault: false });
  assert.deepEqual(G.inAppAdvice({ inApp: { app: "Facebook", os: "android" }, hasInvite: false }), { safari: false, openDefault: true });
  assert.deepEqual(G.inAppAdvice({ inApp: { app: "Facebook", os: "android" }, hasInvite: true }), { safari: false, openDefault: false },
    "Android's way loses the #fragment, and with it the invite's secret");
  assert.deepEqual(G.inAppAdvice({ inApp: null }), { safari: false, openDefault: false });
});

test("Safari is handed the whole address, the invite's fragment included", () => {
  const invite = "https://anirkh.github.io/RelayLink/#bat-room:tok:secret";
  assert.equal(G.safariUrl(invite), `x-safari-${invite}`);
  for (const bad of ["javascript:alert(1)", "intent://x", "", null, 5]) assert.equal(G.safariUrl(bad), null, String(bad));
});

test("Android's default browser is offered only an address with no fragment", () => {
  assert.equal(G.androidIntentUrl("https://anirkh.github.io/RelayLink/"),
               "intent://anirkh.github.io/RelayLink/#Intent;scheme=https;end");
  assert.equal(G.androidIntentUrl("https://anirkh.github.io/RelayLink/?r=1"),
               "intent://anirkh.github.io/RelayLink/?r=1#Intent;scheme=https;end");
  assert.equal(G.androidIntentUrl("https://anirkh.github.io/RelayLink/#bat-room:tok:secret"), null,
    "never with an invite: the secret could not ride along, and must not be put anywhere else");
  for (const bad of ["http://anirkh.github.io/", "not a url", "", null]) assert.equal(G.androidIntentUrl(bad), null, String(bad));
});

/* ══════════════════════════════════════════
   The page, run
══════════════════════════════════════════ */

const HOLD   = between("/* Opened inside another app's own browser", "if (_isAutoJoin && !inAppHold)");
const NOTICE = between("/* ── Opened inside another app's browser ───", "/* ── Tabs: Rooms | Create room | Email ──");

function classes(initial = []) {
  const set = new Set(initial);
  return { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)) };
}

function open({ userAgent, invite = true, chosen = false, socketOpen = true, standalone = false }) {
  const hash = invite ? "#bat-room:tok:secret" : "";
  const location = { pathname: "/RelayLink/", hash, href: `https://anirkh.github.io/RelayLink/${hash}` };
  const log = { replaced: [], joins: 0, toasts: [], copied: [], timers: [] };
  const store = new Map(chosen ? [["dc-inapp-continue", "1"]] : []);
  const els = {};
  for (const id of ["inAppOverlay", "inAppText", "inAppNote", "inAppSafariBtn", "inAppDefaultBtn", "inAppCopyBtn", "inAppContinueBtn"]) {
    els[id] = { id, textContent: "", dataset: {}, onclick: null, classList: classes(["hidden"]) };
  }
  const api = new Function(
    "G", "t", "I18N", "LANG", "navigator", "location", "history", "sessionStorage", "document", "ws", "WebSocket",
    "checkAutoJoin", "showToast", "setTimeout", "runningInstalled", "_isAutoJoin",
    `${HOLD}
     if (_isAutoJoin && !inAppHold) history.replaceState({}, "", location.pathname);
     ${NOTICE}
     return { held: () => inAppHold };`
  )(G, k => I18N.en[k], I18N, "en",
    { userAgent, maxTouchPoints: 5, clipboard: { writeText: t => { log.copied.push(t); return Promise.resolve(); } } },
    location, { replaceState: (s, title, url) => { log.replaced.push(url); location.hash = ""; location.href = `https://anirkh.github.io${url}`; } },
    { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    { getElementById: id => els[id], createElement: () => ({}), body: { appendChild() {} }, execCommand() {} },
    { readyState: socketOpen ? 1 : 0 }, { OPEN: 1 }, () => log.joins++, m => log.toasts.push(m),
    (f, ms) => log.timers.push({ f, ms }), () => standalone, invite);
  const shown = id => !els[id].classList.contains("hidden");
  return { ...api, log, els, location, store, shown };
}

const IG_IPHONE = APPS["Instagram (iPhone)"][0];
const FB_ANDROID = APPS["Facebook (Android)"][0];

test("Instagram on an iPhone, with an invite: the notice, Safari offered, the invite left in the address, nothing joined", () => {
  const p = open({ userAgent: IG_IPHONE });
  assert.equal(p.shown("inAppOverlay"), true);
  assert.match(p.els.inAppText.textContent, /inside Instagram/);
  assert.equal(p.shown("inAppSafariBtn"), true);
  assert.equal(p.shown("inAppDefaultBtn"), false);
  assert.deepEqual(p.log.replaced, [], "the invite stays in the address, so the app's Open in browser carries it");
  assert.equal(p.held(), true);
});

test("Open in Safari hands Safari the whole address; if the app blocks it, the note says what else to do", () => {
  const p = open({ userAgent: IG_IPHONE });
  p.els.inAppSafariBtn.onclick();
  assert.equal(p.location.href, "x-safari-https://anirkh.github.io/RelayLink/#bat-room:tok:secret");
  assert.equal(p.log.timers[0].ms, 1500);
  p.log.timers[0].f();
  assert.equal(p.els.inAppNote.textContent, I18N.en.inAppIfNothing);
});

test("Copy link copies the whole invite", async () => {
  const p = open({ userAgent: IG_IPHONE });
  p.els.inAppCopyBtn.onclick();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(p.log.copied, ["https://anirkh.github.io/RelayLink/#bat-room:tok:secret"]);
  assert.deepEqual(p.log.toasts, [I18N.en.inAppCopied]);
});

test("Continue here: the notice goes, the address is tidied, the invite joins — and it is not asked again in this tab", () => {
  const p = open({ userAgent: IG_IPHONE });
  p.els.inAppContinueBtn.onclick();
  assert.equal(p.shown("inAppOverlay"), false);
  assert.equal(p.held(), false);
  assert.deepEqual(p.log.replaced, ["/RelayLink/"]);
  assert.equal(p.log.joins, 1);
  assert.equal(p.store.get("dc-inapp-continue"), "1");

  const again = open({ userAgent: IG_IPHONE, chosen: true });
  assert.equal(again.shown("inAppOverlay"), false);
  assert.deepEqual(again.log.replaced, ["/RelayLink/"], "an ordinary invite page from then on");
});

test("Continue here before the server link is up joins when it comes up, not into nothing", () => {
  const p = open({ userAgent: IG_IPHONE, socketOpen: false });
  p.els.inAppContinueBtn.onclick();
  assert.equal(p.log.joins, 0, "the socket opening calls checkAutoJoin itself");
});

test("Facebook on Android: the default browser offered for the site, but not for an invite", () => {
  const site = open({ userAgent: FB_ANDROID, invite: false });
  assert.equal(site.shown("inAppDefaultBtn"), true);
  site.els.inAppDefaultBtn.onclick();
  assert.equal(site.location.href, "intent://anirkh.github.io/RelayLink/#Intent;scheme=https;end");

  const invite = open({ userAgent: FB_ANDROID });
  assert.equal(invite.shown("inAppDefaultBtn"), false);
  assert.equal(invite.shown("inAppSafariBtn"), false);
});

test("an app's browser with no name we know gets the general wording", () => {
  const p = open({ userAgent: ANDROID_WV });
  assert.equal(p.els.inAppText.textContent, I18N.en.inAppTextUnknown);
});

test("a real browser gets no notice and the usual tidy address", () => {
  const p = open({ userAgent: BROWSERS["Safari (iPhone)"] });
  assert.equal(p.shown("inAppOverlay"), false);
  assert.equal(p.held(), false);
  assert.deepEqual(p.log.replaced, ["/RelayLink/"]);
});

/* ══════════════════════════════════════════
   The wiring
══════════════════════════════════════════ */

test("nothing joins while the notice is up", () => {
  const check = app.match(/^function checkAutoJoin\(\)\s*\{[\s\S]*?^\}/m)[0];
  /* Other reasons not to join may follow the hold (inviteMovedAway); the hold
     itself must be there. */
  assert.match(check, /if \(!_isAutoJoin \|\| _autoJoinSent \|\| inAppHold( \|\| \w+)*\) return;/);
});

test("the notice's text, which names the app, is redrawn in the other language too", () => {
  assert.match(app, /else if \(typeof val === "function" && "i18nArg" in el\.dataset\) el\.textContent = val\(el\.dataset\.i18nArg\);/);
  for (const lang of ["mn", "en"]) assert.match(I18N[lang].inAppText("Instagram"), /Instagram/);
});

test("the page carries the notice and its four buttons", () => {
  const html = read("index.html");
  assert.match(html, /<div id="inAppOverlay" class="overlay hidden">/);
  for (const id of ["inAppSafariBtn", "inAppDefaultBtn", "inAppCopyBtn", "inAppContinueBtn"]) assert.match(html, new RegExp(`id="${id}"`));
});
