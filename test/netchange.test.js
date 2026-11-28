/*
  The phone's network changed, and data saver on mobile data.

  Asked for: a call froze for about 8 seconds when the phone left Wi-Fi for
  mobile data — the browser first had to notice nothing arrived, and the
  call then waited 3 s more. Now the network-change event asks for fresh
  routes at once (after a second's quiet): the chat's, and the call's — by
  the side that placed it, or the other side telling it (call-net-changed).

  And: on mobile data the camera gets a ceiling of 600 kb/s; on Wi-Fi, or
  where the browser does not say, none. Beside a shared screen the screen's
  own limits rule, and are left alone.

  The functions are lifted out of app.js and run with stand-ins.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");

const grab = (pattern, what) => {
  const m = app.match(pattern);
  assert.ok(m, `${what} not found in app.js`);
  return m[0];
};
const fn = name => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?^\\}`, "m"), name);
const constant = name => grab(new RegExp(`^const ${name} = [^\\n]*;`, "m"), name);

/* ══════════════════════════════════════════
   Fresh routes when the network changes
══════════════════════════════════════════ */

const NET_SOURCE = [constant("NET_SETTLE_MS"), ...["noteNetworkChanged", "routesAfterNetworkChange", "restartCallNow"].map(fn)].join("\n");

function phone({ isHost = true, offerer = true, inCall = true, dcUp = true, pathOpen = true } = {}) {
  const log = { renegotiated: 0, ws: [], sent: [], callRestarts: 0 };
  const clock = { now: 100000, timer: null };
  const env = {
    Date: { now: () => clock.now },
    setTimeout: (f, ms) => { clock.timer = { f, at: clock.now + ms }; return clock.timer; },
    clearTimeout: h => { if (clock.timer === h) clock.timer = null; },
    chatOver: () => false,
    serverPathOpen: () => pathOpen,
    handleFullRenegotiation: () => { log.renegotiated++; },
    wsSend: m => log.ws.push(m.type),
    dcReady: () => dcUp,
    dcSendCallSignal: m => { log.sent.push(m.type); return Promise.resolve(); },
    restartCallRoute: () => { log.callRestarts++; }
  };
  const names = Object.keys(env);
  const api = new Function(...names, "state", `
    let { isHost, inCall, callPc, callOfferer, currentSession, pc } = state;
    let netChangeTimer = null, chatRepairAt = 0, chatRepairs = 0, callRestartAt = 0, callRestarts = 0;
    ${NET_SOURCE}
    return { noteNetworkChanged, restartCallNow, now: () => ({ callRestartAt, callRestarts, chatRepairs }) };
  `)(...names.map(n => env[n]), { isHost, inCall, callPc: inCall ? {} : null, callOfferer: offerer, currentSession: { sessionId: "s" }, pc: {} });
  const wait = ms => {
    clock.now += ms;
    if (clock.timer && clock.timer.at <= clock.now) { const t = clock.timer; clock.timer = null; t.f(); }
  };
  return { ...api, log, clock, wait };
}

test("host that placed the call: both routes restart a second after the network settles", () => {
  const p = phone();
  p.noteNetworkChanged();
  p.wait(500);
  p.noteNetworkChanged();                  // a burst: the second event moves the wait
  p.wait(900);
  assert.equal(p.log.renegotiated, 0, "not before a second's quiet");
  p.wait(200);
  assert.equal(p.log.renegotiated, 1, "the chat's route");
  assert.equal(p.log.callRestarts, 1, "the call's route");
  assert.deepEqual(p.log.sent, []);
  assert.equal(p.now().callRestarts, 1, "counted, so the usual recovery does not ask again at once");
});

test("guest that answered the call: asks the host through the server, and tells the caller", () => {
  const p = phone({ isHost: false, offerer: false });
  p.noteNetworkChanged();
  p.wait(1000);
  assert.deepEqual(p.log.ws, ["repair-request"]);
  assert.equal(p.log.renegotiated, 0);
  assert.deepEqual(p.log.sent, ["call-net-changed"]);
  assert.equal(p.log.callRestarts, 0, "two offers must not cross");
});

test("told by the other side: the caller restarts, the answerer never sends it back", () => {
  const caller = phone();
  caller.restartCallNow(false);
  assert.equal(caller.log.callRestarts, 1);
  const answerer = phone({ offerer: false });
  answerer.restartCallNow(false);
  assert.deepEqual(answerer.log.sent, []);
  assert.equal(answerer.log.callRestarts, 0);
});

