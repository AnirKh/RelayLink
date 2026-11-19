/*
  A call across a locked screen — actually run.

  A phone locked mid-call pauses the page. Two things went wrong after it:

  - its microphone and camera could stay off. The phone may stop them for good
    while locked, and nothing started them again: back on the screen the call
    was still up, but the other side heard and saw nothing.
  - the other side was left with a frozen picture, or silence, and no word why.

  The rules are G.tracksToRestart and G.callPauseNote. The block in app.js from
  "A call across a locked screen" to the attach menu — restartEndedCallMedia,
  watchCallTrack, updateCallPauseNote and the visibility listener — is lifted
  out and run against a stand-in call; the two message cases are run too.
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

const track = (kind, readyState = "live") => ({ kind, readyState });

test("what ended is started again — and only what ended", () => {
  assert.deepEqual(G.tracksToRestart({ inCall: true, tracks: [track("audio", "ended"), track("video")] }), ["audio"]);
  assert.deepEqual(G.tracksToRestart({ inCall: true, tracks: [track("audio", "ended"), track("video", "ended")] }), ["audio", "video"]);
  assert.deepEqual(G.tracksToRestart({ inCall: true, tracks: [track("audio"), track("video")] }), []);
});

test("a voice call never gains a camera by being restarted", () => {
  assert.deepEqual(G.tracksToRestart({ inCall: true, tracks: [track("audio", "ended")] }), ["audio"]);
});

test("nothing is opened outside an agreed call", () => {
  for (const inCall of [false, undefined, "yes", 1]) {
    assert.deepEqual(G.tracksToRestart({ inCall, tracks: [track("audio", "ended")] }), [], String(inCall));
  }
  assert.deepEqual(G.tracksToRestart(undefined), []);
  assert.deepEqual(G.tracksToRestart({ inCall: true, tracks: "nope" }), []);
  assert.deepEqual(G.tracksToRestart({ inCall: true, tracks: [null, track("screen", "ended")] }), []);
});

test("the call screen says the other side stepped away, or that the link is down", () => {
  assert.equal(G.callPauseNote({ inCall: true, peerAway: true, linkState: "connected" }), "away");
  assert.equal(G.callPauseNote({ inCall: true, peerAway: false, linkState: "disconnected" }), "reconnecting");
  assert.equal(G.callPauseNote({ inCall: true, peerAway: true, linkState: "disconnected" }), "away", "their own word says why");
  assert.equal(G.callPauseNote({ inCall: true, peerAway: false, linkState: "connected" }), null);
  assert.equal(G.callPauseNote({ inCall: false, peerAway: true, linkState: "disconnected" }), null, "no call, no note");
  assert.equal(G.callPauseNote(undefined), null);
});

/* ══════════════════════════════════════════
   The block, run
══════════════════════════════════════════ */

const BLOCK = between("/* ── A call across a locked screen ──", "/* ══════════════════════════════════════════════\n   ATTACH MENU");

class Track {
  constructor(kind) { this.kind = kind; this.readyState = "live"; this.enabled = true; this.listeners = {}; }
  addEventListener(type, f) { (this.listeners[type] = this.listeners[type] || []).push(f); }
  stop() { this.readyState = "ended"; }                // as in a browser: stop() fires no "ended"
  endByPhone() { this.readyState = "ended"; (this.listeners.ended || []).forEach(f => f()); }
}
class MediaStream {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === "audio"); }
}

