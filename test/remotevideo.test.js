/*
  The other person's picture in a call, actually run.

  The bug: on an iPhone, sometimes, the other person's picture stayed black
  while their voice came through and they could see you. The call worked; the
  picture was never drawn.

  The cause: the <video> was handed an empty stream when the call began, and
  the other side's tracks were added to that stream as they arrived. Safari —
  the engine of every browser on an iPhone — keeps playing the sound of such a
  stream but may never draw a video track added after it was attached. Whether
  it did depended on timing, hence "sometimes".

  The fix: the picture is never given a stream to grow. Each time a track
  arrives it gets a fresh stream holding every track so far; and if frames
  start arriving while the picture is still blank, it is handed over again.

  Nothing here can run Safari, so this cannot prove the picture on a phone.
  What it does prove is the order of events the fix depends on: the real
  createCallPeerConnection(), showRemoteTracks() and playRemoteCallMedia() are
  lifted out of app.js and run against a stand-in <video> and connection.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

const grab = name => {
  const m = app.match(new RegExp(`^function ${name}\\(\\)\\s*\\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(m, `${name} not found as a top-level function in app.js`);
  return m[0];
};
const G = require("../guards.js");
const SOURCE = ["createCallPeerConnection", "closeCallPeerConnection", "showRemoteTracks", "playRemoteCallMedia",
                "levelVoice", "checkVoiceHeard", "stopLevellingVoice"]
  .map(grab).join("\n");

class MediaStream {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === "audio"); }
  addTrack(track) { this.tracks.push(track); }
}

/** Starts a call's connection with the real code and hands back the controls. */
function call({ inCall = true, refusePlay = null, os = "android", webAudio = true, ctxState = "running", ctxThrows = false } = {}) {
  const video = {
    srcObject: "left over from the last call", videoWidth: 0, plays: 0, attached: [], refusePlay,
    play() {
      this.plays++;
      return this.refusePlay ? Promise.reject(Object.assign(new Error("refused"), { name: this.refusePlay })) : Promise.resolve();
    }
  };
  const hidden = new Set(["hidden"]);
  const tapToHear = { classList: { add: c => hidden.add(c), remove: c => hidden.delete(c), contains: c => hidden.has(c) } };
  /* Record every stream the picture is given, in order. */
  let current = video.srcObject;
  Object.defineProperty(video, "srcObject", {
    get: () => current,
    set: value => { current = value; video.attached.push(value); }
  });

  let connection = null;
  class RTCPeerConnection { constructor() { connection = this; } close() {} }

  /* Web Audio, as far as the leveller uses it: each context and what was made in it. */
  const contexts = [];
  const node = (ctx, kind) => {
    const param = () => ({ value: null });
    const n = { kind, to: null, threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
                connect(next) { n.to = next; return next; } };
    ctx.nodes.push(n);
    return n;
  };
  class AudioContext {
    constructor() {
      if (ctxThrows) throw new Error("no audio here");
      this.state = ctxState; this.nodes = []; this.closed = false; this.resumes = 0; this.onstatechange = null;
      this.destination = { kind: "speakers" };
      contexts.push(this);
    }
    createMediaStreamSource(stream) { const n = node(this, "source"); n.stream = stream; return n; }
    createDynamicsCompressor() { return node(this, "compressor"); }
    resume() { this.resumes++; return ctxState === "running" ? Promise.resolve() : new Promise(() => {}); }
    close() { this.closed = true; return Promise.resolve(); }
  }
  const timers = [];
  const holders = [];
  const document = { createElement: tag => { const el = { tag, muted: false, srcObject: null, plays: 0, play() { el.plays++; return Promise.resolve(); } }; holders.push(el); return el; } };

  const run = new Function(
    "MediaStream", "RTCPeerConnection", "remoteVideo", "callStatusLabel", "t",
    "ICE_CONFIG", "currentSession", "dcSendCallSignal", "endCall", "inCall", "callTapToHear",
    "G", "window", "MY_DEVICE", "document", "setTimeout", "clearTimeout", "console",
    `let callPc = null, remoteCallStream = null, voiceLeveller = null, voiceHeardTimer = null;\nconst stopCallRecovery = () => {}, watchCallLink = () => {};\n${SOURCE}\ncreateCallPeerConnection();\nreturn { playRemoteCallMedia, stopLevellingVoice, createCallPeerConnection, leveller: () => voiceLeveller };`
  );
  const api = run(MediaStream, RTCPeerConnection, video, { textContent: "" }, key => key,
      {}, null, () => {}, () => {}, inCall, tapToHear,
      G, webAudio ? { AudioContext } : {}, { os }, document, (f, ms) => { timers.push({ f, ms }); return timers.length; }, () => {}, { warn() {} });

  const track = kind => ({ kind, id: `${kind}-1` });
  const arrive = t => connection.ontrack({ track: t });
  return { video, track, arrive, ...api, tapShown: () => !hidden.has("hidden"), contexts, holders, timers };
}

