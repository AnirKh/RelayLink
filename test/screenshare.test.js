/*
  Sharing the screen in a video call.

  The screen takes the camera's place in the same sender; the browser's own
  picker is the consent; stopping — by the button or the browser's "Stop
  sharing" bar — brings the camera back. Only where the browser can share: a
  computer's; no iPhone or iPad browser can.

  The decisions are G.mayShareScreen and G.shareOffered (and G.mayFlipCamera,
  which now refuses while sharing). Then startScreenShare(), stopScreenShare()
  and updateShareBtn() are lifted out of app.js and run against a stand-in
  screen and camera.
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

test("sharing starts only in a video call, where the browser can, one change at a time", () => {
  for (const inCall of [true, false, "true"]) {
    for (const hasVideo of [true, false]) {
      for (const busy of [true, false]) {
        for (const supported of [true, false, undefined]) {
          assert.equal(G.mayShareScreen({ inCall, hasVideo, busy, supported }),
            inCall === true && hasVideo && !busy && supported === true,
            JSON.stringify({ inCall, hasVideo, busy, supported }));
        }
      }
    }
  }
  assert.equal(G.mayShareScreen(undefined), false);
});

test("the button is offered in a video call where the browser can share, and nowhere else", () => {
  const ok = { inCall: true, hasVideo: true, supported: true };
  assert.equal(G.shareOffered(ok), true);
  assert.equal(G.shareOffered({ ...ok, supported: false }), false, "an iPhone: no browser there can share");
  assert.equal(G.shareOffered({ ...ok, hasVideo: false }), false, "a voice call: no video to put the screen in");
  assert.equal(G.shareOffered({ ...ok, inCall: false }), false);
  assert.equal(G.shareOffered(undefined), false);
});

test("the camera cannot be flipped while a screen is shared — there is no camera in the call to flip", () => {
  assert.equal(G.mayFlipCamera({ inCall: true, hasVideo: true, busy: false, sharing: true }), false);
  assert.equal(G.mayFlipCamera({ inCall: true, hasVideo: true, busy: false, sharing: false }), true);
});

/* ══════════════════════════════════════════
   startScreenShare() / stopScreenShare(), actually run
══════════════════════════════════════════ */

const grab = (pattern, what) => {
  const m = app.match(pattern);
  assert.ok(m, `${what} not found in app.js`);
  return m[0];
};
const SOURCE = [
  grab(/^const SHARE_SUPPORTED = [^\n]*;$/m,                          "SHARE_SUPPORTED"),
  grab(/^const SCREEN_MAX = [^\n]*;$/m,                               "SCREEN_MAX"),
  grab(/^const SCREEN_PROFILES = [^\n]*;$/m,                          "SCREEN_PROFILES"),
  grab(/^const SCREEN_CAPTURE = [^\n]*;$/m,                           "SCREEN_CAPTURE"),
  grab(/^function screenProfile\([^)]*\)\s*\{[\s\S]*?^\}/m,           "screenProfile"),
  grab(/^function mixScreenSound\([^)]*\)\s*\{[\s\S]*?^\}/m,          "mixScreenSound"),
  grab(/^function screenScale\([^)]*\)\s*\{[\s\S]*?^\}/m,             "screenScale"),
  grab(/^function screenConstraints\([^)]*\)\s*\{[\s\S]*?^\}/m,       "screenConstraints"),
  grab(/^async function limitScreenSender\([^)]*\)\s*\{[\s\S]*?^\}/m,  "limitScreenSender"),
  grab(/^async function startScreenShare\(\)\s*\{[\s\S]*?^\}/m,        "startScreenShare"),
  grab(/^async function stopScreenShare\(\)\s*\{[\s\S]*?^\}/m,         "stopScreenShare"),
  grab(/^function updateShareBtn\(\)\s*\{[\s\S]*?^\}/m,                "updateShareBtn"),
  grab(/^function showCameraFacing\(\)\s*\{[\s\S]*?^\}/m,              "showCameraFacing")
].join("\n");

function classes(initial = []) {
  const set = new Set(initial);
  return { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c),
           toggle: (c, on) => (on ? set.add(c) : set.delete(c)) };
}

