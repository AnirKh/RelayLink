/*
  Saved people — actually run.

  Talking to the same person again took a room made from nothing each time: a
  name typed, a kind picked, a link copied and sent through another app, and
  tapped. Two people who have saved each other now just tap the other's name:
  whoever is first waits, the second tap connects them, green.

  The rules are in guards.js, the room's name in protocol.js, the meeting in
  server.js (see test/integration). The block "SAVED PEOPLE" is lifted out of
  app.js and run against a small stand-in page.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");
const crypto = require("node:crypto");
const G      = require("../guards.js");
const DC     = require("../protocol.js");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8").replace(/\r\n/g, "\n");
const app    = read("app.js");
const html   = read("index.html");
const server = read("server.js");
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

async function person(name, side = "a") {
  const secret = DC.makeRoomSecret();
  return { name, secret, room: await DC.savedRoomName(secret), side, savedAt: 1 };
}

/* ══════════════════════════════════════════
   The rules
══════════════════════════════════════════ */

test("a name is kept as typed, tidied: spaces, invisible marks and the length", () => {
  assert.equal(G.personName("  Anu  "), "Anu");
  assert.equal(G.personName("Anu\n\t  Bat"), "Anu Bat");
  assert.equal(G.personName("An\u0000u​"), "Anu", "control characters and zero-width spaces go");
  assert.equal(G.personName("‮unA"), "unA", "nothing that turns the text round");
  assert.equal(G.personName("👨‍👩‍👧 family"), "👨‍👩‍👧 family", "an emoji made of several keeps its joins");
  assert.equal(G.personName("x".repeat(60)), "x".repeat(G.PERSON_NAME_MAX));
  assert.equal(G.personName("😀".repeat(45)), "😀".repeat(40), "counted as characters: no emoji cut in half");
  for (const nothing of ["", "   ", "​", null, undefined, 7, {}]) assert.equal(G.personName(nothing), null, JSON.stringify(nothing));
});

test("the saved list is believed only as far as it is well-formed", async () => {
  const anu = await person("Anu"), bat = await person("Bat", "b");
  assert.deepEqual(G.savedPeople({ v: 1, people: [anu, bat] }), [anu, bat]);
  assert.deepEqual(G.savedPeople({ v: 1, people: [{ ...anu, name: "  Anu  " }] })[0].name, "Anu");
  assert.equal(G.savedPeople({ v: 1, people: [{ ...anu, savedAt: "x" }] })[0].savedAt, 0);
  for (const bad of [
    { ...anu, name: " " }, { ...anu, secret: "short" }, { ...anu, secret: `${anu.secret}!`.slice(1) },
    { ...anu, room: anu.room.slice(1) }, { ...anu, room: "plain-room" }, { ...anu, side: "c" }, { ...anu, side: undefined },
    null, "Anu", 7
  ]) assert.deepEqual(G.savedPeople({ v: 1, people: [bad] }), [], JSON.stringify(bad));
  assert.deepEqual(G.savedPeople({ v: 1, people: [anu, { ...bat, secret: anu.secret }] }), [anu], "each secret once");
  assert.deepEqual(G.savedPeople({ v: 1, people: [anu, { ...bat, room: anu.room }] }), [anu], "each room once");
  for (const notAList of [null, undefined, "x", [], { v: 2, people: [anu] }, { v: 1, people: "x" }, { people: [anu] }]) {
    assert.deepEqual(G.savedPeople(notAList), [], JSON.stringify(notAList));
  }
  const many = await Promise.all(Array.from({ length: 60 }, (_, i) => person(`P${i}`)));
  assert.equal(G.savedPeople({ v: 1, people: many }).length, G.SAVED_PEOPLE_MAX);
});

test("saving is offered only in a checked chat, and not to someone already saved", () => {
  assert.equal(G.mayOfferSave({ ready: true, secure: true, verified: false, savedRoom: false }), true, "by link or word");
  assert.equal(G.mayOfferSave({ ready: true, secure: false, verified: true, savedRoom: false }), true, "by the code compared");
  assert.equal(G.mayOfferSave({ ready: true, secure: false, verified: false, savedRoom: false }), false, "amber: a middleman would get the key");
  assert.equal(G.mayOfferSave({ ready: false, secure: true, verified: true, savedRoom: false }), false);
  assert.equal(G.mayOfferSave({ ready: true, secure: true, verified: true, savedRoom: true }), false);
});

test("an offer is believed only with a secret of the shape this app makes", () => {
  assert.equal(G.saveOfferValid({ secret: DC.makeRoomSecret() }), true);
  for (const bad of [{ secret: "x" }, { secret: "a".repeat(44) }, { secret: `${"a".repeat(42)}=` }, { secret: 7 }, {}, null]) {
    assert.equal(G.saveOfferValid(bad), false, JSON.stringify(bad));
  }
});

test("offers that crossed: both sides keep the same one", () => {
  for (let i = 0; i < 50; i++) {
    const a = DC.makeRoomSecret(), b = DC.makeRoomSecret();
    assert.notEqual(G.keepTheirOffer(a, b), G.keepTheirOffer(b, a), "exactly one side answers the other's");
  }
  assert.equal(G.keepTheirOffer(null, "x"), false);
});

test("in a saved person's room a key made without the secret is never taken", () => {
  assert.equal(G.mayUsePlainKey("saved"), false);
  for (const kind of ["pin", "open", "code"]) assert.equal(G.mayUsePlainKey(kind), true, kind);
});

test("the room's name: worked out from the secret alone, the same on both sides, and nothing of it given away", async () => {
  const secret = DC.makeRoomSecret();
  const room = await DC.savedRoomName(secret);
  assert.match(room, G.SAVED_ROOM);
  assert.equal(await DC.savedRoomName(secret), room, "both devices arrive at the same name");
  assert.notEqual(await DC.savedRoomName(DC.makeRoomSecret()), room);
  assert.ok(!room.includes(secret) && !room.includes(secret.slice(0, 12)), "the secret is not in it");
  const expected = `~${crypto.createHash("sha256").update(`direct-connection/saved-room/v1:${secret}`).digest("base64url")}`;
  assert.equal(room, expected, "a SHA-256 of the secret, labelled for this one use");
  assert.equal(server.match(/const SAVED_ROOM_PATTERN = (\/.*\/);/)[1], String(G.SAVED_ROOM), "the server knows the same shape");
});

/* ══════════════════════════════════════════
   A small stand-in page
══════════════════════════════════════════ */

function element(tag) {
  const listeners = {};
  const el = {
    tag, type: "", dataset: {}, style: {}, attrs: {}, children: [], parent: null, onclick: null,
    disabled: false, title: "", value: "", _text: "", _class: "",
    get className() { return el._class; },
    set className(v) { el._class = v; },
    classList: {
      contains: c => el._class.split(/\s+/).includes(c),
      add: c => { if (!el.classList.contains(c)) el._class = `${el._class} ${c}`.trim(); },
      remove: c => { el._class = el._class.split(/\s+/).filter(x => x && x !== c).join(" "); },
      toggle: (c, on) => (on ? el.classList.add(c) : el.classList.remove(c))
    },
    get textContent() { return el._text + el.children.map(c => c.textContent).join(""); },
    set textContent(v) { el._text = String(v); el.children = []; },
    setAttribute: (k, v) => { el.attrs[k] = String(v); },
    getAttribute: k => el.attrs[k],
    appendChild: c => { c.parent = el; el.children.push(c); return c; },
    append: (...cs) => cs.forEach(c => el.appendChild(c)),
    replaceChildren: (...cs) => { el._text = ""; el.children = []; cs.forEach(c => el.appendChild(c)); },
    querySelectorAll: sel => {
      const cls = sel.replace(/^\./, "");
      const out = [];
      const walk = n => { for (const c of n.children || []) { if (c.classList && c.classList.contains(cls)) out.push(c); walk(c); } };
      walk(el);
      return out;
    },
    querySelector: sel => el.querySelectorAll(sel)[0] || null,
    addEventListener: (type, f) => { (listeners[type] = listeners[type] || []).push(f); },
    fire: (type, e) => (listeners[type] || []).forEach(f => f(e)),
    focus() {},
    click() { if (!el.disabled && el.onclick) el.onclick(); }
  };
  return el;
}

const BLOCK = between("/* ══════════════════════════════════════════════\n   SAVED PEOPLE",
                      "/* ══════════════════════════════════════════════\n   WEBRTC — DATA CHANNEL PC");

const NAMES = ["G", "DC", "I18N", "LANG", "t", "localStorage", "window", "document",
  "chatMessages", "peopleSection", "peopleList", "saveOverlay", "saveTitle", "saveHint", "saveNameInput",
  "saveCancelBtn", "saveConfirmBtn", "leaveBtn", "lobbyStatus", "voiceCallBtn", "videoCallBtn", "statsBar", "chatScreen",
  "tablerIcon", "showToast", "keepScreenOn", "scrollBottom", "dcSendE2e", "wsSend", "ws", "WebSocket",
  "clearConnectWatch", "endCall", "closePeerConnection", "setQuality", "appendSys", "showReconnectButton",
  "setTimeout", "clearTimeout", "knockBtn", "knockIcon", "knockLabel", "Notification", "navigator", "location", "history", "indexedDB",
  "APP_BUILD", "installOverlay", "showLobbyTab", "runningInstalled",
  "mailOverlay", "mailTitle", "mailHint", "mailList", "mailInput", "mailSendBtn", "mailCloseBtn", "mailClearBtn",
  "fillMessage", "noticeArrival", "typingWithFinger", "env",
  "mailAttachBtn", "mailFileInput", "openImageViewer", "closeImageViewer", "DCS", "fetch", "SERVER_URL", "IDBKeyRange", "URL"];

/** A real P-256 public key and a 16-byte secret, as a browser's subscription has. */
function pushKeys() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") };
}
const SERVER_KNOCK_KEY = (() => { const e = crypto.createECDH("prime256v1"); e.generateKeys(); return e.getPublicKey().toString("base64url"); })();

