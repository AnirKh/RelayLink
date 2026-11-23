/*
  Music from a tab in a voice call, between two real browsers.

  Asked for: while talking in a voice call, music played from a tab — found
  on YouTube or Spotify — heard well on both sides. The tab was shown big at
  first; then asked: not needed, a small card with a volume slider is enough.
  Two Chromium browsers open the page from a real server and one calls the
  other by voice. The browser's picker cannot be clicked in a test, so the
  caller's is stood in for: it hands back what a shared music tab would — a
  picture with a song's name on it, and a tone for its sound. Everything
  after the picker is the page's own. Then what a person would see and hear
  is checked:

  - the share button is there in a voice call, and no camera is opened;
  - the other side sees a small music card with a volume slider, not the
    tab, and no picture arrives; the sharer sees a card saying it shares;
  - its sound arrives in a channel of its own, asked for in stereo, and the
    voice still in its own;
  - the slider turns the music down there;
  - stopping takes the cards away again.

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
  await callee.waitFor(`!musicCard.classList.contains("hidden")`, "the music card at the callee");

  const seen = await callee.eval(`({
    voice: callOverlay.classList.contains("voice-only"),
    big: callOverlay.classList.contains("screen-big"),
    text: musicCard.querySelector(".music-theirs").offsetParent !== null,
    mine: musicCard.querySelector(".music-mine").offsetParent !== null,
    slider: getComputedStyle(musicVolumeRange).display !== "none",
    camera: localStream.getVideoTracks().length,
    stereo: (callPc.localDescription.sdp.split("m=audio")[2] || "").includes("stereo=1")
  })`);
  assert.equal(seen.voice, true, "still a voice call");
  assert.equal(seen.big, false, "not the tab big: a card is enough");
  assert.equal(seen.text, true, "saying music is playing");
  assert.equal(seen.mine, false);
  assert.equal(seen.slider, true, "with a volume slider");
  assert.equal(seen.camera, 0, "and no camera opened");
  assert.equal(seen.stereo, true, "its sound asked for in stereo");
  const sharer = await caller.eval(`({
    card: !musicCard.classList.contains("hidden"),
    mine: musicCard.querySelector(".music-mine").offsetParent !== null,
    slider: getComputedStyle(musicVolumeRange).display !== "none",
    big: callOverlay.classList.contains("screen-big")
  })`);
  assert.deepEqual(sharer, { card: true, mine: true, slider: false, big: false }, "the sharer: a card saying so");

  /* Its sound arrives in the screen's own channel, and the voice in its own;
     no picture at all. */
  const music = energyOf("screenSoundTransceiver(callPc).receiver");
  const voice = energyOf("callPc.getTransceivers().filter(t => t.receiver.track.kind === 'audio')[0].receiver");
  const picture = `(async () => {
    let bytes = 0;
    (await screenVideoTransceiver(callPc).receiver.getStats()).forEach(r => { if (r.type === "inbound-rtp") bytes = r.bytesReceived || 0; });
    return bytes;
  })()`;
  const before = { music: await callee.eval(music), voice: await callee.eval(voice), picture: await callee.eval(picture) };
  await new Promise(r => setTimeout(r, 3000));
  const after = { music: await callee.eval(music), voice: await callee.eval(voice), picture: await callee.eval(picture) };
  assert.ok(after.music.bytes > before.music.bytes, "the music's sound arriving");
  assert.ok(after.music.e > before.music.e, "and not silence");
  assert.ok(after.voice.bytes > before.voice.bytes, "the voice still arriving in its own");
  assert.equal(after.picture, 0, "no picture of the tab arriving at all");
  assert.equal(await callee.eval(`Boolean(screenSoundOut && screenSoundOut.srcObject && !screenSoundOut.paused)`), true,
    "played on its own, apart from the voice");

  /* The card's slider turns it down there. */
  await callee.eval(`musicVolumeRange.value = "30"; musicVolumeRange.dispatchEvent(new Event("input")); true`);
  assert.equal(await callee.eval(`screenSoundOut.volume`), 0.3, "the music at 30% here");

  /* Stopped: the voice call as it was. */
  await caller.eval(`shareBtn.click(); true`);
  await callee.waitFor(`musicCard.classList.contains("hidden")`, "the music card gone at the callee", 20_000);
  assert.equal(await caller.eval(`sharingScreen || !musicCard.classList.contains("hidden")`), false);

  await caller.eval(`endCallBtn.click(); true`);
  await callee.waitFor(`!inCall && callOverlay.classList.contains("hidden")`, "the call ended at the callee", 20_000);
});