function call({ video = true, inCall = true, refuse = false, muted = false, camOff = false } = {}) {
  const listeners = {};
  const log = { asked: [], sent: [], toasts: [], replaced: [], attached: [], played: 0, opened: [], restarted: 0, micSent: [] };
  const clock = { now: 1_000_000 };
  let gate = null;
  const mic = new Track("audio"), cam = video ? new Track("video") : null;
  const senders = [mic, cam].filter(Boolean).map(t => ({ track: t, replaceTrack(n) { log.replaced.push([this.track.kind, n]); this.track = n; return Promise.resolve(); } }));
  const env = {
    G, MediaStream, t: k => k,
    document: { visibilityState: "visible", getElementById: id => ({ id, textContent: "", classList: classes() }),
                addEventListener: (type, f) => { listeners[type] = f; } },
    navigator: { mediaDevices: { getUserMedia: async constraints => {
      log.asked.push(constraints);
      if (gate) await gate;
      if (refuse) throw new Error("NotAllowedError");
      const opened = [constraints.audio && new Track("audio"), constraints.video && new Track("video")].filter(Boolean);
      log.opened.push(...opened);
      return new MediaStream(opened);
    } } },
    console: { error() {}, log() {} },
    showToast: m => log.toasts.push(m),
    dcReady: () => true,
    dcSendCallSignal: m => { log.sent.push(m.type); if (m.type === "call-mic") log.micSent.push(m.silent); return Promise.resolve(); },
    Date: { now: () => clock.now },
    setTimeout: () => 0,
    callMicNote: { classList: classes(["hidden"]), onclick: null },
    callTapToHear: { classList: classes(["hidden"]), onclick: null },
    remoteVideo: { play: () => Promise.resolve() },
    restartLikeCallStart: () => { log.restarted++; },
    attachCallTrack: async t => { log.attached.push(t); },
    callVideo: () => ({ facingMode: "user" }),
    state: { inCall, callPc: { connectionState: "connected", getSenders: () => senders },
             localStream: new MediaStream([mic, cam].filter(Boolean)), isMuted: muted, isCamOff: camOff,
             localVideo: { srcObject: null, play() { log.played++; return Promise.resolve(); } } }
  };
  env.state.localVideo.srcObject = env.state.localStream;
  const names = Object.keys(env).filter(n => n !== "state");
  const api = new Function(...names, "state", `
    let { inCall, callPc, localStream, isMuted, isCamOff, localVideo, sharingScreen = false, screenMix = null } = state;
    ${BLOCK}
    return {
      restartEndedCallMedia, updateCallPauseNote, watchCallTrack, checkMic, noteMicLevel, resetMicCheck,
      micNote: () => !callMicNote.classList.contains("hidden"), tapMicNote: () => callMicNote.onclick(),
      setPeerMic: v => { peerMicSilent = v; },
      note: () => (callPauseNote.classList.contains("hidden") ? null : callPauseText.textContent),
      setAway: v => { peerAway = v; },
      setInCall: v => { inCall = v; },
      setLink: v => { callPc.connectionState = v; },
      stream: () => localStream, video: () => localVideo
    };
  `)(...names.map(n => env[n]), env.state);
  [mic, cam].filter(Boolean).forEach(api.watchCallTrack);
  const show = async visible => {
    env.document.visibilityState = visible ? "visible" : "hidden";
    listeners.visibilitychange();
    await new Promise(r => setImmediate(r));
  };
  return { ...api, log, mic, cam, senders, show, env, clock,
           hold: () => { let open; gate = new Promise(r => { open = r; }); return () => { gate = null; open(); }; } };
}
function classes() {
  const set = new Set(["hidden"]);
  return { toggle: (c, on) => (on ? set.add(c) : set.delete(c)), contains: c => set.has(c),
           add: c => set.add(c), remove: c => set.delete(c) };
}

test("the screen going off tells the other side; coming back tells it again", async () => {
  const c = call();
  await c.show(false);
  await c.show(true);
  assert.deepEqual(c.log.sent, ["call-away", "call-back"]);
});

test("outside a call, the screen going off says nothing", async () => {
  const c = call({ inCall: false });
  await c.show(false);
  await c.show(true);
  assert.deepEqual(c.log.sent, []);
  assert.equal(c.log.asked.length, 0);
});

test("back from a lock that ended the microphone and camera: both start again, in place", async () => {
  const c = call();
  await c.show(false);
  c.mic.stop(); c.cam.stop();          // the phone ended them while locked
  await c.show(true);
  assert.equal(c.log.asked.length, 1);
  assert.equal(c.log.asked[0].audio, true);
  assert.deepEqual(c.log.asked[0].video, { facingMode: "user" });
  assert.deepEqual(c.log.replaced.map(([kind]) => kind), ["audio", "video"], "swapped into the call, no new call");
  assert.ok(c.senders.every(s => s.track.readyState === "live"));
  assert.ok(c.stream().getTracks().every(t => t.readyState === "live"), "the stream holds the new ones");
  assert.equal(c.video().srcObject, c.stream(), "the self-view shows the new camera");
});

