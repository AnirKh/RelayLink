/*
  A code room that survives a wrong word, and a connection that says when it
  cannot come up — actually run.

  - One wrong word used to end a code room: the host sat on a dead chat screen
    while the guest's leaving deleted the room, and the right word could then
    only find "not found". Now the host turns the guest away (release-guest),
    the server keeps the room, and the host goes back to waiting with a note.
  - Two devices whose networks block direct connections sat on "Connecting…"
    for as long as anyone watched. After CONNECT_GIVE_UP_MS the chat says so,
    and what to try.

  pakeFailClosed, returnToWaitingRoom, the guest-left case and the
  connection watch are lifted out of app.js and run against stand-ins. The
  server's side is in test/integration/server.test.js.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");
const G      = require("../guards.js");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");
const fn = name => {
  const m = app.match(new RegExp(`^(?:async )?function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(m, `${name} not found as a top-level function in app.js`);
  return m[0];
};
const between = (from, to) => {
  const a = app.indexOf(from), b = app.indexOf(to, a);
  assert.ok(a > 0 && b > a, `${from} … ${to} not found in app.js`);
  return app.slice(a, b);
};

function classes(initial = []) {
  const set = new Set(initial);
  return { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c),
           toggle: (c, on) => (on ? set.add(c) : set.delete(c)) };
}

/* ══════════════════════════════════════════
   The rule
══════════════════════════════════════════ */

test("a connection is stuck only while the chat shows and the channel never opened", () => {
  assert.equal(G.connectStalled({ chatOpen: true, channelOpen: false, keyAgreed: false }), true);
  assert.equal(G.connectStalled({ chatOpen: true, channelOpen: true, keyAgreed: false }), false,
    "a channel that opened and failed its key check has said so itself");
  assert.equal(G.connectStalled({ chatOpen: true, channelOpen: false, keyAgreed: true }), false);
  assert.equal(G.connectStalled({ chatOpen: false, channelOpen: false, keyAgreed: false }), false, "nobody is looking");
  assert.equal(G.connectStalled({ chatOpen: "yes", channelOpen: false }), false);
  assert.equal(G.connectStalled(undefined), false);
});

/* ══════════════════════════════════════════
   A wrong word, run
══════════════════════════════════════════ */

function codeHost({ isHost = true, locked = false, alreadyWaiting = false } = {}) {
  const log = { sent: [], toasts: [], sys: [], closed: 0, ended: 0, drawn: [], tab: [], screenOn: [], leaves: 0, timers: [], disarmed: 0, saved: 0 };
  const chatScreen = { classList: classes(alreadyWaiting ? ["hidden"] : []) };
  const lobbyScreen = { classList: classes(alreadyWaiting ? [] : ["hidden"]) };
  const createInfo = { notes: [], prepend(n) { this.notes.push(n.textContent); } };
  const dataChannel = { onclose: () => log.sys.push("closed-handler-ran") };
  const api = new Function(
    "G", "t", "wsSend", "showToast", "appendSys", "endCall", "closePeerConnection", "showLobbyTab",
    "showRoomReady", "keepScreenOn", "updateKeyVerifyUi", "pakeReset", "clearConnectWatch", "disarmBackGuard", "saveHostRoom", "document",
    "chatScreen", "lobbyScreen", "createInfo", "sendBtn", "voiceCallBtn", "videoCallBtn", "leaveBtn", "setTimeout", "start",
    `let isHost = start.isHost, currentSession = { sessionId: "word-room" }, keyAgreement = "ECDH";
     let e2eReady = false, e2eVerified = false, e2eSecureMode = false, wordMatched = true;
     let codeFailures = 0, codeLockedUntil = start.locked ? Date.now() + 60000 : 0, roomReadyInfo = { sessionId: "word-room" };
     let dataChannel = start.dataChannel;
     ${fn("pakeFailClosed")}
     ${fn("returnToWaitingRoom")}
     return { pakeFailClosed, returnToWaitingRoom, failures: () => codeFailures, matched: () => wordMatched, channel: () => dataChannel };`
  )(G, k => k, m => log.sent.push(m), m => log.toasts.push(m), m => log.sys.push(m), () => log.ended++,
    () => log.closed++, n => log.tab.push(n), d => log.drawn.push(d), on => log.screenOn.push(on), () => {}, () => {}, () => {}, () => log.disarmed++, () => log.saved++,
    { getElementById: () => ({ style: {} }), createElement: () => ({ style: {}, textContent: "" }) },
    chatScreen, lobbyScreen, createInfo, {}, {}, {}, { click: () => log.leaves++ }, (f, ms) => log.timers.push(ms),
    { isHost, locked, dataChannel });
  return { ...api, log, chatScreen, lobbyScreen, createInfo, dataChannel };
}