function call({ inCall = true, video = true, camOff = false, busy = false, supported = true,
                cancel = false, cameraRefuses = false, screenSize = [2560, 1600], refuseLimits = false,
                withSound = false, mixFails = false } = {}) {
  const log = { order: [], picker: [], asked: [], replaced: [], attached: [], watched: [], toasts: [], flipUpdates: 0,
                applied: [], params: [], mixed: [] };
  let gate = null;
  const track = (kind, name) => ({ kind, name, readyState: "live", enabled: true,
    stop() { this.readyState = "ended"; log.order.push(`stop ${name}`); },
    getSettings: () => (name === "screen" ? { width: screenSize[0], height: screenSize[1] } : {}),
    applyConstraints: async c => { log.applied.push([name, c]); } });
  class MediaStream {
    constructor(tracks = []) { this.tracks = [...tracks]; }
    getTracks() { return [...this.tracks]; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === "audio"); }
    getVideoTracks() { return this.tracks.filter(t => t.kind === "video"); }
  }
  const mic = track("audio", "mic");
  const cam = video ? track("video", "camera") : null;
  if (cam) cam.enabled = !camOff;
  const senders = [mic, cam].filter(Boolean).map(t => {
    let params = { transactionId: "t1", encodings: [{ active: true, scaleResolutionDownBy: 1 }] };
    return {
      track: t, replaceTrack(n) { log.order.push(`replace with ${n ? n.name : "nothing"}`); log.replaced.push(n); this.track = n; return Promise.resolve(); },
      getParameters: () => JSON.parse(JSON.stringify(params)),
      setParameters: async p => {
        if (refuseLimits) throw new Error("InvalidModificationError");
        params = JSON.parse(JSON.stringify(p));
        log.params.push(params.encodings[0]);
      },
      encoding: () => params.encodings[0]
    };
  });
  const mediaDevices = {
    getUserMedia: async constraints => {
      log.asked.push(constraints);
      log.order.push("open camera");
      if (cameraRefuses) throw new Error("NotReadableError");
      return new MediaStream([track("video", "camera again")]);
    }
  };
  if (supported) {
    mediaDevices.getDisplayMedia = async constraints => {
      log.picker.push(constraints);
      log.order.push("picker");
      if (gate) await gate;
      if (cancel) throw Object.assign(new Error("cancelled"), { name: "NotAllowedError" });
      return new MediaStream([track("video", "screen"), ...(withSound ? [track("audio", "screen sound")] : [])]);
    };
  }
  const shareBtn = { disabled: false, classList: classes(["hidden"]), icon: null, attributes: {},
    replaceChildren(i) { this.icon = i; }, setAttribute(k, v) { this.attributes[k] = v; } };
  const toggleCamBtn = { icon: null, replaceChildren(i) { this.icon = i; } };
  const env = {
    G, MediaStream, t: k => k,
    console: { error() {} },
    navigator: { mediaDevices },
    showToast: m => log.toasts.push(m),
    watchCallTrack: t => log.watched.push(t),
    attachCallTrack: async t => { log.attached.push(t); },
    updateLocalVideoAspect() {},
    updateFlipCamBtn: () => { log.flipUpdates++; },
    callVideo: () => ({ facingMode: "environment" }),
    tablerIcon: name => name,
    setTimeout: (f) => { log.order.push("retry later"); },
    shareBtn, toggleCamBtn,
    /* A stand-in Web Audio: what goes into the mix, and a mixed track out. */
    window: { AudioContext: class {
      constructor() { if (mixFails) throw new Error("NotAllowedError"); this.state = "running"; }
      createMediaStreamDestination() { return { stream: new MediaStream([track("audio", "mix")]) }; }      createMediaStreamSource(stream) {
        const name = stream.getTracks()[0].name;
        return { connect() { log.mixed.push(`in ${name}`); }, disconnect() { log.mixed.push(`out ${name}`); } };
      }
      resume() { return Promise.resolve(); }
      close() { log.mixed.push("closed"); return Promise.resolve(); }
    } },
    state: {
      inCall, isCamOff: camOff, restartingCallMedia: busy, cameraFacing: "user",
      callPc: { getSenders: () => senders },
      localStream: new MediaStream([mic, cam].filter(Boolean)),
      localVideo: { srcObject: null, classList: classes(), style: { removeProperty() {} }, play() { return Promise.resolve(); } }
    }
  };
  const names = Object.keys(env).filter(n => n !== "state");
  const api = new Function(...names, "state", `
    let { inCall, isCamOff, restartingCallMedia, cameraFacing, callPc, localStream, localVideo } = state;
    let sharingScreen = false, camOffBeforeShare = false, screenMix = null;
    ${SOURCE}
    return {
      startScreenShare, stopScreenShare, updateShareBtn,
      now: () => ({ inCall, isCamOff, restartingCallMedia, localStream, localVideo, sharingScreen, screenMix }),
      hangUp: () => { inCall = false; localStream = null; }
    };
  `)(...names.map(n => env[n]), env.state);
  return { ...api, log, mic, cam, senders, shareBtn, toggleCamBtn,
           hold: () => { let open; gate = new Promise(r => { open = r; }); return () => { gate = null; open(); }; } };
}