/** The browser's push and notifications, stood in for. */
function pushBrowser(env, log) {
  let current = env.subscribed ? subscription(env.subscribedKey || SERVER_KNOCK_KEY) : null;
  function subscription(key) {
    const keys = pushKeys();
    const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomBytes(8).toString("hex")}`;
    return {
      endpoint, options: { applicationServerKey: Uint8Array.from(Buffer.from(key, "base64url")).buffer },
      toJSON: () => ({ endpoint, keys }),
      unsubscribe: async () => { log.unsubscribed++; current = null; return true; }
    };
  }
  const reg = { pushManager: {
    getSubscription: async () => current,
    subscribe: async opts => {
      log.subscribed.push({ userVisibleOnly: opts.userVisibleOnly, key: Buffer.from(opts.applicationServerKey).toString("base64url") });
      current = subscription(Buffer.from(opts.applicationServerKey).toString("base64url"));
      return current;
    }
  } };
  const swListeners = {};
  const navigator = {
    userAgent: env.ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/130", maxTouchPoints: env.touch || 0,
    serviceWorker: {
      register: async (url, opts) => { log.registered.push({ url, opts }); env.registered = true; return reg; },
      get ready() { return Promise.resolve(reg); },
      getRegistration: async () => (env.registered ? reg : undefined),
      addEventListener: (type, f) => { swListeners[type] = f; }
    }
  };
  const Notification = {
    permission: env.permission || "default",
    requestPermission: async () => { log.asked++; Notification.permission = env.answer || "granted"; return Notification.permission; }
  };
  return { navigator, Notification, swListeners, current: () => current };
}

/** IndexedDB, as much as the page needs: the worker's copy (`idb`), and the
    waiting photos and files (`files`, kept as they are given). */
function fakeIndexedDB(idb, files) {
  return {
    open: name => {
      const db = {
        createObjectStore() {}, close() {},
        transaction: () => {
          const done = result => { setTimeout(() => tx.oncomplete && tx.oncomplete()); return { result }; };
          const tx = { objectStore: () => (name === "dc-mail-files" ? {
            put: (v, k) => { files.set(k, v); return done(undefined); },
            get: k => done(files.get(k)),
            delete: range => { for (const k of [...files.keys()]) if (range.includes(k)) files.delete(k); return done(undefined); }
          } : { put: (v, k) => { idb.set(k, JSON.parse(JSON.stringify(v))); return done(undefined); } }) };
          return tx;
        }
      };
      const req = { result: db };
      setTimeout(() => req.onsuccess && req.onsuccess());
      return req;
    }
  };
}
const IDBKeyRange = { bound: (lo, hi, loOpen, hiOpen) => ({ includes: k => (loOpen ? k > lo : k >= lo) && (hiOpen ? k < hi : k <= hi) }) };

/** The server's /api/mailbox/file, stood in for: what was sent, kept by the
    X-DC-Mail header's "box:side:id"; asked for, handed back. `env.web` says
    how it answers: "works", "down" (no answer), or a status to answer with. */
function fakeWeb(env, log) {
  return async (url, opts = {}) => {
    const [box, side, id, size] = (opts.headers["X-DC-Mail"] || "").split(":");
    log.web.push({ url, method: opts.method || "GET", headers: { ...opts.headers } });
    if (env.web === "down") throw new TypeError("Failed to fetch");
    if (typeof env.web === "number") return { ok: false, status: env.web, json: async () => ({ code: env.webCode }) };
    const at = `${box}:${side}:${id}`;
    if (opts.method === "POST") {
      assert.equal(opts.body.length, Number(size), "the size said is the size sent");
      env.uploads.set(at, Uint8Array.from(opts.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (!env.uploads.has(at)) return { ok: false, status: 404, json: async () => ({ code: "gone" }) };
    const bytes = env.uploads.get(at);
    return { ok: true, status: 200, arrayBuffer: async () => bytes.slice().buffer };
  };
}

/**
 * One page, with `saved` already kept. storage: "works", "readonly" (read but
 * not written), "full" (a small probe fits, the list does not), or "off"
 * (neither read nor written).
 */
function page({ saved = [], storage = "works", connected = true, checked = true, kind = "pin", wsOpen = true, inChat = false, lang = "mn",
                 knock = {}, mail = null, hash = "", timers = null } = {}) {
  const log = { ws: [], sealed: [], toasts: [], sys: [], screen: [], left: 0, quality: [], reconnect: 0, closed: 0,
                asked: 0, registered: [], subscribed: [], unsubscribed: 0, replaced: [], tabs: [], noticed: 0, web: [], viewed: [] };
  const store = new Map();
  if (saved.length) store.set("dc-people", JSON.stringify({ v: 1, people: saved }));
  if (mail) store.set("dc-mail", JSON.stringify(mail));
  const off = () => { throw new Error("storage off"); };
  const localStorage = {
    getItem: k => (storage === "off" ? off() : store.has(k) ? store.get(k) : null),
    setItem: (k, v) => (storage === "readonly" || storage === "off" || (storage === "full" && k === "dc-people") ? off() : store.set(k, String(v))),
    removeItem: k => { store.delete(k); }
  };
  const winListeners = {};
  const idb = new Map();
  const files = new Map();
  const indexedDB = fakeIndexedDB(idb, files);
  const window = { indexedDB, addEventListener: (type, f) => { (winListeners[type] = winListeners[type] || []).push(f); } };
  const push = pushBrowser(knock, log);
  const docListeners = {};
  const document = { createElement: element, createTextNode: s => ({ tag: "#text", textContent: String(s), children: [] }),
                     addEventListener: (type, f) => { (docListeners[type] = docListeners[type] || []).push(f); } };
  const els = {};
  for (const n of ["chatMessages", "peopleSection", "peopleList", "saveOverlay", "saveTitle", "saveHint", "saveNameInput",
                   "saveCancelBtn", "saveConfirmBtn", "leaveBtn", "lobbyStatus", "voiceCallBtn", "videoCallBtn", "statsBar", "chatScreen",
                   "knockBtn", "knockIcon", "knockLabel", "installOverlay",
                   "mailOverlay", "mailTitle", "mailHint", "mailList", "mailInput", "mailSendBtn", "mailCloseBtn", "mailClearBtn",
                   "mailAttachBtn", "mailFileInput"]) {
    els[n] = element(n === "saveNameInput" || n === "mailInput" ? "input" : "div");
  }
  els.peopleSection.classList.add("hidden");
  els.saveOverlay.classList.add("hidden");
  els.mailOverlay.classList.add("hidden");
  els.knockBtn.classList.add("hidden");
  els.installOverlay.classList.add("hidden");
  if (!inChat) els.chatScreen.classList.add("hidden");
  const env = { kind, connected, checked, onLeave: null, knockSupported: knock.supported !== false, calls: [],
                callRequestModal: element("div"),
                knockKey: knock.serverKey === false || knock.keyLater ? null : SERVER_KNOCK_KEY,
                web: "works", webCode: null, uploads: new Map() };
  env.callRequestModal.classList.add("hidden");              // no call ringing here
  const location = { hash: knock.hash || hash || "", pathname: "/RelayLink/", search: "" };
  const history = { replaceState: (s, title, url) => log.replaced.push(url) };
  els.leaveBtn.click = () => { log.left++; if (env.onLeave) env.onLeave(); };
  const ws = { readyState: wsOpen ? 1 : 3 };
  const tablerIcon = name => { const i = element("i"); i.className = `ti ti-${name}`; return i; };
  const api = new Function(...NAMES, `
    let people = [], meeting = null, pendingMeet = null, saveOffer = null, saveAsked = null, saveDialog = null, forgetting = null, waitingForUs = new Set(), personMenuFor = null, heldOpen = false, quickCall = null, inCall = false;
    /* The chat's call: what the row's call buttons end in, stood in for. */
    const callRequestModal = env.callRequestModal;
    function requestCall(video) { env.calls.push(video); }
    let currentSession = null, isConnecting = false, listJoinId = null, pinJoinInFlight = false, isHost = false;
    let hostKey = null, reclaimPending = false, roomSecret = null, pendingRoomSecret = null, pakeCode = null;
    let roomKind = env.kind, guestKey = null, seatPending = false, dataChannel = null;
    let e2eReady = env.connected, e2eSecureMode = env.checked, e2eVerified = false;
    const knockSupported = env.knockSupported;
    let knockKey = env.knockKey, knockSub = null, knockSent = false, knockShared = false, savedInChat = null, knockEarly = null;
    let mailStore = { v: 1, threads: {}, seen: {} }, mailOpenFor = null;
    ${BLOCK}
    return {
      drawPeople, meetPerson, sendPendingMeet, meetWaiting, endMeeting, savedSeatTaken, roomTitle,
      maybeOfferSave, startSaveOffer, receiveSaveOffer, receiveSaveAccept, receiveSaveDecline,
      renamePerson, askForget, forgetPerson, confirmSaveDialog, cancelSaveDialog,
      knockStateNow, knockKeyArrived, knocksOn, knocksOff, shareKnockAddress, sendKnockAddress, receiveKnockAddress,
      knockAnswered, answerKnock, savedInChatNow, theyWait, mailAtConnect, openPersonMenu, closePersonMenu,
      quickCallPerson, placeQuickCall, quickCallPeerReady,
      openThread, closeThread, sendMail, receiveMail, mailAnswered, mailAtConnect, fetchMail, answerMail, sendFromThread,
      sendMailFile, mailFileBlob, files: () => mailFileQueue,
      get: () => ({ people, meeting, waitingForUs, personMenuFor, heldOpen, quickCall, pendingMeet, saveOffer, saveAsked, saveDialog, forgetting, currentSession,
                    isConnecting, isHost, hostKey, roomSecret, pendingRoomSecret, roomKind, guestKey,
                    knockKey, knockSub, knockSent, knockShared, savedInChat, knockEarly, mailStore, mailOpenFor }),
      set: o => { for (const [k, v] of Object.entries(o)) switch (k) {
        case "listJoinId": listJoinId = v; break;
        case "currentSession": currentSession = v; break;
        case "isConnecting": isConnecting = v; break;
        case "isHost": isHost = v; break;
        case "e2eSecureMode": e2eSecureMode = v; break;
        case "e2eVerified": e2eVerified = v; break;
        case "roomKind": roomKind = v; break;
        case "meeting": meeting = v; break;
        case "pendingMeet": pendingMeet = v; break;
        case "knockShared": knockShared = v; break;
        default: throw new Error("cannot set " + k);
      } }
    };`
  )(G, DC, I18N, lang, k => I18N[lang][k], localStorage, window, document,
    els.chatMessages, els.peopleSection, els.peopleList, els.saveOverlay, els.saveTitle, els.saveHint, els.saveNameInput,
    els.saveCancelBtn, els.saveConfirmBtn, els.leaveBtn, els.lobbyStatus, els.voiceCallBtn, els.videoCallBtn, els.statsBar, els.chatScreen,
    tablerIcon, (m, kind) => log.toasts.push(m), on => log.screen.push(on), () => {},
    async m => { if (!env.connected) return false; log.sealed.push(JSON.parse(JSON.stringify(m))); return true; },
    m => log.ws.push(JSON.parse(JSON.stringify(m))), ws, { OPEN: 1 },
    () => {}, () => {}, () => { log.closed++; }, q => log.quality.push(q), s => log.sys.push(s), () => { log.reconnect++; },
    timers ? f => timers.push(f) : f => f(), id => { if (timers && id) timers[id - 1] = null; }, els.knockBtn, els.knockIcon, els.knockLabel, push.Notification, push.navigator, location, history, indexedDB,
    "202610290000-abcdef12", els.installOverlay, n => log.tabs.push(n), () => Boolean(knock.standalone),
    els.mailOverlay, els.mailTitle, els.mailHint, els.mailList, els.mailInput, els.mailSendBtn, els.mailCloseBtn, els.mailClearBtn,
    (el, text) => { el.textContent = text; }, () => { log.noticed++; }, () => false, env,
    els.mailAttachBtn, els.mailFileInput, (url, name) => log.viewed.push({ url, name }), () => {}, { fmtBytes: n => `${n} B` },
    fakeWeb(env, log), "https://pi.test/dc", IDBKeyRange, URL);
  const rows = () => els.peopleList.children;
  const button = (row, cls) => row.children.find(c => c.classList.contains(cls));
  const stored = () => JSON.parse(store.get("dc-people") || "null");
  const storageEvent = () => (winListeners.storage || []).forEach(f => f({ key: "dc-people" }));
  const type = text => { els.saveNameInput.value = text; };
  const doc = (type, e) => (docListeners[type] || []).forEach(f => f(e));
  return { api, log, els, env, ws, store, rows, button, stored, storageEvent, type, idb, files, push, doc, timers };
}

const settle = () => new Promise(r => setTimeout(r, 0));
/** Waits for `done` — for work behind the page's own crypto, which one turn
    of the event loop does not always cover. */
async function until(done, ms = 2000) {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise(r => setTimeout(r, 2));
}

/* ══════════════════════════════════════════
   The list
══════════════════════════════════════════ */

test("nobody saved: no list at all", () => {
  const p = page();
  assert.ok(p.els.peopleSection.classList.contains("hidden"));
  assert.equal(p.rows().length, 0);
});

test("everyone saved is a name to tap — with nothing of their secret or room on the page", async () => {
  const anu = await person("Anu"), bat = await person("Bat", "b");
  const p = page({ saved: [anu, bat] });
  assert.ok(!p.els.peopleSection.classList.contains("hidden"));
  assert.deepEqual(p.rows().map(r => r.querySelector(".person-name").textContent), ["Anu", "Bat"]);
  const all = p.rows().map(r => r.textContent).join(" ");
  assert.ok(all.includes(I18N.mn.personTap));
  for (const x of [anu.secret, anu.room, bat.secret, bat.room]) assert.ok(!all.includes(x));
  const tools = p.rows()[0].children.filter(c => c.classList.contains("person-tool"));
  assert.deepEqual(tools.map(c => c.attrs["aria-label"]),
    [`${I18N.mn.voiceCall}: Anu`, `${I18N.mn.videoCall}: Anu`, `${I18N.mn.personMail}: Anu`],
    "a call either way and the envelope — rename and forget are out of sight until asked for");
  assert.equal(p.rows()[0].querySelector(".person-open").title, I18N.mn.personMenuHint, "and how to ask for them is said on the name");
});

/** Rename or Forget (`what`, an i18n key), from the row's menu — opened as a right click would. */
const menuChoice = (p, i, what) => {
  p.rows()[i].oncontextmenu({ preventDefault() {} });
  const menu = p.rows()[i].querySelector(".person-menu");
  return menu && menu.children.find(c => c.textContent === I18N.mn[what]);
};

/** The row's small button that does `what` (an i18n key), found by its label. */
const toolFor = (row, what) => row.children.find(c => c.classList.contains("person-tool") && String(c.attrs["aria-label"]).startsWith(I18N.mn[what]));

test("storage switched off: an empty list, and nothing breaks", () => {
  const p = page({ storage: "off" });
  assert.equal(p.rows().length, 0);
});

test("saved or forgotten in another tab: the same list here", async () => {
  const p = page();
  p.store.set("dc-people", JSON.stringify({ v: 1, people: [await person("Anu")] }));
  p.storageEvent();
  assert.equal(p.rows().length, 1);
});

/* ══════════════════════════════════════════
   Meeting
══════════════════════════════════════════ */

test("a tap on a name: one message — their room's name and our side, nothing else; the secret stays, for the key", async () => {
  const anu = await person("Anu", "b");
  const p = page({ saved: [anu] });
  p.button(p.rows()[0], "person-open").click();
  assert.deepEqual(p.log.ws, [{ type: "meet-session", sessionId: anu.room, side: "b" }]);
  const s = p.api.get();
  assert.equal(s.pendingRoomSecret, anu.secret, "mixed into the key once connected");
  assert.equal(s.roomKind, "saved");
  assert.equal(s.isConnecting, true);
  assert.equal(s.meeting.name, "Anu");
  assert.ok(p.rows()[0].textContent.includes(I18N.mn.personConnecting));
  assert.ok(!JSON.stringify(p.log.ws).includes(anu.secret));
});

test("while one is being met, no other name — nor the same one again — can be tapped", async () => {
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat] });
  p.api.meetPerson(anu);
  assert.ok(p.rows().every(r => p.button(r, "person-open").disabled));
  p.api.meetPerson(bat);
  p.api.meetPerson(anu);
  assert.equal(p.log.ws.length, 1);
});

test("a tap while a join is under way does nothing; a waiting room of our own is given up for it", async () => {
  const anu = await person("Anu");
  const busy = page({ saved: [anu] });
  busy.api.set({ listJoinId: "someone's room" });
  busy.api.meetPerson(anu);
  busy.api.set({ listJoinId: null, isConnecting: true });       // "Creating…"
  busy.api.meetPerson(anu);
  assert.deepEqual(busy.log.ws, []);

  const hosting = page({ saved: [anu] });
  hosting.env.onLeave = () => hosting.api.set({ currentSession: null, isHost: false });
  hosting.api.set({ currentSession: { sessionId: "my-room" }, isHost: true });
  hosting.api.meetPerson(anu);
  assert.equal(hosting.log.left, 1, "left first: one room per page");
  assert.equal(hosting.log.ws.length, 1);
});

test("tapped with the link down: sent as soon as it is back, and again each time until answered", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu], wsOpen: false });
  p.api.meetPerson(anu);
  assert.deepEqual(p.log.ws, []);
  p.ws.readyState = 1;
  p.api.sendPendingMeet();
  p.api.sendPendingMeet();
  assert.equal(p.log.ws.length, 2);
  p.api.meetWaiting({ sessionId: anu.room, hostKey: "k".repeat(32) });
  p.api.sendPendingMeet();
  assert.equal(p.log.ws.length, 2, "answered: not sent again");
});

test("first there: we wait on their row with the screen kept on, and the key's secret is theirs", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu] });
  p.api.meetPerson(anu);
  p.api.meetWaiting({ type: "session-created", sessionId: anu.room, hostKey: "k".repeat(32), kind: "saved" });
  const s = p.api.get();
  assert.equal(s.isHost, true);
  assert.deepEqual(s.currentSession, { sessionId: anu.room, token: null });
  assert.equal(s.hostKey, "k".repeat(32), "to take the room back if the link drops");
  assert.equal(s.roomSecret, anu.secret);
  assert.equal(s.pendingRoomSecret, null);
  assert.equal(s.isConnecting, false);
  assert.deepEqual(p.log.screen, [true]);
  const row = p.rows()[0];
  assert.ok(row.classList.contains("waiting"));
  assert.ok(row.textContent.includes(I18N.mn.personWaiting));
  const cancel = p.button(row, "person-small-btn");
  assert.equal(cancel.textContent, I18N.mn.personCancel);
  cancel.click();
  assert.equal(p.log.left, 1, "Cancel is leaving the room");
});

test("an answer to a tap already cancelled takes nothing up, and sends nothing", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu] });
  p.api.meetWaiting({ sessionId: anu.room, hostKey: "k".repeat(32) });
  const s = p.api.get();
  assert.equal(s.isHost, false);
  assert.equal(s.currentSession, null);
  assert.deepEqual(p.log.ws, [], "the cancel's own leave already let the room go");
});

test("the wait over — expired, lost or refused: their row is a name again, and the screen let go", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu] });
  p.api.meetPerson(anu);
  p.api.meetWaiting({ sessionId: anu.room, hostKey: "k".repeat(32) });
  p.api.endMeeting();
  const s = p.api.get();
  for (const k of ["meeting", "pendingMeet", "currentSession", "hostKey", "roomSecret", "pendingRoomSecret"]) assert.equal(s[k], null, k);
  assert.equal(s.isHost, false);
  assert.equal(s.roomKind, "pin");
  assert.deepEqual(p.log.screen, [true, false]);
  assert.ok(p.rows()[0].textContent.includes(I18N.mn.personTap));
  assert.ok(!p.button(p.rows()[0], "person-open").disabled);
});

test("opened elsewhere while waiting: said, and the row is a name again", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu] });
  p.api.meetPerson(anu);
  p.api.meetWaiting({ sessionId: anu.room, hostKey: "k".repeat(32) });
  p.api.savedSeatTaken();
  assert.deepEqual(p.log.toasts, [I18N.mn.savedElsewhere]);
  assert.equal(p.api.get().meeting, null);
  assert.equal(p.api.get().currentSession, null);
});

test("opened elsewhere mid-chat: this copy stops, says so, and offers the way back", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu], inChat: true });
  p.api.meetPerson(anu);
  p.api.savedSeatTaken();
  assert.equal(p.log.closed, 1, "its connection let go");
  assert.deepEqual(p.log.sys, [I18N.mn.savedElsewhere]);
  assert.equal(p.log.reconnect, 1);
  assert.equal(p.log.quality.length, 1);
  assert.equal(p.api.get().guestKey, null, "nothing to take back");
  assert.deepEqual(p.log.ws, [p.log.ws[0]], "and nothing joins again by itself");
});

test("on screen, a saved person's room is called by their name — any other by its own", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu] });
  assert.equal(p.api.roomTitle(anu.room), anu.room);
  p.api.meetPerson(anu);
  assert.equal(p.api.roomTitle(anu.room), "Anu");
  assert.equal(p.api.roomTitle("other room"), "other room");
});

/* ══════════════════════════════════════════
   Saving each other
══════════════════════════════════════════ */

test("a checked chat offers to save the person, once; an amber one, or a saved person's own room, does not", () => {
  const green = page({ inChat: true });
  green.api.maybeOfferSave();
  green.api.maybeOfferSave();
  const lines = green.els.chatMessages.querySelectorAll(".save-sys");
  assert.equal(lines.length, 1);
  assert.ok(lines[0].textContent.includes(I18N.mn.saveLineBtn));

  const amber = page({ checked: false, inChat: true });
  amber.api.maybeOfferSave();
  assert.equal(amber.els.chatMessages.querySelectorAll(".save-sys").length, 0);
  amber.api.set({ e2eVerified: true });                      // the code compared by hand
  amber.api.maybeOfferSave();
  assert.equal(amber.els.chatMessages.querySelectorAll(".save-sys").length, 1);

  const saved = page({ kind: "saved", inChat: true });
  saved.api.maybeOfferSave();
  assert.equal(saved.els.chatMessages.querySelectorAll(".save-sys").length, 0);
});

test("Save: named, then offered with a fresh secret — sealed, over the chat, never through the server", async () => {
  const p = page({ inChat: true });
  p.api.maybeOfferSave();
  p.api.startSaveOffer();
  assert.ok(!p.els.saveOverlay.classList.contains("hidden"));
  assert.equal(p.els.saveTitle.textContent, I18N.mn.saveTitle);
  p.type("   ");
  p.api.confirmSaveDialog();
  assert.ok(!p.els.saveOverlay.classList.contains("hidden"), "no name, nothing done");
  p.type("  Anu  ");
  p.els.saveNameInput.fire("keydown", { key: "Enter", isComposing: false, preventDefault() {} });
  await settle();
  assert.ok(p.els.saveOverlay.classList.contains("hidden"));
  assert.equal(p.log.sealed.length, 1);
  assert.equal(p.log.sealed[0].type, "save-offer");
  assert.match(p.log.sealed[0].secret, G.SAVED_SECRET);
  assert.deepEqual(Object.keys(p.log.sealed[0]).sort(), ["secret", "type"], "the name stays here");
  assert.deepEqual(p.log.ws, []);
  assert.equal(p.api.get().saveOffer.name, "Anu");
  assert.ok(p.els.chatMessages.querySelector(".save-sys").textContent.includes(I18N.mn.saveLineWaiting));
  assert.deepEqual(p.stored(), null, "not saved until they say yes");
});

test("a name being typed with an input method: Enter picks the word, it does not save", () => {
  const p = page({ inChat: true });
  p.api.startSaveOffer();
  p.type("Ану");
  p.els.saveNameInput.fire("keydown", { key: "Enter", isComposing: true, preventDefault() {} });
  assert.ok(!p.els.saveOverlay.classList.contains("hidden"));
});

test("their yes: saved as side a, under the name given, its room worked out from the secret", async () => {
  const p = page({ inChat: true });
  p.api.maybeOfferSave();
  p.api.startSaveOffer();
  p.type("Anu");
  p.api.confirmSaveDialog();
  await settle();
  const secret = p.log.sealed[0].secret;
  await p.api.receiveSaveAccept();
  const kept = p.stored().people;
  assert.equal(kept.length, 1);
  assert.deepEqual({ ...kept[0], savedAt: 0 }, { name: "Anu", secret, room: await DC.savedRoomName(secret), side: "a", savedAt: 0 });
  assert.deepEqual(p.log.toasts, [I18N.mn.savedDone("Anu")]);
  assert.ok(p.els.chatMessages.querySelector(".save-sys").textContent.includes(I18N.mn.saveLineDone("Anu")));
  assert.equal(p.rows().length, 1, "and in the list at once");
  await p.api.receiveSaveAccept();
  assert.equal(p.stored().people.length, 1, "a second yes saves nothing more");
});

test("their offer: asked to name them back — yes saves them as side b and says so; Not now says no", async () => {
  const secret = DC.makeRoomSecret();
  const yes = page({ inChat: true });
  yes.api.maybeOfferSave();
  await yes.api.receiveSaveOffer({ type: "save-offer", secret });
  assert.equal(yes.els.saveTitle.textContent, I18N.mn.saveAskTitle);
  assert.equal(yes.els.saveCancelBtn.textContent, I18N.mn.saveNotNow);
  yes.type("Bat");
  yes.api.confirmSaveDialog();
  await until(() => yes.log.sealed.length >= 2);
  assert.deepEqual(yes.log.sealed, [{ type: "save-accept" }, { type: "knock-address", off: true }],
    "and where to knock for us — nowhere, with alerts off");
  assert.deepEqual(yes.stored().people.map(q => [q.name, q.secret, q.side]), [["Bat", secret, "b"]]);
  assert.ok(yes.els.chatMessages.querySelector(".save-sys").textContent.includes(I18N.mn.saveLineDone("Bat")));

  const no = page({ inChat: true });
  await no.api.receiveSaveOffer({ type: "save-offer", secret });
  no.api.cancelSaveDialog();
  await settle();
  assert.deepEqual(no.log.sealed, [{ type: "save-decline" }]);
  assert.equal(no.stored(), null);
  assert.equal(no.api.get().saveAsked, null);
});

test("an offer in a chat this side has not checked is turned down, and why is said on both", async () => {
  const p = page({ checked: false, inChat: true });
  await p.api.receiveSaveOffer({ type: "save-offer", secret: DC.makeRoomSecret() });
  await settle();
  assert.deepEqual(p.log.sealed, [{ type: "save-decline", reason: "unverified" }]);
  assert.deepEqual(p.log.toasts, [I18N.mn.savedVerifyFirst]);
  assert.ok(p.els.saveOverlay.classList.contains("hidden"), "not asked");
});

test("a malformed offer, or a second while one is asked, is ignored", async () => {
  const p = page({ inChat: true });
  await p.api.receiveSaveOffer({ type: "save-offer", secret: "x" });
  await p.api.receiveSaveOffer({ type: "save-offer" });
  assert.deepEqual(p.log.sealed, []);
  assert.ok(p.els.saveOverlay.classList.contains("hidden"));
  const first = DC.makeRoomSecret();
  await p.api.receiveSaveOffer({ type: "save-offer", secret: first });
  await p.api.receiveSaveOffer({ type: "save-offer", secret: DC.makeRoomSecret() });
  assert.equal(p.api.get().saveAsked.secret, first);
});

test("in a saved person's own room an offer is declined at once", async () => {
  const p = page({ kind: "saved", inChat: true });
  await p.api.receiveSaveOffer({ type: "save-offer", secret: DC.makeRoomSecret() });
  await settle();
  assert.deepEqual(p.log.sealed, [{ type: "save-decline" }]);
  assert.ok(p.els.saveOverlay.classList.contains("hidden"));
});

test("both pressed Save at once: both end up with the same secret, on opposite sides, under their own names", async () => {
  for (let i = 0; i < 6; i++) {
    const a = page({ inChat: true }), b = page({ inChat: true });
    for (const [p, name] of [[a, "Bat"], [b, "Anu"]]) {
      p.api.startSaveOffer();
      p.type(name);
      p.api.confirmSaveDialog();
    }
    await settle();
    const offerA = a.log.sealed.shift(), offerB = b.log.sealed.shift();
    await a.api.receiveSaveOffer(offerB);
    await b.api.receiveSaveOffer(offerA);
    await settle();
    for (const [from, to] of [[a, b], [b, a]]) {
      for (const m of from.log.sealed.splice(0)) if (m.type === "save-accept") await to.api.receiveSaveAccept();
    }
    const ka = a.stored().people, kb = b.stored().people;
    assert.equal(ka.length, 1, `round ${i}`);
    assert.equal(kb.length, 1);
    assert.equal(ka[0].secret, kb[0].secret, "the same secret on both");
    assert.equal(ka[0].room, kb[0].room);
    assert.notEqual(ka[0].side, kb[0].side, "one side each");
    assert.deepEqual([ka[0].name, kb[0].name], ["Bat", "Anu"]);
  }
});

test("their no: said in our words, whatever reason came, and the offer is open again", async () => {
  for (const [reason, said] of [["unverified", "savedPeerVerifyFirst"], ["storage", "savedPeerNoStorage"],
                                [undefined, "savedDeclined"], ["constructor", "savedDeclined"], ["<b>x</b>", "savedDeclined"]]) {
    const p = page({ inChat: true });
    p.api.maybeOfferSave();
    p.api.startSaveOffer();
    p.type("Anu");
    p.api.confirmSaveDialog();
    await settle();
    p.api.receiveSaveDecline({ type: "save-decline", reason });
    assert.deepEqual(p.log.toasts, [I18N.mn[said]], String(reason));
    assert.equal(p.api.get().saveOffer, null);
    assert.ok(p.els.chatMessages.querySelector(".save-sys").textContent.includes(I18N.mn.saveLineBtn));
  }
});

test("a yes or a no to no offer of ours is ignored", async () => {
  const p = page({ inChat: true });
  await p.api.receiveSaveAccept();
  p.api.receiveSaveDecline({ reason: "unverified" });
  assert.equal(p.stored(), null);
  assert.deepEqual(p.log.toasts, []);
});

test("a browser that cannot keep them: no offer made and none accepted — never saved on one side alone", async () => {
  for (const storage of ["readonly", "off"]) {
    const p = page({ storage, inChat: true });
    p.api.startSaveOffer();
    assert.ok(p.els.saveOverlay.classList.contains("hidden"), storage);
    assert.deepEqual(p.log.toasts, [I18N.mn.savedNoStorage]);
    await p.api.receiveSaveOffer({ type: "save-offer", secret: DC.makeRoomSecret() });
    await settle();
    assert.deepEqual(p.log.sealed, [{ type: "save-decline", reason: "storage" }]);
  }
});

test("storage full only when the list is written: their offer is turned down, not half-saved", async () => {
  const p = page({ storage: "full", inChat: true });
  await p.api.receiveSaveOffer({ type: "save-offer", secret: DC.makeRoomSecret() });
  assert.ok(!p.els.saveOverlay.classList.contains("hidden"), "the probe fitted, so they were asked");
  p.type("Bat");
  p.api.confirmSaveDialog();
  await until(() => p.log.sealed.length >= 1);
  await settle();
  assert.deepEqual(p.log.sealed, [{ type: "save-decline", reason: "storage" }], "no yes for what was not kept");
  assert.deepEqual(p.log.toasts, [I18N.mn.savedNoStorage]);
  assert.equal(p.rows().length, 0);
});

test("an offer made in an amber chat is refused before any dialog", () => {
  const p = page({ checked: false, inChat: true });
  p.api.startSaveOffer();
  assert.ok(p.els.saveOverlay.classList.contains("hidden"));
  assert.deepEqual(p.log.toasts, [I18N.mn.savedVerifyFirst]);
});

test("fifty at most", async () => {
  const many = await Promise.all(Array.from({ length: G.SAVED_PEOPLE_MAX }, (_, i) => person(`P${i}`)));
  const p = page({ saved: many, inChat: true });
  p.api.startSaveOffer();
  assert.deepEqual(p.log.toasts, [I18N.mn.savedFull]);
  await p.api.receiveSaveOffer({ type: "save-offer", secret: DC.makeRoomSecret() });
  await settle();
  assert.deepEqual(p.log.sealed, [{ type: "save-decline" }]);
});

/* ══════════════════════════════════════════
   Renaming and forgetting — this device only
══════════════════════════════════════════ */

test("renamed here, and only here", async () => {
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat] });
  menuChoice(p, 0, "personRename").click();
  assert.equal(p.els.saveTitle.textContent, I18N.mn.renameTitle);
  assert.equal(p.els.saveNameInput.value, "Anu", "the old name to change");
  p.type("Anu (phone)");
  p.api.confirmSaveDialog();
  assert.deepEqual(p.stored().people.map(q => q.name), ["Anu (phone)", "Bat"], "only the one renamed");
  assert.equal(p.stored().people[0].secret, anu.secret);
  assert.equal(p.rows()[0].querySelector(".person-name").textContent, "Anu (phone)");
  assert.deepEqual(p.log.sealed, [], "nothing sent anywhere");
});

/* ── Someone waiting for us ──
   Asked for: when a saved person taps our name and waits, this lobby shows
   it on their name — the knock's notification was easy to miss. */

test("they tap our name and wait: their row stands out — wants to talk, tap to join — and it is said once", async () => {
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat] });
  p.api.theyWait(anu.room, true);
  const row = p.rows()[0];
  assert.ok(row.classList.contains("knocking"), "the row stands out");
  assert.ok(row.textContent.includes(I18N.mn.personWantsToTalk));
  assert.ok(!p.rows()[1].classList.contains("knocking"), "only theirs");
  assert.deepEqual(p.log.toasts, [I18N.mn.knockTitle("Anu")]);
  assert.equal(p.log.noticed, 1, "the chime and the count, if nobody is looking");
  p.api.theyWait(anu.room, true);
  assert.equal(p.log.toasts.length, 1, "said once, not at every word of it");
});

test("they stop waiting — left, or the wait ran out: their row is a name again, and nothing more is said", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu] });
  p.api.theyWait(anu.room, true);
  p.api.theyWait(anu.room, false);
  assert.ok(!p.rows()[0].classList.contains("knocking"));
  assert.ok(p.rows()[0].textContent.includes(I18N.mn.personTap));
  assert.equal(p.log.toasts.length, 1);
});

test("a tap on their waiting name joins them, and the row is no longer shown as waiting", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu] });
  p.api.theyWait(anu.room, true);
  p.api.meetPerson(anu);
  assert.deepEqual(p.log.ws.at(-1), { type: "meet-session", sessionId: anu.room, side: anu.side });
  assert.equal(p.api.get().waitingForUs.has(anu.room), false);
  assert.ok(!p.rows()[0].classList.contains("knocking"));
});

test("word about a room that is nobody saved here is ignored", async () => {
  const anu = await person("Anu"), stranger = await person("Someone");
  const p = page({ saved: [anu] });
  p.api.theyWait(stranger.room, true);
  assert.equal(p.api.get().waitingForUs.size, 0);
  assert.deepEqual(p.log.toasts, []);
});

test("each link that comes up asks afresh: a wait that ended while it was down is not left showing", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu] });
  p.api.theyWait(anu.room, true);
  p.api.mailAtConnect();
  assert.ok(!p.rows()[0].classList.contains("knocking"));
  assert.deepEqual(p.log.ws.at(-1), { type: "mail-fetch", files: true, boxes: [{ box: anu.room, side: anu.side }] },
    "and asked again, with the mailboxes — the server says again who still waits");
});

test("the server's word that someone waits is taken by the message switch", () => {
  assert.match(between('    case "meet-waiting":', "      break;"), /theyWait\(data\.room, data\.waiting === true\)/);
});

test("forget asks first, in the row; Keep keeps; Forget takes them off this device", async () => {
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat] });
  menuChoice(p, 0, "personForget").click();
  assert.ok(p.rows()[0].classList.contains("asking"));
  assert.ok(p.rows()[0].textContent.includes(I18N.mn.forgetAsk("Anu")));
  p.rows()[0].children.find(c => c.textContent === I18N.mn.forgetNo).click();
  assert.equal(p.stored().people.length, 2);
  assert.ok(!p.rows()[0].classList.contains("asking"));
  p.api.askForget(anu);
  p.rows()[0].children.find(c => c.textContent === I18N.mn.forgetYes).click();
  assert.deepEqual(p.stored().people.map(q => q.name), ["Bat"]);
  assert.equal(p.rows().length, 1);
});

/* ── A call straight from the row ──
   Asked for: a voice or video call from a saved person's row, beside the
   envelope. */

const callTool = (p, i, video) => p.rows()[i].children.find(c => c.classList.contains("call") &&
  String(c.attrs["aria-label"]).startsWith(I18N.mn[video ? "videoCall" : "voiceCall"]));

test("the row's call buttons meet them as a tap on the name does — and the row says the call starts when they connect", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu] });
  callTool(p, 0, true).click();
  assert.deepEqual(p.log.ws.at(-1), { type: "meet-session", sessionId: anu.room, side: anu.side }, "the same tap as on the name");
  assert.deepEqual(p.api.get().quickCall, { room: anu.room, video: true });
  p.api.set({ currentSession: { sessionId: anu.room } });   // in their room, waiting
  p.api.drawPeople();
  assert.ok(p.rows()[0].textContent.includes(I18N.mn.personCallWaiting));
  assert.equal(callTool(p, 0, false), undefined, "no call buttons on the row being met — Cancel is there");
});

test("the host places the call once the guest has said who it is — as the chat's own button would", async () => {
  /* Found trying it: called the moment its own key was agreed, the host's
     request overtook the confirmation that makes the guest ready, and was
     dropped there — the host rang, the guest never heard it. */
  const anu = await person("Anu");
  const p = page({ saved: [anu], kind: "saved", timers: [] });
  callTool(p, 0, false).click();
  p.api.set({ isHost: true });
  p.api.placeQuickCall();
  assert.deepEqual(p.env.calls, [], "not yet: the guest may not be ready");
  p.api.quickCallPeerReady();
  assert.deepEqual(p.env.calls, [false], "the guest introduced itself: a voice call");
  assert.equal(p.api.get().quickCall, null, "once");
  p.api.quickCallPeerReady();
  p.api.placeQuickCall();
  assert.deepEqual(p.env.calls, [false]);
});

test("the guest's introduction is what lets the host's call ring", () => {
  assert.match(between('    case "peer-info":', "      break;"), /if \(isHost\) quickCallPeerReady\(\);/);
});

test("the guest calls a moment later — and not at all if the host's call already rings there", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu], kind: "saved", timers: [] });
  callTool(p, 0, true).click();
  p.api.placeQuickCall();
  assert.deepEqual(p.env.calls, [], "not at once: both may have pressed call");
  p.timers.filter(Boolean).forEach(f => f());
  assert.deepEqual(p.env.calls, [true], "a moment later, a video call");

  const both = page({ saved: [anu], kind: "saved", timers: [] });
  callTool(both, 0, true).click();
  both.api.placeQuickCall();
  both.env.callRequestModal.classList.remove("hidden");     // the host's call came in meanwhile
  both.timers.filter(Boolean).forEach(f => f());
  assert.deepEqual(both.env.calls, [], "two requests would turn each other away: theirs is answered instead");
});

test("cancelled, or the chat is someone else's: no call", async () => {
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat], kind: "saved", timers: [] });
  callTool(p, 0, true).click();
  p.api.set({ isHost: true });
  p.api.placeQuickCall();                                   // armed, waiting for the guest
  p.api.endMeeting();
  assert.equal(p.api.get().quickCall, null, "the call asked for goes with the meeting");
  p.api.quickCallPeerReady();
  assert.deepEqual(p.env.calls, [], "and an armed one with it");

  const busy = page({ saved: [anu, bat] });
  busy.api.meetPerson(anu);
  assert.equal(callTool(busy, 1, true).disabled, true, "not while someone else is being met");
  callTool(busy, 1, true).onclick();
  assert.equal(busy.api.get().quickCall, null);
});

test("the chat being up places the call asked for — right after it says Connected", () => {
  assert.match(fn("e2eActivate"), /maybeOfferSave\(\);\s*\n\s*placeQuickCall\(\);/);
});

/* ── Rename and forget, on request ──
   Asked for: the pencil and the bin on every row were more than needed. A
   right click — or a long press on a phone — opens them instead. */

const menuOf = (p, i) => p.rows()[i].querySelector(".person-menu");
const touch = (x = 10, y = 10) => ({ pointerType: "touch", clientX: x, clientY: y });

test("a right click on a name opens Rename and Forget on that row alone; choosing one closes it", async () => {
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat] });
  assert.equal(menuOf(p, 0), null, "out of sight until asked for");
  let prevented = false;
  p.rows()[1].oncontextmenu({ preventDefault() { prevented = true; } });
  assert.ok(prevented, "not the browser's own menu");
  assert.equal(menuOf(p, 0), null);
  const menu = menuOf(p, 1);
  assert.deepEqual(menu.children.map(c => c.textContent), [I18N.mn.personRename, I18N.mn.personForget]);
  assert.deepEqual(menu.children.map(c => c.attrs["aria-label"]), [`${I18N.mn.personRename}: Bat`, `${I18N.mn.personForget}: Bat`]);
  assert.ok(menu.children[1].classList.contains("danger"));
  menu.children[0].click();
  assert.equal(p.els.saveTitle.textContent, I18N.mn.renameTitle, "Rename: the name dialog");
  assert.equal(p.els.saveNameInput.value, "Bat");
  assert.equal(p.api.get().personMenuFor, null);
});

test("a tap anywhere else, or Escape, closes it; a tap inside it does not", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu] });
  p.rows()[0].oncontextmenu({ preventDefault() {} });
  const inside = menuOf(p, 0).children[0];
  p.doc("click", { target: { closest: sel => (sel === ".person-menu" ? {} : null) } });
  assert.ok(menuOf(p, 0), "inside: left open");
  p.doc("click", { target: { closest: () => null } });
  assert.equal(menuOf(p, 0), null);
  p.rows()[0].oncontextmenu({ preventDefault() {} });
  p.doc("keydown", { key: "Escape" });
  assert.equal(menuOf(p, 0), null);
  assert.ok(inside);
});

test("a long press on a phone opens it after half a second — and its release is not a tap on the name", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu], timers: [] });
  p.rows()[0].fire("pointerdown", touch());
  assert.equal(menuOf(p, 0), null, "not yet");
  p.timers.filter(Boolean).forEach(f => f());
  assert.ok(menuOf(p, 0), "held: open");
  p.rows()[0].querySelector(".person-open").click();       // the release's click, on the name…
  p.doc("click", { target: { closest: () => null } });      // …and on up to the page
  assert.equal(p.log.ws.filter(m => m.type === "meet-session").length, 0, "nobody is met by the press that opened the menu");
  assert.ok(menuOf(p, 0), "nor does its release close what it opened — found trying it in a browser");
  p.doc("pointerdown", {});                                  // the next touch starts afresh
  p.rows()[0].querySelector(".person-open").click();
  assert.equal(p.log.ws.filter(m => m.type === "meet-session").length, 1, "a tap after it meets them, as ever");
});

test("a short tap, a finger that moves (scrolling), or a mouse: no menu", async () => {
  const anu = await person("Anu");
  const tap = page({ saved: [anu], timers: [] });
  tap.rows()[0].fire("pointerdown", touch());
  tap.rows()[0].fire("pointerup", {});
  tap.timers.filter(Boolean).forEach(f => f());
  assert.equal(menuOf(tap, 0), null, "let go before half a second");

  const scroll = page({ saved: [anu], timers: [] });
  scroll.rows()[0].fire("pointerdown", touch(10, 10));
  scroll.rows()[0].fire("pointermove", touch(10, 40));
  scroll.timers.filter(Boolean).forEach(f => f());
  assert.equal(menuOf(scroll, 0), null, "a finger that moves is scrolling");

  const mouse = page({ saved: [anu], timers: [] });
  mouse.rows()[0].fire("pointerdown", { pointerType: "mouse", clientX: 0, clientY: 0 });
  assert.equal(mouse.timers.length, 0, "a mouse has its right button");
});

test("no menu while a row asks \"Forget?\"", async () => {
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat] });
  p.api.askForget(anu);
  p.rows()[1].oncontextmenu({ preventDefault() {} });
  assert.equal(menuOf(p, 1), null);
});

test("while one is being met, nobody can be renamed or forgotten", async () => {
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat] });
  p.api.meetPerson(anu);
  assert.equal(menuChoice(p, 1, "personRename"), null, "no menu opens while someone is being met");
  assert.equal(toolFor(p.rows()[1], "personMail").disabled, false, "a message can still be written");
  assert.ok(toolFor(p.rows()[0], "personMail"), "to the one being waited for too");
});

/* ══════════════════════════════════════════
   The wiring
══════════════════════════════════════════ */

test("a tap's message carries the room's name and the side, and nothing else", () => {
  const m = fn("meetPerson").match(/pendingMeet = (\{[^}]*\});/);
  assert.ok(m);
  assert.equal(m[1], '{ type: "meet-session", sessionId: p.room, side: p.side }');
});

test("the host takes no key made without the secret in a saved person's room", () => {
  const derive = fn("e2eDeriveKey");
  assert.match(derive, /plain:\s*G\.mayUsePlainKey\(roomKind\) \? await deriveKeyWith\(peerPub, null\) : null/);
  assert.match(fn("handleE2eConfirm"), /\} else if \(plain && await opensConfirm\(plain, data\.ct, data\.iv\)\) \{/,
    "and a missing one opens nothing");
});

test("the guard against sending a secret to the server covers every saved one", () => {
  const guarded = fn("roomSecretsInPlay");
  for (const holder of ["meeting && meeting.secret", "saveOffer && saveOffer.secret", "saveAsked && saveAsked.secret", "...people.map(p => p.secret)"]) {
    assert.ok(guarded.includes(holder), `roomSecretsInPlay omits ${holder}`);
  }
});

test("saving each other is believed only sealed", () => {
  for (const type of ["save-offer", "save-accept", "save-decline"]) {
    assert.equal(G.mayHandleFrame(type, false), false, `${type} in the clear`);
    assert.equal(G.mayHandleFrame(type, true), true, `${type} sealed`);
  }
});

test("an offer is let go of with the channel it came on, and its question closed", () => {
  const close = fn("closePeerConnection");
  assert.match(close, /saveOffer = null;\s*\n\s*saveAsked = null;\s*\n\s*if \(saveDialog && saveDialog\.mode !== "rename"\) closeSaveDialog\(\);/);
});

test("the chat offers once it is checked — by the key, or by the code compared by hand", () => {
  assert.match(fn("e2eActivate"), /appendSys\(t\("sysConnected"\)\);\s*\n\s*maybeOfferSave\(\);/);
  assert.match(between('keyVerifyInput.addEventListener("input"', "\n  });"), /updateShield\(\);\s*\n\s*maybeOfferSave\(\);/);
});

test("the room made for us is waited in; a saved room's name is never kept for a reload, nor shown", () => {
  assert.match(between('    case "session-created": {', "pendingCreate = null;"), /if \(data\.kind === "saved"\) \{ meetWaiting\(data\); break; \}/);
  assert.match(fn("saveHostRoom"), /roomKind === "saved"\) return;/);
  assert.match(fn("switchToChat"), /chatSessionLabel\.textContent = roomTitle\(sessionId\);/);
  assert.match(fn("showCallOverlay"), /nameEl\.textContent = roomTitle\(/);
});

test("the server's news about a saved person's room is taken the saved way", () => {
  const created = between('    case "session-created": {', "pendingCreate = null;");
  assert.match(created, /if \(meeting\) \{ meeting = null; pendingMeet = null; drawPeople\(\); \}/, "a room of our own made instead: the wait is given up");
  assert.match(between('    case "session-joined":', '    case "host-back":'), /if \(roomKind !== "saved" && meeting\) \{ meeting = null; drawPeople\(\); \}/,
    "another room joined instead: the same");
  const hostBack = between('    case "host-back":', '    case "session-reclaimed":');
  assert.match(hostBack, /if \(data\.restart === true\) \{\s*\n\s*if \(dataChannel\) dataChannel\.onclose = null;\s*\n\s*endCall\(false\);\s*\n\s*createPeerConnection\(\);/,
    "their side opened afresh: start again with it, quietly, keeping what was said");
  assert.match(between('    case "guest-joined":', '    case "offer":'), /roomKind === "saved" \? I18N\[LANG\]\.savedReopened\(roomTitle\(currentSession\.sessionId\)\) : t\("guestReopened"\)/);
  const seat = between('    case "seat-taken":', '    case "guest-left":');
  assert.match(seat, /if \(!roomEventIsOurs\(data\)\) break;\s*\n\s*if \(roomKind === "saved"\) \{ savedSeatTaken\(\); break; \}\s*\n\s*if \(isHost\) break;/,
    "the host side too, for a saved person's room");
  assert.match(between('    case "session-expired": {', '    case "error": {'), /if \(roomKind === "saved"\) \{[\s\S]*?endMeeting\(\);[\s\S]*?savedExpired/);
  assert.match(fn("loseWaitingRoom"), /if \(roomKind === "saved"\) \{ endMeeting\(\); showToast\(`⚠️ \$\{t\("savedLost"\)\}`, "warn"\); return; \}/);
});

test("the channel gone when Save is pressed: said, and nothing is left waiting", async () => {
  const p = page({ inChat: true });
  p.api.maybeOfferSave();
  p.api.startSaveOffer();
  p.env.connected = false;
  p.type("Anu");
  p.api.confirmSaveDialog();
  await settle();
  assert.deepEqual(p.log.toasts, [I18N.mn.messageNotSent]);
  assert.equal(p.api.get().saveOffer, null);
  assert.ok(p.els.chatMessages.querySelector(".save-sys").textContent.includes(I18N.mn.saveLineBtn), "the offer still there to press");
});

test("a tap while a PIN is being tried does nothing", () => {
  assert.match(fn("meetPerson"), /if \(meeting \|\| listJoinId \|\| pinJoinInFlight \|\| \(isConnecting && !currentSession\)\) return;/);
});

test("leaving lets go of the person being met — and any call asked for from their row — and the lobby shows them as a name again", () => {
  assert.match(between("leaveBtn.onclick = (e) => {", "\n};"),
    /meeting = null;\s*\n\s*pendingMeet = null;\s*\n\s*knockSent = false;\s*\n\s*quickCall = null;[^\n]*\n\s*quickCallArmed = null;\s*\n\s*savedInChat = null;\s*\n\s*drawPeople\(\);/);
});

test("after a chat joined from a link, the whole lobby works again — the name field and Refresh too", () => {
  /* Found checking this feature: a page that joined by link switched them off
     for the join, and nothing switched them on again after the chat. */
  assert.match(fn("checkAutoJoin"), /setLobbyButtons\(true\);/);
  assert.match(between("leaveBtn.onclick = (e) => {", "\n};"), /setLobbyButtons\(false\);/);
  assert.match(fn("setLobbyButtons"), /sessionIdInput\.disabled = disabled;\s*\n\s*refreshBtn\.disabled\s*= disabled;/);
});

test("the lobby has the list and the name dialog, and every word is in both languages", () => {
  for (const id of ["peopleSection", "peopleList", "saveOverlay", "saveTitle", "saveHint", "saveNameInput", "saveCancelBtn", "saveConfirmBtn"]) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.ok(html.indexOf('id="peopleSection"') < html.indexOf('id="sessionsList"'), "above the rooms");
  assert.match(html, /id="saveNameInput"[^>]*maxlength="40"/);
  /* Every quoted word the block names, and every I18N[LANG].x it calls, that
     either language has — a class name or a mode is in neither. */
  const named = [...BLOCK.matchAll(/"(\w+)"/g), ...BLOCK.matchAll(/I18N\[LANG\]\.(\w+)/g)].map(m => m[1]);
  const words = [...new Set(named)].filter(k => k in I18N.en || k in I18N.mn);
  assert.ok(words.length > 28, `only ${words.length} words found`);
  for (const key of words) {
    for (const lang of ["mn", "en"]) assert.ok(key in I18N[lang], `${lang}.${key}`);
    assert.equal(typeof I18N.mn[key], typeof I18N.en[key], key);
  }
});

/* ══════════════════════════════════════════
   Knocks
══════════════════════════════════════════ */

const timers = () => new Promise(r => setTimeout(r, 5));

test("an address is believed only in the shape a browser gives one", () => {
  const keys = pushKeys();
  const ok = { endpoint: "https://fcm.googleapis.com/fcm/send/x", ...keys };
  assert.equal(G.knockAddressValid(ok), true);
  for (const bad of [
    { ...ok, endpoint: "fcm.googleapis.com/x" }, { ...ok, endpoint: "javascript:alert(1)//x" }, { ...ok, endpoint: "https://a b/x" },
    { ...ok, endpoint: `https://x.y/${"z".repeat(1100)}` }, { ...ok, p256dh: keys.p256dh.slice(1) }, { ...ok, p256dh: `A${keys.p256dh.slice(1)}` },
    { ...ok, auth: `${keys.auth}x` }, { ...ok, auth: 7 }, { endpoint: ok.endpoint }, null, "x"
  ]) assert.equal(G.knockAddressValid(bad), false, JSON.stringify(bad));
});

