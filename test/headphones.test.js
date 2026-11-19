/*
  Where a call's sound goes on a phone: headphones, the earpiece, the
  loudspeaker.

  Reported, in order:
    1. Bluetooth headphones connected mid-call, and the other person went on
       coming out of the phone's speaker. On an iPhone a call's sound goes
       wherever its microphone is, and the call's microphone was the phone's
       own. Fix: a change in microphones opens the microphone again, alone.
    2. Taking the headphones off then left the sound on the quiet earpiece, as
       for a voice call, with no way back. A page cannot choose loudspeaker over
       earpiece on an iPhone; a video call starts on the loudspeaker, so the
       headphones coming off in a video call now open microphone and camera
       again as a call starts (restartLikeCallStart), and a button does the
       same on request.

  The decisions are G.mayMoveMic, G.micChangeAction and G.speakerOffered. Then
  followAudioDevice() and restartLikeCallStart() are lifted out of app.js and
  run against stand-in devices. Where the sound actually goes is the phone's
  decision; only a phone shows it.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const G   = require("../guards.js");
const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");

/* ══════════════════════════════════════════
   The decisions
══════════════════════════════════════════ */

test("the microphone is opened again only in a call that has one, one change at a time", () => {
  for (const inCall of [true, false, "true", undefined]) {
    for (const hasAudio of [true, false, undefined]) {
      for (const busy of [true, false, undefined]) {
        assert.equal(G.mayMoveMic({ inCall, hasAudio, busy }), inCall === true && hasAudio === true && !busy,
          `inCall ${inCall}, hasAudio ${hasAudio}, busy ${busy}`);
      }
    }
  }
  assert.equal(G.mayMoveMic(undefined), false);
});

test("headphones arriving move the microphone; leaving a video call, they bring the call's start back", () => {
  assert.equal(G.micChangeAction({ before: 1, after: 2, hasVideo: true }), "mic", "arriving");
  assert.equal(G.micChangeAction({ before: 1, after: 2, hasVideo: false }), "mic");
  assert.equal(G.micChangeAction({ before: 2, after: 1, hasVideo: true }), "mic-and-camera", "leaving, in a video call");
  assert.equal(G.micChangeAction({ before: 2, after: 1, hasVideo: false }), "mic",
    "leaving, in a voice call: there is no camera to open, and opening one is capture nobody agreed to");
  assert.equal(G.micChangeAction({ before: 2, after: 2, hasVideo: true }), "mic", "one swapped for another");
  assert.equal(G.micChangeAction({ before: NaN, after: 1, hasVideo: true }), "none");
  assert.equal(G.micChangeAction(undefined), "none");
});

test("the loudspeaker button is for an iPhone or iPad in a video call, and nowhere else", () => {
  const ok = { inCall: true, hasVideo: true, os: "iphone" };
  assert.equal(G.speakerOffered(ok), true);
  assert.equal(G.speakerOffered({ ...ok, os: "ipad" }), true);
  for (const os of ["android", "macos", "windows", "other", undefined]) {
    assert.equal(G.speakerOffered({ ...ok, os }), false, `${os}: no such switch to stand in for`);
  }
  assert.equal(G.speakerOffered({ ...ok, hasVideo: false }), false, "a voice call has no camera to open");
  assert.equal(G.speakerOffered({ ...ok, inCall: false }), false);
  assert.equal(G.speakerOffered(undefined), false);
});

/* ══════════════════════════════════════════
   followAudioDevice() and restartLikeCallStart(), actually run
══════════════════════════════════════════ */

const grab = (pattern, what) => {
  const m = app.match(pattern);
  assert.ok(m, `${what} not found in app.js`);
  return m[0];
};
const SOURCE = [
  grab(/^async function audioInputsNow\(\)\s*\{[\s\S]*?^\}/m,       "audioInputsNow"),
  grab(/^function micCount\([^)]*\)\s*\{[\s\S]*?^\}/m,              "micCount"),
  grab(/^async function followAudioDevice\(\)\s*\{[\s\S]*?^\}/m,    "followAudioDevice"),
  grab(/^async function restartLikeCallStart\(\)\s*\{[\s\S]*?^\}/m, "restartLikeCallStart")
].join("\n");

const PHONE_MIC = { kind: "audioinput", deviceId: "a1", label: "iPhone Microphone" };
const AIRPODS   = { kind: "audioinput", deviceId: "a2", label: "AirPods" };
const CAMERA    = { kind: "videoinput", deviceId: "v1", label: "Front Camera" };
const SEEN_PHONE   = "a1|iPhone Microphone";
const SEEN_AIRPODS = "a1|iPhone Microphone,a2|AirPods";

