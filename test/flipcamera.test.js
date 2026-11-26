/*
  Flipping the camera mid-call — front to back and back again.

  The decisions are in guards.js and tested first: when a flip may open a
  camera (G.mayFlipCamera) and when the button is offered at all
  (G.flipCameraOffered). Then flipCamera(), updateFlipCamBtn() and callVideo()
  are lifted out of app.js and run against stand-in cameras, for the things a
  flip has to get right that no phone shows you at a glance:

    - the old camera is stopped before the other is opened (many phones run
      one camera at a time)
    - the other camera goes into the same sender: no new call
    - a call hung up while the camera was opening gets no camera
    - a camera that will not open leaves the call with the one it had
    - only the front camera is mirrored, and a restart after a lock opens
      whichever camera was last flipped to

  A real phone is still the only proof that the picture turns round.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const G   = require("../guards.js");
const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");
const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");

/* ══════════════════════════════════════════
   The decisions
══════════════════════════════════════════ */

test("a flip opens a camera only in a call that already has one, one change at a time", () => {
  assert.equal(G.mayFlipCamera({ inCall: true, hasVideo: true, busy: false }), true);
  for (const inCall of [true, false, "true", 1, undefined]) {
    for (const hasVideo of [true, false, 1, undefined]) {
      for (const busy of [true, false, undefined]) {
        const expected = inCall === true && hasVideo === true && !busy;
        assert.equal(G.mayFlipCamera({ inCall, hasVideo, busy }), expected,
          `inCall ${inCall}, hasVideo ${hasVideo}, busy ${busy}`);
      }
    }
  }
  assert.equal(G.mayFlipCamera(undefined), false);
  assert.equal(G.mayFlipCamera(null), false);
});

test("the button is offered on a phone or tablet in a video call, and nowhere else", () => {
  const phone = { inCall: true, hasVideo: true, facing: "user", cameras: 2 };
  assert.equal(G.flipCameraOffered(phone), true);
  assert.equal(G.flipCameraOffered({ ...phone, facing: "environment" }), true, "already on the back camera");
  assert.equal(G.flipCameraOffered({ ...phone, cameras: 4 }), true, "a phone with several back lenses");
  assert.equal(G.flipCameraOffered({ ...phone, facing: undefined }), false, "a computer's webcam says nothing about facing");
  assert.equal(G.flipCameraOffered({ ...phone, facing: "" }), false);
  assert.equal(G.flipCameraOffered({ ...phone, facing: "left" }), false);
  assert.equal(G.flipCameraOffered({ ...phone, cameras: 1 }), false, "nothing to flip to");
  assert.equal(G.flipCameraOffered({ ...phone, cameras: 0 }), false);
  assert.equal(G.flipCameraOffered({ ...phone, hasVideo: false }), false, "a voice call");
  assert.equal(G.flipCameraOffered({ ...phone, inCall: false }), false, "the call has ended");
  assert.equal(G.flipCameraOffered(undefined), false);
});

/* ══════════════════════════════════════════
   flipCamera(), actually run
══════════════════════════════════════════ */

const grab = (pattern, what) => {
  const m = app.match(pattern);
  assert.ok(m, `${what} not found in app.js`);
  return m[0];
};
const SOURCE = [
  grab(/^const CALL_VIDEO = \{[^\n]*\};$/m,                                   "CALL_VIDEO"),
  grab(/^function callVideo\(\)\s*\{[\s\S]*?^\}/m,                            "callVideo"),
  grab(/^async function flipCamera\(\)\s*\{[\s\S]*?^\}/m,                     "flipCamera"),
  grab(/^function showCameraFacing\(\)\s*\{[\s\S]*?^\}/m,                     "showCameraFacing"),
  grab(/^function screenInCameraPlace\(\)\s*\{[\s\S]*?^\}/m,                  "screenInCameraPlace"),
  grab(/^async function updateFlipCamBtn\(\)\s*\{[\s\S]*?^\}/m,               "updateFlipCamBtn")
].join("\n");

function classes(initial = []) {
  const set = new Set(initial);
  return { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c),
           toggle: (c, on) => (on ? set.add(c) : set.delete(c)) };
}

/** A call with a front camera in it. `cameras` answers each getUserMedia:
    a facing to open, or an Error to refuse with. */