test("a person keeps a good address, and loses a bad one — not themselves", async () => {
  const anu = await person("Anu");
  const knock = { endpoint: "https://fcm.googleapis.com/fcm/send/x", ...pushKeys() };
  assert.deepEqual(G.savedPeople({ v: 1, people: [{ ...anu, knock }] }), [{ ...anu, knock }]);
  assert.deepEqual(G.savedPeople({ v: 1, people: [{ ...anu, knock: { ...knock, auth: "x" } }] }), [anu]);
  assert.deepEqual(G.savedPeople({ v: 1, people: [{ ...anu, knock: { ...knock, extra: "kept?" } }] })[0].knock, knock, "only the three parts");
});

test("the alerts switch: only where it can work, and saying how where it cannot yet", () => {
  const base = { serverKey: true, supported: true, appleTouch: false, standalone: false, permission: "default", subscribed: false };
  assert.equal(G.knockState(base), "off");
  assert.equal(G.knockState({ ...base, permission: "granted", subscribed: true }), "on");
  assert.equal(G.knockState({ ...base, permission: "granted" }), "off", "allowed, but no subscription yet");
  assert.equal(G.knockState({ ...base, subscribed: true }), "off", "subscribed, but not allowed to show it");
  assert.equal(G.knockState({ ...base, permission: "denied", subscribed: true }), "blocked");
  assert.equal(G.knockState({ ...base, serverKey: false, permission: "granted", subscribed: true }), "hidden", "the server sends none");
  assert.equal(G.knockState({ ...base, supported: false }), "hidden", "a browser that cannot be woken");
  assert.equal(G.knockState({ ...base, supported: false, appleTouch: true }), "install", "an iPhone in Safari: the Home Screen first");
  assert.equal(G.knockState({ ...base, supported: false, appleTouch: true, standalone: true }), "hidden");
  assert.equal(G.knockState(null), "hidden");
});