test("not twice within three seconds", () => {
  const p = phone();
  p.restartCallNow(true);
  p.wait(2000);
  p.restartCallNow(false);
  assert.equal(p.log.callRestarts, 1);
  p.wait(1500);
  p.restartCallNow(false);
  assert.equal(p.log.callRestarts, 2);
});

test("no call: only the chat's route; no server path: the chat waits for its usual repair", () => {
  const p = phone({ inCall: false });
  p.noteNetworkChanged();
  p.wait(1000);
  assert.equal(p.log.renegotiated, 1);
  assert.equal(p.log.callRestarts, 0);
  const q = phone({ pathOpen: false });
  q.noteNetworkChanged();
  q.wait(1000);
  assert.equal(q.log.renegotiated, 0);
  assert.equal(q.log.callRestarts, 1, "the call's ask goes on the chat's channel, not the server");
});

test("the network-change events are listened to, and the message is handled", () => {
  assert.match(app, /navigator\.connection\.addEventListener\("change"/);
  assert.match(app, /window\.addEventListener\("online", noteNetworkChanged\)/);
  assert.match(app, /case "call-net-changed":\s*\n(?:\s*\/\*[\s\S]*?\*\/\s*\n)?\s*restartCallNow\(false\);/);
});

/* ══════════════════════════════════════════
   Data saver on mobile data
══════════════════════════════════════════ */

const CAP_SOURCE = [constant("MOBILE_CAMERA_BITRATE"), ...["onMobileData", "keepCameraCap"].map(fn)].join("\n");

function camera({ type = "cellular", sharing = false, negotiated = true, busy = false } = {}) {
  const track = { kind: "video" };
  const encodings = negotiated ? [{ active: true }] : [];
  const sender = {
    track, sets: 0,
    getParameters: () => ({ encodings: encodings.map(e => ({ ...e })) }),
    setParameters: async p => { sender.sets++; encodings.splice(0, encodings.length, ...p.encodings); }
  };
  const pc = { getSenders: () => [sender] };
  const navigator = { connection: { type } };
  const api = new Function("navigator", "state", `
    let { callPc, sharingScreen, localStream, lineRetrying } = state;
    let cameraCapSet = null;
    ${CAP_SOURCE}
    return { keepCameraCap, share: v => { sharingScreen = v; } };
  `)(navigator, { callPc: pc, sharingScreen: sharing, localStream: { getVideoTracks: () => [track] }, lineRetrying: { busy } });
  return { ...api, sender, encodings, navigator };
}

test("mobile data: the camera gets a 600 kb/s ceiling, set once", async () => {
  const c = camera();
  await c.keepCameraCap();
  assert.equal(c.encodings[0].maxBitrate, 600000);
  await c.keepCameraCap();
  assert.equal(c.sender.sets, 1, "not touched again while nothing changed");
});

test("back on Wi-Fi: the ceiling is taken off", async () => {
  const c = camera();
  await c.keepCameraCap();
  c.navigator.connection.type = "wifi";
  await c.keepCameraCap();
  assert.equal(c.encodings[0].maxBitrate, undefined);
});

test("a browser that does not say (an iPhone): no ceiling", async () => {
  const c = camera({ type: null });
  await c.keepCameraCap();
  assert.equal(c.encodings[0].maxBitrate, undefined);
});

test("beside a shared screen, during a line test, or before the call is negotiated: left alone", async () => {
  for (const o of [{ sharing: true }, { busy: true }, { negotiated: false }]) {
    const c = camera(o);
    await c.keepCameraCap();
    assert.equal(c.sender.sets, 0, JSON.stringify(o));
  }
});

test("sharing stops: the ceiling is set again", async () => {
  const c = camera();
  await c.keepCameraCap();
  c.share(true);
  await c.keepCameraCap();
  c.encodings[0] = { active: true };       // the screen's end took the camera's limits off
  c.share(false);
  await c.keepCameraCap();
  assert.equal(c.encodings[0].maxBitrate, 600000);
});

test("checked with the call's figures, and reset for every call", () => {
  assert.match(fn("updateCallStats"), /keepCameraCap\(\);/);
  assert.match(fn("watchCallStats"), /cameraCapSet = null;/);
});
