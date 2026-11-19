/*
  ─────────────────────────────────────────────
  RelayLink — duck.js
  ─────────────────────────────────────────────

  The shared screen's sound dips while the sharer talks.

  Reported: sharing a video with its sound and talking over it, the voice was
  hard to hear on the other side — the two go out mixed in one track (see
  mixScreenSound() in app.js), at full volume each. Now the microphone is
  listened to on its way into the mix: when the sharer starts talking the
  screen's sound fades down to 12% within a fraction of a second, stays down
  through the pauses between words, and fades back up once they have been
  quiet for a second. Radio calls it ducking.

  Tuned once more, by ear. First a quarter, quick; then the voice was asked
  louder and the video lower, and the voice was raised too — which raised its
  hiss with it, and the limit that kept a raised voice from clipping bent the
  video's own loud moments: it came out dirty. So nothing is raised now: the
  voice goes out exactly as the microphone gave it, and stands out because
  the video goes lower, 12% (about −18 dB). And it fades at an even pace in
  decibels, as a hand on a fader would — eased in plain volume, most of a
  fade happened in its first moment, which sounded like a jump.

  Only the sharer's own voice can do this. The other person's voice is not in
  this mix, and what plays on the sharer's own computer — another tab, another
  program — is beyond a web page's reach.

  Telling a voice from the room. A microphone near speakers hears the screen's
  sound too, and that must not count as talking. So the level is compared not
  with a fixed line but with the quietest it has lately been: speech comes in
  syllables, dropping back between them, while a steady background — a fan, or
  music leaking off the speakers — sits high and pulls that line up after it.
  Talking is a level well above it, and above near-silence, for long enough
  that a click or a tap on the desk is not mistaken for a word. Headphones on
  the sharing side still keep it cleanest, which a tip says.

  The same file is two things:
    - an AudioWorklet module, loaded by app.js as duck.js?v=<the build>. It
      runs on the browser's audio thread, which keeps time while the page is
      hidden — and the sharer is usually in the window being shown, where the
      page's own timers slow to once a second;
    - for the tests, a CommonJS module of the plain rule, duckStep(), which
      the processor below calls once per slice of sound.
*/

"use strict";

/* How it behaves, in decibels and milliseconds. */
const DUCK = Object.freeze({
  low:          0.12,   // the screen's sound while talking: 12%, about −18 dB
  quietDb:      -50,    // below this the microphone is hearing nothing much
  aboveFloorDb: 10,     // talking is this far above the quietest it has lately been
  floorRiseDb:  10,     // per second: how fast a steady background raises that line
  envMs:        25,     // the level is smoothed over this, so one slice is not a word
  onsetMs:      50,     // loud for this long before it counts as talking
  holdMs:       1000,   // and still talking until quiet for this long
  downDbPerSec: 120,    // fading down: all the way in about 0.15 s
  upDbPerSec:   24,     // fading back up: all the way in about 0.75 s
  minDb:        -100    // silence, as a number
});

/** Before anything is heard: full volume, nothing learned about the room. */
function duckInit() {
  return { env: null, floor: null, voicedMs: 0, sinceVoiceMs: Infinity, gainDb: 0, gain: 1 };
}

/** The share of the way toward a target that `ms` covers, for a smoothing
    of `tc` milliseconds. */
function ease(ms, tc) {
  return tc > 0 ? 1 - Math.exp(-ms / tc) : 1;
}

/**
 * One slice of sound: the microphone's level in it (dBFS) and how long it
 * lasted. Returns the next state; its `gain` is how loud the screen's sound
 * is to be by the end of this slice, 1 being as it came.
 */
function duckStep(state, levelDb, ms, c = DUCK) {
  const s = state || duckInit();
  const db = Number.isFinite(levelDb) ? Math.max(c.minDb, levelDb) : c.minDb;
  const env = s.env === null ? db : s.env + (db - s.env) * ease(ms, c.envMs);
  /* The quietest it has lately been: down at once, up only slowly. */
  const floor = s.floor === null ? env : Math.min(env, s.floor + c.floorRiseDb * ms / 1000);
  const loud = env >= c.quietDb && env >= floor + c.aboveFloorDb;
  const voicedMs = loud ? s.voicedMs + ms : 0;
  const sinceVoiceMs = voicedMs >= c.onsetMs ? 0 : s.sinceVoiceMs + ms;
  /* Toward the target at an even pace in decibels, never past it. */
  const targetDb = sinceVoiceMs < c.holdMs ? 20 * Math.log10(c.low) : 0;
  const was = Number.isFinite(s.gainDb) ? s.gainDb : 0;
  const gainDb = targetDb < was
    ? Math.max(targetDb, was - c.downDbPerSec * ms / 1000)
    : Math.min(targetDb, was + c.upDbPerSec * ms / 1000);
  return { env, floor, voicedMs, sinceVoiceMs, gainDb, gain: gainDb === 0 ? 1 : 10 ** (gainDb / 20) };
}

/** The level of a slice across all its channels, in dBFS. Nothing → −∞. */
function levelDb(channels) {
  let sum = 0, n = 0;
  for (const samples of channels || []) {
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    n += samples.length;
  }
  return n ? 10 * Math.log10(sum / n) : -Infinity;
}

/* ── On the audio thread ───────────────────────
   Input 0: the screen's sound. Input 1: the microphone, only its speech band
   — app.js filters it on the way here; this is for listening, not sending.
   Output: the screen's sound at the level the rule says, eased across each
   slice so a change is never a click. */
if (typeof registerProcessor === "function" && typeof AudioWorkletProcessor === "function") {
  registerProcessor("duck", class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.state = duckInit();
    }
    process(inputs, outputs) {
      const sound = inputs[0] || [];
      const out = outputs[0] || [];
      const frames = out[0] ? out[0].length : 128;
      const before = this.state.gain;
      this.state = duckStep(this.state, levelDb(inputs[1]), frames / sampleRate * 1000);
      const after = this.state.gain;
      for (let ch = 0; ch < out.length; ch++) {
        const from = sound[Math.min(ch, sound.length - 1)];
        const to = out[ch];
        if (!from) { to.fill(0); continue; }
        for (let i = 0; i < to.length; i++) to[i] = from[i] * (before + (after - before) * (i + 1) / to.length);
      }
      return true;
    }
  });
}

if (typeof module === "object" && module && module.exports) {
  module.exports = { DUCK, duckInit, duckStep, levelDb };
}
