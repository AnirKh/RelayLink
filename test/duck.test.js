/*
  The shared screen's sound dipping while the sharer talks.

  The rule (duckStep in duck.js) is fed made-up microphone levels slice by
  slice, as the audio thread would: talking in syllables, a click, a steady
  background, a microphone muted. Then duck.js is run as the browser runs it —
  an AudioWorklet module — against stand-in sound, and mixScreenSound() is
  lifted out of app.js to check what goes where in the mix.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");
const vm     = require("node:vm");

const D   = require("../duck.js");
const ROOT = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8").replace(/\r\n/g, "\n");

const SLICE = 128 / 48000 * 1000;           // one render quantum at 48 kHz, in ms

/** Feeds `ms` of microphone at `db`, calling `each(state, t)` after every slice. */
function feed(state, db, ms, each = () => {}) {
  let s = state;
  for (let t = SLICE; t <= ms + 1e-9; t += SLICE) { s = D.duckStep(s, db, SLICE); each(s, t); }
  return s;
}

/** Talking: syllables at `db` with short gaps at `gapDb`, for about `ms`. */
function talk(state, ms, { db = -25, gapDb = -65, on = 150, off = 80 } = {}, each) {
  let s = state, t = 0;
  while (t < ms) {
    s = feed(s, db, on, (x, u) => each && each(x, t + u)); t += on;
    s = feed(s, gapDb, off, (x, u) => each && each(x, t + u)); t += off;
  }
  return s;
}

/* ══════════════════════════════════════════
   The rule
══════════════════════════════════════════ */

test("silence leaves the shared sound as it came", () => {
  feed(D.duckInit(), -Infinity, 5000, s => assert.equal(s.gain, 1));
  feed(D.duckInit(), -70, 5000, s => assert.equal(s.gain, 1));
});

test("talking turns the shared sound down quickly, and keeps it down between words", () => {
  let s = feed(D.duckInit(), -70, 1000);    // a quiet room first
  assert.equal(s.gain, 1);
  const seen = [];
  s = talk(s, 2000, {}, (x, t) => seen.push([t, x.gain]));
  const at = ms => seen.find(([t]) => t >= ms)[1];
  assert.ok(at(100) < 0.75, `already dipping at 0.1 s: ${at(100)}`);
  assert.ok(at(250) <= 0.3, `well down by 0.25 s: ${at(250)}`);
  for (const [t, g] of seen) if (t >= 250) assert.ok(g <= 0.3, `down through the gaps between words, at ${t.toFixed(0)} ms: ${g}`);
  assert.ok(Math.abs(s.gain - D.DUCK.low) < 0.01);
});

test("already talking when sharing starts: it dips from the first pause between words", () => {
  const seen = [];
  const s = talk(D.duckInit(), 2000, {}, (x, t) => seen.push([t, x.gain]));
  assert.ok(seen.find(([t]) => t >= 600)[1] <= 0.3, "down once a gap has shown how quiet the room is");
  assert.ok(s.gain <= 0.3);
});

test("it comes back after a moment's quiet, gently", () => {
  let s = talk(feed(D.duckInit(), -70, 500), 1500);
  const seen = [];
  s = feed(s, -70, 3000, (x, t) => seen.push([t, x.gain]));
  const at = ms => seen.find(([t]) => t >= ms)[1];
  assert.ok(at(800) <= 0.3, "a pause is not the end of talking");
  assert.ok(at(1500) > 0.3 && at(1500) < 0.9, `on its way back, not jumped: ${at(1500)}`);
  assert.ok(at(2300) > 0.95, `back up: ${at(2300)}`);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i][1] >= seen[i - 1][1] - 1e-12, "only ever rising once quiet");
});

