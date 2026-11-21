/*
  A picture held down after a bad line, helped back up.

  Reported: a shared screen went small while the internet was bad, and stayed
  small long after it was good again. On a line made slow on purpose (500 kb/s
  for 25 s, then free), Chrome took 28 s to send 720p again; testing the line
  and letting go of the steps down brought that to 2 s. G.lineRetry decides,
  DCS.heldVideo reads the call's figures, and retryLine() with its two moves is
  lifted out of app.js and run against stand-in senders and a stand-in clock.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const G   = require("../guards.js");
const DCS = require("../connstats.js");
const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");

/* ══════════════════════════════════════════
   The decision
══════════════════════════════════════════ */

const held = { held: true, roomKbps: 600, needKbps: 4500, heldFor: 6000, tests: 0, sinceTest: Infinity, sinceReset: Infinity };

test("held for a few seconds on a line with no room: the line is tested", () => {
  assert.equal(G.lineRetry(held), "test");
  assert.equal(G.lineRetry({ ...held, heldFor: 3000 }), "none", "a moment's dip is the browser's to ride out");
  assert.equal(G.lineRetry({ ...held, held: false }), "none");
});

test("tested again later and later while the line stays bad, never more seldom than each minute", () => {
  const gaps = [1, 2, 3, 4, 5, 9].map(tests => {
    let ms = 0;
    while (G.lineRetry({ ...held, tests, sinceTest: ms }) !== "test") ms += 1000;
    return ms;
  });
  assert.deepEqual(gaps, [10000, 20000, 40000, 60000, 60000, 60000]);
});

test("the guess climbing a quarter past the last test: the line may be back, and is tested at once", () => {
  /* On the test line the next test otherwise came by the clock, 18 s after
     the line was good again. */
  const after = { ...held, tests: 3, sinceTest: 4000, roomAtTest: 500 };
  assert.equal(G.lineRetry({ ...after, roomKbps: 560 }), "none", "a guess wobbling on a line still bad");
  assert.equal(G.lineRetry({ ...after, roomKbps: 625 }), "test");
  assert.equal(G.lineRetry({ ...after, roomKbps: 625, sinceTest: 2000 }), "none", "the last burst given time to land");
  assert.equal(G.lineRetry({ ...after, roomKbps: 625, roomAtTest: 0 }), "none", "no guess at the last test: by the clock alone");
  assert.equal(G.lineRetry({ ...after, roomKbps: null }), "none");
});

test("room for every picture's full rate: the steps down are let go of, not more than every 8 s", () => {
  const room = { ...held, roomKbps: 4000 };       // 4000 ≥ 80% of 4500
  assert.equal(G.lineRetry(room), "reset");
  assert.equal(G.lineRetry({ ...room, heldFor: 0 }), "reset", "no waiting once the room is there");
  assert.equal(G.lineRetry({ ...room, sinceReset: 5000 }), "none", "just let go of: given time to climb");
  assert.equal(G.lineRetry({ ...room, sinceReset: 8000 }), "reset");
  assert.equal(G.lineRetry({ ...room, sinceReset: 5000, tests: 3, sinceTest: 0 }), "none", "and with room, no testing");
});

test("a browser that gives no guess of the line: only tested, never let go of", () => {
  for (const roomKbps of [null, undefined, NaN]) assert.equal(G.lineRetry({ ...held, roomKbps }), "test");
  assert.equal(G.lineRetry({ ...held, roomKbps: 9999, needKbps: 0 }), "test", "nothing to measure the room against");
});

test("nonsense in: nothing done", () => {
  for (const o of [undefined, null, {}, { ...held, held: "yes" }, { ...held, heldFor: NaN }, { ...held, heldFor: -1 }]) {
    assert.equal(G.lineRetry(o), "none", JSON.stringify(o));
  }
});

/* ══════════════════════════════════════════
   What is read
══════════════════════════════════════════ */

function report(entries) {
  return new Map(entries.map(e => [e.id, e]));
}
const route = (availableOutgoingBitrate = 600_000) => [
  { id: "t", type: "transport", selectedCandidatePairId: "p" },
  { id: "p", type: "candidate-pair", state: "succeeded", nominated: true, availableOutgoingBitrate }
];
const picture = (id, track, reason) => [
  { id: `s-${id}`, type: "media-source", kind: "video", trackIdentifier: track },
  { id, type: "outbound-rtp", kind: "video", mediaSourceId: `s-${id}`, qualityLimitationReason: reason }
];