function call({ inCall = true, video = true, camOff = false, busy = false, facing = "user",
                answers = [], devices = 2 } = {}) {
  const log = { order: [], asked: [], replaced: [], attached: [], toasts: [], watched: [], played: 0 };
  let gate = null;
  const track = (kind, facingMode) => {
    const t = { kind, facingMode, readyState: "live", enabled: true,
      stop() { this.readyState = "ended"; log.order.push(`stop ${kind}${facingMode ? " " + facingMode : ""}`); },
      getSettings: () => (facingMode ? { facingMode } : {}) };
    return t;
  };
  class MediaStream {
    constructor(tracks = []) { this.tracks = [...tracks]; }
    getTracks() { return [...this.tracks]; }
    getVideoTracks() { return this.tracks.filter(t => t.kind === "video"); }
    getAudioTracks() { return this.tracks.filter(t => t.kind === "audio"); }
  }
  const mic = track("audio"), cam = video ? track("video", facing) : null;
  const senders = [mic, cam].filter(Boolean).map(t => ({
    track: t, replaceTrack(n) { log.replaced.push(n); this.track = n; return Promise.resolve(); }
  }));
  const pending = [...answers];
  const env = {
    G, MediaStream, t: k => k,
    console: { error() {} },
    showToast: m => log.toasts.push(m),
    watchCallTrack: t => log.watched.push(t),
    attachCallTrack: async t => { log.attached.push(t); },
    updateLocalVideoAspect() {},
    flipCamBtn: { disabled: false, classList: classes(["hidden"]) },
    navigator: { mediaDevices: {
      getUserMedia: async constraints => {
        log.asked.push(constraints);
        const f = constraints.video.facingMode;
        log.order.push(`open ${typeof f === "object" ? `exact ${f.exact}` : f}`);
        if (gate) await gate;
        const answer = pending.length ? pending.shift() : (typeof f === "object" ? f.exact : f);
        if (answer instanceof Error) throw answer;
        return new MediaStream([track("video", answer)]);
      },
      enumerateDevices: async () => {
        if (gate) await gate;
        return [{ kind: "audioinput" }, ...Array.from({ length: devices }, () => ({ kind: "videoinput" }))];
      }
    } },
    state: {
      inCall, isCamOff: camOff, restartingCallMedia: busy, cameraFacing: facing,
      callPc: { getSenders: () => senders },
      localStream: new MediaStream([mic, cam].filter(Boolean)),
      localVideo: { srcObject: null, classList: classes(), style: { removeProperty() {} },
                    play() { log.played++; return Promise.resolve(); } }
    }
  };
  const names = Object.keys(env).filter(n => n !== "state");
  const api = new Function(...names, "state", `
    let { inCall, isCamOff, restartingCallMedia, cameraFacing, callPc, localStream, localVideo, sharingScreen = false } = state;
    let sharedScreen = null, sharedMusic = null;
    ${SOURCE}
    return {
      flipCamera, updateFlipCamBtn, callVideo, showCameraFacing,
      now: () => ({ inCall, restartingCallMedia, cameraFacing, callPc, localStream, localVideo }),
      hangUp: () => { inCall = false; localStream = null; }
    };
  `)(...names.map(n => env[n]), env.state);
  return { ...api, log, mic, cam, senders, button: env.flipCamBtn,
           hold: () => { let open; gate = new Promise(r => { open = r; }); return () => { gate = null; open(); }; } };
}

test("front to back: the front camera stops, then the back one opens", () => {
  const c = call();
  return c.flipCamera().then(() => {
    assert.deepEqual(c.log.order, ["stop video user", "open exact environment"],
      "the camera in use is stopped before the other is opened");
    assert.equal(c.log.asked[0].audio, false, "the microphone is not touched");
    assert.equal(c.log.asked[0].video.width.ideal, 1280, "the call's own camera settings");
  });
});

test("the other camera goes into the same sender — no new call", async () => {
  const c = call();
  await c.flipCamera();
  const back = c.now().localStream.getVideoTracks()[0];
  assert.equal(back.facingMode, "environment");
  assert.deepEqual(c.log.replaced, [back], "replaceTrack on the camera's sender");
  assert.equal(c.senders[0].track, c.mic, "the microphone's sender is left alone");
  assert.equal(c.log.attached.length, 0, "nothing added — adding would need a new offer");
  assert.deepEqual(c.log.watched, [back], "watched like every call track, for a lock");
});

test("the self-view gets a fresh stream with the same microphone", async () => {
  const c = call();
  const before = c.now().localStream;
  await c.flipCamera();
  const { localStream, localVideo } = c.now();
  assert.notEqual(localStream, before, "Safari may never draw a track added to a stream on screen");
  assert.equal(localVideo.srcObject, localStream);
  assert.deepEqual(localStream.getAudioTracks(), [c.mic]);
  assert.equal(c.log.played, 1);
});

test("only the front camera is mirrored", async () => {
  const c = call();
  await c.flipCamera();
  assert.equal(c.now().cameraFacing, "environment");
  assert.equal(c.now().localVideo.classList.contains("back-camera"), true, "back camera: no mirror");
  await c.flipCamera();
  assert.equal(c.now().cameraFacing, "user");
  assert.equal(c.now().localVideo.classList.contains("back-camera"), false, "front again: mirrored");
});

test("a restart after a lock opens whichever camera was last flipped to", async () => {
  /* callVideo() is what restartEndedCallMedia and attachCallMedia ask for. */
  const c = call();
  assert.equal(c.callVideo().facingMode, "user");
  await c.flipCamera();
  assert.equal(c.callVideo().facingMode, "environment");
  assert.equal(c.callVideo().width.ideal, 1280);
});

test("camera off stays off through a flip", async () => {
  const c = call({ camOff: true });
  await c.flipCamera();
  assert.equal(c.now().localStream.getVideoTracks()[0].enabled, false);
});