test("only what ended is started again; the self-view is left alone if the camera was not", async () => {
  const c = call();
  const view = c.video().srcObject;
  c.mic.stop();
  await c.show(true);
  assert.equal(c.log.asked[0].video, false);
  assert.deepEqual(c.log.replaced.map(([kind]) => kind), ["audio"]);
  assert.equal(c.video().srcObject, view);
});

test("nothing ended: nothing is opened", async () => {
  const c = call();
  await c.show(true);
  assert.equal(c.log.asked.length, 0);
});

test("muted stays muted, and a camera turned off stays off", async () => {
  const c = call({ muted: true, camOff: true });
  c.mic.stop(); c.cam.stop();
  await c.show(true);
  const [audio, video] = c.log.replaced.map(([, t]) => t);
  assert.equal(audio.enabled, false);
  assert.equal(video.enabled, false);
});

test("hung up while the phone was asking: the new microphone and camera are put straight back", async () => {
  const c = call();
  c.mic.stop();
  const open = c.hold();
  const restarting = c.restartEndedCallMedia();
  c.setInCall(false);
  open();
  await restarting;
  assert.equal(c.log.replaced.length, 0);
  assert.equal(c.log.attached.length, 0);
  assert.ok(c.log.opened.length > 0 && c.log.opened.every(t => t.readyState === "ended"),
    "the microphone it opened is switched off again, not left running");
});

test("refused: said once, and the next return tries again", async () => {
  const c = call({ refuse: true });
  c.mic.stop();
  await c.show(true);
  assert.deepEqual(c.log.toasts, ["callMediaRestartFailed"]);
  await c.show(true);
  assert.equal(c.log.asked.length, 2, "not stuck behind a flag left set");
});

test("two returns at once open the microphone once", async () => {
  const c = call();
  c.mic.stop();
  const open = c.hold();
  const a = c.restartEndedCallMedia(), b = c.restartEndedCallMedia();
  open();
  await Promise.all([a, b]);
  assert.equal(c.log.asked.length, 1);
});

test("a device that keeps failing is not retried for ever", async () => {
  const c = call({ refuse: true });
  c.mic.stop();
  for (let i = 0; i < 12; i++) await c.restartEndedCallMedia();
  assert.ok(c.log.asked.length <= 5, `asked ${c.log.asked.length} times`);
});

test("a track the phone takes while the page is showing is started again at once", async () => {
  const c = call();
  c.mic.endByPhone();
  await new Promise(r => setImmediate(r));
  assert.equal(c.log.asked.length, 1);
});

test("a track that ends while hidden waits for the page to come back", async () => {
  const c = call();
  await c.show(false);
  c.mic.endByPhone();
  await new Promise(r => setImmediate(r));
  assert.equal(c.log.asked.length, 0);
  await c.show(true);
  assert.equal(c.log.asked.length, 1);
});

test("the note: away, reconnecting, and gone again", () => {
  const c = call();
  c.setAway(true); c.updateCallPauseNote();
  assert.equal(c.note(), "callPeerAway");
  c.setAway(false); c.setLink("disconnected"); c.updateCallPauseNote();
  assert.equal(c.note(), "reconnecting");
  c.setLink("connected"); c.updateCallPauseNote();
  assert.equal(c.note(), null);
});

/* ══════════════════════════════════════════
   The wiring
══════════════════════════════════════════ */

/* ══════════════════════════════════════════
   A microphone the phone has paused
   ──────────────────────────────────────────
   Reported: an Android phone heard nothing at all from an iPhone, from the
   start, voice or video, now and then — while the iPhone heard it.
══════════════════════════════════════════ */

const mic = o => G.micCheck({ inCall: true, hasMic: true, userMuted: false, visible: true, pausedBy: "phone", pausedFor: 0, reopens: 0, ...o });