test("held is the browser's own word: limited by bandwidth, each by its track", () => {
  const r = DCS.heldVideo(report([...route(612_400), ...picture("o1", "screen", "bandwidth"), ...picture("o2", "cam", "none"),
    ...picture("o3", "other", "cpu"), { id: "a", type: "outbound-rtp", kind: "audio", qualityLimitationReason: "bandwidth" }]));
  assert.deepEqual(r, { held: ["screen"], roomKbps: 612 });
});

test("no guess of the line, or no figures at all", () => {
  assert.deepEqual(DCS.heldVideo(report([...route(null), ...picture("o1", "screen", "bandwidth")])), { held: ["screen"], roomKbps: null });
  assert.deepEqual(DCS.heldVideo(report(picture("o1", "screen", "bandwidth"))).roomKbps, null);
  assert.deepEqual(DCS.heldVideo(null), { held: [], roomKbps: null });
  assert.deepEqual(DCS.heldVideo(new Map()), { held: [], roomKbps: null });
  /* A picture whose source is not named can't be matched to a sender. */
  assert.deepEqual(DCS.heldVideo(report([{ id: "o", type: "outbound-rtp", kind: "video", qualityLimitationReason: "bandwidth" }])).held, []);
});

/* ══════════════════════════════════════════
   retryLine(), actually run
══════════════════════════════════════════ */

const grab = (pattern, what) => {
  const m = app.match(pattern);
  assert.ok(m, `${what} not found in app.js`);
  return m[0];
};
const SOURCE = [
  grab(/^const LINE_TEST_DIP = [^\n]*$/m,                          "LINE_TEST_DIP"),
  grab(/^const lineRetrying = [^\n]*$/m,                           "lineRetrying"),
  grab(/^function senderCeiling\([\s\S]*?^\}/m,                     "senderCeiling"),
  grab(/^async function retryLine\([\s\S]*?^\}/m,                   "retryLine"),
  grab(/^async function testLine\([\s\S]*?^\}/m,                    "testLine"),
  grab(/^async function letGoOfSteps\([\s\S]*?^\}/m,                "letGoOfSteps")
].join("\n");

/** A sender as the browser keeps one: getParameters hands out a copy, and
    setParameters takes it back. Every change is written down. */
function sender(trackId, { kind = "video", ceiling, preference } = {}) {
  let kept = { encodings: [ceiling ? { maxBitrate: ceiling } : {}] };
  if (preference) kept.degradationPreference = preference;
  const s = {
    track: trackId ? { id: trackId, kind } : null,
    sets: [],
    meanwhile: null,                          // something else changing it, between this page's two steps
    getParameters: () => JSON.parse(JSON.stringify(kept)),
    setParameters: async p => {
      kept = JSON.parse(JSON.stringify(p));
      s.sets.push({ maxBitrate: kept.encodings[0].maxBitrate, degradationPreference: kept.degradationPreference });
      if (s.meanwhile) { const f = s.meanwhile; s.meanwhile = null; f(kept); }
    },
    kept: () => kept
  };
  return s;
}

function call(senders) {
  const clock = { t: 0 };
  const api = new Function("G", "DCS", "Date", "callPc", `${SOURCE}\nreturn { retryLine, lineRetrying };`
  )(G, DCS, { now: () => clock.t }, { getSenders: () => senders });
  /** The call's figures read at this moment: these tracks held, the line guessed at this. */
  const read = async (at, heldTracks, kbps) => {
    clock.t = 1_000_000 + at;                 // a real clock is never at 0
    await api.retryLine(report([...route(kbps * 1000), ...heldTracks.flatMap((track, i) => picture(`o${i}`, track, "bandwidth"))]));
  };
  return { ...api, read };
}

test("a shared film held small on a bad line: its ceiling is nudged now and then, and left where it was", async () => {
  const screen = sender("screen", { ceiling: 4_000_000 });
  const camera = sender("cam", { ceiling: 500_000 });
  const voice  = sender("mic", { kind: "audio" });
  const c = call([screen, camera, voice]);
  for (const at of [0, 2000, 4000]) await c.read(at, ["screen"], 600);
  assert.deepEqual(screen.sets, [], "nothing in the first few seconds");
  await c.read(6000, ["screen"], 600);
  assert.deepEqual(screen.sets.map(s => s.maxBitrate), [3_800_000, 4_000_000], "a touch down and straight back: up is what tests the line");
  for (const at of [8000, 10000, 12000, 14000]) await c.read(at, ["screen"], 600);
  assert.equal(screen.sets.length, 2, "then left alone for 10 s");
  await c.read(16000, ["screen"], 600);
  assert.equal(screen.sets.length, 4, "and tested again");
  assert.equal(screen.kept().encodings[0].maxBitrate, 4_000_000);
  assert.deepEqual(camera.sets, [], "only the held picture is touched");
  assert.deepEqual(voice.sets, []);
});

