/*
  "Where are you?" — asked by the app's owner, answered by choice.

  Asked for: the owner, talking with their child, wanted a button that asks
  where the child is right now — the place, the battery, the phone. Only the
  owner's device may ask: the question is signed with the owner's key, bound
  to the chat, and the other side shows it only if the app's own lock checks
  it. The other side always chooses; the answer goes sealed through the chat,
  and both sides are shown the same card.

  Here: the signature (against node's own crypto), the rules in guards.js,
  which addresses can have a city looked up (connstats.js), and the block
  "WHERE ARE YOU" lifted out of app.js and run as two devices — the owner's
  and the other side's — talking to each other.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs     = require("node:fs");
const path   = require("node:path");
const DC     = require("../protocol.js");
const G      = require("../guards.js");
const DCS    = require("../connstats.js");
const { p256 } = require("@noble/curves/p256");
const { META_CSP, DEFAULT_ALLOWED_ORIGINS, LOOKUP_ORIGINS } = require("../csp.js");

const ROOT = path.join(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8").replace(/\r\n/g, "\n");
const app = read("app.js");
const I18N = new Function("localStorage", `${read("i18n.js")}; return I18N;`)({ getItem: () => null });

const between = (from, to) => {
  const a = app.indexOf(from), b = app.indexOf(to, a);
  assert.ok(a > 0 && b > a, `${from} … ${to} not found in app.js`);
  return app.slice(a, b);
};
const fn = name => {
  const m = app.match(new RegExp(`^(?:async )?function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(m, `${name} not found as a top-level function in app.js`);
  return m[0];
};

const CODE  = "3f2a 91bc 07de 55a1 c0ff";     // this chat's verification code, the same on both sides
const OTHER = "9999 0000 1111 2222 3333";     // another chat's

let keysMemo = null;
/** The owner's keys from a code of their own, and a stranger's from another. */
async function keys() {
  if (!keysMemo) keysMemo = { owner: await DC.ownerKeys(DC.makeOwnerCode(), p256), stranger: await DC.ownerKeys(DC.makeOwnerCode(), p256) };
  return keysMemo;
}

/* ══════════════════════════════════════════
   The signature
══════════════════════════════════════════ */

test("a question's word: 16 random bytes in base64url, never the same twice", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const nonce = DC.makeWhereNonce();
    assert.match(nonce, /^[A-Za-z0-9_-]{22}$/);
    seen.add(nonce);
  }
  assert.equal(seen.size, 200);
});