test("a voice call, an ended call, or a change already under way opens nothing", async () => {
  for (const setup of [{ video: false }, { inCall: false }, { busy: true }]) {
    const c = call(setup);
    await c.flipCamera();
    assert.equal(c.log.asked.length, 0, JSON.stringify(setup));
    assert.deepEqual(c.log.order, [], `${JSON.stringify(setup)} — and the camera in use is not stopped`);
  }
});

test("a second press while the camera is opening does nothing", async () => {
  const c = call();
  const release = c.hold();
  const first = c.flipCamera();
  await c.flipCamera();
  assert.equal(c.button.disabled, true, "the button is off while the camera opens");
  release();
  await first;
  assert.equal(c.log.asked.length, 1);
  assert.equal(c.button.disabled, false, "and back on after");
  assert.equal(c.now().restartingCallMedia, false, "a restart after a lock may run again");
});

test("hung up while the camera was opening: the camera is put straight back", async () => {
  const c = call();
  const release = c.hold();
  const flipping = c.flipCamera();
  c.hangUp();
  release();
  await flipping;
  assert.equal(c.log.replaced.length, 0);
  assert.equal(c.now().localStream, null);
  assert.deepEqual(c.log.order, ["stop video user", "open exact environment", "stop video environment"],
    "the camera that opened late is stopped");
});

test("the other camera will not open: the one in use comes back, and the call says so", async () => {
  const c = call({ answers: [new Error("NotReadableError"), "user"] });
  await c.flipCamera();
  assert.deepEqual(c.log.order, ["stop video user", "open exact environment", "open user"]);
  assert.equal(c.log.asked[1].video.facingMode, "user", "any front camera, not exactly one — getting a picture back is what matters");
  const front = c.now().localStream.getVideoTracks()[0];
  assert.deepEqual(c.log.replaced, [front], "the call has its camera back");
  assert.equal(c.now().cameraFacing, "user");
  assert.equal(c.now().localVideo.classList.contains("back-camera"), false);
  assert.deepEqual(c.log.toasts, ["cameraFlipFailed"]);
});

test("neither camera will open: one message, and the button works again", async () => {
  const c = call({ answers: [new Error("NotReadableError"), new Error("NotReadableError")] });
  await c.flipCamera();
  assert.deepEqual(c.log.toasts, ["callMediaRestartFailed"], "one message, not two");
  assert.equal(c.button.disabled, false);
  assert.equal(c.now().restartingCallMedia, false);
  assert.equal(c.now().cameraFacing, "user");
  assert.equal(c.now().localStream.getVideoTracks()[0].readyState, "ended",
    "left ended, so coming back to the page tries the camera again (restartEndedCallMedia)");
});

/* ══════════════════════════════════════════
   updateFlipCamBtn(), actually run
══════════════════════════════════════════ */

test("the button shows in a phone's video call", async () => {
  const c = call();
  await c.updateFlipCamBtn();
  assert.equal(c.button.classList.contains("hidden"), false);
});

test("the button stays hidden on a computer, with one camera, or in a voice call", async () => {
  /* facing: null — a camera whose settings name no facing, as a webcam's do. */
  for (const setup of [{ facing: null }, { devices: 1 }, { video: false }]) {
    const c = call(setup);
    await c.updateFlipCamBtn();
    assert.equal(c.button.classList.contains("hidden"), true, JSON.stringify(setup));
  }
});

test("a call that ends while the cameras are being counted does not get the button back", async () => {
  const c = call();
  const release = c.hold();
  const updating = c.updateFlipCamBtn();
  c.hangUp();
  release();
  await updating;
  assert.equal(c.button.classList.contains("hidden"), true);
});

/* ══════════════════════════════════════════
   That it is wired up
══════════════════════════════════════════ */

test("the stylesheet un-mirrors the back camera", () => {
  const rule = css.replace(/\/\*[\s\S]*?\*\//g, "").match(/#localVideo\.back-camera\s*\{([^}]*)\}/);
  assert.ok(rule, "#localVideo.back-camera rule not found");
  assert.match(rule[1], /transform:\s*none/);
});

test("the button flips, a call offers it once its camera is in, and ending one takes it away", () => {
  assert.match(app, /^flipCamBtn\.onclick = \(\) => flipCamera\(\);$/m);
  const attach = grab(/^async function attachCallMedia\([^)]*\)\s*\{[\s\S]*?^\}/m, "attachCallMedia");
  assert.match(attach, /cameraFacing = "user";/, "every call starts on the front camera");
  assert.ok(attach.lastIndexOf("updateFlipCamBtn()") > attach.lastIndexOf("attachCallTrack("),
    "offered once the camera is in the call");
  const stop = grab(/^function stopCallMedia\([^)]*\)\s*\{[\s\S]*?^\}/m, "stopCallMedia");
  assert.match(stop, /flipCamBtn\.classList\.add\("hidden"\)/);
  assert.match(stop, /cameraFacing = "user";\s*\n\s*showCameraFacing\(\);/);
});