test("no knocks from the server, or a browser without push: no switch", async () => {
  for (const knock of [{ serverKey: false }, { supported: false }]) {
    const p = page({ saved: [await person("Anu")], knock });
    assert.ok(p.els.knockBtn.classList.contains("hidden"), JSON.stringify(knock));
  }
  const iphone = page({ saved: [await person("Anu")], knock: { supported: false, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" } });
  assert.equal(iphone.els.knockBtn.dataset.state, "install");
  assert.equal(iphone.els.knockLabel.textContent, I18N.mn.knockInstall);
  iphone.els.knockBtn.onclick();
  assert.ok(!iphone.els.installOverlay.classList.contains("hidden"), "the Home Screen steps");
});

test("turning alerts on: asked inside the tap, the worker registered for this build, subscribed for the server's key", async () => {
  const p = page({ saved: [await person("Anu")] });
  assert.equal(p.els.knockBtn.dataset.state, "off");
  assert.equal(p.els.knockLabel.textContent, I18N.mn.knockOff);
  assert.equal(p.els.knockBtn.title, I18N.mn.knockHint);
  p.els.knockBtn.onclick();
  assert.equal(p.log.asked, 1, "the question is asked in the tap itself");
  await timers();
  assert.deepEqual(p.log.registered, [{ url: "sw.js?v=202610290000-abcdef12", opts: { updateViaCache: "none" } }]);
  assert.deepEqual(p.log.subscribed, [{ userVisibleOnly: true, key: SERVER_KNOCK_KEY }]);
  assert.equal(p.els.knockBtn.dataset.state, "on");
  assert.equal(p.els.knockBtn.attrs["aria-pressed"], "true");
  assert.equal(p.els.knockLabel.textContent, I18N.mn.knockOn);
  assert.deepEqual(p.log.toasts, [I18N.mn.knockOnDone]);
});

test("refused: said where to allow it, and the switch says blocked; a tap then only says so again", async () => {
  const p = page({ saved: [await person("Anu")], knock: { answer: "denied" } });
  await p.api.knocksOn();
  assert.deepEqual(p.log.subscribed, []);
  assert.equal(p.els.knockBtn.dataset.state, "blocked");
  assert.deepEqual(p.log.toasts, [I18N.mn.knockBlockedHint]);
  p.els.knockBtn.onclick();
  assert.equal(p.log.asked, 1, "not asked again — the browser would not show it");
  const later = page({ saved: [await person("Anu")], knock: { answer: "default" } });
  await later.api.knocksOn();
  assert.equal(later.els.knockBtn.dataset.state, "off", "dismissed: still off, nothing said");
  assert.deepEqual(later.log.toasts, []);
});

test("turning alerts off unsubscribes", async () => {
  const p = page({ saved: [await person("Anu")] });
  await p.api.knocksOn();
  p.log.toasts.length = 0;
  p.els.knockBtn.onclick();
  await timers();
  assert.equal(p.log.unsubscribed, 1);
  assert.equal(p.els.knockBtn.dataset.state, "off");
  assert.deepEqual(p.log.toasts, [I18N.mn.knockOffDone]);
});

test("the worker's copy: each person's room and name and the language — no secrets — and only while alerts are on", async () => {
  const anu = await person("Anu", "a"), bat = await person("Bat", "b");
  const p = page({ saved: [anu, bat] });
  await timers();
  assert.equal(p.idb.size, 0, "nothing kept for a worker that is not there");
  await p.api.knocksOn();
  await timers();
  assert.deepEqual(p.idb.get("people"), { lang: "mn", names: [[anu.room, "Anu"], [bat.room, "Bat"]] });
  assert.ok(!JSON.stringify([...p.idb]).includes(anu.secret));
  p.api.renamePerson(anu);
  p.type("Anu (phone)");
  p.api.confirmSaveDialog();
  await timers();
  assert.equal(p.idb.get("people").names[0][1], "Anu (phone)", "kept up to date");
});

test("alerts on at an earlier visit: taken up again — and made afresh if the server's key changed", async () => {
  const same = page({ saved: [await person("Anu")], knock: { keyLater: true, registered: true, subscribed: true, permission: "granted" } });
  await same.api.knockKeyArrived(SERVER_KNOCK_KEY);
  assert.equal(same.els.knockBtn.dataset.state, "on");
  assert.equal(same.log.unsubscribed, 0);
  assert.equal(same.log.registered.length, 1, "the worker brought to this build");

  const changed = page({ saved: [await person("Anu")], knock: { keyLater: true, registered: true, subscribed: true, permission: "granted",
                                                                  subscribedKey: pushKeys().p256dh } });
  await changed.api.knockKeyArrived(SERVER_KNOCK_KEY);
  assert.equal(changed.log.unsubscribed, 1);
  assert.deepEqual(changed.log.subscribed, [{ userVisibleOnly: true, key: SERVER_KNOCK_KEY }]);
  assert.equal(changed.els.knockBtn.dataset.state, "on");

  const never = page({ saved: [await person("Anu")], knock: { keyLater: true } });
  await never.api.knockKeyArrived(SERVER_KNOCK_KEY);
  assert.deepEqual(never.log.registered, [], "nothing registered for someone who never turned alerts on");
  assert.equal(never.els.knockBtn.dataset.state, "off");
});

test("in a saved person's chat, each side says where to knock for it — once a channel — or that alerts are off", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu], kind: "saved", inChat: true });
  p.api.set({ meeting: anu });
  p.api.shareKnockAddress();
  p.api.shareKnockAddress();
  await settle();
  assert.deepEqual(p.log.sealed, [{ type: "knock-address", off: true }]);
  const on = page({ saved: [anu], kind: "saved", inChat: true });
  on.api.set({ meeting: anu });
  await on.api.knocksOn();
  on.log.sealed.length = 0;
  on.api.set({ knockShared: false });
  on.api.shareKnockAddress();
  await settle();
  const sent = on.log.sealed[0];
  assert.equal(sent.type, "knock-address");
  assert.ok(G.knockAddressValid(sent), "the subscription's endpoint and keys");
  const normal = page({ saved: [anu], inChat: true });
  normal.api.shareKnockAddress();
  await settle();
  assert.deepEqual(normal.log.sealed, [], "not in any other room");
});