test("the rule: a microphone paused a moment is opened again, twice at most; then said", () => {
  assert.equal(mic({ pausedBy: null }), "ok", "sending");
  assert.equal(mic({ pausedFor: 1000 }), "wait", "the phone's flag, a moment");
  assert.equal(mic({ pausedFor: G.MIC_CHECK.phoneMs }), "reopen");
  assert.equal(mic({ pausedFor: 5000, reopens: 1 }), "reopen");
  assert.equal(mic({ pausedFor: 5000, reopens: 2 }), "tell");
  assert.equal(mic({ pausedBy: "zeros", pausedFor: 2000 }), "wait", "zeros take longer to be sure of");
  assert.equal(mic({ pausedBy: "zeros", pausedFor: G.MIC_CHECK.zerosMs }), "reopen");
});

test("the rule: silence the person chose, a hidden page, no call or no microphone — nothing to do", () => {
  assert.equal(mic({ userMuted: true, pausedFor: 9999 }), "ok", "their own mute");
  assert.equal(mic({ visible: false, pausedFor: 9999 }), "wait", "a phone pauses a hidden page's capture for its own reasons");
  assert.equal(mic({ inCall: false, pausedFor: 9999 }), "ok");
  assert.equal(mic({ hasMic: false, pausedFor: 9999 }), "ok");
  assert.equal(mic({ pausedFor: NaN }), "wait");
  assert.equal(G.micCheck(undefined), "ok");
});

test("paused by the phone: opened again as a call starts it, twice — then said here, and told to the other side", () => {
  const c = call();
  c.mic.muted = true;
  c.checkMic();
  assert.equal(c.log.restarted, 0, "a moment: wait");
  const later = () => { c.clock.now += G.MIC_CHECK.phoneMs; c.checkMic(); };
  later();
  assert.equal(c.log.restarted, 1, "opened again, with the camera — so an iPhone keeps the loudspeaker");
  later();                                   // the new microphone, paused too: its own moment first
  assert.equal(c.log.restarted, 1);
  later();
  assert.equal(c.log.restarted, 2);
  later();
  assert.equal(c.micNote(), false, "its own moment, again");
  later();
  assert.equal(c.log.restarted, 2, "twice at most");
  assert.equal(c.micNote(), true, "\"Your microphone isn't picking up sound — tap to try again\"");
  assert.deepEqual(c.log.micSent, [true], "the other side told, once");
  c.checkMic();
  assert.deepEqual(c.log.micSent, [true]);
});

test("back by itself: the note goes, the other side is told, and a later pause may be tried again", () => {
  const c = call();
  c.mic.muted = true;
  c.checkMic();
  for (let i = 0; i < 6; i++) { c.clock.now += G.MIC_CHECK.phoneMs; c.checkMic(); }
  assert.equal(c.micNote(), true);
  c.mic.muted = false;
  c.checkMic();
  assert.equal(c.micNote(), false);
  assert.deepEqual(c.log.micSent, [true, false]);
  c.mic.muted = true;
  c.clock.now += 1;
  c.checkMic();
  c.clock.now += G.MIC_CHECK.phoneMs;
  c.checkMic();
  assert.equal(c.log.restarted, 3, "tried again: the count started afresh");
});

test("the note tapped: tried again at once", () => {
  const c = call();
  c.mic.muted = true;
  c.checkMic();
  for (let i = 0; i < 6; i++) { c.clock.now += G.MIC_CHECK.phoneMs; c.checkMic(); }
  const before = c.log.restarted;
  c.tapMicNote();
  assert.equal(c.log.restarted, before + 1);
  assert.equal(c.micNote(), false);
});

test("zeros from the start: taken as paused — but never once the microphone has been heard", () => {
  const c = call();
  c.noteMicLevel({ level: 0 });
  c.clock.now += G.MIC_CHECK.zerosMs;
  c.noteMicLevel({ level: 0 });
  assert.equal(c.log.restarted, 1, "nothing but zeros since it opened");

  const heard = call();
  heard.noteMicLevel({ level: 0.02 });                 // they said hello
  heard.noteMicLevel({ level: 0 });
  heard.clock.now += 60_000;
  heard.noteMicLevel({ level: 0 });
  assert.equal(heard.log.restarted, 0, "a quiet person, not a paused microphone");

  const quiet = call();
  quiet.noteMicLevel({ level: 0.0004 });               // a quiet room still reads above 0
  quiet.clock.now += 60_000;
  quiet.noteMicLevel({ level: 0.0004 });
  assert.equal(quiet.log.restarted, 0);
});

