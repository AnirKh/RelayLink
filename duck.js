/*
  ─────────────────────────────────────────────
  RelayLink — duck.js
  ─────────────────────────────────────────────

  The shared screen's sound dips while the sharer talks.

  Reported: sharing a video with its sound and talking over it, the voice was
  hard to hear on the other side — the two go out mixed in one track (see
  mixScreenSound() in app.js), at full volume each. Now the microphone is
  listened to on its way into the mix: when the sharer starts talking the
  screen's sound drops to 6% at once, stays down through the pauses between
  words, and fades back up once they have been quiet for a second. Radio
  calls it ducking.

  Tuned by ear, more than once. First a quarter, quick; then the voice was
  asked louder and the video lower, and the voice was raised too — which
  raised its hiss with it, and the limit that kept a raised voice from
  clipping bent the video's own loud moments: it came out dirty. So nothing
  is raised: the voice goes out exactly as the microphone gave it, and stands
  out because the video goes lower — 12%, and then, asked again, 6% (about
  −24 dB). It fades at an even pace in decibels, as a hand on a fader would.
  Going down it was a fade of 0.15 s, which was asked to be almost at once:
  now 0.03 s, the voice's first syllable all but missed. Coming back up stays
  a gentle 0.8 s.

  On the sharer's own computer, too. Reported: sharing a film from a browser
  tab, the sharer heard it at full volume all along and never the dip. A
  page cannot turn another tab down — but Chrome, asked, stops playing a
  shared tab's sound itself (app.js asks), and then app.js plays it here
  from this processor's second output: dipped while either of them talks,
  so the sharer hears the other person over the film as well as their own
  dip. Shared from a window or the whole screen there is no such choice, and
  the film plays there as it is.

  Telling a voice from the room. A microphone near speakers hears the screen's
  sound too, and that must not count as talking. Two things keep it from
  being taken for a voice:
    - The level is compared not with a fixed line but with the quietest it has
      lately been: speech comes in syllables, dropping back between them,
      while a steady background — a fan, or music leaking off the speakers —
      sits high and pulls that line up after it.
    - And the screen's own sound is heard here too, as it was before it went
      to the speakers, so how much of it comes back through the microphone
      can be learned: the loudest the microphone has lately been, against the
      loudest the screen's sound has. A film's voices come in syllables just
      as the sharer's do, and the first rule alone took them for talking;
      now the microphone has to be clearly louder than what the film would
      put in it by itself.
  Talking is a level above both, and above near-silence, for long enough that
  a click or a tap on the desk is not mistaken for a word. Headphones on the
  sharing side still keep it cleanest, which a tip says.

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
  low:          0.06,   // the screen's sound while talking: 6%, about −24 dB
  quietDb:      -50,    // below this the microphone is hearing nothing much
  aboveFloorDb: 10,     // talking is this far above the quietest it has lately been
  floorRiseDb:  10,     // per second: how fast a steady background raises that line
  envMs:        25,     // the level is smoothed over this, so one slice is not a word
  onsetMs:      50,     // loud for this long before it counts as talking — a tap on the desk is not
  holdMs:       1000,   // and still talking until quiet for this long
  downDbPerSec: 800,    // fading down: all the way in about 0.03 s — at once, without a click
  upDbPerSec:   30,     // fading back up: all the way in about 0.8 s

  /* The screen's sound coming back through the microphone. */
  aboveFilmDb:  10,     // talking is this far above what the film alone would put in the microphone
  peakMs:       400,    // the film at its loudest over this long: it reaches the microphone late,
                        // through the speakers and the room — Bluetooth ones a quarter of a second
  learnMs:      1500,   // how much of it comes back is learned from the loudest of each over this long,
                        // so a moment's lateness is a small part of it
  stepMs:       25,     // both kept as the loudest of each stretch this long
  leakStartDb:  0,      // before anything is learned: as if the microphone heard the film at full
  leakDownDbPerSec: 20, // what is learned follows the film getting quieter in the room readily —
                        // not at once, as a film turned up reaches the microphone a moment late —
  leakUpDbPerSec:   2,  // louder slowly, so a long stretch of talking is not learned as film,
  leakUpTalkingDbPerSec: 0.1, // and hardly at all while the sound is down for a voice: the
                        // film's own quieter moments, music between its lines, catch it up

  minDb:        -100    // silence, as a number
});

