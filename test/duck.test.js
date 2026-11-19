/*
  The shared screen's sound dipping while the sharer talks.

  The rule (duckStep in duck.js) is fed made-up microphone levels slice by
  slice, as the audio thread would: talking in syllables, a click, a steady
  background, a microphone muted — and a film, whose own voices come back
  through the microphone off the speakers. Then duck.js is run as the browser runs it —
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

/** Levels added as sound adds: in power. */
const sumDb = (...dbs) => 10 * Math.log10(dbs.reduce((a, d) => a + (Number.isFinite(d) ? 10 ** (d / 10) : 0), 0));

/** A film's dialogue: syllables at `db`, over its own music 20 dB under. */
const dialogue = (db = -20) => t => (t < 0 ? -Infinity : t % 300 < 200 ? db : db - 20);

/**
 * A film playing for `ms`, from `t0`: the microphone hears it `delayMs` late
 * and `leakDb` quieter, over a room at `roomDb`, with the sharer's own voice
 * `voice(t)` on top — or, given, `mic(t)` instead. `listen: false` keeps the
 * film from the rule, as it was before.
 */
function play(state, ms, { film, voice = () => -Infinity, leakDb = -25, delayMs = 60, roomDb = -70,
                           t0 = 0, listen = true, mic = null } = {}, each = () => {}) {
  let s = state;
  for (let t = SLICE; t <= ms + 1e-9; t += SLICE) {
    const T = t0 + t;
    const heard = mic ? mic(T) : sumDb(roomDb, film(T - delayMs) + leakDb, voice(T));
    s = D.duckStep(s, heard, SLICE, listen ? film(T) : -Infinity);
    each(s, T);
  }
  return s;
}

/** The sharer talking from `from` ms: syllables at `db`, as talk() makes them. */
const speaking = (from, db = -25) => t => (t < from ? -Infinity : (t - from) % 230 < 150 ? db : -Infinity);

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
  assert.ok(at(40) > 0.99, `not before it is sure it is talking: ${at(40)}`);
  assert.ok(at(110) <= D.DUCK.low + 0.01, `all the way down by 0.11 s — almost at once: ${at(110)}`);
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
  assert.ok(fadeMs > 20 && fadeMs < 45, `all the way down in about 0.03 s — asked for almost at once, still a fade: ${fadeMs.toFixed(0)} ms`);
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
      const film = rand() < 0.3 ? -Infinity : -100 + rand() * 110;
      s = D.duckStep(s, db, SLICE * (0.5 + rand()), film);
      assert.ok(s.gain <= 1 && s.gain >= D.DUCK.low - 1e-12, `gain ${s.gain}`);
    }
  }
  assert.equal(D.duckStep(undefined, -70, SLICE).gain, 1, "no state yet is the start");
});

/* ── The film in the microphone ── */

test("a film's own voices, coming back through the microphone, are not the sharer talking", () => {
  /* Before, they were: syllables off the speakers look like a voice. */
  let lowest = 1;
  play(feed(D.duckInit(), -70, 500), 6000, { film: dialogue(), listen: false }, x => { lowest = Math.min(lowest, x.gain); });
  assert.ok(lowest < 0.5, `without the film to compare with, it dipped: ${lowest}`);

  /* Heard alongside the film, they are told apart — however loud they come
     back, and however late: Bluetooth speakers are a quarter of a second. */
  for (const leakDb of [-40, -25, -15]) {
    for (const delayMs of [10, 60, 150, 250]) {
      const s = feed(D.duckInit(), -70, 500);
      play(s, 10000, { film: dialogue(), leakDb, delayMs }, (x, t) =>
        assert.ok(x.gain > 0.99, `${leakDb} dB back, ${delayMs} ms late: dipped to ${x.gain} at ${t.toFixed(0)} ms`));
    }
  }
});