test("it fades at an even pace in decibels — no jump at the start of a fade", () => {
  /* Eased in plain volume, most of a fade happened in its first moment. Now
     every 0.1 s of a fade moves about as many decibels as the next. */
  let s = talk(feed(D.duckInit(), -70, 500), 1500);
  const dbs = [];
  feed(s, -70, 3000, x => dbs.push(x.gainDb));
  const rising = dbs.map((v, i) => (i ? v - dbs[i - 1] : 0)).filter(d => d > 1e-9);
  assert.ok(rising.length > 100, "a fade, not a step");
  const per = SLICE / 1000 * D.DUCK.upDbPerSec;
  for (const d of rising.slice(0, -1)) assert.ok(Math.abs(d - per) < 1e-9, `the same each slice: ${d} vs ${per}`);
  const down = [];
  s = feed(D.duckInit(), -70, 500);
  talk(s, 600, {}, x => down.push(x.gainDb));
  const falling = down.map((v, i) => (i ? down[i - 1] - v : 0)).filter(d => d > 1e-9);
  const step = SLICE / 1000 * D.DUCK.downDbPerSec;
  for (const d of falling.slice(0, -1)) assert.ok(Math.abs(d - step) < 1e-9, `down evenly: ${d} vs ${step}`);
  const fadeMs = (falling.length * SLICE);
  assert.ok(fadeMs > 100 && fadeMs < 220, `all the way down in about 0.15 s: ${fadeMs.toFixed(0)} ms`);
});

test("a click or a tap on the desk is not talking", () => {
  for (const db of [-20, -10, 0]) {
    for (const ms of [10, 20, 30]) {
      let s = feed(D.duckInit(), -70, 500);
      s = feed(s, db, ms);
      s = feed(s, -70, 1000, x => assert.ok(x.gain > 0.99, `${ms} ms at ${db} dB dipped to ${x.gain}`));
    }
  }
});

test("a steady background is not talking — and a voice over it still is", () => {
  /* Music leaking off the speakers from the start: never taken for a voice. */
  feed(D.duckInit(), -35, 5000, s => assert.equal(s.gain, 1));

  /* Music starting partway: it may look like talking at first, but the line
     rises after it, and the sound comes back. */
  let s = feed(D.duckInit(), -70, 1000);
  const seen = [];
  s = feed(s, -35, 6000, (x, t) => seen.push([t, x.gain]));
  assert.ok(seen.find(([t]) => t >= 5000)[1] > 0.95, "back up within five seconds of steady music");
  assert.ok(s.gain > 0.99);

  /* And talking over that music, louder than it, still dips. */
  s = talk(s, 1500, { db: -18, gapDb: -35 });
  assert.ok(s.gain <= 0.3, `a voice over the music: ${s.gain}`);
});

test("a microphone muted mid-sentence lets the sound come back", () => {
  let s = talk(feed(D.duckInit(), -70, 500), 1000);
  assert.ok(s.gain <= 0.3);
  s = feed(s, -Infinity, 2500);             // a muted track is silence
  assert.ok(s.gain > 0.95, `back up: ${s.gain}`);
});

test("the sound is only ever turned down, and never below its low", () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let run = 0; run < 40; run++) {
    let s = D.duckInit();
    for (let i = 0; i < 3000; i++) {
      const db = rand() < 0.05 ? -Infinity : -100 + rand() * 110;
      s = D.duckStep(s, db, SLICE * (0.5 + rand()));
      assert.ok(s.gain <= 1 && s.gain >= D.DUCK.low - 1e-12, `gain ${s.gain}`);
    }
  }
  assert.equal(D.duckStep(undefined, -70, SLICE).gain, 1, "no state yet is the start");
});

test("the level of a slice, across its channels", () => {
  assert.equal(D.levelDb([new Float32Array(128).fill(1)]), 0);
  assert.ok(Math.abs(D.levelDb([new Float32Array(128).fill(0.1)]) - -20) < 1e-6);
  assert.ok(Math.abs(D.levelDb([new Float32Array(128).fill(0.1), new Float32Array(128)]) - (-20 - 10 * Math.log10(2))) < 1e-6, "averaged over both");
  assert.equal(D.levelDb([]), -Infinity);
  assert.equal(D.levelDb(undefined), -Infinity);
  assert.equal(D.levelDb([new Float32Array(128)]), -Infinity, "digital silence");
});

/* ══════════════════════════════════════════
   duck.js as the browser runs it: an AudioWorklet module
══════════════════════════════════════════ */

function worklet() {
  const registered = {};
  class AudioWorkletProcessor {}
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "duck.js"), "utf8"), {
    registerProcessor: (name, cls) => { registered[name] = cls; },
    AudioWorkletProcessor, sampleRate: 48000, Math, Number, Infinity, Object
  });
  assert.ok(registered.duck, "registered as \"duck\" — the name app.js asks for");
  return new registered.duck();
}

