/*
  Upright pictures only: no video-orientation extension in a call.

  Reported: a laptop in Edge heard an iPhone but never saw it, while the
  call's own figures showed the phone's video arriving and decoding — and
  with the phone turned sideways, it appeared. An iPhone held upright sends
  its picture sideways with an instruction to turn it, and Edge on that laptop
  drew such pictures black.

  withoutRotationExtension() and setCallLocalDescription() are lifted out of
  app.js and run on real-shaped descriptions.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");
const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const grab = (pattern, what) => {
  const m = app.match(pattern);
  assert.ok(m, `${what} not found in app.js`);
  return m[0];
};
const SOURCE = [
  grab(/^function withoutRotationExtension\([^)]*\)\s*\{[\s\S]*?^\}/m,       "withoutRotationExtension"),
  grab(/^const SCREEN_SOUND_OPUS = [^\n]*;$/m,                              "SCREEN_SOUND_OPUS"),
  grab(/^function withStereoScreenSound\([^)]*\)\s*\{[\s\S]*?^\}/m,          "withStereoScreenSound"),
  grab(/^async function setCallLocalDescription\([^)]*\)\s*\{[\s\S]*?^\}/m,  "setCallLocalDescription")
].join("\n");

function lifted(callPc = null) {
  return new Function("callPc", `${SOURCE}\nreturn { withoutRotationExtension, withStereoScreenSound, setCallLocalDescription };`)(callPc);
}

/* An offer as Chrome writes one, cut down: audio and video, with the
   extensions around the one that matters. */
const OFFER = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
  "a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
  "m=video 9 UDP/TLS/RTP/SAVPF 96 102",
  "a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
  "a=extmap:13 urn:3gpp:video-orientation",
  "a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
  "a=rtpmap:102 H264/90000",
  ""
].join("\r\n");

test("the turn-it instruction is taken out, and nothing else", () => {
  const { withoutRotationExtension } = lifted();
  const out = withoutRotationExtension({ type: "offer", sdp: OFFER });
  assert.equal(out.type, "offer");
  assert.ok(!/video-orientation/.test(out.sdp));
  assert.equal(out.sdp, OFFER.replace("a=extmap:13 urn:3gpp:video-orientation\r\n", ""), "every other line exactly as it was");
});

test("with a direction on it, or with plain newlines, it goes too", () => {
  const { withoutRotationExtension } = lifted();
  assert.ok(!/video-orientation/.test(withoutRotationExtension({ type: "answer", sdp: "a=extmap:4/sendrecv urn:3gpp:video-orientation\r\na=x\r\n" }).sdp));
  assert.equal(withoutRotationExtension({ type: "offer", sdp: "a=y\na=extmap:4 urn:3gpp:video-orientation\na=x\n" }).sdp, "a=y\na=x\n");
});

test("a description without it is left as it is, and taking it out twice changes nothing", () => {
  const { withoutRotationExtension } = lifted();
  const once = withoutRotationExtension({ type: "offer", sdp: OFFER });
  assert.equal(withoutRotationExtension(once).sdp, once.sdp);
  const voice = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
  assert.equal(withoutRotationExtension({ type: "offer", sdp: voice }).sdp, voice);
});

test("the call is given the upright description", async () => {
  const set = [];
  const { setCallLocalDescription } = lifted({ setLocalDescription: async d => { set.push(d); } });
  await setCallLocalDescription({ type: "offer", sdp: OFFER });
  assert.equal(set.length, 1);
  assert.ok(!/video-orientation/.test(set[0].sdp));
});

test("a browser that will not take the changed description is given the original — the call goes ahead", async () => {
  const set = [];
  const original = { type: "answer", sdp: OFFER };
  const { setCallLocalDescription } = lifted({ setLocalDescription: async d => {
    if (!/video-orientation/.test(d.sdp)) throw new Error("InvalidModificationError");
    set.push(d);
  } });
  await setCallLocalDescription(original);
  assert.deepEqual(set, [original]);
});

test("nothing to take out: the description is set exactly as the browser wrote it", async () => {
  const set = [];
  const desc = { type: "offer", sdp: "v=0\r\n" };
  const { setCallLocalDescription } = lifted({ setLocalDescription: async d => { set.push(d); } });
  await setCallLocalDescription(desc);
  assert.equal(set[0], desc, "the very same object, untouched");
});