test("a voice over the film still turns it down, as quickly", () => {
  for (const delayMs of [60, 250]) {
    let s = play(feed(D.duckInit(), -70, 500), 3000, { film: dialogue(), delayMs });
    assert.equal(s.gain, 1);
    const seen = [];
    s = play(s, 2000, { film: dialogue(), delayMs, voice: speaking(3000), t0: 3000 }, (x, t) => seen.push([t - 3000, x.gain]));
    const at = ms => seen.find(([t]) => t >= ms)[1];
    assert.ok(at(100) < 0.75, `already dipping at 0.1 s: ${at(100)}`);
    assert.ok(at(300) <= 0.3, `well down by 0.3 s: ${at(300)}`);
    assert.ok(Math.abs(s.gain - D.DUCK.low) < 0.01, `down to its low: ${s.gain}`);
  }
});

test("nothing of the film in the microphone — headphones, or the browser's own canceller: a voice dips as before", () => {
  let s = play(feed(D.duckInit(), -70, 500), 1000, { film: dialogue(-10), leakDb: -Infinity });
  const seen = [];
  s = play(s, 1500, { film: dialogue(-10), leakDb: -Infinity, voice: speaking(1000), t0: 1000 }, (x, t) => seen.push([t - 1000, x.gain]));
  const at = ms => seen.find(([t]) => t >= ms)[1];
  assert.ok(at(100) < 0.75, `already dipping at 0.1 s: ${at(100)}`);
  assert.ok(at(250) <= 0.3, `well down by 0.25 s: ${at(250)}`);
});

test("a voice quieter than the film's echo waits for the film to pause", () => {
  /* The film comes back loud, 15 dB under itself; the voice is quieter
     than that in the microphone. Nothing can tell them apart — and once the
     film is paused, the same voice turns the sound down. */
  const film = t => (t < 3000 ? dialogue()(t) : -Infinity);
  let s = play(feed(D.duckInit(), -70, 500), 3000, { film, leakDb: -15 });
  s = play(s, 1500, { film, leakDb: -15, voice: speaking(3000, -40), t0: 3000 });
  assert.ok(s.gain <= 0.3, `down once the film has stopped: ${s.gain}`);
});

test("talking on and on over the film, with only short pauses: still heard a minute later", () => {
  /* Talking is louder than the film's echo, and some of it is learned as
     echo — slowly enough that a sharer explaining at length keeps the
     film down. */
  let s = play(feed(D.duckInit(), -70, 500), 3000, { film: dialogue() });
  let down = 0, n = 0;
  s = play(s, 60000, { film: dialogue(), voice: speaking(3000), t0: 3000 }, (x, t) => {
    if (t > 4000) { n++; if (x.gain <= 0.3) down++; }
  });
  assert.ok(down / n > 0.99, `held down ${(100 * down / n).toFixed(1)}% of the minute`);
  assert.ok(s.gain <= 0.3, `still down at the end: ${s.gain}`);
});

test("the speakers turned up partway through: learned again, and the film left alone", () => {
  /* Its echo may pass for talking at first; the film's quieter moments —
     music between its lines — show it for what it is. */
  const leakAt = t => (t < 10000 ? -30 : -20);
  const film = t => (t % 6000 < 4000 ? dialogue()(t) : -40);
  let s = feed(D.duckInit(), -70, 500), late = 1;
  for (let t = SLICE; t <= 60000; t += SLICE) {
    s = D.duckStep(s, sumDb(-70, film(t - 80) + leakAt(t - 80)), SLICE, film(t));
    if (t > 30000) late = Math.min(late, s.gain);
  }
  assert.ok(late > 0.99, `left alone once learned: ${late}`);
  assert.ok(Math.abs(s.leakDb - -20) < 3, `learned the louder echo: ${s.leakDb}`);
});