const block = value => new Float32Array(128).fill(value);
const sine = (amp, from) => Float32Array.from({ length: 128 }, (_, i) => amp * Math.sin(2 * Math.PI * 440 * (from + i) / 48000));

test("the worklet passes the screen's sound through while nobody talks", () => {
  const p = worklet();
  for (let i = 0; i < 100; i++) {
    const out = [new Float32Array(128), new Float32Array(128)];
    assert.equal(p.process([[block(0.5), block(-0.5)], [block(0)]], [out]), true, "kept running");
    assert.ok(out[0].every(v => v === 0.5) && out[1].every(v => v === -0.5));
  }
});

test("the worklet turns the screen's sound down while the microphone hears talking, smoothly", () => {
  const p = worklet();
  for (let i = 0; i < 75; i++) {           // 0.2 s of a quiet room, learned first
    p.process([[block(0.5), block(0.5)], [sine(0.0003, i * 128)]], [[new Float32Array(128), new Float32Array(128)]]);
  }
  let out, last = 0.5;
  for (let i = 0; i < 150; i++) {          // 0.4 s of a voice at about −23 dB
    out = [new Float32Array(128), new Float32Array(128)];
    p.process([[block(0.5), block(0.5)], [sine(0.1, i * 128)]], [out]);
    for (const v of out[0]) { assert.ok(v <= last + 1e-9 && last - v < 0.01, "eased, never a step"); last = v; }
  }
  assert.ok(Math.abs(out[0][127] - 0.5 * D.DUCK.low) < 0.01, `down to its low: ${out[0][127]}`);
  assert.deepEqual(out[1], out[0], "both channels alike");
});

test("the worklet copies a one-channel sound to both sides, and is silent with no sound", () => {
  const p = worklet();
  const out = [new Float32Array(128), new Float32Array(128)];
  p.process([[block(0.3)], []], [out]);
  assert.ok(out[0].every(v => Math.abs(v - 0.3) < 1e-6) && out[1].every(v => Math.abs(v - 0.3) < 1e-6));
  const none = [block(9), block(9)];
  assert.equal(p.process([[], []], [none]), true);
  assert.ok(none[0].every(v => v === 0) && none[1].every(v => v === 0), "nothing in, nothing out");
});

/* ══════════════════════════════════════════
   mixScreenSound(): what goes where
══════════════════════════════════════════ */

const grab = (pattern, what) => {
  const m = app.match(pattern);
  assert.ok(m, `${what} not found in app.js`);
  return m[0];
};
const MIX = [
  grab(/^const DUCK_EAR = [^\n]*;$/m,                         "DUCK_EAR"),
  grab(/^function mixScreenSound\([^)]*\)\s*\{[\s\S]*?^\}/m, "mixScreenSound")
].join("\n");

function mixer({ worklet: hasWorklet = true, loadFails = false } = {}) {
  const edges = new Set(), log = { loaded: [], made: [], warned: [], extra: [] };
  let load;
  const loading = new Promise((resolve, reject) => { load = () => (loadFails ? reject(new Error("blocked")) : resolve()); });
  const node = name => ({
    name,
    connect(to, output = 0, input = 0) { edges.add(`${name} → ${to.name}${input ? `:${input}` : ""}`); },
    disconnect() { for (const e of [...edges]) if (e.startsWith(`${name} → `)) edges.delete(e); }
  });
  const track = name => ({ name, stop() {} });
  class MediaStream {
    constructor(tracks = []) { this.tracks = tracks; }
    getAudioTracks() { return this.tracks; }
  }
  class Ctx {
    constructor() {
      this.state = "running";
      if (hasWorklet) this.audioWorklet = { addModule: url => { log.loaded.push(url); return loading; } };
    }
    createMediaStreamDestination() { return { ...node("out"), stream: new MediaStream([track("mix")]) }; }
    createMediaStreamSource(stream) { return node(stream.tracks[0].name); }
    /* Anything that would change the sound on its way out: none is wanted. */
    createGain() { log.extra.push("gain"); return { ...node("gain"), gain: { value: 1 } }; }
    createWaveShaper() { log.extra.push("shaper"); return node("shaper"); }
    createDynamicsCompressor() { log.extra.push("compressor"); return node("compressor"); }
    createBiquadFilter() {
      const n = node(`filter ${this.filters = (this.filters || 0) + 1}`);
      n.frequency = { value: 0 };
      return n;
    }
    close() { return Promise.resolve(); }
  }
  class AudioWorkletNode {
    constructor(ctx, name, options) { log.made.push([name, options]); Object.assign(this, node("duck")); }
  }
  const mix = new Function("window", "MediaStream", "AudioWorkletNode", "APP_BUILD", "console",
    `${MIX}
return mixScreenSound;`)(
    { AudioContext: Ctx }, MediaStream, AudioWorkletNode, "202611160000-abcdef12",
    { warn: (...a) => log.warned.push(a.join(" ")) });
  return { mix, edges, log, load, track, settle: () => new Promise(r => setTimeout(r, 0)) };
}