test("forgotten with alerts on: the address made afresh and the old one ended, so they can no longer knock", async () => {
  /* Found in a security assessment: forgetting took them off this device and
     nothing more — they still held where to knock for it. */
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat] });
  await p.api.knocksOn();
  const old = p.api.get().knockSub.endpoint;
  p.log.toasts.length = 0;
  p.api.askForget(anu);
  p.rows()[0].children.find(c => c.textContent === I18N.mn.forgetYes).click();
  await timers();
  assert.equal(p.log.unsubscribed, 1, "the address they hold is ended: the push service now calls it gone");
  assert.equal(p.log.subscribed.length, 2, "and a new one made, for the same server key");
  assert.equal(p.log.subscribed[1].key, SERVER_KNOCK_KEY);
  assert.notEqual(p.api.get().knockSub.endpoint, old);
  assert.equal(p.els.knockBtn.dataset.state, "on", "alerts stay on");
  assert.deepEqual(p.log.toasts, [I18N.mn.forgetRenewed("Anu")], "said, with what it costs the others");
  assert.deepEqual(p.idb.get("people").names, [[bat.room, "Bat"]], "and the worker no longer names them");
});

test("forgotten, the others still saved learn the new address the next time they connect", async () => {
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat], kind: "saved", inChat: true });
  await p.api.knocksOn();
  p.api.forgetPerson(anu);
  await timers();
  const fresh = p.api.get().knockSub.endpoint;
  p.api.set({ meeting: p.api.get().people[0] });
  p.api.shareKnockAddress();
  await settle();
  assert.equal(p.log.sealed.at(-1).endpoint, fresh);
});