const kinds = stream => stream.getTracks().map(t => t.kind);

test("the picture is not handed an empty stream when a call begins", () => {
  /* The old code attached an empty stream here and grew it — the Safari case. */
  const c = call();
  assert.equal(c.video.srcObject, null, "nothing to show yet, and nothing left over from the last call");
});

test("every track that arrives reaches the picture in a fresh stream", () => {
  const c = call();
  const audio = c.track("audio"), video = c.track("video");
  c.arrive(audio);
  const first = c.video.srcObject;
  assert.deepEqual(kinds(first), ["audio"]);

  c.arrive(video);
  const second = c.video.srcObject;
  assert.notEqual(second, first, "a new stream, not the old one grown");
  assert.deepEqual(kinds(second), ["audio", "video"]);
  assert.deepEqual(kinds(first), ["audio"], "a stream already given to the picture is never added to");
});

test("video arriving before sound works the same", () => {
  const c = call();
  c.arrive(c.track("video"));
  c.arrive(c.track("audio"));
  assert.deepEqual(kinds(c.video.srcObject), ["video", "audio"]);
});

test("a track announced twice is not added twice", () => {
  const c = call();
  const video = c.track("video");
  c.arrive(video);
  c.arrive(video);
  assert.deepEqual(kinds(c.video.srcObject), ["video"]);
});

test("a picture still blank when frames start arriving is handed over again", () => {
  const c = call();
  const video = c.track("video");
  c.arrive(c.track("audio"));
  c.arrive(video);
  const before = c.video.attached.length;
  c.video.videoWidth = 0;
  video.onunmute();
  assert.equal(c.video.attached.length, before + 1, "should be re-attached");
  assert.deepEqual(kinds(c.video.srcObject), ["audio", "video"]);
});

test("a picture already showing is left alone", () => {
  /* Re-attaching restarts the player — a hiccup in the sound for nothing. */
  const c = call();
  const video = c.track("video");
  c.arrive(video);
  const before = c.video.attached.length;
  c.video.videoWidth = 640;
  video.onunmute();
  assert.equal(c.video.attached.length, before);
});

test("sound arriving is never a reason to restart the picture", () => {
  const c = call();
  const audio = c.track("audio");
  c.arrive(audio);
  const before = c.video.attached.length;
  audio.onunmute();
  assert.equal(c.video.attached.length, before);
});

test("tracks that arrive before the call is accepted are held, not played", () => {
  /* The answering side's tracks arrive during setRemoteDescription. */
  const c = call({ inCall: false });
  c.arrive(c.track("audio"));
  assert.equal(c.video.plays, 0);
  assert.equal(c.video._pendingPlay, true);
  assert.deepEqual(kinds(c.video.srcObject), ["audio"], "attached, so it is ready the moment the call is");
});

/* ── A phone that will not start the sound by itself ──
   Reported: an Android phone heard nothing from an iPhone, from the start.
   A refused play() was swallowed: a call that connected in silence, with
   nothing to press. */

const settled = () => new Promise(r => setImmediate(r));

test("a phone that will not start the sound without a tap: Tap to hear appears, and goes once it plays", async () => {
  const c = call({ refusePlay: "NotAllowedError" });
  c.arrive(c.track("audio"));
  await settled();
  assert.equal(c.tapShown(), true);
  c.video.refusePlay = null;                 // the tap is the phone's permission
  c.playRemoteCallMedia();
  await settled();
  assert.equal(c.tapShown(), false);
});

test("a play interrupted by a fresh stream is not that: nothing to tap", async () => {
  const c = call({ refusePlay: "AbortError" });
  c.arrive(c.track("audio"));
  await settled();
  assert.equal(c.tapShown(), false);
});

test("sound that starts by itself: nothing to tap", async () => {
  const c = call();
  c.arrive(c.track("audio"));
  await settled();
  assert.equal(c.tapShown(), false);
});

/* ── The other person's voice, loud and steady ──
   Reported: on an Android phone, an iPhone's voice was loud and clear in one
   call and far and quiet in the next. Now it is evened out as it arrives. */

const chain = ctx => {
  const source = ctx.nodes.find(n => n.kind === "source");
  const out = [];
  for (let n = source; n; n = n.to) out.push(n);
  return out;
};