test("the voice goes out exactly as the microphone gave it: not raised, not limited", async () => {
  /* Tried: the voice raised 3 dB, through a soft limit against clipping. Its
     hiss rose with it, and the limit bent the video's own loud moments —
     dirty. Nothing on the way out changes the sound now but the dip. */
  for (const m of [mixer({ worklet: false }), mixer()]) {
    m.mix(m.track("mic"), m.track("screen sound"));
    m.load(); await m.settle();
    assert.ok(m.edges.has("mic → out"), "straight in");
    assert.deepEqual(m.log.extra, [], "no gain, shaper or compressor anywhere in the mix");
  }
});

test("the screen's sound goes through the dip, and the voice is listened to on its way in", async () => {
  const m = mixer();
  const screenMix = m.mix(m.track("mic"), m.track("screen sound"));
  assert.deepEqual([...m.edges].sort(), ["mic → out", "screen sound → out"], "at full volume until it has loaded");
  assert.deepEqual(m.log.loaded, ["duck.js?v=202611160000-abcdef12"], "this build's copy");
  m.load(); await m.settle();
  assert.deepEqual([...m.edges].sort(), [
    "duck → out",                           // the screen's sound, turned down as needed
    "filter 1 → filter 2",                  // the speech band
    "filter 2 → duck:1",                    // listened to
    "mic → filter 1",
    "mic → out",                            // the voice itself, sent as it is
    "screen sound → duck"
  ]);
  assert.equal(m.log.made.length, 1);
  assert.equal(m.log.made[0][0], "duck");
  assert.deepEqual(m.log.made[0][1], { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2] });

  /* Headphones plugged in: their microphone is sent and listened to. */
  screenMix.setMic(m.track("headset"));
  assert.ok(m.edges.has("headset → out") && m.edges.has("headset → filter 1"));
  assert.ok(![...m.edges].some(e => e.startsWith("mic → ")), "the old microphone is out of it");
});

test("sharing stopped before the dip loaded: nothing is built", async () => {
  const m = mixer();
  m.mix(m.track("mic"), m.track("screen sound")).close();
  m.load(); await m.settle();
  assert.deepEqual(m.log.made, []);
});

test("where the dip cannot load, or the browser has none, the sound goes in at full volume as before", async () => {
  const failed = mixer({ loadFails: true });
  failed.mix(failed.track("mic"), failed.track("screen sound"));
  failed.load(); await failed.settle();
  assert.deepEqual([...failed.edges].sort(), ["mic → out", "screen sound → out"]);
  assert.equal(failed.log.warned.length, 1);

  const none = mixer({ worklet: false });
  const mix = none.mix(none.track("mic"), none.track("screen sound"));
  assert.deepEqual(none.log.loaded, []);
  mix.setMic(none.track("headset"));
  assert.deepEqual([...none.edges].sort(), ["headset → out", "screen sound → out"]);
});

/* ══════════════════════════════════════════
   Served and versioned like the other files
══════════════════════════════════════════ */

test("duck.js is served by the Pi and is part of the build", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.match(server, /"\/duck\.js"/, "the Pi serves it");
  const build = require("../tools/sync-build.js");
  assert.ok(build.CLIENT_FILES.includes("duck.js"), "a change to it is a new build");
});
