/*
  Telling you something arrived — actually run.

  A message, a file or a call that came while nobody was looking at the page
  arrived in silence: no sound, nothing in the tab's title, and an incoming
  call rang nobody. Now a message chimes, buzzes and counts in the title while
  the page is not looked at, and an incoming call rings until it is answered,
  turned down or over.

  The rules are G.unattended and G.tabTitle. The block "Telling you something
  arrived" is lifted out of app.js and run against a stand-in page, sound and
  clock. Where it is called from is checked in message, receive and ring.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");
const G      = require("../guards.js");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");
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

/* ══════════════════════════════════════════
   The rules
══════════════════════════════════════════ */

test("nobody is looking when the page is hidden, or another window is in front", () => {
  assert.equal(G.unattended({ visibility: "hidden", focused: false }), true);
  assert.equal(G.unattended({ visibility: "hidden", focused: true }), true);
  assert.equal(G.unattended({ visibility: "visible", focused: false }), true, "another window in front");
  assert.equal(G.unattended({ visibility: "visible", focused: true }), false);
  assert.equal(G.unattended(undefined), false);
});

test("the title counts what is unread, and shows a phone while a call rings", () => {
  const base = "Өртөө";
  assert.equal(G.tabTitle({ base, unread: 0, ringing: false }), base);
  assert.equal(G.tabTitle({ base, unread: 2, ringing: false }), `(2) ${base}`);
  assert.equal(G.tabTitle({ base, unread: 120, ringing: false }), `(99+) ${base}`);
  assert.equal(G.tabTitle({ base, unread: 0, ringing: true }), `📞 ${base}`);
  assert.equal(G.tabTitle({ base, unread: 3, ringing: true }), `📞 (3) ${base}`);
  for (const unread of [-1, 1.5, NaN, "2", undefined]) assert.equal(G.tabTitle({ base, unread }), base, String(unread));
  assert.equal(G.tabTitle(undefined), "");
});

/* ══════════════════════════════════════════
   The block, run
══════════════════════════════════════════ */

const BLOCK = between("/* ── Telling you something arrived ──", "/* ── Reconnect / back-to-lobby button");

function classes(initial = []) {
  const set = new Set(initial);
  return { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c) };
}

const I18N = new Function("localStorage", `${fs.readFileSync(path.join(__dirname, "..", "i18n.js"), "utf8")}; return I18N;`)({ getItem: () => null });

function page({ visible = false, focused = false, ctxState = "running", resumeWorks = true, lang = "mn" } = {}) {
  const log = { buzz: [], badge: [], sys: [], ended: 0, callChat: 0 };
  const listeners = {};
  const timers = new Map();
  let nextTimer = 0, releaseResume = null;
  const clock = { now: 1_000_000 };
  const speakers = { name: "speakers" };
  const contexts = [];
  class AudioContext {
    constructor() { this.state = ctxState; this.currentTime = 0; this.destination = speakers; this.tones = []; contexts.push(this); }
    resume() {
      if (resumeWorks === "later") return new Promise(r => { releaseResume = () => { this.state = "running"; r(); }; });
      if (resumeWorks) this.state = "running";
      return Promise.resolve();
    }
    createOscillator() {
      const o = { frequency: {}, connect: n => { o.to = n; }, start: at => { o.at = at; }, stop() {} };
      this.tones.push(o);
      return o;
    }
    createGain() {
      const g = { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
                  connect: n => { g.to = n; }, disconnect: () => { g.to = null; } };
      return g;
    }
  }
  const document = {
    title: "Өртөө", visibilityState: visible ? "visible" : "hidden",
    hasFocus: () => focused,
    addEventListener: (type, f) => { (listeners[type] = listeners[type] || []).push(f); }
  };
  const window = { AudioContext, addEventListener: (type, f) => { (listeners[type] = listeners[type] || []).push(f); } };
  const navigator = {
    vibrate: p => { log.buzz.push(p); return true; },
    setAppBadge: n => { log.badge.push(n); return Promise.resolve(); },
    clearAppBadge: () => { log.badge.push(0); return Promise.resolve(); }
  };
  const callRequestModal = { classList: classes(["hidden"]) };
  const api = new Function(
    "G", "t", "document", "window", "navigator", "Date", "setTimeout", "clearTimeout", "callRequestModal", "appendSys", "log", `
    ${BLOCK}
    function endCall() { log.ended++; stopIncomingRing(); callRequestModal.classList.add("hidden"); }
    function noteCallChat() { log.callChat++; }
    return { noticeArrival, startIncomingRing, stopIncomingRing,
             ringing: () => ringing, RING_BUZZ, INCOMING_RING_MS };`
  )(G, k => (k === "appName" ? I18N[lang].appName : k), document, window, navigator, { now: () => clock.now },
    (f, ms) => { const id = ++nextTimer; timers.set(id, { f, ms }); return id; }, id => timers.delete(id),
    callRequestModal, k => log.sys.push(k), log);

  const fire = type => (listeners[type] || []).forEach(f => f());
  /* Where a tone ends up: straight to the speakers (a chime), through the
     ring's own output (a ring), or nowhere — the ring was cut. */
  const heard = () => {
    const ctx = contexts[0];
    if (!ctx) return { chimes: 0, rings: 0 };
    const reaches = o => { let n = o.to; for (let i = 0; i < 3 && n; i++) { if (n === speakers) return i; n = n.to; } return -1; };
    return { chimes: ctx.tones.filter(o => reaches(o) === 1).length, rings: ctx.tones.filter(o => reaches(o) === 2).length };
  };
  const look = (v, f) => { document.visibilityState = v ? "visible" : "hidden"; focused = f; };
  const settle = () => new Promise(r => setImmediate(r));
  const runTimers = () => { for (const [id, t] of [...timers]) { timers.delete(id); t.f(); } };
  return { ...api, log, fire, heard, look, settle, clock, document, timers, runTimers, callRequestModal, contexts,
           resume: () => releaseResume && releaseResume() };
}