/** A call with a microphone (and a camera, unless `video` is false). Each
    getUserMedia opens what it asks for, named `next`. */
function call({ inCall = true, audio = true, video = true, muted = false, camOff = false, busy = false,
                refuse = false, devices = [PHONE_MIC, AIRPODS, CAMERA], seen = SEEN_PHONE, next = "headphones",
                mixing = false, ownChannel = false } = {}) {
  const log = { order: [], asked: [], replaced: [], attached: [], watched: [], toasts: [], played: 0 };
  let gate = null;
  const track = (kind, name) => ({ kind, name, readyState: "live", enabled: true,
    stop() { this.readyState = "ended"; log.order.push(`stop ${name}`); } });
  class MediaStream {
    constructor(tracks = []) { this.tracks = [...tracks]; }
    getTracks() { return [...this.tracks]; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === "audio"); }
    getVideoTracks() { return this.tracks.filter(t => t.kind === "video"); }
  }
  const mic = audio ? track("audio", "phone mic") : null;
  const cam = video ? track("video", "camera") : null;
  const senders = [mic, cam].filter(Boolean).map(t => ({
    kind: t.kind,
    track: t, replaceTrack(n) { log.order.push(`replace with ${n.name}`); log.replaced.push(n); this.track = n; return Promise.resolve(); }
  }));
  const speakerBtn = { disabled: false };
  const env = {
    G, MediaStream, t: k => k,
    console: { error() {} },
    showToast: m => log.toasts.push(m),
    watchCallTrack: t => log.watched.push(t),
    attachCallTrack: async t => { log.attached.push(t); },
    updateLocalVideoAspect() {},
    showCameraFacing: () => log.order.push("mirror set"),
    callVideo: () => ({ facingMode: "user" }),
    speakerBtn,
    navigator: { mediaDevices: {
      enumerateDevices: async () => devices,
      getUserMedia: async constraints => {
        log.asked.push(constraints);
        log.order.push(`open ${[constraints.audio && "mic", constraints.video && "camera"].filter(Boolean).join("+")}`);
        if (gate) await gate;
        if (refuse) throw new Error("NotReadableError");
        return new MediaStream([constraints.audio && track("audio", `${next} mic`), constraints.video && track("video", `${next} camera`)].filter(Boolean));
      }
    } },
    state: {
      inCall, isMuted: muted, isCamOff: camOff, restartingCallMedia: busy, audioInputsSeen: seen,
      /* A screen's sound mixed in with the voice, as while sharing with sound. */
      screenMix: mixing ? { carriesVoice: true, setMic: m => log.order.push(`into the mix: ${m.name}`) }
               : ownChannel ? { carriesVoice: false, setMic: m => log.order.push(`listened to: ${m.name}`) } : null,
      callPc: { getSenders: () => senders },
      localStream: new MediaStream([mic, cam].filter(Boolean)),
      localVideo: { srcObject: null, style: { removeProperty() {} }, play() { log.played++; return Promise.resolve(); } }
    }
  };
  const names = Object.keys(env).filter(n => n !== "state");
  const api = new Function(...names, "state", `
    let { inCall, isMuted, isCamOff, restartingCallMedia, callPc, localStream, localVideo, audioInputsSeen, sharingScreen = false, screenMix = null } = state;
    ${SOURCE}
    return {
      followAudioDevice, restartLikeCallStart,
      now: () => ({ inCall, restartingCallMedia, localStream, localVideo, audioInputsSeen }),
      hangUp: () => { inCall = false; localStream = null; }
    };
  `)(...names.map(n => env[n]), env.state);
  return { ...api, log, mic, cam, senders, speakerBtn,
           hold: () => { let open; gate = new Promise(r => { open = r; }); return () => { gate = null; open(); }; } };
}

/* ── headphones arriving ── */

test("headphones connected: the microphone alone is opened again, swapped in, and only then the old one stopped", async () => {
  const c = call();
  await c.followAudioDevice();
  assert.deepEqual(c.log.asked, [{ audio: true, video: false }], "the phone's preferred microphone, the camera untouched");
  assert.deepEqual(c.log.order, ["open mic", "replace with headphones mic", "stop phone mic"],
    "stopped after the swap, so a failure would have left the call its sound");
  assert.equal(c.senders[0].track.name, "headphones mic", "the same sender: no new call");
  assert.equal(c.senders[1].track, c.cam, "the camera's sender is left alone");
  assert.equal(c.log.attached.length, 0);
  assert.equal(c.log.watched[0].name, "headphones mic", "watched like every call track, for a lock");
  assert.deepEqual(c.now().localStream.getVideoTracks(), [c.cam]);
});