test("the line coming back is tested as soon as the guess climbs, not when the clock says", async () => {
  const screen = sender("screen", { ceiling: 4_000_000 });
  const c = call([screen]);
  await c.read(0, ["screen"], 500);
  await c.read(6000, ["screen"], 500);
  assert.equal(c.lineRetrying.roomAtTest, 500, "the guess when it was tested");
  await c.read(8000, ["screen"], 540);
  assert.equal(screen.sets.length, 2);
  await c.read(10000, ["screen"], 640);           // past 625: a quarter up, 4 s on
  assert.equal(screen.sets.length, 4, "tested again at 4 s, not 10");
});

test("the line good again: every step down is let go of at once, and the browser's own choice comes back", async () => {
  const screen = sender("screen", { ceiling: 4_000_000 });
  const camera = sender("cam", { ceiling: 500_000, preference: "maintain-resolution" });
  const c = call([screen, camera]);
  await c.read(0, ["screen", "cam"], 3700);       // 3700 ≥ 80% of 4500
  assert.deepEqual(screen.sets.map(s => s.degradationPreference), ["balanced", undefined]);
  assert.equal("degradationPreference" in screen.kept(), false, "none set before, none after");
  assert.deepEqual(camera.sets.map(s => s.degradationPreference), ["balanced", "maintain-resolution"], "put back as it was");
  assert.equal(screen.kept().encodings[0].maxBitrate, 4_000_000, "the ceiling untouched");
  await c.read(4000, ["screen"], 4000);
  assert.equal(screen.sets.length, 2, "given time to climb before it is done again");
});

test("a way of stepping down set to balanced is changed the other way for the moment", async () => {
  const screen = sender("screen", { ceiling: 4_000_000, preference: "balanced" });
  await call([screen]).read(0, ["screen"], 4000);
  assert.deepEqual(screen.sets.map(s => s.degradationPreference), ["maintain-framerate", "balanced"]);
});

test("not held any more: the count starts over, and the next bad spell waits its few seconds again", async () => {
  const screen = sender("screen", { ceiling: 4_000_000 });
  const c = call([screen]);
  await c.read(0, ["screen"], 600);
  await c.read(6000, ["screen"], 600);
  assert.equal(c.lineRetrying.tests, 1);
  await c.read(8000, [], 600);
  assert.deepEqual([c.lineRetrying.since, c.lineRetrying.tests, c.lineRetrying.roomAtTest], [0, 0, 0]);
  await c.read(100000, ["screen"], 600);
  await c.read(103000, ["screen"], 600);
  assert.equal(screen.sets.length, 2, "3 s into the new spell: not yet");
  await c.read(105000, ["screen"], 600);
  assert.equal(screen.sets.length, 4);
});

test("pictures without a ceiling are the browser's alone: a camera in a call with nothing shared", async () => {
  const camera = sender("cam");
  const c = call([camera]);
  for (const at of [0, 6000, 20000]) await c.read(at, ["cam"], 600);
  await c.read(30000, ["cam"], 9000);
  assert.deepEqual(camera.sets, []);
});

test("the ceiling moved by something else between the two steps (sharing stopping): not put back over it", async () => {
  const screen = sender("screen", { ceiling: 4_000_000 });
  screen.meanwhile = kept => { delete kept.encodings[0].maxBitrate; };   // limits lifted for the camera
  const c = call([screen]);
  await c.read(0, ["screen"], 600);
  await c.read(6000, ["screen"], 600);
  assert.equal(screen.sets.length, 1, "only the first step");
  assert.equal(screen.kept().encodings[0].maxBitrate, undefined, "the lifting stands");
});

test("a browser that refuses: nothing breaks, and the next reading carries on", async () => {
  const screen = sender("screen", { ceiling: 4_000_000 });
  screen.setParameters = async () => { throw new Error("InvalidModificationError"); };
  const c = call([screen]);
  await c.read(0, ["screen"], 600);
  await assert.doesNotReject(c.read(6000, ["screen"], 600));
  assert.equal(c.lineRetrying.busy, false);
});

/* ══════════════════════════════════════════
   That it is wired up
══════════════════════════════════════════ */

test("every reading of the call's figures looks, and a new call starts the count over", () => {
  assert.match(grab(/^async function updateCallStats\(\)\s*\{[\s\S]*?^\}/m, "updateCallStats"), /retryLine\(report\);/);
  assert.match(grab(/^function watchCallStats\([^)]*\)\s*\{[\s\S]*?^\}/m, "watchCallStats"), /lineRetrying\.since = lineRetrying\.tests = lineRetrying\.roomAtTest = 0;/);
});