test("sharing: the picker, then the screen in the camera's sender, and only then the camera stopped", async () => {
  const c = call();
  await c.startScreenShare();
  assert.deepEqual(c.log.picker, [{ video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 60 } }, audio: true, systemAudio: "include" }],
    "no more than Full HD, nor 60 frames a second — the most either profile takes — and the picker offers the screen's sound too");
  assert.deepEqual(c.log.order, ["picker", "replace with screen", "stop camera"]);
  const screen = c.senders[1].track;
  assert.equal(screen.name, "screen", "the same sender: no new call");
  assert.equal(c.senders[0].track, c.mic, "the microphone is left alone");
  assert.equal(c.log.attached.length, 0);
  assert.equal(screen.contentHint, "detail", "text kept sharp");
  assert.equal(typeof screen.onended, "function", "the browser's own Stop sharing is listened for");
  assert.ok(!c.log.watched.includes(screen), "not a camera to restart if it ends — ending is the sharer stopping");
});

test("a shared screen is held to Full HD — asked of the picker, the track and the sender", async () => {
  /* Reported: a laptop's whole screen went out at full size, costly and
     laggy, worst on the phone receiving it. */
  const c = call({ screenSize: [2560, 1600] });
  await c.startScreenShare();
  assert.deepEqual(c.log.applied, [["screen", { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 30 } }]],
    "the track is asked again, where the picker did not hold to it");
  const encoding = c.senders[1].encoding();
  assert.equal(encoding.maxBitrate, 2500000);
  assert.equal(encoding.maxFramerate, 30);
  assert.ok(Math.abs(encoding.scaleResolutionDownBy - 1600 / 1080) < 1e-9,
    "2560×1600 scaled to 1728×1080: its shape kept, its height fitted");
  assert.equal(c.senders[0].encoding().maxBitrate, undefined, "the microphone is left alone");
});

test("the scale only ever shrinks a screen, to fit both ways", () => {
  const { screenScale } = new Function(`${SOURCE.split("\n").filter(l => /^const SCREEN_MAX/.test(l))[0]}\n${grab(/^function screenScale\([^)]*\)\s*\{[\s\S]*?^\}/m, "screenScale")}\nreturn { screenScale };`)();
  assert.equal(screenScale(3840, 2160), 2, "4K to Full HD");
  assert.equal(screenScale(1920, 1080), 1);
  assert.equal(screenScale(1280, 800), 1, "a small screen is never scaled up");
  assert.ok(Math.abs(screenScale(2560, 1440) - 4 / 3) < 1e-9, "wide: fitted by its width");
  assert.equal(screenScale(0, 0), 1, "a size not known yet is left alone");
  assert.equal(screenScale(undefined, 900), 1);
  assert.equal(screenScale(1920, 1080, { width: 1280, height: 720 }), 1.5, "Full HD to 720p, for a video");
  assert.equal(screenScale(1280, 720, { width: 1280, height: 720 }), 1);
});

