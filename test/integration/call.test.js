/*
  A video call between two real browsers, start to finish.

  Two Chromium browsers with fake cameras open the page from a real server,
  one makes an open room, the other joins it, and one calls the other. Then
  what a person would see is checked, not what the code says:

  - the other person's picture appears, on both sides;
  - the player is not restarted more than the call needs — each fresh stream
    handed to it restarts it, and one too many was a black flash and flicker
    at the start of every call on Android — and once the picture has
    appeared it never goes black again;
  - "Connected" is not said over a picture still black;
  - the call's figures say what video is arriving (↓), with its size;
  - every call video has a poster, so the app's Android view draws no grey
    "play" picture of its own before the first frame.

  Skipped where there is no Chromium or Chrome (see browser.js).
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const { startServer, waitForServer, stopServer } = require("./serve.js");
const { findBrowser, openBrowser } = require("./browser.js");

const PORT    = 3970 + Math.floor(Math.random() * 20);
const ORIGIN  = `http://127.0.0.1:${PORT}`;
const BROWSER = findBrowser();

/* Runs in each page before its own scripts: point it at this server, and
   watch the other person's picture from the outside. */
const SETUP = `
  window.DIRECT_CONNECTION_SERVER_URL = location.origin;
  const rec = window.__callRec = { sets: [], firstFrame: 0, blanks: 0, earlyConnected: 0 };
  const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject");
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
    configurable: true,
    get() { return d.get.call(this); },
    set(v) { rec.sets.push({ id: this.id, at: performance.now(), stream: Boolean(v) }); d.set.call(this, v); }
  });
  setInterval(() => {
    const v = document.getElementById("remoteVideo");
    const overlay = document.getElementById("callOverlay");
    const label = document.getElementById("callStatusLabel");
    if (!v || !overlay || overlay.classList.contains("hidden") || overlay.classList.contains("voice-only")) return;
    if (v.videoWidth > 0 && !rec.firstFrame) rec.firstFrame = performance.now();
    if (rec.firstFrame && v.videoWidth === 0) rec.blanks++;
    if (!v.videoWidth && typeof t === "function" && label.textContent === t("callConnected")) rec.earlyConnected++;
  }, 30);
`;

test("a video call between two real browsers", { skip: BROWSER ? false : "no Chromium or Chrome here", timeout: 240_000 }, async t => {
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

  /* The caller makes an open room; the callee joins it from the list. */
  const room = `calltest${Date.now() % 100000}`;
  await caller.eval(`showLobbyTab("create"); sessionIdInput.value = ${JSON.stringify(room)}; createOpenBtn.click(); true`);
  await callee.waitFor(`[...document.querySelectorAll(".session-item")].some(i => i.textContent.includes(${JSON.stringify(room)}))`, "the room in the callee's list");
  await callee.eval(`[...document.querySelectorAll(".session-item")].find(i => i.textContent.includes(${JSON.stringify(room)})).querySelector(".join-btn").click(); true`);

  const chatUp = `e2eReady === true && isChatLinkUp()`;
  await Promise.all([caller.waitFor(chatUp, "the caller's encrypted chat"), callee.waitFor(chatUp, "the callee's encrypted chat")]);

  /* The call. */
  await caller.eval(`videoCallBtn.click(); true`);
  await callee.waitFor(`!callRequestModal.classList.contains("hidden")`, "the call ringing at the callee");
  await callee.eval(`callAcceptBtn.click(); true`);

  const seesThem = `remoteVideo.videoWidth > 0`;
  await Promise.all([caller.waitFor(seesThem, "the callee's picture at the caller"),
                     callee.waitFor(seesThem, "the caller's picture at the callee")]);

  /* Let it run: the figures come every two seconds, and a late restart of the
     picture would show here. */
  await new Promise(r => setTimeout(r, 7000));

  for (const [who, page] of [["caller", caller], ["callee", callee]]) {
    const r = await page.eval(`({
      rec: window.__callRec,
      stats: callStats.textContent,
      none: t("callVideoNone"),
      posters: ["screenVideo", "remoteVideo", "localVideo"].map(id => document.getElementById(id).getAttribute("poster") || ""),
      voice: { levelled: voiceLeveller !== null, playerMuted: remoteVideo.muted, os: MY_DEVICE.os }
    })`);
    /* Each stream handed over restarts the player. One per track that
       arrives (voice, camera) is the most a call needs; a third was the old
       hand-over again on the first frames — the flash and flicker. */
    const handed = r.rec.sets.filter(s => s.id === "remoteVideo" && s.stream);
    assert.ok(handed.length <= 2, `${who}: the picture was handed ${handed.length} streams — each one restarts it (black flash, flicker)`);
    const lateSets = r.rec.sets.filter(s => s.id === "remoteVideo" && s.at > r.rec.firstFrame);
    assert.equal(lateSets.length, 0, `${who}: the picture was handed a new stream after it was showing — that restarts it (black flash)`);
    assert.equal(r.rec.blanks, 0, `${who}: the other person's picture went black after it had appeared`);
    assert.equal(r.rec.earlyConnected, 0, `${who}: "Connected" was shown over a black picture`);
    const down = r.stats.split("\n").find(l => l.startsWith("↓")) || "";
    assert.ok(down && !down.includes(r.none) && /\d+×\d+/.test(down), `${who}: the incoming video's figures are missing — got ${JSON.stringify(r.stats)}`);
    for (const p of r.posters) assert.ok(p.startsWith("data:image/"), `${who}: a call video has no poster — Android draws a grey "play" picture`);
    /* Reported: on a computer the voice sounded robotic and crackled. There it
       plays as it arrives, from the browser's own player — see G.mayLevelVoice. */
    assert.deepEqual(r.voice, { levelled: false, playerMuted: false, os: r.voice.os }, `${who} (${r.voice.os}): the voice as it arrives`);
  }

  /* Hung up: both sides back out of the call. */
  await caller.eval(`endCallBtn.click(); true`);
  await callee.waitFor(`!inCall && callOverlay.classList.contains("hidden")`, "the call ended at the callee", 20_000);
});
