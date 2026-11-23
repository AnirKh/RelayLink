/*
  Music from a tab in a voice call, between two real browsers.

  Asked for: while talking in a voice call, music played from a tab — found
  on YouTube or Spotify — heard well on both sides, with the song showing.
  Two Chromium browsers open the page from a real server and one calls the
  other by voice. The browser's picker cannot be clicked in a test, so the
  caller's is stood in for: it hands back what a shared music tab would — a
  picture with a song's name on it, and a tone for its sound. Everything
  after the picker is the page's own. Then what a person would see and hear
  is checked:

  - the share button is there in a voice call, and no camera is opened;
  - the other side sees the tab big, in the voice call, with who it is small
    in the corner;
  - its sound arrives in a channel of its own, asked for in stereo, and the
    voice still in its own;
  - stopping takes it away again.

  Skipped where there is no Chromium or Chrome (see browser.js).
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const { startServer, waitForServer, stopServer } = require("./serve.js");
const { findBrowser, openBrowser } = require("./browser.js");

const PORT    = 3990 + Math.floor(Math.random() * 20);
const ORIGIN  = `http://127.0.0.1:${PORT}`;
const BROWSER = findBrowser();

/* Runs in each page before its own scripts: point it at this server, and
   stand in for the picker with a music tab — a moving picture with a song's
   name on it, and a 660 Hz tone. */
const SETUP = `
  window.DIRECT_CONNECTION_SERVER_URL = location.origin;
  navigator.mediaDevices.getDisplayMedia = async () => {
    window.__pickerAsked = (window.__pickerAsked || 0) + 1;
    const canvas = document.createElement("canvas");
    canvas.width = 1280; canvas.height = 720;
    const g = canvas.getContext("2d");
    let f = 0;
    const draw = () => {
      f++;
      g.fillStyle = "#1db954"; g.fillRect(0, 0, 1280, 720);
      g.fillStyle = "#000"; g.font = "64px sans-serif";
      g.fillText("Now playing: a song", 80 + (f % 120), 360);
    };
    draw(); setInterval(draw, 33);
    const picture = canvas.captureStream(30).getVideoTracks()[0];
    const ctx = new AudioContext();
    const tone = ctx.createOscillator();
    tone.frequency.value = 660;
    const out = ctx.createMediaStreamDestination();
    tone.connect(out); tone.start();
    return new MediaStream([picture, out.stream.getAudioTracks()[0]]);
  };
`;

/** Sound arriving on a receiver: its energy so far (grows while sound comes). */
const energyOf = receiver => `(async () => {
  let e = 0, bytes = 0;
  (await ${receiver}.getStats()).forEach(r => { if (r.type === "inbound-rtp") { e = r.totalAudioEnergy || 0; bytes = r.bytesReceived || 0; } });
  return { e, bytes };
})()`;