test("a screen already within Full HD goes out at its own size", async () => {
  const c = call({ screenSize: [1366, 768] });
  await c.startScreenShare();
  assert.equal(c.senders[1].encoding().scaleResolutionDownBy, 1);
  assert.equal(c.senders[1].encoding().maxFramerate, 30, "30 frames a second, at its own size");
});

test("stopping lifts the limits, so the camera goes out at its own size again", async () => {
  const c = call();
  await c.startScreenShare();
  await c.stopScreenShare();
  const encoding = c.senders[1].encoding();
  assert.equal(encoding.maxBitrate, undefined);
  assert.equal(encoding.maxFramerate, undefined);
  assert.equal(encoding.scaleResolutionDownBy, 1);
});

test("the limits are lifted even when the camera will not come back", async () => {
  /* A later return to the page brings the camera back into this sender. */
  const c = call({ cameraRefuses: true });
  await c.startScreenShare();
  await c.stopScreenShare();
  assert.equal(c.senders[1].encoding().maxBitrate, undefined);
});

test("a browser that will not take limits still shares", async () => {
  const c = call({ refuseLimits: true });
  await c.startScreenShare();
  assert.equal(c.now().sharingScreen, true);
  assert.equal(c.senders[1].track.name, "screen");
});

/* ── Sharing with sound ── */

test("shared with its sound: the voice and the screen's sound go out mixed, in the voice's own sender", async () => {
  /* Reported: a video playing on the laptop sounded bad on the phone — only
     its picture was shared, and its sound reached the call off the laptop's
     speakers through a microphone made for speech. */
  const c = call({ withSound: true });
  await c.startScreenShare();
  assert.deepEqual(c.log.mixed, ["in mic", "in screen sound"], "both into the one mix");
  assert.equal(c.senders[0].track.name, "mix", "the voice's sender carries the mix: no new call");
  assert.equal(c.senders[0].track.contentHint, "music", "not squeezed as if it were only a voice");
  assert.deepEqual(c.now().localStream.getAudioTracks().map(t => t.name), ["mic"],
    "the microphone stays its own track, so muting mutes the voice and leaves the shared sound playing");
  assert.deepEqual(c.log.toasts, ["shareSoundTip"], "said once: the laptop's speakers still reach its microphone");
});

test("shared with its sound, it is taken for a video: 60 frames a second at 720p, sent for motion", async () => {
  /* Asked for: videos at 60 frames a second, one step down from Full HD. */
  const c = call({ withSound: true, screenSize: [2560, 1600] });
  await c.startScreenShare();
  assert.equal(c.senders[1].track.contentHint, "motion");
  assert.deepEqual(c.log.applied, [["screen", { width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 60 } }]],
    "the track asked for 720p at 60");
  const encoding = c.senders[1].encoding();
  assert.equal(encoding.maxFramerate, 60);
  assert.equal(encoding.maxBitrate, 4000000, "the same rate Full HD at 30 had: about as much per pixel");
  assert.ok(Math.abs(encoding.scaleResolutionDownBy - 1600 / 720) < 1e-9,
    "2560×1600 scaled to 1152×720: its shape kept, its height fitted");
});

test("a video shared from a screen already within 720p goes out at its own size, at 60", async () => {
  const c = call({ withSound: true, screenSize: [1280, 720] });
  await c.startScreenShare();
  assert.equal(c.senders[1].encoding().scaleResolutionDownBy, 1);
  assert.equal(c.senders[1].encoding().maxFramerate, 60);
});

test("shared without its sound, it is taken for a page: Full HD at 30 frames a second, sent for detail", async () => {
  const c = call();
  await c.startScreenShare();
  assert.equal(c.senders[1].track.contentHint, "detail");
  assert.equal(c.senders[1].encoding().maxFramerate, 30, "asked for: documents at 30, as smooth to scroll as a video at 30 was");
  assert.equal(c.senders[0].track, c.mic, "and the voice goes out alone, as ever");
  assert.deepEqual(c.log.toasts, []);
});

test("stopping: the voice alone again, in its own sender, and the screen's sound stopped", async () => {
  const c = call({ withSound: true });
  await c.startScreenShare();
  await c.stopScreenShare();
  assert.equal(c.senders[0].track, c.mic);
  assert.ok(c.log.mixed.includes("closed"), "the mix is taken apart");
  assert.equal(c.log.order.includes("stop screen sound"), true, "the shared sound stops with the picture");
  assert.equal(c.now().screenMix, null);
});