test("signed by the owner for this chat, it checks; checked by node, it is ECDSA P-256 over exactly that", async () => {
  const { owner } = await keys();
  const nonce = DC.makeWhereNonce();
  const sig = await DC.signWhereAsk(owner, CODE, nonce);
  assert.match(sig, /^[A-Za-z0-9_-]{86}$/, "64 bytes, r‖s");
  assert.equal(await DC.checkWhereAsk(owner.lock, CODE, nonce, sig), true);
  const signKey = crypto.createPublicKey({ key: Buffer.concat([
    Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"),
    Buffer.from(owner.lock.split(".")[1], "base64url")]), format: "der", type: "spki" });
  assert.equal(crypto.verify("sha256", Buffer.from(JSON.stringify(["dc-where-1", CODE, nonce])),
    { key: signKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")), true);
});

test("it does not check for another chat, another word, a changed signature or anyone else's key", async () => {
  const { owner, stranger } = await keys();
  const nonce = DC.makeWhereNonce();
  const sig = await DC.signWhereAsk(owner, CODE, nonce);
  assert.equal(await DC.checkWhereAsk(owner.lock, OTHER, nonce, sig), false, "passed on to another chat");
  assert.equal(await DC.checkWhereAsk(owner.lock, CODE, DC.makeWhereNonce(), sig), false, "another word");
  const bent = Buffer.from(sig, "base64url"); bent[10] ^= 1;
  assert.equal(await DC.checkWhereAsk(owner.lock, CODE, nonce, bent.toString("base64url")), false, "a changed signature");
  assert.equal(await DC.checkWhereAsk(owner.lock, CODE, nonce, await DC.signWhereAsk(stranger, CODE, nonce)), false, "someone else's key");
  const swapped = owner.lock.split(".").reverse().join(".");
  assert.equal(await DC.checkWhereAsk(swapped, CODE, nonce, sig), false, "the lock's other key");
  for (const [lock, code, n, s] of [[null, CODE, nonce, sig], ["nonsense", CODE, nonce, sig], [owner.lock, "", nonce, sig],
                                    [owner.lock, CODE, 7, sig], [owner.lock, CODE, nonce, null], [owner.lock, CODE, nonce, "!!"]]) {
    assert.equal(await DC.checkWhereAsk(lock, code, n, s), false, "nothing that is not one throws, or passes");
  }
});

test("the app's own lock is one a question can be checked against", () => {
  assert.ok(DC.parseLock(DC.OWNER_LOCK), "OWNER_LOCK parses");
});

/* ══════════════════════════════════════════
   The rules
══════════════════════════════════════════ */

test("only the owner's device asks, and only in a checked chat", () => {
  for (const owner of [true, false, undefined]) for (const green of [true, false, undefined]) {
    assert.equal(G.mayAskWhere({ owner, green }), owner === true && green === true, JSON.stringify({ owner, green }));
  }
  assert.equal(G.mayAskWhere(null), false);
});

test("a question in the shape of one", () => {
  const ok = { nonce: "A".repeat(22), sig: "b".repeat(86) };
  assert.equal(G.whereAskValid(ok), true);
  for (const bad of [null, {}, { ...ok, nonce: "A".repeat(21) }, { ...ok, nonce: `${"A".repeat(21)}=` }, { ...ok, sig: "b".repeat(85) },
                     { ...ok, sig: 5 }, { nonce: ok.nonce }]) {
    assert.equal(G.whereAskValid(bad), false, JSON.stringify(bad));
  }
});

const NONCE = "N".repeat(22);
const FULL = {
  nonce: NONCE, loc: { lat: 47.918, lon: 106.917, acc: 12.4 }, battery: { level: 0.54, charging: true },
  os: "android", browser: "chrome", model: "SM-A546E", osVersion: "14.0.0", net: "cellular", speed: "4g",
  lang: "mn-MN", screen: { w: 412, h: 915 }
};

test("an answer to our question is kept to what it may say", () => {
  assert.deepEqual(G.whereAnswer(FULL, NONCE), {
    loc: { lat: 47.918, lon: 106.917, acc: 12 }, locError: null, battery: { level: 0.54, charging: true },
    os: "android", browser: "chrome", model: "SM-A546E", osVersion: "14.0.0", net: "cellular", speed: "4g",
    lang: "mn-MN", screen: { w: 412, h: 915 }
  });
  assert.equal(G.whereAnswer(FULL, "M".repeat(22)), null, "an answer to another question");
  assert.equal(G.whereAnswer(FULL, null), null, "no question asked");
  assert.equal(G.whereAnswer({ ...FULL, nonce: undefined }, NONCE), null);
  assert.equal(G.whereAnswer(null, NONCE), null);
  assert.equal(Object.hasOwn(G.whereAnswer({ ...FULL, html: "<b>x</b>" }, NONCE), "html"), false, "nothing else is copied");
});

test("a part out of shape is dropped, and the rest of the answer kept", () => {
  const with_ = o => G.whereAnswer({ ...FULL, ...o }, NONCE);
  for (const loc of [{ lat: 91, lon: 0, acc: 5 }, { lat: 0, lon: 181, acc: 5 }, { lat: 0, lon: 0, acc: -1 }, { lat: NaN, lon: 0, acc: 1 },
                     { lat: "47", lon: 106, acc: 5 }, null, "here"]) {
    const a = with_({ loc });
    assert.equal(a.loc, null, JSON.stringify(loc));
    assert.equal(a.locError, "unavailable");
    assert.equal(a.model, "SM-A546E", "the rest is kept");
  }
  for (const err of G.WHERE_LOC_ERRORS) assert.equal(with_({ loc: { err } }).locError, err);
  assert.equal(with_({ loc: { err: "<script>" } }).locError, "unavailable");
  for (const battery of [{ level: 1.2, charging: true }, { level: 0.5 }, { level: "50", charging: false }, 50]) {
    assert.equal(with_({ battery }).battery, null, JSON.stringify(battery));
  }
  for (const model of ["Pixel 8 Pro", "moto g(60)", "SM-A546E", "Redmi Note 12", "iPhone15,2"]) {
    assert.equal(with_({ model }).model, model.includes(",") ? "" : model, model);
  }
  for (const model of ["<img src=x onerror=alert(1)>", "✅ verified by server", "x".repeat(61), " ", "‮evil", 42]) {
    assert.equal(with_({ model }).model, "", String(model));
  }
  assert.equal(with_({ osVersion: "14.0.0; drop" }).osVersion, "");
  assert.equal(with_({ net: "5g" }).net, null);
  assert.equal(with_({ speed: "5g" }).speed, null);
  assert.equal(with_({ lang: "en-US<script>" }).lang, "");
  assert.equal(with_({ os: "Android 14" }).os, null, "a code, looked up in a fixed table where shown");
  assert.equal(with_({ screen: { w: 0, h: 900 } }).screen, null);
  assert.equal(with_({ screen: { w: 412.5, h: 900 } }).screen, null);
});

test("the city and provider from the address lookup: words only, short, the network number taken off", () => {
  assert.deepEqual(G.ipPlace({ ip: "202.131.0.1", city: "Ulaanbaatar", region: "Ulaanbaatar", country: "MN", org: "AS17882 Univision LLC" }),
    { city: "Ulaanbaatar", region: "Ulaanbaatar", country: "MN", provider: "Univision LLC" });
  assert.deepEqual(G.ipPlace({ city: "Seoul\u0007", country: "kr", org: "SK Broadband" }),
    { city: "Seoul", region: "", country: "", provider: "SK Broadband" });
  assert.equal(G.ipPlace({ city: "x".repeat(200) }).city.length, 80);
  for (const nothing of [null, "text", {}, { bogon: true, ip: "10.0.0.1" }, { city: 5, org: null }]) {
    assert.equal(G.ipPlace(nothing), null, JSON.stringify(nothing));
  }
});

test("a city is looked up only for an address on the open internet", () => {
  for (const ip of ["202.131.0.1", "8.8.8.8", "1.1.1.1", "100.63.255.255", "172.32.0.1", "2001:4860:4860::8888", "2a00:1450:4001::1"]) {
    assert.equal(DCS.isPublicAddress(ip), true, ip);
  }
  for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.60.78", "100.64.0.1", "100.127.0.1", "127.0.0.1",
                    "169.254.1.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "256.1.1.1", "fe80::1", "fd00::1", "fc00::1", "::1", "::",
                    "::ffff:8.8.8.8", "abc.local", "", null, 7]) {
    assert.equal(DCS.isPublicAddress(ip), false, String(ip));
  }
});

/* ══════════════════════════════════════════
   The block, run as two devices
══════════════════════════════════════════ */

const BLOCK = between("/* ══════════════════════════════════════════════\n   WHERE ARE YOU — ASKED BY THE OWNER",
                      "/* ══════════════════════════════════════════════\n   LEAVE A MESSAGE");

/** A few DOM elements: enough to draw the line and the card and read them back. */
function el(tag) {
  const e = {
    tagName: tag, children: [], parent: null, className: "", textContent: "", href: "", target: "", rel: "", type: "", onclick: null,
    classList: {
      has: c => e.className.split(" ").includes(c),
      contains: c => e.className.split(" ").includes(c),
      add: c => { if (!e.classList.has(c)) e.className = `${e.className} ${c}`.trim(); },
      toggle: (c, on) => { e.className = e.className.split(" ").filter(x => x && x !== c).concat(on ? [c] : []).join(" "); }
    },
    append(...xs) { for (const x of xs) { const n = typeof x === "string" ? { text: x } : x; n.parent = e; e.children.push(n); } },
    appendChild(x) { e.append(x); return x; },
    replaceChildren(...xs) { e.children = []; e.append(...xs); },
    remove() { if (e.parent) e.parent.children = e.parent.children.filter(c => c !== e); },
    querySelector(sel) {
      for (const c of e.children) {
        if (c.classList && c.classList.has(sel.slice(1))) return c;
        const deeper = c.querySelector && c.querySelector(sel);
        if (deeper) return deeper;
      }
      return null;
    },
    all(cls) { return e.children.flatMap(c => [...(c.classList && c.classList.has(cls) ? [c] : []), ...(c.all ? c.all(cls) : [])]); }
  };
  return e;
}
const text = n => (n.tagName ? `${n.textContent}${n.children.map(text).join("")}` : n.text);

/** One device: the block, with this side's chat, keys and phone stood in for. */
function device({ owner = null, lock, code = CODE, green = true, phone = {}, addresses = null, lookup = null, lang = "en" } = {}) {
  const log = { sent: [], toasts: [], sys: [], noticed: 0, fetched: [], geo: [] };
  const chatMessages = el("div");
  const whereBtn = el("button");
  whereBtn.className = "icon-btn hidden";
  const document = { createElement: el, createTextNode: s => ({ text: s }) };
  const navigator = {
    language: phone.lang ?? "mn-MN",
    ...(phone.geo === "none" ? {} : { geolocation: { getCurrentPosition: (ok, fail, opts) => {
      log.geo.push(opts);
      if (phone.geo === "denied") fail({ code: 1 }); else ok({ coords: { latitude: 47.918, longitude: 106.917, accuracy: 12.4 } });
    } } }),
    ...(phone.battery === false ? {} : { getBattery: async () => ({ level: 0.54, charging: true }) }),
    ...(phone.hints === false ? {} : { userAgentData: { getHighEntropyValues: async () => ({ model: "SM-A546E", platformVersion: "14.0.0" }) } }),
    ...(phone.connection === false ? {} : { connection: { type: "cellular", effectiveType: "4g" } })
  };
  const fetch = async (url, opts) => {
    log.fetched.push({ url, opts });
    if (lookup === "fail") throw new Error("offline");
    return { ok: true, json: async () => lookup || { ip: "202.131.0.1", city: "Ulaanbaatar", region: "Ulaanbaatar", country: "MN", org: "AS17882 Univision LLC" } };
  };
  const names = ["G", "DC", "DCS", "I18N", "LANG", "t", "document", "navigator", "screen", "fetch", "AbortSignal",
    "chatMessages", "whereBtn", "ownerKeysHere", "OWNER_LOCK", "e2eReady", "e2eSecureMode", "e2eVerified", "e2eVerifyCode",
    "MY_DEVICE", "_lastAddresses", "showToast", "dcSendE2e", "appendSys", "noticeArrival", "scrollBottom", "tablerIcon", "now", "log"];
  const values = [G, DC, DCS, I18N, lang, k => I18N[lang][k] ?? k, document, navigator, { width: 412, height: 915 }, fetch,
    { timeout: ms => ({ ms }) }, chatMessages, whereBtn, owner, lock, true, green, false, code,
    phone.device || { os: "android", browser: "chrome" }, addresses, m => log.toasts.push(m),
    async m => { log.sent.push(JSON.parse(JSON.stringify(m))); return true; }, s => log.sys.push(s), () => { log.noticed++; },
    () => {}, name => { const i = el("i"); i.className = `ti ti-${name}`; return i; }, () => "12:00", log];
  const api = new Function(...names, `${BLOCK}
    return { askWhere, receiveWhereAsk, receiveWhereAnswer, receiveWhereDecline, drawWhereBtn, shareWhere, declineWhere,
             state: () => ({ whereAsked, whereAskedHere }) };`)(...values);
  /** What arrives from the other side, handed to the case the switch would pick. */
  const deliver = m => ({ "where-ask": api.receiveWhereAsk, "where-answer": api.receiveWhereAnswer, "where-decline": api.receiveWhereDecline })[m.type](m);
  const line = () => chatMessages.querySelector(".where-sys");
  const buttons = () => { const l = line(); const a = l && l.querySelector(".where-sys-actions"); return a ? a.children : []; };
  const cards = () => chatMessages.all("where-card");
  /** A card's rows by their label: the value's element. */
  const rows = card => Object.fromEntries(card.children[1].children.map(r => [text(r.children[0]), r.children[1]]));
  return { api, log, chatMessages, whereBtn, deliver, line, buttons, cards, rows };
}

const settle = () => new Promise(r => setTimeout(r, 5));

/** The owner asks, and the other side gets it. */
async function asked(childOptions = {}, ownerOptions = {}) {
  const k = await keys();
  const owner = device({ owner: k.owner, lock: k.owner.lock, addresses: { local: "203.0.113.9", remote: "202.131.0.1" }, ...ownerOptions });
  const child = device({ lock: k.owner.lock, ...childOptions });
  await owner.api.askWhere();
  const question = owner.log.sent.at(-1);
  await child.deliver(question);
  return { owner, child, question, k };
}

test("the button: on the owner's device in a checked chat, and nowhere else", async () => {
  const { owner, stranger } = await keys();
  const show = o => { const d = device(o); d.api.drawWhereBtn(); return !d.whereBtn.classList.has("hidden"); };
  assert.equal(show({ owner, lock: owner.lock, green: true }), true);
  assert.equal(show({ owner, lock: owner.lock, green: false }), false, "an amber chat");
  assert.equal(show({ owner: null, lock: owner.lock, green: true }), false, "anyone else's device");
  void stranger;
});

test("asked: the question goes sealed, signed for this chat; the other side chooses, with two buttons", async () => {
  const { owner, child, question, k } = await asked();
  assert.equal(question.type, "where-ask");
  assert.equal(await DC.checkWhereAsk(k.owner.lock, CODE, question.nonce, question.sig), true);
  assert.deepEqual(owner.log.sys, ["whereAsked"].map(key => I18N.en[key]));
  assert.ok(child.line(), "the line is in the chat");
  assert.equal(text(child.line().children[0]), I18N.en.whereAskText);
  assert.deepEqual(child.buttons().map(text), [I18N.en.whereShare, I18N.en.whereNotNow]);
  assert.equal(child.log.noticed, 1, "told like a message");
  assert.deepEqual(child.log.sent, [], "nothing goes until they choose");
  assert.deepEqual(child.log.geo, [], "and the phone is not asked yet");
});

test("Share: the answer goes back sealed, and both sides see the same card", async () => {
  const { owner, child } = await asked();
  await child.buttons()[0].onclick();
  assert.deepEqual(child.log.geo, [{ enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }], "a fresh, precise position");
  const answer = child.log.sent.at(-1);
  assert.equal(answer.type, "where-answer");
  assert.equal(answer.nonce, owner.api.state().whereAsked.nonce, "answering the question asked");
  assert.equal(text(child.line()), I18N.en.whereSharedLine);
  assert.equal(child.cards().length, 1, "they see what they shared");

  await owner.deliver(answer);
  await settle();
  assert.equal(owner.api.state().whereAsked, null);
  const [card] = owner.cards();
  assert.ok(card.classList.has("theirs"));
  const r = owner.rows(card);
  assert.equal(text(r.Location), `47.91800, 106.91700 (±12 m) ${I18N.en.whereMap}`);
  const map = r.Location.children.find(c => c.tagName === "a");
  assert.equal(map.href, "https://www.google.com/maps?q=47.918000,106.917000");
  assert.equal(map.rel, "noopener noreferrer");
  assert.equal(map.target, "_blank");
  assert.equal(text(r["City, internet"]), "Ulaanbaatar, MN · Univision LLC (202.131.0.1)");
  assert.equal(text(r.Battery), "54% · charging");
  assert.equal(text(r.Phone), "Android · Chrome · 14.0.0 · SM-A546E");
  assert.equal(text(r.Network), "mobile data · 4g");
  assert.equal(text(r.Language), "mn-MN");
  assert.equal(text(r.Screen), "412×915");
  assert.equal(owner.log.noticed, 1);

  const mine = child.rows(child.cards()[0]);
  assert.equal(text(mine.Battery), "54% · charging", "the same values on their side");
  assert.equal(Object.hasOwn(mine, "City, internet"), false, "the lookup is the owner's");

  assert.deepEqual(owner.log.fetched.map(f => f.url), ["https://ipinfo.io/202.131.0.1/json"]);
  assert.equal(owner.log.fetched[0].opts.credentials, "omit");
  assert.equal(owner.log.fetched[0].opts.referrerPolicy, "no-referrer");
  assert.deepEqual(child.log.fetched, [], "the other side looks nothing up");
});

test("a question not signed by the owner is never shown, and nothing is said back", async () => {
  const k = await keys();
  const stranger = device({ owner: k.stranger, lock: k.stranger.lock });
  const child = device({ lock: k.owner.lock });
  await stranger.api.askWhere();
  await child.deliver(stranger.log.sent.at(-1));
  assert.equal(child.line(), null);
  assert.deepEqual(child.log.sent, []);
  assert.equal(child.log.noticed, 0);
});

test("a signed question passed on to another chat is not shown there", async () => {
  const { question, k } = await asked();
  const someoneElse = device({ lock: k.owner.lock, code: OTHER });
  await someoneElse.deliver(question);
  assert.equal(someoneElse.line(), null);
  assert.deepEqual(someoneElse.log.sent, []);
});

test("a chat not checked on their side: no choice is shown, and the owner is told why", async () => {
  const { owner, child } = await asked({ green: false });
  assert.equal(child.line(), null);
  assert.equal(child.log.sent.at(-1).type, "where-decline");
  assert.equal(child.log.sent.at(-1).reason, "unverified");
  await owner.deliver(child.log.sent.at(-1));
  assert.equal(owner.log.sys.at(-1), I18N.en.whereDeclinedUnverified);
  assert.equal(owner.api.state().whereAsked, null);
});

test("Not now: nothing about the phone goes, and the owner is told they chose not to", async () => {
  const { owner, child } = await asked();
  child.buttons()[1].onclick();
  assert.deepEqual(child.log.sent.map(m => Object.keys(m).sort()), [["nonce", "type"]]);
  assert.deepEqual(child.log.geo, []);
  assert.equal(text(child.line()), I18N.en.whereNotSharedLine);
  await owner.deliver(child.log.sent.at(-1));
  assert.equal(owner.log.sys.at(-1), I18N.en.whereDeclined);
  child.buttons()[0]?.onclick?.();
  assert.equal(child.log.sent.length, 1, "the buttons are gone with the choice");
});

test("location not allowed on the phone: the rest is still shared, and the card says so", async () => {
  const { owner, child } = await asked({ phone: { geo: "denied" } });
  await child.buttons()[0].onclick();
  await owner.deliver(child.log.sent.at(-1));
  const r = owner.rows(owner.cards()[0]);
  assert.equal(text(r.Location), I18N.en.whereLocDenied);
  assert.equal(r.Location.children.length, 0, "no map link");
  assert.equal(text(r.Battery), "54% · charging");
});

test("an iPhone: no battery, no model, no network type — said as unknown, not guessed", async () => {
  const { owner, child } = await asked({ phone: { battery: false, hints: false, connection: false, device: { os: "iphone", browser: "safari" } } });
  await child.buttons()[0].onclick();
  await owner.deliver(child.log.sent.at(-1));
  const r = owner.rows(owner.cards()[0]);
  assert.equal(text(r.Battery), I18N.en.whereNotAvailable);
  assert.equal(text(r.Phone), "iPhone · Safari");
  assert.equal(text(r.Network), I18N.en.whereNotAvailable);
});

test("an answer nobody asked for, to another question, or a second time, is not shown", async () => {
  const { owner, child } = await asked();
  const k = await keys();
  const fresh = device({ owner: k.owner, lock: k.owner.lock });
  await fresh.deliver({ type: "where-answer", ...FULL });
  assert.equal(fresh.cards().length, 0, "never asked");

  await owner.deliver({ type: "where-answer", ...FULL, nonce: "Z".repeat(22) });
  assert.equal(owner.cards().length, 0, "another question's word");
  await owner.deliver({ type: "where-decline", nonce: "Z".repeat(22) });
  assert.deepEqual(owner.log.sys, [I18N.en.whereAsked], "nor its no");

  await child.buttons()[0].onclick();
  const answer = child.log.sent.at(-1);
  await owner.deliver(answer);
  await owner.deliver(answer);
  assert.equal(owner.cards().length, 1, "once");
});

test("the city is looked up only for an address on the open internet, seen by this side", async () => {
  const run = async (addresses, lookup) => {
    const { owner, child } = await asked({}, { addresses, lookup });
    await child.buttons()[0].onclick();
    await owner.deliver(child.log.sent.at(-1));
    await settle();
    return { place: text(owner.rows(owner.cards()[0])["City, internet"]), fetched: owner.log.fetched };
  };
  const local = await run({ local: "192.168.60.78", remote: "192.168.60.5" });
  assert.equal(local.place, I18N.en.wherePlaceLocal);
  assert.deepEqual(local.fetched, []);
  const none = await run(null);
  assert.equal(none.place, I18N.en.whereNotAvailable);
  assert.deepEqual(none.fetched, []);
  const failed = await run({ local: "203.0.113.9", remote: "202.131.0.1" }, "fail");
  assert.equal(failed.place, `${I18N.en.whereNotAvailable} (202.131.0.1)`);
});

test("asked again while the first is on screen: one line, at the end, answering the newest", async () => {
  const { owner, child } = await asked();
  await owner.api.askWhere();
  await child.deliver(owner.log.sent.at(-1));
  assert.equal(child.chatMessages.all("where-sys").length, 1);
  assert.equal(child.chatMessages.children.at(-1), child.line());
  await child.buttons()[0].onclick();
  assert.equal(child.log.sent.at(-1).nonce, owner.log.sent.at(-1).nonce);
  await owner.deliver(child.log.sent.at(-1));
  assert.equal(owner.cards().length, 1);
});

test("in Mongolian too", async () => {
  const { owner, child } = await asked({ lang: "mn" }, { lang: "mn" });
  assert.equal(text(child.line().children[0]), I18N.mn.whereAskText);
  await child.buttons()[0].onclick();
  await owner.deliver(child.log.sent.at(-1));
  assert.equal(text(owner.rows(owner.cards()[0]).Батерей), `54% · ${I18N.mn.whereCharging}`);
});

/* ══════════════════════════════════════════
   The wiring
══════════════════════════════════════════ */

test("the three messages are sealed only, and each reaches its own handler", () => {
  for (const type of ["where-ask", "where-answer", "where-decline"]) {
    assert.equal(G.CLEAR_TYPES.includes(type), false, `${type} is believed only sealed`);
  }
  assert.match(between('    case "where-ask":', "      break;"), /receiveWhereAsk\(data\);/);
  assert.match(between('    case "where-answer":', "      break;"), /receiveWhereAnswer\(data\);/);
  assert.match(between('    case "where-decline":', "      break;"), /receiveWhereDecline\(data\);/);
  assert.doesNotMatch(BLOCK, /wsSend\(/, "never through the server");
});

test("a question is shown only after its shape, the owner's signature and a checked chat", () => {
  const body = fn("receiveWhereAsk");
  const shape = body.indexOf("G.whereAskValid(data)"), signed = body.indexOf("DC.checkWhereAsk(OWNER_LOCK, code,"),
        green = body.indexOf("chatGreen()"), shown = body.indexOf('drawWhereChoice("ask")');
  assert.ok(shape > -1 && signed > shape && green > signed && shown > green, "in that order");
});

test("the button follows the shield and the owner code, and a closed channel takes the question with it", () => {
  assert.match(fn("updateShield"), /drawWhereBtn\(\);/);
  assert.match(fn("ownerFromCode"), /drawOwner\(\);\s*\n\s*drawWhereBtn\(\);/);
  assert.match(fn("closePeerConnection"), /whereAsked = null;[\s\S]*?whereAskedHere = null;/);
  assert.match(read("index.html"), /<button id="whereBtn" class="icon-btn hidden"/, "hidden until drawn");
  assert.doesNotMatch(BLOCK, /innerHTML/, "every value goes in as text");
});

test("the lookup is allowed for the page only, and the Pi's copy may ask for the location", () => {
  assert.deepEqual(LOOKUP_ORIGINS, ["https://ipinfo.io"]);
  assert.ok(META_CSP.match(/connect-src ([^;]*)/)[1].split(" ").includes("https://ipinfo.io"));
  assert.equal(DEFAULT_ALLOWED_ORIGINS.includes("https://ipinfo.io"), false, "not an origin the server lets in");
  assert.match(read("index.html"), /connect-src [^"]*https:\/\/ipinfo\.io/);
  assert.match(read("server.js"), /"Permissions-Policy", "camera=\(self\), microphone=\(self\), geolocation=\(self\), payment=\(\), usb=\(\)"/);
});