test("music from a tab in a voice call, between two real browsers", { skip: BROWSER ? false : "no Chromium or Chrome here", timeout: 240_000 }, async t => {
  const server = startServer({ PORT: String(PORT), ALLOWED_ORIGINS: ORIGIN });
  let caller = null, callee = null;
  t.after(async () => {
    await Promise.all([caller?.close(), callee?.close()]);
    await stopServer(server);
  });
  await waitForServer(server, async () => (await fetch(`${ORIGIN}/api/ping`)).ok);

  [caller, callee] = await Promise.all([openBrowser(BROWSER, SETUP), openBrowser(BROWSER, SETUP)]);
  await Promise.all([caller.goto(`${ORIGIN}/`), callee.goto(`${ORIGIN}/`)]);
  const lobbyReady = `typeof ws !== "undefined" && ws && ws.readyState === 1 && document.body.style.visibility !== "hidden"`;
  await Promise.all([caller.waitFor(lobbyReady, "the caller's lobby"), callee.waitFor(lobbyReady, "the callee's lobby")]);

  const room = `musictest${Date.now() % 100000}`;
  await caller.eval(`showLobbyTab("create"); sessionIdInput.value = ${JSON.stringify(room)}; createOpenBtn.click(); true`);
  await callee.waitFor(`[...document.querySelectorAll(".session-item")].some(i => i.textContent.includes(${JSON.stringify(room)}))`, "the room in the callee's list");
  await callee.eval(`[...document.querySelectorAll(".session-item")].find(i => i.textContent.includes(${JSON.stringify(room)})).querySelector(".join-btn").click(); true`);
  const chatUp = `e2eReady === true && isChatLinkUp()`;
  await Promise.all([caller.waitFor(chatUp, "the caller's encrypted chat"), callee.waitFor(chatUp, "the callee's encrypted chat")]);

  /* A voice call. */
  await caller.eval(`voiceCallBtn.click(); true`);
  await callee.waitFor(`!callRequestModal.classList.contains("hidden")`, "the call ringing at the callee");
  await callee.eval(`callAcceptBtn.click(); true`);
  const up = `inCall && callPc?.connectionState === "connected" && callOverlay.classList.contains("voice-only")`;
  await Promise.all([caller.waitFor(up, "the caller's voice call connected"), callee.waitFor(up, "the callee's voice call connected")]);
  /* Both sides have agreed the screen's channels: the answer is in. */
  await caller.waitFor(`screenVideoSender(callPc) && screenSoundSender(callPc)`, "the screen's channels agreed in a voice call");

  assert.equal(await caller.eval(`shareBtn.classList.contains("hidden")`), false, "the share button, in a voice call");
  for (const page of [caller, callee]) {
    assert.equal(await page.eval(`localStream.getVideoTracks().length`), 0, "no camera opened by a voice call");
  }

  /* The music tab shared. */
  await caller.eval(`shareBtn.click(); true`);
  await caller.waitFor(`sharingScreen === true`, "the caller sharing");
  assert.equal(await caller.eval(`window.__pickerAsked`), 1, "the picker asked, once");
  await callee.waitFor(`callOverlay.classList.contains("screen-big") && screenVideo.videoWidth > 0`, "the tab big at the callee");
  /* A share starts small and is brought up to its full size (see "A picture
     held down after a bad line" in app.js): the song's name sharp. */
  const sharedAt = Date.now();
  await callee.waitFor(`screenVideo.videoWidth >= 1280`, "the tab at its full size, 1280×720, at the callee", 30_000);
  t.diagnostic(`full size ${((Date.now() - sharedAt) / 1000).toFixed(1)} s after it first showed`);

  const seen = await callee.eval(`({
    voice: callOverlay.classList.contains("voice-only"),
    size: [screenVideo.videoWidth, screenVideo.videoHeight],
    shown: getComputedStyle(screenVideo).display,
    corner: getComputedStyle(document.querySelector(".voice-only-avatar")).transform,
    top: parseFloat(getComputedStyle(document.querySelector(".voice-only-avatar")).top),
    camera: localStream.getVideoTracks().length,
    stereo: (callPc.localDescription.sdp.split("m=audio")[2] || "").includes("stereo=1")
  })`);
  assert.equal(seen.voice, true, "still a voice call");
  assert.equal(seen.shown, "block");
  assert.deepEqual(seen.size, [1280, 720], "the song's tab at its full size");
  assert.equal(seen.corner, "none", "who it is, out of the middle of the screen");
  assert.ok(seen.top > 40 && seen.top < 120, `in the top corner — top ${seen.top}px`);
  assert.equal(seen.camera, 0, "and no camera opened to see it");
  assert.equal(seen.stereo, true, "its sound asked for in stereo");
  assert.equal(await caller.eval(`callOverlay.classList.contains("screen-big") && screenVideo.videoWidth > 0`), true,
    "the sharer sees it big too");

  /* Its sound arrives in the screen's own channel, and the voice in its own. */
  const music = energyOf("screenSoundTransceiver(callPc).receiver");
  const voice = energyOf("callPc.getTransceivers().filter(t => t.receiver.track.kind === 'audio')[0].receiver");
  const before = { music: await callee.eval(music), voice: await callee.eval(voice) };
  await new Promise(r => setTimeout(r, 3000));
  const after = { music: await callee.eval(music), voice: await callee.eval(voice) };
  assert.ok(after.music.bytes > before.music.bytes, "the music's sound arriving");
  assert.ok(after.music.e > before.music.e, "and not silence");
  assert.ok(after.voice.bytes > before.voice.bytes, "the voice still arriving in its own");
  assert.equal(await callee.eval(`Boolean(screenSoundOut && screenSoundOut.srcObject && !screenSoundOut.paused)`), true,
    "played on its own, apart from the voice");

  /* Stopped: the voice call as it was. */
  await caller.eval(`shareBtn.click(); true`);
  await callee.waitFor(`!callOverlay.classList.contains("screen-big")`, "the tab gone at the callee", 20_000);
  assert.equal(await callee.eval(`getComputedStyle(document.querySelector(".voice-only-avatar")).transform !== "none"`), true,
    "who it is back in the middle");
  assert.equal(await caller.eval(`sharingScreen || callOverlay.classList.contains("screen-big")`), false);

  await caller.eval(`endCallBtn.click(); true`);
  await callee.waitFor(`!inCall && callOverlay.classList.contains("hidden")`, "the call ended at the callee", 20_000);
});