test("muted by the person: their zeros are their own", () => {
  const c = call({ muted: true });
  c.mic.enabled = false;
  c.noteMicLevel({ level: 0 });
  c.clock.now += 60_000;
  c.noteMicLevel({ level: 0 });
  assert.equal(c.log.restarted, 0);
  assert.equal(c.micNote(), false);
});

test("their microphone silent, by their word: said on this side's call, after their being away or the link", () => {
  assert.equal(G.callPauseNote({ inCall: true, peerMicSilent: true, linkState: "connected" }), "mic");
  assert.equal(G.callPauseNote({ inCall: true, peerAway: true, peerMicSilent: true }), "away", "a hidden page says more");
  assert.equal(G.callPauseNote({ inCall: true, peerMicSilent: true, linkState: "failed" }), "reconnecting");
  const c = call();
  c.setPeerMic(true);
  c.updateCallPauseNote();
  assert.equal(c.note(), "callPeerMicSilent");
  c.setPeerMic(false);
  c.updateCallPauseNote();
  assert.equal(c.note(), null);
});

test("the paused microphone is watched from the track, and its word heard only in a call", () => {
  assert.match(fn("watchCallTrack"), /addEventListener\("mute"[\s\S]*addEventListener\("unmute", checkMic\)/);
  const CASES = between('    case "call-mic":', "      break;");
  assert.match(CASES, /if \(!inCall\) break;\s*\n\s*peerMicSilent = data\.silent === true;\s*\n\s*updateCallPauseNote\(\);/);
  assert.match(fn("watchCallStats"), /resetMicCheck\(\);/, "every call starts with nothing paused, and ends so");
});

test("the other side's word is heard only during a call", () => {
  const CASES = between('    case "call-away":', "  }\n}");
  const run = inCall => {
    const seen = [];
    new Function("inCall", "updateCallPauseNote", "seen", `
      let peerAway = false;
      function deliver(data) { switch (data.type) {\n${CASES}\n} }
      deliver({ type: "call-away" }); seen.push(peerAway);
      deliver({ type: "call-back" }); seen.push(peerAway);
    `)(inCall, () => {}, seen);
    return seen;
  };
  assert.deepEqual(run(true), [true, false]);
  assert.deepEqual(run(false), [false, false]);
});

test("the call's link changing redraws the note; ending a call clears it; a new call starts clear", () => {
  assert.match(between("callPc.onconnectionstatechange = () => {", "callPc.ontrack"), /updateCallPauseNote\(\)/);
  assert.match(fn("endCall"), /peerAway = false;\s*\n\s*updateCallPauseNote\(\)/);
  assert.match(fn("createCallPeerConnection"), /peerAway = false;/);
});

test("the call's own microphone and camera are watched from the start", () => {
  const attach = fn("attachCallMedia");
  assert.match(attach, /localStream\.getTracks\(\)\.forEach\(watchCallTrack\)/);
  assert.match(attach, /video: withVideo \? callVideo\(\) : false/, "the same camera settings, starting or starting again");
  /* callVideo() faces whichever way the camera was last flipped. A fixed
     setting here turned a flipped-to back camera round to the front on every
     unlock. */
  assert.match(fn("restartEndedCallMedia"), /video: kinds\.includes\("video"\) \? callVideo\(\) : false/);
});

test("starting again asks the call guard before opening, and again after", () => {
  const restart = fn("restartEndedCallMedia");
  const opens = restart.indexOf("getUserMedia(");
  assert.ok(restart.indexOf("G.tracksToRestart(") > -1 && restart.indexOf("G.tracksToRestart(") < opens,
    "tracksToRestart — which asks mayCaptureForCall — before opening");
  assert.ok(restart.indexOf("G.mayCaptureForCall(inCall)") > opens, "and the call is checked again once it has opened");
});