test("a wrong word: the host turns the guest away and goes back to waiting, with a note", () => {
  const h = codeHost();
  h.pakeFailClosed(false);
  assert.deepEqual(h.log.sent, [{ type: "release-guest", sessionId: "word-room" }], "the server frees the seat");
  assert.equal(h.log.closed, 1, "the attempt's connection is closed");
  assert.equal(h.chatScreen.classList.contains("hidden"), true);
  assert.equal(h.lobbyScreen.classList.contains("hidden"), false);
  assert.deepEqual(h.log.tab, ["create"], "on the Create tab, where the room is");
  assert.deepEqual(h.log.drawn, [{ sessionId: "word-room" }], "the ready panel drawn again");
  assert.deepEqual(h.createInfo.notes, ["⚠️ codeWrongHost"]);
  assert.equal(h.failures(), 1);
  assert.deepEqual(h.log.screenOn, [true], "still hosting: the screen stays on");
  assert.deepEqual(h.log.toasts, [], "the note says it; no toast on top");
  assert.equal(h.log.disarmed, 1, "the Back button's hold on the chat is let go");
  assert.equal(h.log.saved, 1, "hosting a waiting room again: kept, to take back after a reload");
});

test("our own closing does not run the channel's close handler", () => {
  const h = codeHost();
  h.pakeFailClosed(false);
  assert.equal(h.dataChannel.onclose, null);
  assert.ok(!h.log.sys.includes("closed-handler-ran"));
});

test("once locked, the note says so", () => {
  const h = codeHost({ locked: true });
  h.pakeFailClosed(true);
  assert.deepEqual(h.createInfo.notes, ["⚠️ codeLocked"]);
  assert.equal(h.failures(), 0, "the lock itself is not another failure");
});

test("a guest turned away from a locked room is told so through the server, and for how long", () => {
  const h = codeHost({ locked: true });          // locked for another minute
  h.pakeFailClosed(true);
  assert.equal(h.log.sent.length, 1);
  const [sent] = h.log.sent;
  assert.equal(sent.type, "release-guest");
  assert.equal(sent.reason, "locked");
  assert.ok(sent.retryIn > 55 && sent.retryIn <= 60, `retryIn ${sent.retryIn}`);
});

test("how long a lock has left, and the minutes a guest is told", () => {
  assert.equal(G.codeLockSecondsLeft(0, 1000), 0, "no lock");
  assert.equal(G.codeLockSecondsLeft(1000, 1000), 0, "over");
  assert.equal(G.codeLockSecondsLeft(61_001, 1000), 61);
  assert.equal(G.codeLockSecondsLeft(1e12, 0), 3600, "never more than an hour");
  assert.equal(G.codeLockSecondsLeft(NaN, 0), 0);
  assert.equal(G.lockMinutes(240), 4);
  assert.equal(G.lockMinutes(241), 5, "rounded up: never told to come back too soon");
  assert.equal(G.lockMinutes(10), 1, "at least one — not \"0 minutes\"");
  assert.equal(G.lockMinutes(0), 1, "a lock with nothing left is still said as a minute");
  assert.equal(G.lockMinutes(undefined), 5, "an older page said nothing: the lock's own length");
  assert.equal(G.lockMinutes(-3), 5);
});

