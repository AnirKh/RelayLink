/*
  A call whose link drops tries again before it gives up.

  Reported, asking for steadier connections: a call whose link failed — Wi-Fi
  to mobile data mid-call, a moment without signal — simply ended, while the
  chat beside it tried again. Now the side that placed the call asks for a
  fresh route (an ICE restart) over the chat's channel, on the same
  connection; both sides give up once it has been down for a minute (it was half a
  minute: too short for a lift or a tunnel).

  G.callRecovery decides. watchCallLink(), stepCallRecovery(),
  restartCallRoute() and the two handlers are lifted out of app.js and run
  with a stand-in clock and connection.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const G   = require("../guards.js");
const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");

/* ══════════════════════════════════════════
   The decision
══════════════════════════════════════════ */

const step = o => G.callRecovery({ state: "disconnected", offerer: true, downFor: 0, sinceRestart: 0, restarts: 0, ...o });

test("a link that is up needs nothing", () => {
  for (const state of ["connected", "connecting", "new", "closed", undefined]) {
    assert.equal(step({ state, downFor: 60000 }), "none", String(state));
  }
  assert.equal(G.callRecovery(undefined), "none");
});

test("the side that placed the call asks for a fresh route after a few seconds down, then now and then", () => {
  assert.equal(step({ downFor: 1000 }), "wait", "a blip may mend itself");
  assert.equal(step({ downFor: 3000 }), "restart");
  assert.equal(step({ state: "failed", downFor: 3000 }), "restart", "failed outright too");
  assert.equal(step({ downFor: 6000, restarts: 1, sinceRestart: 3000 }), "wait", "not again straight away");
  assert.equal(step({ downFor: 12000, restarts: 1, sinceRestart: 8000 }), "restart", "again, a while later");
});

test("the side that answered never asks — two offers must not cross", () => {
  for (const downFor of [3000, 10000, 20000]) assert.equal(step({ offerer: false, downFor }), "wait");
});

test("down for a minute, both sides give up", () => {
  assert.equal(step({ downFor: 60000 }), "give-up");
  assert.equal(step({ offerer: false, downFor: 60000 }), "give-up");
  assert.equal(step({ downFor: 59999, restarts: 3, sinceRestart: 1000 }), "wait");
  assert.equal(step({ downFor: 30000, restarts: 3, sinceRestart: 8000 }), "restart", "half a minute is no longer the end");
});

test("a time that makes no sense is waited on, not acted on", () => {
  assert.equal(step({ downFor: NaN }), "wait");
  assert.equal(step({ downFor: -5 }), "wait");
});

test("a failed link says Reconnecting too — it is being worked on now, not ended", () => {
  assert.equal(G.callPauseNote({ inCall: true, peerAway: false, linkState: "failed" }), "reconnecting");
  assert.equal(G.callPauseNote({ inCall: true, peerAway: true, linkState: "failed" }), "away", "their own word still says why");
});

/* ══════════════════════════════════════════
   The recovery, actually run
══════════════════════════════════════════ */