test("a microphone muted while the film plays: what was learned is kept", () => {
  const film = dialogue();
  let s = play(feed(D.duckInit(), -70, 500), 3000, { film });
  const learned = s.leakDb;
  assert.ok(Math.abs(learned - -25) < 3, `learned about how loud it comes back: ${learned}`);
  s = play(s, 3000, { film, t0: 3000, mic: () => -Infinity });
  assert.equal(s.leakDb, learned, "silence teaches nothing");
  for (const t0 of [6000, 6100, 6200]) {    // unmuted at any point in the film
    play(s, 3000, { film, t0 }, x => assert.ok(x.gain > 0.99, `dipped after unmuting at ${t0}: ${x.gain}`));
  }
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

function worklet(options) {
  const registered = {};
  class AudioWorkletProcessor {}
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "duck.js"), "utf8"), {
    registerProcessor: (name, cls) => { registered[name] = cls; },
    AudioWorkletProcessor, sampleRate: 48000, Math, Number, Infinity, Object
  });
  assert.ok(registered.duck, "registered as \"duck\" — the name app.js asks for");
  return new registered.duck(options);
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

test("the worklet listens to the film too, and does not dip for it coming back through the microphone", () => {
  const p = worklet();
  /* The film in bursts at about −23 dB; the microphone hears it 20 dB under. */
  const burst = i => ((i * 128) % 14400 < 9600 ? 0.1 : 0.001);
  let out;
  for (let i = 0; i < 1125; i++) {          // 3 s
    const film = sine(burst(i), i * 128);
    out = [new Float32Array(128), new Float32Array(128)];
    p.process([[block(0.5), block(0.5)], [film.map(v => v * 0.1)], [film]], [out]);
    assert.ok(out[0].every(v => v > 0.5 * 0.99), `dipped for the film, at block ${i}`);
  }
  for (let i = 1125; i < 1300; i++) {       // and a voice, louder than the echo
    const film = sine(burst(i), i * 128);
    const voice = Float32Array.from({ length: 128 }, (_, k) => 0.1 * Math.sin(2 * Math.PI * 220 * (i * 128 + k) / 48000));
    out = [new Float32Array(128), new Float32Array(128)];
    p.process([[block(0.5), block(0.5)], [film.map((v, k) => v * 0.1 + voice[k])], [film]], [out]);
  }
  assert.ok(Math.abs(out[0][127] - 0.5 * D.DUCK.low) < 0.01, `down for the voice: ${out[0][127]}`);
});

test("played here too: both dip while the sharer talks, and only the one here while the other person does", () => {
  const p = worklet({ processorOptions: { here: true } });
  const pair = () => [new Float32Array(128), new Float32Array(128)];
  const voice = (i, hz = 220) => Float32Array.from({ length: 128 }, (_, k) => 0.1 * Math.sin(2 * Math.PI * hz * (i * 128 + k) / 48000));
  const quiet = i => sine(0.0003, i * 128);
  let sent, here, i = 0;
  const run = (blocks, mine, theirs) => {
    for (const end = i + blocks; i < end; i++) {
      sent = pair(); here = pair();
      assert.equal(p.process([[block(0.5), block(0.5)], [mine(i)], [], [theirs(i)]], [sent, here]), true);
    }
  };
  run(75, quiet, quiet);                    // 0.2 s of quiet rooms, learned first
  assert.ok(sent[0][127] === 0.5 && here[0][127] === 0.5, "both as they came while nobody talks");
  run(150, quiet, voice);                   // the other person talks
  assert.equal(sent[0][127], 0.5, "the call's copy is left alone: they hear the film as it is while they talk");
  assert.ok(Math.abs(here[0][127] - 0.5 * D.DUCK.low) < 0.01, `down here, to hear them over it: ${here[0][127]}`);
  run(750, quiet, quiet);                   // 2 s: back up
  assert.ok(sent[0][127] === 0.5 && here[0][127] > 0.5 * 0.99, `back up here: ${here[0][127]}`);
  run(150, voice, quiet);                   // the sharer talks
  assert.ok(Math.abs(sent[0][127] - 0.5 * D.DUCK.low) < 0.01, `down for the call: ${sent[0][127]}`);
  assert.ok(Math.abs(here[0][127] - 0.5 * D.DUCK.low) < 0.01, `and here — the sharer hears the dip: ${here[0][127]}`);
  assert.deepEqual(sent[1], sent[0], "both channels alike");
});