/* The guest's side: the server's notice, with or without the lock. */
const PEER_GONE = between('    case "peer-disconnected":', '    case "seat-taken":');
const I18N_ = new Function("localStorage", `${fs.readFileSync(path.join(__dirname, "..", "i18n.js"), "utf8")}; return I18N;`)({ getItem: () => null });

function guestTold(data, { isHost = false, roomKind = "code", e2eReady = false } = {}) {
  const log = { toasts: [], sys: [], left: 0, status: [], timers: [], closed: 0 };
  const dataChannel = { readyState: "open", onclose: () => log.sys.push("closed-handler") };
  new Function("G", "t", "I18N", "LANG", "roomEventIsOurs", "showToast", "appendSys", "endCall", "closePeerConnection",
    "showReconnectButton", "setTimeout", "leaveBtn", "lobbyStatus", "document", "start", `
    let isHost = start.isHost, roomKind = start.roomKind, e2eReady = start.e2eReady, serverRoomGone = false;
    let currentSession = { sessionId: "word-room" };
    const dataChannel = start.dataChannel, pc = { iceConnectionState: "connected" };
    ${fn("turnedAwayLocked")}
    function deliver(data) { switch (data.type) {\n${PEER_GONE}\n} }
    deliver(start.data);`
  )(G, k => I18N_.mn[k], I18N_, "mn", () => true, m => log.toasts.push(m), k => log.sys.push(k), () => {},
    () => log.closed++, () => {}, (f, ms) => log.timers.push({ f, ms }), { click: () => log.left++ },
    { replaceChildren: el => log.status.push(el.textContent) }, { createElement: () => ({ style: {}, textContent: "" }) },
    { isHost, roomKind, e2eReady, data, dataChannel });
  return Object.assign(log, { dataChannel });      // the live log: the timer still writes to it
}

test("turned away from a locked room: told why and how long, then back to the lobby, where it is said again", () => {
  const g = guestTold({ type: "peer-disconnected", sessionId: "word-room", reason: "code-locked", retryIn: 240 });
  const words = I18N_.mn.codeLockedGuest(4);
  assert.deepEqual(g.toasts, [words]);
  assert.deepEqual(g.sys, [words], "not \"the other side left\"");
  assert.equal(g.dataChannel.onclose, null, "the channel closing after says nothing more");
  assert.deepEqual(g.timers.map(t => t.ms), [1200]);
  g.timers[0].f();
  assert.equal(g.left, 1);
  assert.deepEqual(g.status, [`🔒 ${words}`]);
});

test("without the lock, or after a chat began, or not in a code room, the notice is the old one", () => {
  for (const [data, opts] of [
    [{ type: "peer-disconnected", sessionId: "word-room" }, {}],
    [{ type: "peer-disconnected", sessionId: "word-room", reason: "code-locked" }, { e2eReady: true }],
    [{ type: "peer-disconnected", sessionId: "word-room", reason: "code-locked" }, { roomKind: "pin" }],
    [{ type: "peer-disconnected", sessionId: "word-room", reason: "code-locked" }, { isHost: true }]
  ]) {
    const g = guestTold(data, opts);
    assert.deepEqual(g.toasts, [], JSON.stringify(opts));
    assert.notEqual(g.dataChannel.onclose, null, "the chat's own handling is left alone");
  }
});

/* pakeBegin and pakeFailClosed together, on a stand-in clock: the host's count
   of wrong words through a whole lock. */