test("forgotten with alerts off: nothing to take back, nothing made, nothing said", async () => {
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat] });
  p.api.forgetPerson(anu);
  await timers();
  assert.equal(p.log.unsubscribed, 0);
  assert.deepEqual(p.log.subscribed, []);
  assert.deepEqual(p.log.toasts, []);
});

test("the new address cannot be made: the old one is still ended, and alerts are said to be off", async () => {
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat] });
  await p.api.knocksOn();
  const reg = await p.push.navigator.serviceWorker.ready;
  reg.pushManager.subscribe = async () => { throw new Error("offline"); };
  p.log.toasts.length = 0;
  p.api.forgetPerson(anu);
  await timers();
  assert.equal(p.log.unsubscribed, 1, "what they hold is ended regardless");
  assert.equal(p.api.get().knockSub, null);
  assert.equal(p.els.knockBtn.dataset.state, "off", "so the switch can turn them on again");
  assert.deepEqual(p.log.toasts, [I18N.mn.knockFailed]);
});

test("turned on or off mid-chat with a saved person: they are told at once", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu], kind: "saved", inChat: true });
  p.api.set({ meeting: anu });
  await p.api.knocksOn();
  await settle();
  assert.equal(p.log.sealed.at(-1).type, "knock-address");
  assert.ok(p.log.sealed.at(-1).endpoint);
  await p.api.knocksOff();
  await settle();
  assert.deepEqual(p.log.sealed.at(-1), { type: "knock-address", off: true });
});

test("their address is kept with them, and the bell shows by their name; off forgets it; a bad one changes nothing", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu], kind: "saved" });
  p.api.set({ meeting: anu });
  const address = { endpoint: "https://web.push.apple.com/QGu", ...pushKeys() };
  p.api.receiveKnockAddress({ type: "knock-address", ...address });
  assert.deepEqual(p.stored().people[0].knock, address);
  assert.deepEqual(p.api.get().meeting.knock, address, "the person being met, too");
  const name = p.rows()[0].querySelector(".person-name");
  assert.ok(name.children.some(c => c.classList && c.classList.contains("person-knock")), "a bell by the name");
  p.api.receiveKnockAddress({ type: "knock-address", endpoint: "nope", p256dh: "x", auth: "y" });
  assert.deepEqual(p.stored().people[0].knock, address, "a bad one changes nothing");
  p.api.receiveKnockAddress({ type: "knock-address", off: true });
  assert.equal(p.stored().people[0].knock, undefined);
  assert.ok(!p.rows()[0].querySelector(".person-name").children.some(c => c.classList && c.classList.contains("person-knock")));
});

test("saved just now: their address, come before the save finished here, is kept for them — and ours goes to them", async () => {
  const p = page({ inChat: true });
  const address = { endpoint: "https://fcm.googleapis.com/fcm/send/early", ...pushKeys() };
  p.api.receiveKnockAddress({ type: "knock-address", ...address });          // ahead of their yes being handled
  assert.deepEqual(p.api.get().knockEarly, { type: "knock-address", ...address });
  p.api.startSaveOffer();
  p.type("Anu");
  p.api.confirmSaveDialog();
  await settle();
  p.log.sealed.length = 0;
  await p.api.receiveSaveAccept();
  assert.deepEqual(p.stored().people[0].knock, address);
  assert.deepEqual(p.log.sealed, [{ type: "knock-address", off: true }], "and they learn ours");
});

test("first in their room, and they get alerts: a knock with their address — and none for someone without", async () => {
  const knock = { endpoint: "https://fcm.googleapis.com/fcm/send/x", ...pushKeys() };
  const anu = { ...await person("Anu"), knock };
  const p = page({ saved: [anu] });
  p.api.meetPerson(p.api.get().people[0]);
  p.api.meetWaiting({ sessionId: anu.room, hostKey: "k".repeat(32) });
  assert.deepEqual(p.log.ws.at(-1), { type: "knock", sessionId: anu.room, to: knock });
  assert.ok(!JSON.stringify(p.log.ws).includes(anu.secret), "nothing of the secret");
  p.api.knockAnswered({ type: "knock-result", sessionId: anu.room, ok: true, gone: false });
  assert.ok(p.rows()[0].textContent.includes(I18N.mn.personKnocked));

  const bat = await person("Bat");
  const q = page({ saved: [bat] });
  q.api.meetPerson(bat);
  q.api.meetWaiting({ sessionId: bat.room, hostKey: "k".repeat(32) });
  assert.deepEqual(q.log.ws.map(m => m.type), ["meet-session"]);
});

test("an address the push service says is gone is forgotten; another room's answer changes nothing", async () => {
  const knock = { endpoint: "https://fcm.googleapis.com/fcm/send/x", ...pushKeys() };
  const anu = { ...await person("Anu"), knock };
  const p = page({ saved: [anu] });
  p.api.meetPerson(p.api.get().people[0]);
  p.api.meetWaiting({ sessionId: anu.room, hostKey: "k".repeat(32) });
  p.api.knockAnswered({ sessionId: "~other", ok: false, gone: true });
  assert.deepEqual(p.stored().people[0].knock, knock);
  p.api.knockAnswered({ sessionId: anu.room, ok: false, gone: true });
  assert.equal(p.stored().people[0].knock, undefined);
  assert.ok(p.rows()[0].textContent.includes(I18N.mn.personWaiting), "still waiting, not knocked");
});

test("opened by tapping a knock: the address tidied, and them met at once", async () => {
  const anu = await person("Anu");
  const p = page({ saved: [anu], knock: { hash: `#knock=${anu.room}` } });
  assert.deepEqual(p.log.replaced, ["/RelayLink/"]);
  assert.deepEqual(p.log.ws, [{ type: "meet-session", sessionId: anu.room, side: "a" }]);
  assert.deepEqual(p.log.tabs, ["rooms"]);
  const stranger = page({ saved: [anu], knock: { hash: `#knock=~${"z".repeat(43)}` } });
  assert.deepEqual(stranger.log.ws, [], "someone not saved here: nothing");
  const bad = page({ saved: [anu], knock: { hash: `#knock=${anu.room}x` } });
  assert.deepEqual(bad.log.replaced, [], "not a room's shape: left alone");
});

test("tapped with the page open: met if it is free; if it is busy, only said", async () => {
  const anu = await person("Anu"), bat = await person("Bat");
  const p = page({ saved: [anu, bat] });
  p.push.swListeners.message({ data: { type: "knock", room: anu.room } });
  assert.equal(p.log.ws.at(-1).sessionId, anu.room);
  p.push.swListeners.message({ data: { type: "knock", room: bat.room } });
  assert.equal(p.log.ws.length, 1, "already meeting someone: not dropped for another");
  assert.deepEqual(p.log.toasts, [I18N.mn.knockTitle("Bat")]);
  p.push.swListeners.message({ data: { type: "knock", room: anu.room } });
  assert.equal(p.log.toasts.length, 1, "their own knock again: nothing more");
  p.push.swListeners.message({ data: { type: "other", room: bat.room } });
  p.push.swListeners.message({ data: { type: "knock", room: "<b>" } });
  assert.equal(p.log.toasts.length, 1);
  const chatting = page({ saved: [anu], inChat: true });
  chatting.push.swListeners.message({ data: { type: "knock", room: anu.room } });
  assert.deepEqual(chatting.log.ws, []);
  assert.deepEqual(chatting.log.toasts, [I18N.mn.knockTitle("Anu")]);
});

/* ══════════════════════════════════════════
   Waiting messages
══════════════════════════════════════════ */

/** A message from the other side of `p`'s pair, sealed as their device seals it. */
async function fromThem(p, text, over = {}) {
  const key = await DC.mailboxKey(p.secret);
  const m = { box: p.room, from: G.otherSide(p.side), to: p.side, id: DC.makeMailId(), at: Date.now() - 1000, text, ...over };
  const sealed = await DC.sealMail(key, m);
  return { id: m.id, at: m.at, ...sealed };
}
const envelope = row => toolFor(row, "personMail");

test("the envelope by each name, counting what is new from them", async () => {
  const anu = await person("Anu", "a");
  const mail = { v: 1, threads: { [anu.room]: { read: 10, items: [
    { id: "a".repeat(22), at: 5, mine: false, text: "old" },
    { id: "b".repeat(22), at: 20, mine: false, text: "new" },
    { id: "c".repeat(22), at: 30, mine: false, text: "newer" },
    { id: "d".repeat(22), at: 40, mine: true, text: "ours", state: "kept" }] } }, seen: {} };
  const p = page({ saved: [anu], mail });
  const tool = envelope(p.rows()[0]);
  assert.ok(tool.classList.contains("has-new"));
  assert.equal(tool.querySelector(".mail-count").textContent, "2");
  assert.equal(tool.attrs["aria-label"], `${I18N.mn.personMail}: Anu — ${I18N.mn.mailUnreadCount(2)}`);
  const none = page({ saved: [anu] });
  assert.equal(envelope(none.rows()[0]).querySelector(".mail-count"), null);
});