/** Before anything is heard: full volume, nothing learned about the room. */
function duckInit() {
  return {
    env: null, floor: null, voicedMs: 0, sinceVoiceMs: Infinity, gainDb: 0, gain: 1,
    filmEnv: null, filmNear: null, filmLong: null, micLong: null, filmOnMs: 0, micOnMs: 0, leakDb: null
  };
}

/** The share of the way toward a target that `ms` covers, for a smoothing
    of `tc` milliseconds. */
function ease(ms, tc) {
  return tc > 0 ? 1 - Math.exp(-ms / tc) : 1;
}

/** A level, smoothed: the slice's own the first time. */
function smooth(was, db, ms, c) {
  return was === null ? db : was + (db - was) * ease(ms, c.envMs);
}

/** The loudest over the last `windowMs`, kept as the loudest of each
    c.stepMs: a new stretch begun when the newest is full, the oldest let go.
    Returns the next record; its `db` is the loudest in it. (Held and let go
    evenly instead, a syllable a shade below the one before let go of it
    early, and the film and the microphone stopped lining up.) */
function loudest(was, db, ms, windowMs, c) {
  const steps = Math.max(1, Math.round(windowMs / c.stepMs));
  let maxes, into;
  if (!was) {
    maxes = [db]; into = ms;
  } else if (was.ms + ms <= c.stepMs) {
    maxes = was.maxes.slice();
    maxes[maxes.length - 1] = Math.max(maxes[maxes.length - 1], db);
    into = was.ms + ms;
  } else {
    maxes = was.maxes.slice(Math.max(0, was.maxes.length - steps + 1));
    maxes.push(db); into = ms;
  }
  return { maxes, ms: into, db: Math.max(...maxes) };
}

/**
 * One slice of sound: the microphone's level in it (dBFS), how long it
 * lasted, and the level of the screen's own sound in the same slice. Returns
 * the next state; its `gain` is how loud the screen's sound is to be by the
 * end of this slice, 1 being as it came.
 */