test("the sound cannot be mixed: the picture is still shared, and the voice goes out as before", async () => {
  const c = call({ withSound: true, mixFails: true });
  await c.startScreenShare();
  assert.equal(c.now().sharingScreen, true);
  assert.equal(c.senders[1].track.name, "screen");
  assert.equal(c.senders[0].track, c.mic);
  assert.equal(c.log.order.includes("stop screen sound"), true, "the unused sound is not left running");
});

test("a call ending while the sound is shared takes the mix apart too", () => {
  const stop = grab(/^function stopCallMedia\([^)]*\)\s*\{[\s\S]*?^\}/m, "stopCallMedia");
  assert.match(stop, /if \(screenMix\) \{ screenMix\.close\(\); screenMix = null; \}/);
});

test("while sharing, the self-view shows the screen unmirrored, and the button says so", async () => {
  const c = call();
  await c.startScreenShare();
  const { localStream, localVideo, sharingScreen } = c.now();
  assert.equal(sharingScreen, true);
  assert.deepEqual(localStream.getTracks().map(t => t.name), ["mic", "screen"]);
  assert.equal(localVideo.srcObject, localStream);
  assert.equal(localVideo.classList.contains("screen-share"), true, "unmirrored: what the other side sees, as they see it");
  assert.equal(c.shareBtn.classList.contains("sharing"), true);
  assert.equal(c.shareBtn.icon, "screen-share-off");
  assert.equal(c.shareBtn.attributes["aria-label"], "stopSharing");
  assert.equal(c.shareBtn.classList.contains("hidden"), false);
  assert.ok(c.log.flipUpdates > 0, "the flip is told — it has no camera to flip now");
});

test("sharing with the camera off: the screen goes out — sharing is choosing to be seen", async () => {
  const c = call({ camOff: true });
  await c.startScreenShare();
  assert.equal(c.now().isCamOff, false);
  assert.equal(c.toggleCamBtn.icon, "camera");
});

test("the picker closed without choosing: the call goes on exactly as it was", async () => {
  const c = call({ cancel: true });
  await c.startScreenShare();
  assert.deepEqual(c.log.order, ["picker"], "the camera is not touched");
  assert.equal(c.cam.readyState, "live");
  assert.equal(c.senders[1].track, c.cam);
  assert.equal(c.now().sharingScreen, false);
  assert.deepEqual(c.log.toasts, [], "choosing not to share is not an error");
  assert.equal(c.shareBtn.disabled, false);
  assert.equal(c.now().restartingCallMedia, false);
});

test("hung up while the picker was up: the screen is put straight back", async () => {
  const c = call();
  const release = c.hold();
  const sharing = c.startScreenShare();
  c.hangUp();
  release();
  await sharing;
  assert.deepEqual(c.log.order, ["picker", "stop screen"]);
  assert.equal(c.log.replaced.length, 0);
});

test("a voice call, a browser that cannot share, an ended call, or a change under way: no picker", async () => {
  for (const setup of [{ video: false }, { supported: false }, { inCall: false }, { busy: true }]) {
    const c = call(setup);
    await c.startScreenShare();
    assert.equal(c.log.picker.length, 0, JSON.stringify(setup));
  }
});

test("a second press while the picker is up does nothing", async () => {
  const c = call();
  const release = c.hold();
  const first = c.startScreenShare();
  await c.startScreenShare();
  release();
  await first;
  assert.equal(c.log.picker.length, 1);
});

test("stopping: the camera opens again, takes the screen's place, and only then the screen stops", async () => {
  const c = call();
  await c.startScreenShare();
  c.log.order.length = 0;
  await c.stopScreenShare();
  assert.deepEqual(c.log.asked, [{ audio: false, video: { facingMode: "environment" } }],
    "the camera as it was — facing the way it was last flipped");
  assert.deepEqual(c.log.order, ["open camera", "replace with camera again", "stop screen"]);
  const { localStream, localVideo, sharingScreen } = c.now();
  assert.equal(sharingScreen, false);
  assert.deepEqual(localStream.getTracks().map(t => t.name), ["mic", "camera again"]);
  assert.equal(localVideo.srcObject, localStream);
  assert.equal(localVideo.classList.contains("screen-share"), false);
  assert.ok(c.log.watched.some(t => t.name === "camera again"), "watched like every call camera");
  assert.equal(c.shareBtn.attributes["aria-label"], "shareScreen");
  assert.equal(c.shareBtn.icon, "screen-share");
});