test("written: sealed here for their side, sent to their mailbox — with where to alert them, if they get alerts", async () => {
  const knock = { endpoint: "https://fcm.googleapis.com/fcm/send/x", ...pushKeys() };
  const anu = { ...await person("Anu", "a"), knock };
  const p = page({ saved: [anu] });
  await p.api.sendMail(p.api.get().people[0], "see you at 6");
  const sent = p.log.ws.at(-1);
  assert.deepEqual(Object.keys(sent).sort(), ["at", "box", "ct", "id", "iv", "knock", "to", "type"]);
  assert.equal(sent.type, "mail-drop");
  assert.equal(sent.box, anu.room);
  assert.equal(sent.to, "b", "for the other side");
  assert.deepEqual(sent.knock, knock);
  assert.ok(!JSON.stringify(sent).includes("see you") && !JSON.stringify(sent).includes(anu.secret), "neither the text nor the secret");
  assert.equal(await DC.openMail(await DC.mailboxKey(anu.secret), { box: anu.room, from: "a", to: "b", id: sent.id, at: sent.at, iv: sent.iv, ct: sent.ct }),
    "see you at 6", "their device opens it");
  const kept = JSON.parse(p.store.get("dc-mail")).threads[anu.room].items[0];
  assert.equal(kept.state, "sending");
  assert.equal(kept.text, "see you at 6");
  const bat = await person("Bat");
  const q = page({ saved: [bat] });
  await q.api.sendMail(bat, "hi");
  assert.equal(q.log.ws.at(-1).knock, undefined, "no alerts for them: no address sent");
});

test("sent again at each connection until the server says it has it — then never again", async () => {
  const anu = await person("Anu", "a");
  const p = page({ saved: [anu] });
  await p.api.sendMail(anu, "one");
  await p.api.sendMail(anu, "two");
  const [first, second] = p.log.ws.filter(m => m.type === "mail-drop");
  p.log.ws.length = 0;
  p.api.mailAtConnect();
  assert.deepEqual(p.log.ws.filter(m => m.type === "mail-drop").map(m => m.id), [first.id, second.id], "the link was down: both again, the same ids");
  assert.deepEqual(p.log.ws.find(m => m.type === "mail-fetch"), { type: "mail-fetch", files: true, boxes: [{ box: anu.room, side: "a" }] },
    "saying it can take photos and files");
  p.api.mailAnswered({ type: "mail-dropped", id: first.id }, true);
  p.log.ws.length = 0;
  p.api.mailAtConnect();
  assert.deepEqual(p.log.ws.filter(m => m.type === "mail-drop").map(m => m.id), [second.id]);
  const kept = JSON.parse(p.store.get("dc-mail")).threads[anu.room].items.find(m => m.id === first.id);
  assert.equal(kept.state, "kept");
  assert.equal(kept.ct, undefined, "the sealed copy is let go once kept");
});

test("refused by the server: said why, in our words, and marked not sent", async () => {
  const anu = await person("Anu", "a");
  const p = page({ saved: [anu] });
  await p.api.sendMail(anu, "hello");
  const id = p.log.ws.at(-1).id;
  p.api.mailAnswered({ type: "mail-refused", id, code: "full" }, false);
  assert.deepEqual(p.log.toasts, [I18N.mn.mailBoxFull]);
  assert.equal(p.api.get().mailStore.threads[anu.room].items[0].state, "refused");
  p.api.mailAnswered({ type: "mail-refused", id, code: "full" }, false);
  assert.equal(p.log.toasts.length, 1, "said once");
});

test("theirs: opened, kept, counted and said — and the server told it can let them go", async () => {
  const anu = await person("Anu", "a");
  const p = page({ saved: [anu] });
  const m = await fromThem(anu, "are you free tonight?");
  await p.api.receiveMail({ type: "mail", box: anu.room, side: "a", items: [m] });
  const thread = p.api.get().mailStore.threads[anu.room];
  assert.deepEqual(thread.items.map(x => [x.mine, x.text]), [[false, "are you free tonight?"]]);
  assert.deepEqual(p.log.ws.at(-1), { type: "mail-ack", box: anu.room, side: "a", ids: [m.id] });
  assert.deepEqual(p.log.toasts, [I18N.mn.mailArrived("Anu")]);
  assert.equal(p.log.noticed, 1, "chimed and counted, as a chat message is");
  assert.equal(envelope(p.rows()[0]).querySelector(".mail-count").textContent, "1");
  assert.ok(JSON.parse(p.store.get("dc-mail")).seen[anu.room].includes(m.id));
});

test("one handed back, from another pair, re-dated or garbled: not shown — and still let go", async () => {
  const anu = await person("Anu", "a");
  const p = page({ saved: [anu] });
  const ours = await fromThem(anu, "mine, reflected", { from: "a", to: "b" });
  const otherPair = await fromThem({ ...anu, secret: DC.makeRoomSecret() }, "not for us");
  const redated = { ...(await fromThem(anu, "moved in time")), at: Date.now() };
  const garbled = { id: DC.makeMailId(), at: Date.now(), iv: "x".repeat(16), ct: "AAAA" };
  await p.api.receiveMail({ type: "mail", box: anu.room, side: "a", items: [ours, otherPair, redated, garbled] });
  assert.equal((p.api.get().mailStore.threads[anu.room] || { items: [] }).items.length, 0, "none shown");
  assert.deepEqual(p.log.ws.at(-1).ids, [ours.id, otherPair.id, redated.id, garbled.id]);
  assert.deepEqual(p.log.toasts, []);
});

test("delivered twice — or two deliveries crossing — shown once", async () => {
  const anu = await person("Anu", "a");
  const p = page({ saved: [anu] });
  const m = await fromThem(anu, "once");
  const one = p.api.receiveMail({ type: "mail", box: anu.room, side: "a", items: [m] });
  const two = p.api.receiveMail({ type: "mail", box: anu.room, side: "a", items: [m] });
  await Promise.all([one, two]);
  await p.api.receiveMail({ type: "mail", box: anu.room, side: "a", items: [m] });
  assert.equal(p.api.get().mailStore.threads[anu.room].items.length, 1);
  assert.equal(p.log.toasts.length, 1);
});

test("for someone not saved here: nothing opened, nothing said", async () => {
  const anu = await person("Anu", "a");
  const p = page({ saved: [anu] });
  const stranger = await person("x", "a");
  await p.api.receiveMail({ type: "mail", box: stranger.room, side: "a", items: [await fromThem(stranger, "hi")] });
  await p.api.receiveMail({ type: "mail", box: anu.room, side: "b", items: [await fromThem(anu, "wrong side")] });
  assert.deepEqual(p.api.get().mailStore.threads, {});
  assert.deepEqual(p.log.toasts, []);
});

test("the conversation: opened by the envelope, named, read — theirs left, ours right", async () => {
  const anu = await person("Anu", "a");
  const p = page({ saved: [anu] });
  await p.api.receiveMail({ type: "mail", box: anu.room, side: "a", items: [await fromThem(anu, "hello there")] });
  await p.api.sendMail(anu, "hi!");
  envelope(p.rows()[0]).click();
  assert.ok(!p.els.mailOverlay.classList.contains("hidden"));
  assert.equal(p.els.mailTitle.textContent, "Anu");
  assert.equal(p.els.mailHint.textContent, I18N.mn.mailHint, "said plainly, with no name worked into it");
  const rows = p.els.mailList.children;
  assert.deepEqual(rows.map(r => r.className), ["mail-item peer", "mail-item me"]);
  assert.equal(rows[0].querySelector(".mail-bubble").textContent, "hello there");
  assert.match(rows[1].querySelector(".mail-meta").textContent, new RegExp(I18N.mn.mailSending));
  assert.equal(envelope(p.rows()[0]).querySelector(".mail-count"), null, "read now");
  assert.equal(p.log.ws.at(-1).type, "mail-fetch", "and anything newer asked after");
  p.api.closeThread();
  assert.ok(p.els.mailOverlay.classList.contains("hidden"));
});

test("with their conversation open, a new one is shown there — read, and no toast", async () => {
  const anu = await person("Anu", "a");
  const p = page({ saved: [anu] });
  p.api.openThread(anu);
  await p.api.receiveMail({ type: "mail", box: anu.room, side: "a", items: [await fromThem(anu, "while you look")] });
  assert.equal(p.els.mailList.children.length, 1);
  assert.deepEqual(p.log.toasts, []);
  assert.equal(G.mailUnread(p.api.get().mailStore.threads[anu.room]), 0);
});

test("Enter sends on a computer; nothing for an empty one; too long is refused, and kept to fix", async () => {
  const anu = await person("Anu", "a");
  const p = page({ saved: [anu] });
  p.api.openThread(anu);
  p.els.mailInput.value = "   ";
  p.els.mailInput.fire("keydown", { key: "Enter", shiftKey: false, isComposing: false, preventDefault() {} });
  assert.ok(!p.log.ws.some(m => m.type === "mail-drop"));
  p.els.mailInput.value = "x".repeat(G.MAX_MESSAGE_CHARS + 1);
  p.api.sendFromThread();
  assert.deepEqual(p.log.toasts, [I18N.mn.messageTooLong(G.MAX_MESSAGE_CHARS)]);
  assert.equal(p.els.mailInput.value.length, G.MAX_MESSAGE_CHARS + 1, "not lost");
  p.els.mailInput.value = "hello";
  p.els.mailInput.fire("keydown", { key: "Enter", shiftKey: false, isComposing: false, preventDefault() {} });
  await until(() => p.log.ws.some(m => m.type === "mail-drop"));
  assert.equal(p.els.mailInput.value, "");
  p.els.mailInput.value = "line";
  p.els.mailInput.fire("keydown", { key: "Enter", shiftKey: true, isComposing: false, preventDefault() {} });
  assert.equal(p.els.mailInput.value, "line", "Shift+Enter is a new line");
});

test("clearing takes two taps — and keeps the ids, so nothing cleared comes back; forgetting them takes it all", async () => {
  const anu = await person("Anu", "a"), bat = await person("Bat", "a");
  const p = page({ saved: [anu, bat] });
  const m = await fromThem(anu, "hello");
  await p.api.receiveMail({ type: "mail", box: anu.room, side: "a", items: [m] });
  p.api.openThread(anu);
  p.els.mailClearBtn.onclick();
  assert.equal(p.api.get().mailStore.threads[anu.room].items.length, 1, "one tap only asks");
  assert.equal(p.els.mailClearBtn.textContent, I18N.mn.mailClearSure);
  p.els.mailClearBtn.onclick();
  assert.equal(p.api.get().mailStore.threads[anu.room].items.length, 0);
  await p.api.receiveMail({ type: "mail", box: anu.room, side: "a", items: [m] });
  assert.equal(p.api.get().mailStore.threads[anu.room].items.length, 0, "delivered again: still gone");
  await p.api.receiveMail({ type: "mail", box: bat.room, side: "a", items: [await fromThem(bat, "from bat")] });
  p.api.askForget(bat);
  p.rows()[1].children.find(c => c.textContent === I18N.mn.forgetYes).click();
  assert.equal(p.api.get().mailStore.threads[bat.room], undefined);
  assert.equal(JSON.parse(p.store.get("dc-mail")).seen[bat.room], undefined);
});

test("\"a message waits\" tapped: the app opens at their conversation — or, already open, goes to it", async () => {
  const anu = await person("Anu", "a");
  const p = page({ saved: [anu], hash: `#mail=${anu.room}` });
  assert.ok(!p.els.mailOverlay.classList.contains("hidden"));
  assert.equal(p.els.mailTitle.textContent, "Anu");
  assert.deepEqual(p.log.replaced, ["/RelayLink/"], "the address tidied");
  const q = page({ saved: [anu] });
  q.push.swListeners.message({ data: { type: "mail", room: anu.room } });
  assert.equal(q.els.mailTitle.textContent, "Anu");
  const stranger = page({ saved: [anu], hash: `#mail=~${"z".repeat(43)}` });
  assert.ok(stranger.els.mailOverlay.classList.contains("hidden"), "not saved here: nothing opens");
});

test("the wiring: asked after at each connection, the server's word taken, and the payload nothing but the sealed message", () => {
  const onopen = between("  ws.onopen    = () => {", "  ws.onclose");
  assert.match(onopen, /mailAtConnect\(\);/);
  for (const type of ["mail", "mail-waiting", "mail-dropped", "mail-refused"]) assert.ok(app.includes(`case "${type}":`), type);
  assert.match(fn("dropMail"), /wsSend\(\{ type: "mail-drop", box: p\.room, to: G\.otherSide\(p\.side\), id: item\.id, at: item\.at, iv: item\.iv, ct: item\.ct,\s*\n\s*\.\.\.\(item\.file \? \{ file: true \} : \{\}\), \.\.\.\(p\.knock \? \{ knock: p\.knock \} : \{\}\) \}\);/);
  assert.match(fn("forgetPerson"), /delete mailStore\.threads\[p\.room\];\s*\n\s*delete mailStore\.seen\[p\.room\];/);
  for (const id of ["mailOverlay", "mailTitle", "mailHint", "mailList", "mailInput", "mailSendBtn", "mailCloseBtn", "mailClearBtn",
                    "mailAttachBtn", "mailFileInput"]) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
});

/* ══════════════════════════════════════════
   Waiting photos and files
══════════════════════════════════════════ */

/** A file as the picker hands one over. */
function picked(name, type, bytes) {
  const file = new Blob([bytes], { type });
  file.name = name;
  return file;
}

/** A photo or file from the other side of `p`'s pair: its message, sealed as
    their device seals it, and its bytes left on the stand-in server. */