function lockingHost() {
  const log = { notes: [], started: 0 };
  const clock = { now: 1_000_000 };
  const api = new Function("G", "t", "Date", "PAKE", "appendSys", "wsSend", "showToast", "setTimeout", "console", "log", `
    let isHost = true, currentSession = { sessionId: "word-room" }, keyAgreement = "ECDH", pakeCode = "apple";
    let e2eReady = false, e2eVerified = false, e2eSecureMode = false, wordMatched = false, pakeStarted = null, pakeSession = null;
    let codeFailures = 0, codeLockedUntil = 0;
    const sendBtn = {}, voiceCallBtn = {}, videoCallBtn = {}, leaveBtn = {}, dataChannel = { send() {} };
    function pakeReset() { pakeStarted = null; pakeSession = null; }
    function updateKeyVerifyUi() {}
    function returnToWaitingRoom(note) { log.notes.push(note); }
    ${fn("pakeBegin")}
    ${fn("pakeFailClosed")}
    return { pakeBegin, pakeFailClosed, failures: () => codeFailures };`
  )(G, k => k, { now: () => clock.now }, { start: () => { log.started++; return { message: "m", state: {} }; } },
    () => {}, () => {}, () => {}, () => {}, { error() {} }, log);
  return { ...api, log, clock };
}

test("ten wrong words lock the room for five minutes — then it opens again; it used to stay shut for good", async () => {
  const h = lockingHost();
  for (let i = 0; i < G.CODE_MAX_ATTEMPTS; i++) { await h.pakeBegin(); h.pakeFailClosed(false); }
  assert.deepEqual(h.log.notes, [...Array(G.CODE_MAX_ATTEMPTS - 1).fill("codeWrongHost"), "codeLocked"]);
  assert.equal(h.log.started, G.CODE_MAX_ATTEMPTS);

  h.clock.now += G.CODE_LOCK_MS - 1;
  await h.pakeBegin();
  assert.equal(h.log.started, G.CODE_MAX_ATTEMPTS, "locked: not even started");
  assert.equal(h.log.notes.at(-1), "codeLocked", "and the host is told it is locked, not that the word was wrong");

  h.clock.now += 2;
  await h.pakeBegin();
  assert.equal(h.log.started, G.CODE_MAX_ATTEMPTS + 1, "the lock is over: the next guest gets to try");
  assert.equal(h.failures(), 0, "with a fresh count");
  h.pakeFailClosed(false);
  assert.equal(h.log.notes.at(-1), "codeWrongHost", "one more wrong word is just a wrong word");
  for (let i = 1; i < G.CODE_MAX_ATTEMPTS; i++) { await h.pakeBegin(); h.pakeFailClosed(false); }
  assert.equal(h.log.notes.at(-1), "codeLocked", "ten more, and it locks again — the limit still holds");
});

test("a wrong word on the guest's side: told, and back to the lobby to try again", () => {
  const g = codeHost({ isHost: false });
  g.pakeFailClosed(false);
  assert.deepEqual(g.log.sent, [], "a guest frees no seat");
  assert.deepEqual(g.log.toasts, ["codeWrong"]);
  assert.deepEqual(g.log.timers, [1200], "leaves shortly, once the message has been seen");
});

test("back to waiting twice for one attempt — the host's own, then the server's — changes nothing the second time", () => {
  const h = codeHost({ alreadyWaiting: true });
  h.returnToWaitingRoom();
  assert.deepEqual(h.log.drawn, [], "not drawn again, so the note from the first time stays");
  assert.deepEqual(h.log.tab, []);
});

/* ══════════════════════════════════════════
   The server says the seat is free
══════════════════════════════════════════ */

const GUEST_LEFT = between('    case "guest-left":', '    case "session-expired": {');

function guestLeft({ isHost = true, wordMatched = false, channel = "open", ice = "connected", ours = true } = {}) {
  const log = { sent: [], waits: 0, sys: [], closed: 0, buttons: 0 };
  const flag = new Function(
    "G", "t", "roomEventIsOurs", "returnToWaitingRoom", "wsSend", "appendSys", "endCall", "closePeerConnection",
    "showReconnectButton", "start",
    `let isHost = start.isHost, wordMatched = start.wordMatched, serverRoomGone = false;
     let currentSession = { sessionId: "word-room" };
     const dataChannel = { readyState: start.channel }, pc = { iceConnectionState: start.ice };
     function deliver(data) { switch (data.type) {\n${GUEST_LEFT}\n} }
     deliver({ type: "guest-left", sessionId: "word-room" });
     return serverRoomGone;`
  )(G, k => k, () => ours, () => log.waits++, m => log.sent.push(m), k => log.sys.push(k), () => {},
    () => log.closed++, () => log.buttons++, { isHost, wordMatched, channel, ice });
  return { ...log, serverRoomGone: flag };
}