function duckStep(state, levelDb, ms, filmLevelDb = -Infinity, c = DUCK) {
  const s = state || duckInit();
  const heard = Number.isFinite(levelDb) && levelDb > c.minDb;   // a muted track, or one gone, is silence
  const db = heard ? levelDb : c.minDb;
  const env = smooth(s.env, db, ms, c);
  /* The quietest it has lately been: down at once, up only slowly. */
  const floor = s.floor === null ? env : Math.min(env, s.floor + c.floorRiseDb * ms / 1000);

  /* The film, and how much of it the microphone hears: the loudest of each
     over the same stretch, compared. Learned only once the film has been
     playing longer than it takes to come round through the room, and the
     microphone hearing for the whole stretch — a muted microphone's silence
     says nothing about it. */
  const filmDb = Number.isFinite(filmLevelDb) ? Math.max(c.minDb, filmLevelDb) : c.minDb;
  const filmEnv = smooth(s.filmEnv, filmDb, ms, c);
  const film = loudest(s.filmNear, filmEnv, ms, c.peakMs, c);
  const filmLong = loudest(s.filmLong, filmEnv, ms, c.learnMs, c);
  const micLong = loudest(s.micLong, env, ms, c.learnMs, c);
  const playing = film.db >= c.quietDb;
  const filmOnMs = playing ? s.filmOnMs + ms : 0;
  const micOnMs = heard ? s.micOnMs + ms : 0;
  let leakDb = s.leakDb;
  if (filmOnMs >= c.peakMs && micOnMs >= c.learnMs) {
    const now = micLong.db - filmLong.db;
    const up = s.sinceVoiceMs < c.holdMs ? c.leakUpTalkingDbPerSec : c.leakUpDbPerSec;
    leakDb = leakDb === null ? now
      : now < leakDb ? Math.max(now, leakDb - c.leakDownDbPerSec * ms / 1000)
      : Math.min(now, leakDb + up * ms / 1000);
  }
  const filmLine = playing ? film.db + (leakDb === null ? c.leakStartDb : leakDb) + c.aboveFilmDb : -Infinity;

  const loud = env >= c.quietDb && env >= floor + c.aboveFloorDb && env >= filmLine;
  const voicedMs = loud ? s.voicedMs + ms : 0;
  const sinceVoiceMs = voicedMs >= c.onsetMs ? 0 : s.sinceVoiceMs + ms;
  /* Toward the target at an even pace in decibels, never past it. */
  const targetDb = sinceVoiceMs < c.holdMs ? 20 * Math.log10(c.low) : 0;
  const was = Number.isFinite(s.gainDb) ? s.gainDb : 0;
  const gainDb = targetDb < was
    ? Math.max(targetDb, was - c.downDbPerSec * ms / 1000)
    : Math.min(targetDb, was + c.upDbPerSec * ms / 1000);
  return {
    env, floor, voicedMs, sinceVoiceMs, gainDb, gain: gainDb === 0 ? 1 : 10 ** (gainDb / 20),
    filmEnv, filmNear: film, filmLong, micLong, filmOnMs, micOnMs, leakDb
  };
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

/** The level a gain (in dB) leaves a sound at; nothing stays nothing. */
function lowered(db, gainDb) {
  return Number.isFinite(db) ? db + gainDb : db;
}

/** `sound` into `out`, its volume eased from `from` to `to` across the
    slice so a change is never a click; one channel copied to both sides. */
function fade(out, sound, from, to) {
  for (let ch = 0; ch < out.length; ch++) {
    const was = sound[Math.min(ch, sound.length - 1)];
    const into = out[ch];
    if (!was) { into.fill(0); continue; }
    for (let i = 0; i < into.length; i++) into[i] = was[i] * (from + (to - from) * (i + 1) / into.length);
  }
}

/* ── On the audio thread ───────────────────────
   Input 0: the screen's sound. Input 1: the microphone, only its speech band
   — app.js filters it on the way here; this is for listening, not sending.
   Input 2: the screen's sound again, through the same band, so the two are
   measured alike. Input 3, only when it plays here: the other person's
   voice, through the same band.
   Output 0: the screen's sound for the call, dipped while the sharer talks.
   Output 1, only when it plays here (processorOptions.here): the same, for
   this computer's speakers, dipped while either of them talks.

   Played here, the film the microphone hears is the dipped one, and that is
   what it is compared with. Compared with the film as it came, a dip for the
   other person talking looked like the room gone quiet, was learned as
   that, and the film's own voices coming back up after it were taken for
   the sharer talking — seconds of dips nobody asked for.

   The other person's voice is not compared with the film: it has been
   through their own browser's echo canceller already, and the quiet between
   their words may be silence itself, from which nothing is learned — the
   comparison learned from their voice instead, and stopped hearing it. */
if (typeof registerProcessor === "function" && typeof AudioWorkletProcessor === "function") {
  registerProcessor("duck", class extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this.here = Boolean(options && options.processorOptions && options.processorOptions.here);
      this.mine = duckInit();               // the sharer's own voice
      this.theirs = duckInit();             // the other person's, for what plays here
    }
    process(inputs, outputs) {
      const sound = inputs[0] || [];
      const sent = outputs[0] || [];
      const frames = sent[0] ? sent[0].length : 128;
      const ms = frames / sampleRate * 1000;
      const film = levelDb(inputs[2]);
      const sentFrom = this.mine.gain;
      const hereFrom = Math.min(this.mine.gain, this.theirs.gain);
      const heardHere = this.here ? lowered(film, Math.min(this.mine.gainDb, this.theirs.gainDb)) : film;
      this.mine = duckStep(this.mine, levelDb(inputs[1]), ms, heardHere);
      if (this.here) this.theirs = duckStep(this.theirs, levelDb(inputs[3]), ms);
      fade(sent, sound, sentFrom, this.mine.gain);
      if (this.here && outputs[1]) fade(outputs[1], sound, hereFrom, Math.min(this.mine.gain, this.theirs.gain));
      return true;
    }
  });
}

if (typeof module === "object" && module && module.exports) {
  module.exports = { DUCK, duckInit, duckStep, levelDb };
}