test("played here, the film the microphone hears is the dipped one — so the other person talking teaches it nothing wrong", () => {
  /* The microphone hears what plays here, 20 dB under, a slice late: a film
     of syllables at many levels. The other person talks for 2 s, and the film
     here is down all that while. Compared with the film as it came, the
     quieter echo was learned as the room — and the film's own voices, back
     up after it, were taken for the sharer talking: seconds of dips. */
  const p = worklet({ processorOptions: { here: true } });
  let seed = 3;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const levels = [];
  while (levels.length < 4500) {
    const on = Math.round(30 + rand() * 82), off = Math.round(19 + rand() * 75), amp = 0.05 + rand() * 0.35;
    for (let k = 0; k < on; k++) levels.push(amp);
    for (let k = 0; k < off; k++) levels.push(0.01);
  }
  const tone = (amp, hz, i) => Float32Array.from({ length: 128 }, (_, k) => amp * Math.sin(2 * Math.PI * hz * (i * 128 + k) / 48000));
  let echo = new Float32Array(128), during = 0, after = 1;
  for (let i = 0; i < 4500; i++) {           // 12 s
    const film = tone(levels[i], 440, i);
    const talking = i >= 1125 && i < 1875;   // they talk from 3 s to 5 s
    const sent = [new Float32Array(128), new Float32Array(128)];
    const here = [new Float32Array(128), new Float32Array(128)];
    p.process([[film, film], [echo.map(v => v * 0.1)], [film], [talking ? tone(0.1, 220, i) : new Float32Array(128)]], [sent, here]);
    echo = here[0];
    const gain = Math.max(...here[0].map(Math.abs)) / levels[i];
    if (talking && gain < 0.1) during++;
    if (i < 1125 || i > 2625) after = Math.min(after, gain);   // before they talk, and from 2 s after
  }
  assert.ok(during > 700, `down here while they talk: ${during} of 750 slices`);
  assert.ok(after > 0.99, `the film's own voices never dipped it: ${after}`);
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
    get destination() { return node("speakers"); }
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
    m.mix(m.track("mic"), m.track("screen sound"), { withVoice: true });
    m.load(); await m.settle();
    assert.ok(m.edges.has("mic → out"), "straight in");
    assert.deepEqual(m.log.extra, [], "no gain, shaper or compressor anywhere in the mix");
  }
});

test("in a channel of its own, the screen's sound goes out alone: the voice is only listened to", async () => {
  const m = mixer();
  const screenMix = m.mix(m.track("mic"), m.track("screen sound"));
  assert.equal(screenMix.carriesVoice, false);
  assert.deepEqual([...m.edges].sort(), ["screen sound → out"], "at full volume until the dip has loaded, and no voice in it");
  m.load(); await m.settle();
  assert.deepEqual([...m.edges].sort(), [
    "duck → out",
    "filter 1 → filter 2",
    "filter 2 → duck:1",
    "filter 3 → filter 4",
    "filter 4 → duck:2",
    "mic → filter 1",                       // listened to, and nothing more
    "screen sound → duck",
    "screen sound → filter 3"
  ]);
  assert.deepEqual(m.log.extra, []);
  screenMix.setMic(m.track("headset"));
  assert.ok(m.edges.has("headset → filter 1") && !m.edges.has("headset → out"), "a new microphone, listened to only");

  const none = mixer({ worklet: false });
  none.mix(null, none.track("screen sound"));
  assert.deepEqual([...none.edges], ["screen sound → out"], "no microphone: the film goes out undipped");
});