test("a guest gone before any chat: back to waiting, the room kept", () => {
  const r = guestLeft({ wordMatched: false });
  assert.equal(r.waits, 1);
  assert.deepEqual(r.sent, [], "the room stays on the server");
});

test("a guest gone after a real chat, while the link still holds (a locked screen): the chat goes on, the room goes", () => {
  const r = guestLeft({ wordMatched: true, channel: "open", ice: "connected" });
  assert.deepEqual(r.sent, [{ type: "leave-session", sessionId: "word-room" }], "the seat is not offered to anyone mid-chat");
  assert.equal(r.serverRoomGone, true);
  assert.deepEqual(r.sys, []);
  assert.equal(r.closed, 0);
});

test("a guest gone after a real chat, with the link down too: the chat ends, as it always did", () => {
  const r = guestLeft({ wordMatched: true, channel: "closed", ice: "failed" });
  assert.deepEqual(r.sent.map(m => m.type), ["leave-session"]);
  assert.deepEqual(r.sys, ["sysPeerLeft"]);
  assert.equal(r.closed, 1);
  assert.equal(r.buttons, 1);
});

test("not the host, or not this room: nothing happens", () => {
  for (const r of [guestLeft({ isHost: false }), guestLeft({ ours: false })]) {
    assert.equal(r.waits, 0);
    assert.deepEqual(r.sent, []);
  }
});

test("the word matching is what marks a real chat, and each attempt starts unmatched", () => {
  assert.match(fn("handlePakeConfirm"), /wordMatched = true;/);
  assert.match(fn("pakeBegin"), /wordMatched = false;/);
});

/* ══════════════════════════════════════════
   A connection that never comes up, run
══════════════════════════════════════════ */

function watching({ chatOpen = true, channel = "connecting", keyAgreed = false } = {}) {
  const log = { sys: [], buttons: 0, timers: [], cleared: 0 };
  const api = new Function(
    "G", "t", "appendSys", "showReconnectButton", "setTimeout", "clearTimeout", "chatScreen", "start",
    `let dataChannel = { readyState: start.channel }, e2eReady = start.keyAgreed;
     ${between("const CONNECT_GIVE_UP_MS", "function switchToChat(")}
     return { watchConnecting, clearConnectWatch, wait: CONNECT_GIVE_UP_MS };`
  )(G, k => k, k => log.sys.push(k), () => log.buttons++, (f, ms) => { log.timers.push({ f, ms }); return log.timers.length; },
    () => log.cleared++, { classList: classes(chatOpen ? [] : ["hidden"]) }, { channel, keyAgreed });
  const fire = () => log.timers[log.timers.length - 1].f();
  return { ...api, log, fire };
}

test("thirty seconds with no channel: the chat says why, and offers the way back", () => {
  const w = watching();
  w.watchConnecting();
  assert.equal(w.log.timers[0].ms, 30_000);
  assert.equal(w.wait, 30_000);
  w.fire();
  assert.deepEqual(w.log.sys, ["sysNoDirectRoute"]);
  assert.equal(w.log.buttons, 1);
});

test("a channel that came up, or a chat no longer showing, gets no such note", () => {
  for (const w of [watching({ channel: "open" }), watching({ keyAgreed: true }), watching({ chatOpen: false })]) {
    w.watchConnecting();
    w.fire();
    assert.deepEqual(w.log.sys, []);
  }
});

test("the watch starts with the chat screen, and stops when the chat works or is left", () => {
  assert.match(fn("switchToChat"), /watchConnecting\(\);/);
  assert.match(fn("e2eActivate"), /clearConnectWatch\(\);/);
  assert.match(between("leaveBtn.onclick = (e) => {", "wsSend("), /clearConnectWatch\(\);/);
  assert.match(fn("returnToWaitingRoom"), /clearConnectWatch\(\);/);
});