test("the voice is evened out as it arrives: a compressor, then a limiter, then the speakers — the picture muted", async () => {
  const c = call();
  const audio = c.track("audio");
  c.arrive(audio);
  c.arrive(c.track("video"));
  await settled();
  assert.equal(c.contexts.length, 1, "one for the call, not one per track");
  const [source, even, limit, speakers] = chain(c.contexts[0]);
  assert.deepEqual(source.stream.getTracks(), [audio], "the voice alone");
  const L = G.VOICE_LEVELLER;
  assert.deepEqual([even.threshold.value, even.knee.value, even.ratio.value, even.attack.value, even.release.value],
                   [L.threshold, L.knee, L.ratio, L.attack, L.release]);
  assert.deepEqual([limit.threshold.value, limit.knee.value, limit.ratio.value, limit.attack.value, limit.release.value],
                   [L.limit, 0, L.limitRatio, L.limitAttack, L.limitRelease]);
  assert.equal(speakers.kind, "speakers");
  assert.equal(c.video.muted, true, "heard once, from the leveller — not twice");
  const holder = c.holders.at(-1);
  assert.deepEqual([holder.tag, holder.muted, holder.srcObject.getTracks()[0], holder.plays], ["audio", true, audio, 1],
                   "a silent element plays the voice too: Chrome hands it to Web Audio only then");
  c.timers.at(-1).f();
  assert.equal(c.tapShown(), false, "started by itself: nothing to tap, then or a moment on");
});

test("the same voice again is left as it is; a new one is evened out afresh, the old let go", () => {
  const c = call();
  c.arrive(c.track("audio"));
  c.playRemoteCallMedia();
  c.playRemoteCallMedia();
  assert.equal(c.contexts.length, 1);
  c.createCallPeerConnection();                       // the call's connection made afresh mid-call
  const fresh = { kind: "audio", id: "audio-2" };
  c.arrive(fresh);
  assert.equal(c.contexts.length, 2);
  assert.equal(c.contexts[0].closed, true, "the old one let go");
  assert.deepEqual(chain(c.contexts[1])[0].stream.getTracks(), [fresh]);
  c.stopLevellingVoice();
  assert.equal(c.contexts[1].closed, true);
  assert.equal(c.video.muted, false, "heard from the picture again");
  assert.ok(c.holders.every(h => h.srcObject === null), "the silent elements let the voice go");
  assert.equal(c.leveller(), null);
});

test("on an iPhone or iPad, or without Web Audio, or if it will not start: the voice plays as it came", () => {
  for (const opts of [{ os: "iphone" }, { os: "ipad" }, { webAudio: false }, { ctxThrows: true }]) {
    const c = call(opts);
    c.arrive(c.track("audio"));
    assert.equal(c.leveller(), null, JSON.stringify(opts));
    assert.equal(c.video.muted, false, JSON.stringify(opts));
    assert.equal(c.video.plays > 0, true);
  }
  for (const os of ["android", "windows", "macos", "linux", "chromeos", "other"]) {
    assert.equal(G.mayLevelVoice({ webAudio: true, hasAudio: true, os }), true, os);
  }
  assert.equal(G.mayLevelVoice({ webAudio: true, hasAudio: false, os: "android" }), false, "no voice yet: nothing to even out");
  assert.equal(G.mayLevelVoice(null), false);
});

test("a picture alone is not a voice: nothing evened out until the voice arrives", () => {
  const c = call();
  c.arrive(c.track("video"));
  assert.equal(c.contexts.length, 0);
  assert.equal(c.video.muted, false);
});

test("a phone that will not start the evened-out voice: Tap to hear, a moment on — and gone once it starts", async () => {
  const c = call({ ctxState: "suspended" });
  c.arrive(c.track("audio"));
  await settled();
  assert.equal(c.tapShown(), false, "not at once: a context can take a moment to start");
  const wait = c.timers.at(-1);
  assert.equal(wait.ms, 1500);
  wait.f();
  assert.equal(c.tapShown(), true);
  const ctx = c.contexts[0];
  ctx.state = "running";
  ctx.onstatechange();
  assert.equal(c.tapShown(), false);
});

test("the wiring: the call's end lets the leveller go; Tap to hear starts it", () => {
  const stop = app.match(/^function stopCallMedia\([^)]*\)\s*\{[\s\S]*?^\}/m)[0];
  assert.match(stop, /stopLocalCallMedia\(\);\s*\n\s*stopLevellingVoice\(\);/);
  const tap = app.slice(app.indexOf("callTapToHear.onclick = () => {"), app.indexOf("};", app.indexOf("callTapToHear.onclick = () => {")));
  assert.match(tap, /if \(voiceLeveller\) voiceLeveller\.ctx\.resume\(\)/);
});