test("while a screen's sound is mixed in, new headphones' microphone goes into the mix, not over it", async () => {
  /* The voice's sender carries the mix; replacing its track would cut the
     shared sound off. */
  const c = call({ mixing: true });
  await c.followAudioDevice();
  assert.deepEqual(c.log.order, ["open mic", "into the mix: headphones mic", "stop phone mic"]);
  assert.equal(c.log.replaced.length, 0, "the sender keeps the mix");
  assert.deepEqual(c.now().localStream.getAudioTracks().map(t => t.name), ["headphones mic"]);
});

test("while a screen's sound has a channel of its own, new headphones' microphone goes out as the voice, and the dip listens to it", async () => {
  const c = call({ ownChannel: true });
  await c.followAudioDevice();
  assert.deepEqual(c.log.order, ["open mic", "listened to: headphones mic", "replace with headphones mic", "stop phone mic"]);
  assert.equal(c.log.replaced[0].name, "headphones mic", "in the voice's own sender");
});

test("muted stays muted", async () => {
  const c = call({ muted: true });
  await c.followAudioDevice();
  assert.equal(c.now().localStream.getAudioTracks()[0].enabled, false);
});

test("a device change while the call is still setting up is not headphones, and opens nothing", async () => {
  /* Reported: a laptop heard the phone but never saw it. The list used to be
     compared with the last call's — or with nothing — until the new call had
     noted its own, so a phone reporting a change as its camera and microphone
     started had the call's devices opened again mid-setup. */
  const c = call({ seen: null });
  await c.followAudioDevice();
  assert.equal(c.log.asked.length, 0);
  assert.equal(c.now().audioInputsSeen, null, "and nothing is noted from it either");
});

test("a change that is only a camera leaves the microphone alone", async () => {
  const c = call({ devices: [PHONE_MIC, CAMERA, { kind: "videoinput", deviceId: "v2", label: "Back Camera" }] });
  await c.followAudioDevice();
  assert.equal(c.log.asked.length, 0);
});

test("no call, a call without a microphone, or another change under way: nothing opens", async () => {
  for (const setup of [{ inCall: false }, { audio: false }, { busy: true }]) {
    const c = call(setup);
    await c.followAudioDevice();
    assert.equal(c.log.asked.length, 0, JSON.stringify(setup));
  }
});

test("hung up while it was opening: the new microphone is put straight back", async () => {
  const c = call();
  const release = c.hold();
  const moving = c.followAudioDevice();
  c.hangUp();
  release();
  await moving;
  assert.deepEqual(c.log.order, ["open mic", "stop headphones mic"]);
  assert.equal(c.log.replaced.length, 0);
});

test("the new microphone will not open: the call keeps the one it had", async () => {
  const c = call({ refuse: true });
  await c.followAudioDevice();
  assert.equal(c.mic.readyState, "live", "not stopped — the call still has its sound");
  assert.equal(c.senders[0].track, c.mic);
  assert.equal(c.now().restartingCallMedia, false, "the flip and the restart after a lock may run again");
});

/* ── headphones leaving ── */

test("headphones taken off in a video call: microphone and camera open again, as the call started", async () => {
  const c = call({ devices: [PHONE_MIC, CAMERA], seen: SEEN_AIRPODS, next: "phone" });
  await c.followAudioDevice();
  assert.deepEqual(c.log.asked, [{ audio: true, video: { facingMode: "user" } }], "both, with the call's camera settings");
  assert.equal(c.now().audioInputsSeen, SEEN_PHONE);
});

test("headphones taken off in a voice call: the microphone alone, no camera", async () => {
  const c = call({ video: false, devices: [PHONE_MIC], seen: SEEN_AIRPODS, next: "phone" });
  await c.followAudioDevice();
  assert.deepEqual(c.log.asked, [{ audio: true, video: false }]);
});

/* ── the restart itself, as the button and the headphones leaving run it ── */

test("as a call starts: everything stopped first, both opened again, both swapped into the same senders", async () => {
  const c = call({ next: "fresh" });
  await c.restartLikeCallStart();
  assert.deepEqual(c.log.order, ["stop phone mic", "stop camera", "open mic+camera",
    "replace with fresh mic", "replace with fresh camera", "mirror set"],
    "the capture has to stop for the phone to choose again as it starts");
  assert.deepEqual(c.senders.map(s => s.track.name), ["fresh mic", "fresh camera"], "the same senders: no new call");
  assert.equal(c.log.attached.length, 0);
  const { localStream, localVideo } = c.now();
  assert.equal(localVideo.srcObject, localStream, "the self-view shows the camera that came back");
  assert.equal(c.log.played, 1);
  assert.deepEqual(c.log.watched.map(t => t.name), ["fresh mic", "fresh camera"]);
});