const grab = (pattern, what) => {
  const m = app.match(pattern);
  assert.ok(m, `${what} not found in app.js`);
  return m[0];
};
const fn = name => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?^\\}`, "m"), name);
const SOURCE = ["watchCallLink", "stepCallRecovery", "stopCallRecovery", "restartCallRoute", "handleCallRestart", "handleCallRestartAnswer"]
  .map(fn).join("\n");

function call({ offerer = true, dcUp = true, inCall = true } = {}) {
  const log = { sent: [], ended: [], sys: [], local: [], remote: [], drained: 0, offers: [] };
  const clock = { now: 0, interval: null };
  const pc = {
    connectionState: "connected", signalingState: "stable", localDescription: null,
    createOffer: async o => { log.offers.push(o); return { type: "offer", sdp: "restart-offer" }; },
    createAnswer: async () => ({ type: "answer", sdp: "restart-answer" }),
    setRemoteDescription: async d => { log.remote.push(d.type); pc.signalingState = d.type === "offer" ? "have-remote-offer" : "stable"; }
  };
  const env = {
    G, t: k => k,
    console: { error() {} },
    Date: { now: () => clock.now },
    setInterval: (f, ms) => { clock.interval = { f, ms }; return clock.interval; },
    clearInterval: h => { if (clock.interval === h) clock.interval = null; },
    RTCSessionDescription: function (d) { return d; },
    dcReady: () => dcUp,
    dcSendCallSignal: m => { log.sent.push(m.type); return Promise.resolve(); },
    drainCallIceQueue: async () => { log.drained++; },
    setCallLocalDescription: async d => { log.local.push(d.type); pc.localDescription = d; pc.signalingState = d.type === "offer" ? "have-local-offer" : "stable"; },
    endCall: notify => { log.ended.push(notify); },
    appendSys: line => log.sys.push(line)
  };
  const names = Object.keys(env);
  const api = new Function(...names, "state", `
    let { inCall, callPc, callOfferer } = state;
    let callDownSince = 0, callRestartAt = 0, callRestarts = 0, callRecoverTimer = null;
    ${SOURCE}
    return { watchCallLink, stepCallRecovery, handleCallRestart, handleCallRestartAnswer,
             now: () => ({ callDownSince, callRestarts, callRecoverTimer }), hangUp: () => { inCall = false; } };
  `)(...names.map(n => env[n]), { inCall, callPc: pc, callOfferer: offerer });
  /** The link goes to `state`, as the connection would report it. */
  const link = state => { pc.connectionState = state; api.watchCallLink(); };
  /** Time passes; the recovery takes its one-second steps. */
  const wait = async ms => {
    for (let t = 0; t < ms; t += 1000) {
      clock.now += 1000;
      if (clock.interval) clock.interval.f();
      await new Promise(r => setImmediate(r));
    }
  };
  return { ...api, log, pc, clock, link, wait, env, dcUp: v => { dcUp = v; } };
}

test("link down: after three seconds the caller asks for a fresh route, on the same connection", async () => {
  const c = call();
  c.link("disconnected");
  await c.wait(2000);
  assert.deepEqual(c.log.sent, [], "a blip may mend itself");
  await c.wait(1000);
  assert.deepEqual(c.log.offers, [{ iceRestart: true }], "a fresh route, not a new call");
  assert.deepEqual(c.log.sent, ["call-restart"]);
  assert.deepEqual(c.log.ended, []);
});

test("back up: the recovery stops, and nothing more is sent", async () => {
  const c = call();
  c.link("disconnected");
  await c.wait(4000);
  c.link("connected");
  assert.equal(c.now().callRecoverTimer, null);
  assert.equal(c.now().callDownSince, 0);
  await c.wait(20000);
  assert.deepEqual(c.log.sent, ["call-restart"]);
});

test("still down: asked again every eight seconds", async () => {
  const c = call();
  c.link("failed");
  await c.wait(20000);
  assert.deepEqual(c.log.sent, ["call-restart", "call-restart", "call-restart"], "at 3, 11 and 19 seconds");
});

test("down for a minute: the call ends, the other side is told, and the chat says why", async () => {
  const c = call();
  c.link("failed");
  await c.wait(60000);
  assert.deepEqual(c.log.ended, [true], "endCall(true) — the other side is told");
  assert.deepEqual(c.log.sys, ["callLinkLost"]);
  assert.equal(c.now().callRecoverTimer, null);
});

test("with the chat's channel down too, the ask waits for it rather than going nowhere", async () => {
  const c = call({ dcUp: false });
  c.link("disconnected");
  await c.wait(5000);
  assert.deepEqual(c.log.sent, []);
  c.dcUp(true);
  await c.wait(1000);
  assert.deepEqual(c.log.sent, ["call-restart"]);
});

test("the side that answered waits — and gives up at the same time", async () => {
  const c = call({ offerer: false });
  c.link("disconnected");
  await c.wait(59000);
  assert.deepEqual(c.log.sent, []);
  assert.deepEqual(c.log.ended, []);
  await c.wait(1000);
  assert.deepEqual(c.log.ended, [true]);
});

test("a fresh route asked for is answered on the same connection", async () => {
  const c = call({ offerer: false });
  await c.handleCallRestart({ offer: { type: "offer", sdp: "x" } });
  assert.deepEqual(c.log.remote, ["offer"]);
  assert.ok(c.log.drained > 0, "candidates that arrived early are tried now");
  assert.deepEqual(c.log.local, ["answer"]);
  assert.deepEqual(c.log.sent, ["call-restart-answer"]);
});

test("the answer is taken only while an ask is out, and only in a call", async () => {
  const c = call();
  await c.handleCallRestartAnswer({ answer: { type: "answer", sdp: "x" } });
  assert.deepEqual(c.log.remote, [], "nothing was asked: a stray answer changes nothing");
  c.link("disconnected");
  await c.wait(3000);
  await c.handleCallRestartAnswer({ answer: { type: "answer", sdp: "x" } });
  assert.deepEqual(c.log.remote, ["answer"]);
  const done = call();
  done.hangUp();
  await done.handleCallRestart({ offer: { type: "offer", sdp: "x" } });
  assert.deepEqual(done.log.remote, [], "a hung-up call answers nothing");
});

/* ══════════════════════════════════════════
   That it is wired up
══════════════════════════════════════════ */

test("a failed link is worked on, not ended; a closed one is the call put down", () => {
  const create = fn("createCallPeerConnection");
  assert.match(create, /watchCallLink\(\);/);
  assert.ok(!/state === "failed"/.test(create), "failed no longer ends the call by itself");
  assert.match(create, /if \(state === "closed"\) \{\s*\n\s*if \(inCall\) endCall\(false\);/);
});

test("the caller is the one who asks; the handlers are wired; a closed connection stops it all", () => {
  assert.match(fn("initiateCallOffer"), /callOfferer = true;/);
  assert.match(fn("handleIncomingCallOffer"), /callOfferer = false;/);
  assert.match(app, /case "call-restart":\s*\n\s*handleCallRestart\(data\);/);
  assert.match(app, /case "call-restart-answer":\s*\n\s*handleCallRestartAnswer\(data\);/);
  assert.match(fn("closeCallPeerConnection"), /stopCallRecovery\(\);/);
});

test("a candidate that arrives before its fresh description is kept and tried again", () => {
  const ice = fn("handleCallIce");
  const failed = ice.match(/catch \(e\) \{[\s\S]*?\}/);
  assert.ok(failed, "handleCallIce has no catch");
  assert.match(failed[0], /callIceQueue\.push\(candidate\);/);
});

/* ══════════════════════════════════════════
   The other side leaves during a call
   ──────────────────────────────────────────
   Reported: when one side left mid-call — the X, then Leave — the other's
   call froze on "Reconnecting…" for half a minute, then said the
   connection had dropped. Now the chat's channel closing ends the call at
   once, as a hang-up would.
══════════════════════════════════════════ */

test("the chat closing ends a call that is on, and a call still ringing here is a missed one", () => {
  assert.equal(G.callWhenChatCloses({ inCall: true, ringingHere: false }), "ended");
  assert.equal(G.callWhenChatCloses({ inCall: false, ringingHere: true }), "missed");
  assert.equal(G.callWhenChatCloses({ inCall: true, ringingHere: true }), "missed", "theirs, unanswered: missed, as a hang-up while ringing is");
  assert.equal(G.callWhenChatCloses({ inCall: false, ringingHere: false }), "none");
  assert.equal(G.callWhenChatCloses({ inCall: "yes" }), "none", "only a real yes");
  assert.equal(G.callWhenChatCloses(undefined), "none");
});

/** The chat channel's close handler, as shipped, run with a stand-in page. */
function chatCloses({ inCall = false, ringing = false } = {}) {
  const body = grab(/^  dataChannel\.onclose = \(\) => \{[\s\S]*?^  \};/m, "dataChannel.onclose");
  const log = { sys: [], ended: [] };
  const hidden = { contains: c => c === "hidden" && !ringing };
  const env = {
    G, t: k => k,
    sendBtn: {}, voiceCallBtn: {}, videoCallBtn: {},
    callRequestModal: { classList: hidden },
    endCall: notify => { log.ended.push(notify); },
    appendSys: k => log.sys.push(k),
    serverRoomGone: true,
    recvBuffers: {}, pendingAcks: {}, orphanChunks: {}, refusedTransfers: new Set(),
    failTransfer() {}, stopChatRepair() {}, showReconnectButton() {}
  };
  const names = Object.keys(env);
  const run = new Function(...names, "inCall", `
    let dataChannel = {}, orphanChunkCount = 0;
    ${body}
    dataChannel.onclose();`);
  run(...names.map(n => env[n]), inCall);
  return log;
}

test("the other side leaves mid-call: the call ends at once, without a word sent back, and the chat says so first", () => {
  const log = chatCloses({ inCall: true });
  assert.deepEqual(log.ended, [false], "ended here; nothing to tell a side that has gone");
  assert.deepEqual(log.sys, ["sysCallEnded", "sysPeerLeft"], "the call ended, then they left");
});

test("they leave while their call is still ringing here: a missed call", () => {
  assert.deepEqual(chatCloses({ ringing: true }).sys, ["sysMissedCall", "sysPeerLeft"]);
});

test("they leave with no call on: only that they left", () => {
  const log = chatCloses();
  assert.deepEqual(log.ended, []);
  assert.deepEqual(log.sys, ["sysPeerLeft"]);
});