test("the screen's sound goes through the dip, and the voice is listened to on its way in", async () => {
  const m = mixer();
  const screenMix = m.mix(m.track("mic"), m.track("screen sound"), { withVoice: true });
  assert.equal(screenMix.carriesVoice, true);
  assert.deepEqual([...m.edges].sort(), ["mic → out", "screen sound → out"], "at full volume until it has loaded");
  assert.deepEqual(m.log.loaded, ["duck.js?v=202611160000-abcdef12"], "this build's copy");
  m.load(); await m.settle();
  assert.deepEqual([...m.edges].sort(), [
    "duck → out",                           // the screen's sound, turned down as needed
    "filter 1 → filter 2",                  // the speech band
    "filter 2 → duck:1",                    // the voice, listened to
    "filter 3 → filter 4",                  // the same band
    "filter 4 → duck:2",                    // the screen's sound, listened to as well
    "mic → filter 1",
    "mic → out",                            // the voice itself, sent as it is
    "screen sound → duck",
    "screen sound → filter 3"
  ]);
  assert.equal(m.log.made.length, 1);
  assert.equal(m.log.made[0][0], "duck");
  assert.deepEqual(m.log.made[0][1], { numberOfInputs: 3, numberOfOutputs: 1, outputChannelCount: [2] });

  /* Headphones plugged in: their microphone is sent and listened to. */
  screenMix.setMic(m.track("headset"));
  assert.ok(m.edges.has("headset → out") && m.edges.has("headset → filter 1"));
  assert.ok(![...m.edges].some(e => e.startsWith("mic → ")), "the old microphone is out of it");
});

test("sharing stopped before the dip loaded: nothing is built", async () => {
  const m = mixer();
  m.mix(m.track("mic"), m.track("screen sound"), { withVoice: true }).close();
  m.load(); await m.settle();
  assert.deepEqual(m.log.made, []);
});

test("where the dip cannot load, or the browser has none, the sound goes in at full volume as before", async () => {
  const failed = mixer({ loadFails: true });
  failed.mix(failed.track("mic"), failed.track("screen sound"), { withVoice: true });
  failed.load(); await failed.settle();
  assert.deepEqual([...failed.edges].sort(), ["mic → out", "screen sound → out"]);
  assert.equal(failed.log.warned.length, 1);

  const none = mixer({ worklet: false });
  const mix = none.mix(none.track("mic"), none.track("screen sound"), { withVoice: true });
  assert.deepEqual(none.log.loaded, []);
  mix.setMic(none.track("headset"));
  assert.deepEqual([...none.edges].sort(), ["headset → out", "screen sound → out"]);
});

test("played here too, where the browser has kept a tab's sound off the speakers: dipped for either of them", async () => {
  const m = mixer();
  const screenMix = m.mix(m.track("mic"), m.track("screen sound"), { playHere: true, them: m.track("their voice") });
  assert.equal(screenMix.playsHere, true);
  assert.deepEqual([...m.edges].sort(), ["screen sound → out", "screen sound → speakers"],
    "played here as it came until the dip has loaded — never silent");
  m.load(); await m.settle();
  assert.deepEqual(m.log.made[0][1], { numberOfInputs: 4, numberOfOutputs: 2, outputChannelCount: [2, 2], processorOptions: { here: true } });
  assert.deepEqual([...m.edges].sort(), [
    "duck → out",                           // for the call
    "duck → speakers",                      // and here, from its second output
    "filter 1 → filter 2",
    "filter 2 → duck:1",                    // the sharer's voice, listened to
    "filter 3 → filter 4",
    "filter 4 → duck:3",                    // the other person's, listened to
    "filter 5 → filter 6",
    "filter 6 → duck:2",                    // the film, listened to
    "mic → filter 1",
    "screen sound → duck",
    "screen sound → filter 5",
    "their voice → filter 3"
  ]);

  const failed = mixer({ loadFails: true });
  failed.mix(failed.track("mic"), failed.track("screen sound"), { playHere: true });
  failed.load(); await failed.settle();
  assert.ok(failed.edges.has("screen sound → speakers"), "where the dip cannot load, still played here, as it came");
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