test("muted stays muted and camera off stays off through it", async () => {
  const c = call({ muted: true, camOff: true });
  await c.restartLikeCallStart();
  const { localStream } = c.now();
  assert.equal(localStream.getAudioTracks()[0].enabled, false);
  assert.equal(localStream.getVideoTracks()[0].enabled, false);
});

test("a voice call is never given a camera by it", async () => {
  const c = call({ video: false });
  await c.restartLikeCallStart();
  assert.deepEqual(c.log.asked, [{ audio: true, video: false }]);
});

test("no call, or another change under way: nothing is stopped and nothing opens", async () => {
  for (const setup of [{ inCall: false }, { busy: true }, { audio: false }]) {
    const c = call(setup);
    await c.restartLikeCallStart();
    assert.deepEqual(c.log.order, [], JSON.stringify(setup));
  }
});

test("hung up while they were opening: put straight back", async () => {
  const c = call({ next: "late" });
  const release = c.hold();
  const restarting = c.restartLikeCallStart();
  c.hangUp();
  release();
  await restarting;
  assert.deepEqual(c.log.order.slice(-2), ["stop late mic", "stop late camera"]);
  assert.equal(c.log.replaced.length, 0);
});

test("they will not open: said once, the buttons work again, and the next return to the page tries again", async () => {
  const c = call({ refuse: true });
  await c.restartLikeCallStart();
  assert.deepEqual(c.log.toasts, ["callMediaRestartFailed"]);
  assert.equal(c.speakerBtn.disabled, false);
  assert.equal(c.now().restartingCallMedia, false);
  assert.ok(c.now().localStream.getTracks().every(t => t.readyState === "ended"),
    "left ended, which is what restartEndedCallMedia looks for");
});

/* ══════════════════════════════════════════
   That it is wired up
══════════════════════════════════════════ */

test("a device change mid-call is followed, once it settles; each call notes what it started with", () => {
  assert.match(app, /navigator\.mediaDevices\?\.addEventListener\?\.\("devicechange", \(\) => \{\s*\n\s*clearTimeout\(audioChangeTimer\);\s*\n\s*audioChangeTimer = setTimeout\(followAudioDevice, \d+\);/);
  const attach = grab(/^async function attachCallMedia\([^)]*\)\s*\{[\s\S]*?^\}/m, "attachCallMedia");
  assert.ok(attach.lastIndexOf("noteAudioInputs()") > attach.lastIndexOf("attachCallTrack("),
    "noted once the call's own microphone is open, so the list includes it");
  assert.ok(attach.indexOf("audioInputsSeen = null;") > -1 && attach.indexOf("audioInputsSeen = null;") < attach.indexOf("getUserMedia("),
    "forgotten before the call's devices start, so their starting is not taken for headphones");
  assert.match(grab(/^function stopCallMedia\([^)]*\)\s*\{[\s\S]*?^\}/m, "stopCallMedia"), /audioInputsSeen = null;/,
    "and between calls, so no call is measured against the last one's");
  assert.match(grab(/^function noteAudioInputs\(\)\s*\{[\s\S]*?^\}/m, "noteAudioInputs"), /if \(callPc === pc && inCall\) audioInputsSeen = list;/,
    "a list that arrives after its call has gone is not kept for the next");
});

test("the loudspeaker button restarts as a call starts; a call offers it once its devices are in; ending one hides it", () => {
  assert.match(app, /^speakerBtn\.onclick = \(\) => restartLikeCallStart\(\);$/m);
  const attach = grab(/^async function attachCallMedia\([^)]*\)\s*\{[\s\S]*?^\}/m, "attachCallMedia");
  assert.ok(attach.lastIndexOf("updateSpeakerBtn()") > attach.lastIndexOf("attachCallTrack("));
  const stop = grab(/^function stopCallMedia\([^)]*\)\s*\{[\s\S]*?^\}/m, "stopCallMedia");
  assert.match(stop, /speakerBtn\.classList\.add\("hidden"\)/);
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(html, /<button id="speakerBtn" class="call-btn hidden" data-i18n-aria="loudspeaker"/, "hidden until a call offers it");
});