async function fileFromThem(page, p, meta, bytes, over = {}) {
  const key = await DC.mailboxKey(p.secret);
  const where = { box: p.room, from: G.otherSide(p.side), to: p.side, id: DC.makeMailId() };
  const at = Date.now() - 1000;
  const sealed = await DC.sealMailBody(key, { ...where, at }, { file: meta });
  const fileWhere = { ...where, ...(over.fileWhere || {}) };
  page.env.uploads.set(`${p.room}:${p.side}:${where.id}`, await DC.sealMailFile(key, fileWhere, over.bytes || bytes));
  return { id: where.id, at, ...sealed, file: bytes.length + 28 };
}

const thePhoto = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]);

test("a photo for them: kept here, sealed, sent to the server first — then its message, which says only that it is a file", async () => {
  const anu = await person("Anu", "a");
  const p = page({ saved: [anu] });
  p.api.openThread(anu);
  p.els.mailAttachBtn.onclick === null || p.els.mailAttachBtn.onclick();
  p.els.mailFileInput.files = [picked("beach.png", "image/png", thePhoto)];
  p.els.mailFileInput.onchange();
  await until(() => p.log.ws.some(m => m.type === "mail-drop"));
  await p.api.files();
  const [upload] = p.log.web;
  assert.equal(upload.method, "POST");
  assert.equal(upload.url, "https://pi.test/dc/api/mailbox/file", "nothing of who or what in the address");
  const drop = p.log.ws.find(m => m.type === "mail-drop");
  assert.equal(upload.headers["X-DC-Mail"], `${anu.room}:b:${drop.id}:${thePhoto.length + 28}`);
  assert.equal(upload.headers["X-DC-Client"], "1");
  const key = await DC.mailboxKey(anu.secret);
  const where = { box: anu.room, from: "a", to: "b", id: drop.id };
  const sent = p.env.uploads.get(`${anu.room}:b:${drop.id}`);
  assert.ok(!Buffer.from(sent).includes(Buffer.from(thePhoto)), "sealed: the server never sees it");
  assert.deepEqual(await DC.openMailFile(key, where, sent), thePhoto, "their device opens it");
  assert.equal(drop.file, true);
  assert.deepEqual(await DC.openMailBody(key, { ...where, at: drop.at, iv: drop.iv, ct: drop.ct }),
                   { file: { name: "beach.png", type: "image/png", size: thePhoto.length } });
  const kept = JSON.parse(p.store.get("dc-mail")).threads[anu.room].items[0];
  assert.deepEqual(kept.file, { name: "beach.png", type: "image/png", size: thePhoto.length });
  assert.equal(kept.text, undefined);
  const copy = await p.api.mailFileBlob(anu.room, drop.id);
  assert.deepEqual(new Uint8Array(await copy.arrayBuffer()), thePhoto, "our own copy, kept here");
  assert.equal(p.els.mailFileInput.value, "", "the picker emptied, so the same one can be picked again");
  p.api.mailAnswered({ type: "mail-dropped", id: drop.id }, true);
  assert.equal(p.api.get().mailStore.threads[anu.room].items[0].state, "kept");
});

test("a file that says it is a page is kept as plain bytes, here and there — never opened as one", async () => {
  const anu = await person("Anu", "a");
  const p = page({ saved: [anu] });
  await p.api.sendMailFile(anu, picked("note.html", "text/html", Uint8Array.from([60, 98, 62])));
  const id = p.api.get().mailStore.threads[anu.room].items[0].id;
  assert.equal((await p.api.mailFileBlob(anu.room, id)).type, "application/octet-stream");
  const q = page({ saved: [{ ...anu, side: "b" }] });
  const m = await fileFromThem(q, { ...anu, side: "b" }, { name: "x.svg", type: "image/svg+xml", size: 3 }, Uint8Array.from([1, 2, 3]));
  await q.api.receiveMail({ type: "mail", box: anu.room, side: "b", items: [m] });
  assert.equal((await q.api.mailFileBlob(anu.room, m.id)).type, "application/octet-stream", "an SVG can carry script: a file, not a picture");
});

test("too big, or a server that keeps no files: said, and nothing sent", async () => {
  const anu = await person("Anu", "a");
  const p = page({ saved: [anu] });
  const big = picked("film.mp4", "video/mp4", new Uint8Array(1));
  Object.defineProperty(big, "size", { value: G.MAIL_FILE_MAX + 1 });
  await p.api.sendMailFile(anu, big);
  assert.deepEqual(p.log.toasts, [I18N.mn.mailFileTooBig]);
  assert.deepEqual(p.log.web, []);
  assert.equal((p.api.get().mailStore.threads[anu.room] || { items: [] }).items.length, 0);
  assert.match(app, /if \(j && Number\.isSafeInteger\(j\.mailFileMaxBytes\)\) mailFileMaxBytes = Math\.max\(0, Math\.min\(j\.mailFileMaxBytes - 28, G\.MAIL_FILE_MAX\)\);/,
    "the server's own limit, from /api/ping — 0 when it keeps none");
  assert.match(fn("sendMailFile"), /if \(!mailFileMaxBytes\) \{ showToast\(t\("mailFilesOff"\), "warn"\); return; \}/);
});

test("the server says no: marked not sent, and why — in our words", async () => {
  const anu = await person("Anu", "a");
  for (const [status, code, said] of [[507, "full", I18N.mn.mailBoxFull], [503, "busy", I18N.mn.mailTryLater],
                                      [413, "too-large", I18N.mn.mailFileTooBig], [503, "off", I18N.mn.mailFilesOff], [500, null, I18N.mn.mailNotSent]]) {
    const p = page({ saved: [anu] });
    p.env.web = status;
    p.env.webCode = code;
    await p.api.sendMailFile(anu, picked("a.png", "image/png", thePhoto));
    assert.equal(p.api.get().mailStore.threads[anu.room].items[0].state, "refused", code);
    assert.deepEqual(p.log.toasts, [said], code);
    assert.ok(!p.log.ws.some(m => m.type === "mail-drop"), "no message for a file not there");
  }
});

test("no answer from the server: still on its way, and sent from the start at the next connection — once, however often asked", async () => {
  const anu = await person("Anu", "a");
  const p = page({ saved: [anu] });
  p.env.web = "down";
  await p.api.sendMailFile(anu, picked("a.png", "image/png", thePhoto));
  const item = p.api.get().mailStore.threads[anu.room].items[0];
  assert.equal(item.state, "sending");
  assert.deepEqual(p.log.toasts, []);
  p.env.web = "works";
  p.log.web.length = 0;
  p.api.mailAtConnect();
  p.api.mailAtConnect();
  await p.api.files();
  assert.equal(p.log.web.filter(r => r.method === "POST").length, 1, "the file once");
  assert.deepEqual(p.log.ws.filter(m => m.type === "mail-drop").map(m => [m.id, m.file]), [[item.id, true]]);
});

test("several picked at once: each shown at once, sent one after another", async () => {
  const anu = await person("Anu", "a");
  const p = page({ saved: [anu] });
  p.api.openThread(anu);
  p.els.mailFileInput.files = [picked("1.png", "image/png", thePhoto), picked("2.pdf", "application/pdf", Uint8Array.from([7, 7]))];
  p.els.mailFileInput.onchange();
  await until(() => p.log.ws.filter(m => m.type === "mail-drop").length === 2);
  assert.deepEqual(p.api.get().mailStore.threads[anu.room].items.map(m => m.file.name).sort(), ["1.png", "2.pdf"]);
  assert.equal(p.log.web.length, 2);
});

test("theirs: fetched, opened, kept here and shown — and only then the server told it can let it go", async () => {
  const anu = await person("Anu", "a");
  const p = page({ saved: [anu] });
  const m = await fileFromThem(p, anu, { name: "cat.jpg", type: "image/jpeg", size: thePhoto.length }, thePhoto);
  await p.api.receiveMail({ type: "mail", box: anu.room, side: "a", items: [m] });
  const fetched = p.log.web.find(r => r.method === "GET");
  assert.equal(fetched.url, "https://pi.test/dc/api/mailbox/file");
  assert.equal(fetched.headers["X-DC-Mail"], `${anu.room}:a:${m.id}`);
  const item = p.api.get().mailStore.threads[anu.room].items[0];
  assert.deepEqual([item.mine, item.file], [false, { name: "cat.jpg", type: "image/jpeg", size: thePhoto.length }]);
  const copy = await p.api.mailFileBlob(anu.room, m.id);
  assert.deepEqual(new Uint8Array(await copy.arrayBuffer()), thePhoto);
  assert.equal(copy.type, "image/jpeg");
  assert.deepEqual(p.log.ws.at(-1), { type: "mail-ack", box: anu.room, side: "a", ids: [m.id] });
  assert.deepEqual(p.log.toasts, [I18N.mn.mailArrived("Anu")]);
});

test("theirs, with no answer from the server: not taken, not let go — fetched next time", async () => {
  const anu = await person("Anu", "a");
  const p = page({ saved: [anu] });
  const m = await fileFromThem(p, anu, { name: "cat.jpg", type: "image/jpeg", size: thePhoto.length }, thePhoto);
  const text = await fromThem(anu, "and a word");
  p.env.web = "down";
  await p.api.receiveMail({ type: "mail", box: anu.room, side: "a", items: [m, text] });
  assert.deepEqual(p.log.ws.at(-1).ids, [text.id], "only the word let go");
  assert.equal(p.api.get().mailStore.threads[anu.room].items.length, 1);
  p.env.web = 429;
  await p.api.receiveMail({ type: "mail", box: anu.room, side: "a", items: [m] });
  assert.equal(p.api.get().mailStore.threads[anu.room].items.length, 1, "busy: the same");
  p.env.web = "works";
  await p.api.receiveMail({ type: "mail", box: anu.room, side: "a", items: [m] });
  assert.deepEqual(p.api.get().mailStore.threads[anu.room].items.map(x => Boolean(x.file)).sort(), [false, true]);
  assert.deepEqual(p.log.ws.at(-1).ids, [m.id]);
});

test("theirs, gone from the server or not opening as this one: said once, and let go", async () => {
  const anu = await person("Anu", "a");
  const p = page({ saved: [anu] });
  const gone = await fileFromThem(p, anu, { name: "a.png", type: "image/png", size: thePhoto.length }, thePhoto);
  p.env.uploads.clear();
  const swapped = await fileFromThem(p, anu, { name: "b.png", type: "image/png", size: thePhoto.length }, thePhoto, { fileWhere: { id: DC.makeMailId() } });
  const resized = await fileFromThem(p, anu, { name: "c.png", type: "image/png", size: 3 }, thePhoto);
  await p.api.receiveMail({ type: "mail", box: anu.room, side: "a", items: [gone, swapped, resized] });
  assert.equal((p.api.get().mailStore.threads[anu.room] || { items: [] }).items.length, 0);
  assert.deepEqual(p.log.toasts, [I18N.mn.mailFileGone]);
  assert.deepEqual(p.log.ws.at(-1).ids, [gone.id, swapped.id, resized.id]);
  assert.equal(p.files.size, 0, "nothing kept");
});

test("in the conversation: a photo is drawn, tap to see it big; a file is its name and size, tap to save it", async () => {
  const anu = await person("Anu", "a");
  const p = page({ saved: [anu] });
  const photo = await fileFromThem(p, anu, { name: "cat.jpg", type: "image/jpeg", size: thePhoto.length }, thePhoto);
  const doc = await fileFromThem(p, anu, { name: "plan.pdf", type: "application/pdf", size: 2 }, Uint8Array.from([1, 2]));
  await p.api.receiveMail({ type: "mail", box: anu.room, side: "a", items: [photo, doc] });
  p.api.openThread(anu);
  await settle(); await settle(); await settle();
  const [first, second] = p.els.mailList.children.map(r => r.querySelector(".mail-bubble"));
  const img = first.children[0];
  assert.equal(img.className, "mail-image");
  assert.ok(first.classList.contains("has-image"));
  assert.match(img.src, /^blob:/);
  img.onclick();
  assert.deepEqual(p.log.viewed, [{ url: img.src, name: "cat.jpg" }]);
  const chip = second.querySelector(".mail-file");
  assert.equal(chip.querySelector(".mail-file-name").textContent, "plan.pdf");
  assert.equal(chip.download, "plan.pdf");
  assert.match(chip.href, /^blob:/);
  p.api.closeThread();
  p.files.clear();
  p.api.openThread(anu);
  await settle(); await settle(); await settle();
  const missing = p.els.mailList.children[0].querySelector(".mail-file");
  assert.ok(missing.classList.contains("missing"), "its copy gone from this device: said so");
  assert.match(missing.querySelector(".mail-file-size").textContent, new RegExp(I18N.mn.mailFileMissing));
  assert.doesNotMatch(fn("fillMailFile"), /[^.]fmtBytes\(/, "drawn as the page loads, from a tapped alert: nothing declared later in app.js");
});

test("cleared, or the person forgotten: their files go from this device too", async () => {
  const anu = await person("Anu", "a"), bat = await person("Bat", "a");
  const p = page({ saved: [anu, bat] });
  await p.api.sendMailFile(anu, picked("a.png", "image/png", thePhoto));
  await p.api.sendMailFile(bat, picked("b.png", "image/png", thePhoto));
  assert.equal(p.files.size, 2);
  p.api.openThread(anu);
  p.els.mailClearBtn.click();
  p.els.mailClearBtn.click();
  await settle(); await settle();
  assert.deepEqual([...p.files.keys()].map(k => k.split("/")[0]), [bat.room], "only theirs");
  p.api.forgetPerson(p.api.get().people.find(q => q.name === "Bat"));
  await settle(); await settle();
  assert.equal(p.files.size, 0);
});