test("both the offer and the answer go through it", () => {
  for (const name of ["initiateCallOffer", "handleIncomingCallOffer"]) {
    const body = grab(new RegExp(`^async function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?^\\}`, "m"), name);
    assert.match(body, /await setCallLocalDescription\((offer|answer)\);/, name);
    assert.ok(!/callPc\.setLocalDescription\(/.test(body), `${name} sets a description that skips it`);
  }
});

test("with the figures showing, the away note sits under them, not on top", () => {
  /* Lower than it was: the figures have a third line now, for the sound. */
  assert.match(css, /\.call-stats:not\(:empty\) ~ \.call-pause-note\s*\{\s*top:\s*calc\(122px \+ var\(--safe-top\)\)/);
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.ok(html.indexOf('id="callStats"') < html.indexOf('id="callPauseNote"'), "the ~ only reaches a note that comes after the figures");
});

/* ── The film's sound in stereo ── */

/* A video call's offer as Chrome writes one, cut down: the voice, the camera,
   the screen's sound and the screen's picture. */
const CALL = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63",
  "a=mid:0",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=rtpmap:63 red/48000/2",
  "m=video 9 UDP/TLS/RTP/SAVPF 102",
  "a=mid:1",
  "a=rtpmap:102 H264/90000",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63",
  "a=mid:2",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=rtpmap:63 red/48000/2",
  "m=video 9 UDP/TLS/RTP/SAVPF 102",
  "a=mid:3",
  "a=rtpmap:102 H264/90000",
  ""
].join("\r\n");

test("the screen sound's channel asks for stereo, up to 128 kb/s; the voice's is left as it was", () => {
  const { withStereoScreenSound } = lifted();
  const out = withStereoScreenSound({ type: "offer", sdp: CALL });
  assert.equal(out.type, "offer");
  const [, voice, , screen] = out.sdp.split(/(?=^m=)/m);
  assert.match(voice, /^a=fmtp:111 minptime=10;useinbandfec=1\r$/m, "the voice: one channel, as made for it");
  assert.match(screen, /^a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000\r$/m);
  assert.equal(out.sdp.replace(";stereo=1;sprop-stereo=1;maxaveragebitrate=128000", ""), CALL, "nothing else changed");
});

test("asked once only, however often it is written, and a setting already there is replaced, not doubled", () => {
  const { withStereoScreenSound } = lifted();
  const once = withStereoScreenSound({ type: "offer", sdp: CALL });
  assert.equal(withStereoScreenSound(once).sdp, once.sdp);
  const asked = CALL.replace("a=mid:2\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1",
                             "a=mid:2\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 stereo=0;minptime=10");
  const fixed = withStereoScreenSound({ type: "answer", sdp: asked }).sdp.split(/(?=^m=)/m)[3];
  assert.match(fixed, /^a=fmtp:111 stereo=1;minptime=10;sprop-stereo=1;maxaveragebitrate=128000\r$/m);
});

test("no settings line for it: one is added under the format's own", () => {
  const { withStereoScreenSound } = lifted();
  const bare = CALL.replace("a=mid:2\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n", "a=mid:2\r\na=rtpmap:111 opus/48000/2\r\n");
  const screen = withStereoScreenSound({ type: "offer", sdp: bare }).sdp.split(/(?=^m=)/m)[3];
  assert.match(screen, /^a=rtpmap:111 opus\/48000\/2\r\na=fmtp:111 stereo=1;sprop-stereo=1;maxaveragebitrate=128000\r$/m);
});

test("a call with one sound channel — a voice call, or an older page's — is left exactly as it was", () => {
  const { withStereoScreenSound } = lifted();
  const voiceCall = CALL.split(/(?=^m=)/m).slice(0, 2).join("");
  assert.equal(withStereoScreenSound({ type: "offer", sdp: voiceCall }).sdp, voiceCall);
  assert.equal(withStereoScreenSound({ type: "offer", sdp: OFFER }).sdp, OFFER);
});

test("the call is given its description upright and in stereo — and a browser that will not take the stereo, upright", async () => {
  const set = [];
  const withTurn = CALL.replace("a=mid:1\r\n", "a=mid:1\r\na=extmap:13 urn:3gpp:video-orientation\r\n");
  const { setCallLocalDescription } = lifted({ setLocalDescription: async d => { set.push(d); } });
  await setCallLocalDescription({ type: "offer", sdp: withTurn });
  assert.equal(set.length, 1);
  assert.ok(!/video-orientation/.test(set[0].sdp) && /sprop-stereo=1/.test(set[0].sdp));

  const taken = [];
  const strict = lifted({ setLocalDescription: async d => { if (/stereo=1/.test(d.sdp)) throw new Error("InvalidModificationError"); taken.push(d); } });
  await strict.setCallLocalDescription({ type: "offer", sdp: withTurn });
  assert.equal(taken.length, 1);
  assert.ok(!/video-orientation/.test(taken[0].sdp), "still upright");
  assert.ok(!/stereo=1/.test(taken[0].sdp), "the film in one channel, as before");
});