test("nobody looking: a message chimes, buzzes, and counts in the title and on the app's icon", async () => {
  const p = page();
  p.fire("pointerdown");                    // touched once, earlier
  p.noticeArrival();
  await p.settle();
  assert.equal(p.document.title, "(1) Өртөө");
  assert.equal(p.heard().chimes, 2, "a two-note chime");
  assert.deepEqual(p.log.buzz, [120]);
  assert.deepEqual(p.log.badge, [1]);
  p.clock.now += 5000;
  p.noticeArrival();
  assert.equal(p.document.title, "(2) Өртөө");
});

test("the title names the app in the language chosen: Өртөө or RelayLink", () => {
  assert.equal(I18N.mn.appName, "Өртөө");
  assert.equal(I18N.en.appName, "RelayLink");
  const p = page({ lang: "en" });
  p.noticeArrival();
  assert.equal(p.document.title, "(1) RelayLink");
  assert.match(fn("applyI18n"), /\n\s*drawTitle\(\);/, "switching the language renames the tab at once");
  assert.doesNotMatch(app, /BASE_TITLE|document\.title(?! =)/, "nothing keeps the name the page was loaded with");
});

test("a burst of messages chimes once, and every one is counted", () => {
  const p = page();
  p.fire("pointerdown");
  for (let i = 0; i < 5; i++) p.noticeArrival();
  assert.equal(p.document.title, "(5) Өртөө");
  assert.equal(p.heard().chimes, 2);
  assert.equal(p.log.buzz.length, 1);
  p.clock.now += 1500;
  p.noticeArrival();
  assert.equal(p.heard().chimes, 4, "a moment later, the next one chimes again");
});

test("while it is looked at, a message makes no sound and no count", () => {
  const p = page({ visible: true, focused: true });
  p.fire("pointerdown");
  p.noticeArrival();
  assert.equal(p.document.title, "Өртөө");
  assert.equal(p.heard().chimes, 0);
  assert.deepEqual(p.log.buzz, []);
  assert.equal(p.log.callChat, 1, "but a call covering the chat is still told — see callchat");
});

test("on screen but behind another window counts as not looked at", () => {
  const p = page({ visible: true, focused: false });
  p.fire("pointerdown");
  p.noticeArrival();
  assert.equal(p.document.title, "(1) Өртөө");
});

test("looked at again, the count goes — and only once it really is", () => {
  const p = page();
  p.fire("pointerdown");
  p.noticeArrival(); p.noticeArrival();
  p.look(true, false);
  p.fire("visibilitychange");
  assert.equal(p.document.title, "(2) Өртөө", "back on screen, but another window has the focus");
  p.look(true, true);
  p.fire("focus");
  assert.equal(p.document.title, "Өртөө");
  assert.equal(p.log.badge.at(-1), 0, "the app's icon is cleared too");
});