test("the browser's own Stop sharing does the same", async () => {
  const c = call();
  await c.startScreenShare();
  const screen = c.senders[1].track;
  await screen.onended();
  assert.equal(c.now().sharingScreen, false);
  assert.equal(c.senders[1].track.name, "camera again");
});

test("a camera turned off before sharing comes back off; one that was on comes back on", async () => {
  const off = call({ camOff: true });
  await off.startScreenShare();
  await off.stopScreenShare();
  assert.equal(off.senders[1].track.name, "camera again");
  assert.equal(off.senders[1].track.enabled, false, "turned off was a choice, and sharing did not undo it");
  assert.equal(off.now().isCamOff, true);
  assert.equal(off.toggleCamBtn.icon, "camera-off");

  const on = call();
  await on.startScreenShare();
  await on.stopScreenShare();
  assert.equal(on.senders[1].track.enabled, true);
  assert.equal(on.toggleCamBtn.icon, "camera");
});

test("no camera to come back to: said once, the screen stops anyway, and it is left for a later return to retry", async () => {
  const c = call({ cameraRefuses: true });
  await c.startScreenShare();
  await c.stopScreenShare();
  assert.deepEqual(c.log.toasts, ["callMediaRestartFailed"]);
  const screen = c.senders[1].track;
  assert.equal(screen.name, "screen");
  assert.equal(screen.readyState, "ended", "the share has stopped, as asked");
  assert.equal(c.now().localStream.getVideoTracks()[0], screen,
    "left ended in the call, which is what restartEndedCallMedia looks for");
  assert.equal(c.now().restartingCallMedia, false);
});

/* ══════════════════════════════════════════
   That it is wired up, and stays out of the way of the rest
══════════════════════════════════════════ */

test("the button toggles; a call offers it once its devices are in; ending one resets it", () => {
  assert.match(app, /^shareBtn\.onclick = \(\) => \(sharingScreen \? stopScreenShare\(\) : startScreenShare\(\)\);$/m);
  const attach = grab(/^async function attachCallMedia\([^)]*\)\s*\{[\s\S]*?^\}/m, "attachCallMedia");
  assert.ok(attach.lastIndexOf("updateShareBtn()") > attach.lastIndexOf("attachCallTrack("));
  const stop = grab(/^function stopCallMedia\([^)]*\)\s*\{[\s\S]*?^\}/m, "stopCallMedia");
  assert.ok(stop.indexOf("sharingScreen = false;") > -1 && stop.indexOf("sharingScreen = false;") < stop.indexOf("updateShareBtn();"),
    "sharing is over before the button is redrawn");
});

test("nothing that opens the camera can put it back over a shared screen", () => {
  assert.match(grab(/^async function flipCamera\(\)\s*\{[\s\S]*?^\}/m, "flipCamera"), /sharing: sharingScreen/);
  assert.match(grab(/^async function restartLikeCallStart\(\)\s*\{[\s\S]*?^\}/m, "restartLikeCallStart"), /if \(sharingScreen\) return;/);
  assert.match(grab(/^async function followAudioDevice\(\)\s*\{[\s\S]*?^\}/m, "followAudioDevice"),
    /hasVideo: Boolean\(localStream\?\.getVideoTracks\(\)\.length\) && !sharingScreen/,
    "headphones moving move only the microphone while sharing");
});

test("a sharer in another window is not reported as gone away", () => {
  assert.match(app, /if \(dcReady\(\) && !\(away && sharingScreen\)\) dcSendCallSignal\(\{ type: away \? "call-away" : "call-back" \}\)/);
});

test("the shared screen is never mirrored on this screen", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /#localVideo\.screen-share\s*\{[^}]*transform:\s*none/);
});