test("before the first tap there is no sound — browsers allow none — but the title still counts", () => {
  const p = page();
  p.noticeArrival();
  assert.equal(p.contexts.length, 0, "no sound made at all");
  assert.equal(p.document.title, "(1) Өртөө");
});

test("a sound the phone put to sleep is woken first", async () => {
  const p = page({ ctxState: "suspended" });
  p.fire("pointerdown");
  p.contexts[0].state = "suspended";     // an iPhone back from the background
  p.noticeArrival();
  await p.settle();
  assert.equal(p.heard().chimes, 2);
});

test("an incoming call rings — looked at or not — with a phone in the title, until it stops", async () => {
  const p = page({ visible: true, focused: true });
  p.fire("pointerdown");
  p.startIncomingRing();
  await p.settle();
  assert.equal(p.document.title, "📞 Өртөө");
  const rings = Math.ceil(p.INCOMING_RING_MS / 3000);
  assert.equal(p.heard().rings, 2 * rings, "a two-note ring every three seconds, for the whole time");
  assert.deepEqual(p.log.buzz, [p.RING_BUZZ]);
  p.stopIncomingRing();
  assert.equal(p.heard().rings, 0, "cut, every ring still to come with it");
  assert.equal(p.log.buzz.at(-1), 0, "the buzzing stops");
  assert.equal(p.document.title, "Өртөө");
  assert.equal(p.timers.size, 0);
});

test("answered while the sound was still waking: it never starts ringing", async () => {
  const p = page({ ctxState: "suspended", resumeWorks: "later" });
  p.fire("pointerdown");
  p.startIncomingRing();
  p.stopIncomingRing();
  p.resume();
  await p.settle();
  assert.equal(p.heard().rings, 0);
});

test("one ring at a time", async () => {
  const p = page();
  p.fire("pointerdown");
  p.startIncomingRing();
  p.startIncomingRing();
  await p.settle();
  assert.equal(p.heard().rings, 2 * Math.ceil(p.INCOMING_RING_MS / 3000));
  assert.equal(p.timers.size, 1);
});

test("a hang-up that never arrives: once the caller has surely given up, it is a missed call", async () => {
  const p = page();
  p.fire("pointerdown");
  p.callRequestModal.classList.remove("hidden");
  p.startIncomingRing();
  assert.equal([...p.timers.values()][0].ms, G.CALL_RING_MS + 5000, "longer than the caller rings");
  p.runTimers();
  await p.settle();
  assert.equal(p.log.ended, 1);
  assert.deepEqual(p.log.sys, ["sysMissedCall"]);
  assert.equal(p.ringing(), false);
  assert.equal(p.document.title, "(1) Өртөө", "noticed like a message");
});

test("the ring's buzz is a buzz, then quiet, for as long as it rings, inside what phones accept", () => {
  const p = page();
  const total = p.RING_BUZZ.reduce((a, b) => a + b, 0);
  assert.ok(total >= p.INCOMING_RING_MS, `${total}ms of pattern`);
  assert.ok(p.RING_BUZZ.length <= 128 && p.RING_BUZZ.every(ms => ms > 0 && ms <= 10_000), "Chrome's limits on a pattern");
});

/* ══════════════════════════════════════════
   The wiring
══════════════════════════════════════════ */

test("an incoming call rings once it is asked, and stops when answered, turned down or ended", () => {
  const ask = fn("handleCallRequest");
  const busy = ask.indexOf('dcSendCallSignal({ type: "call-reject" });'), ring = ask.indexOf("startIncomingRing();");
  assert.ok(busy > -1 && ring > busy, "a call refused as busy does not ring");
  assert.match(ask, /const cleanup = \(\) => \{ stopIncomingRing\(\);/, "Accept and Decline both go through cleanup");
  assert.match(fn("endCall"), /stopIncomingRing\(\);\n\s*callRequestModal\.classList\.add\("hidden"\);/);
});

test("sound is readied at the first tap or key, and looking again is noticed", () => {
  assert.match(BLOCK, /document\.addEventListener\("pointerdown", readySound, true\);/);
  assert.match(BLOCK, /document\.addEventListener\("keydown", readySound, true\);/);
  assert.match(BLOCK, /document\.addEventListener\("visibilitychange", markSeen\);/);
  assert.match(BLOCK, /window\.addEventListener\("focus", markSeen\);/);
});
