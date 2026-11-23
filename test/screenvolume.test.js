/*
  The film's volume: a slider for the other side's shared film, on this
  device alone (see "The film's volume" in app.js). The block is lifted out
  of app.js and run against stand-ins: a device that keeps the last setting
  or has none, one whose storage refuses, and an iPhone, where a page cannot
  set a sound's volume at all.

  Music played from a tab in a voice call comes the same way, and its card
  has a slider of its own: the two are one setting.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const ROOT = path.join(__dirname, "..");
const app  = fs.readFileSync(path.join(ROOT, "app.js"), "utf8").replace(/\r\n/g, "\n");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

const BLOCK = (() => {
  const a = app.indexOf("const SCREEN_VOLUME_KEY = ");
  const b = app.indexOf("\n  });\n}", app.indexOf('range.addEventListener("input"', a));
  assert.ok(a > 0 && b > a, "the film's volume not found in app.js");
  return app.slice(a, b + 8);
})();

function device({ kept = null, storageRefuses = false, iPhone = false, sound = true } = {}) {
  const stored = new Map(kept === null ? [] : [["screenVolume", kept]]);
  const localStorage = {
    getItem: k => { if (storageRefuses) throw new Error("SecurityError"); return stored.has(k) ? stored.get(k) : null; },
    setItem: (k, v) => { if (storageRefuses) throw new Error("QuotaExceededError"); stored.set(k, String(v)); }
  };
  /* An iPhone takes no volume from a page: it reads back 1 whatever is set. */
  const document = { createElement: () => { let v = 1; return { get volume() { return v; }, set volume(x) { if (!iPhone) v = x; } }; } };
  const listeners = {}, musicListeners = {};
  const screenVolumeRange = { value: "100", addEventListener: (t, f) => { listeners[t] = f; } };
  const musicVolumeRange  = { value: "100", addEventListener: (t, f) => { musicListeners[t] = f; } };
  const hidden = new Set(["hidden"]);
  const screenVolume = { classList: { toggle: (c, on) => (on ? hidden.add(c) : hidden.delete(c)) } };
  const screenSoundOut = sound ? { volume: 1 } : null;
  const api = new Function("document", "localStorage", "screenVolume", "screenVolumeRange", "musicVolumeRange", "screenSoundOut",
    `${BLOCK}\nreturn { screenVolumeLevel, showScreenVolume };`
  )(document, localStorage, screenVolume, screenVolumeRange, musicVolumeRange, screenSoundOut);
  const slide = value => { screenVolumeRange.value = String(value); listeners.input(); };
  const slideMusic = value => { musicVolumeRange.value = String(value); musicListeners.input(); };
  return { ...api, slide, slideMusic, stored, screenVolumeRange, musicVolumeRange, screenSoundOut, shown: () => !hidden.has("hidden") };
}

test("sliding it turns the film up or down here, and is kept for next time", () => {
  const d = device();
  assert.equal(d.screenVolumeLevel(), 1, "full, as it came, until set");
  d.slide(35);
  assert.equal(d.screenSoundOut.volume, 0.35);
  assert.equal(d.stored.get("screenVolume"), "35");
  assert.equal(device({ kept: "35" }).screenVolumeLevel(), 0.35, "the next call starts where it was left");
});

test("the music card's slider and the film's are one setting: either turns it, both show it, it is kept", () => {
  const d = device();
  d.slideMusic(40);
  assert.equal(d.screenSoundOut.volume, 0.4, "the music turned down here");
  assert.equal(d.screenVolumeRange.value, "40", "and the film's slider says so");
  assert.equal(d.stored.get("screenVolume"), "40");
  d.slide(70);
  assert.equal(d.musicVolumeRange.value, "70");
  const next = device({ kept: "40" });
  assert.deepEqual([next.screenVolumeRange.value, next.musicVolumeRange.value], ["40", "40"], "the next call starts both where it was left");
});

test("a kept setting that makes no sense is not used, and one past the ends is held to them", () => {
  assert.equal(device({ kept: "loud" }).screenVolumeLevel(), 1);
  assert.equal(device({ kept: "250" }).screenVolumeLevel(), 1);
  assert.equal(device({ kept: "-20" }).screenVolumeLevel(), 0);
});

test("storage refused: it still works, for this time", () => {
  const d = device({ storageRefuses: true });
  assert.doesNotThrow(() => d.slide(50));
  assert.equal(d.screenSoundOut.volume, 0.5);
});

test("slid before any film has come: nothing to turn, nothing broken", () => {
  const d = device({ sound: false });
  assert.doesNotThrow(() => d.slide(20));
  assert.equal(d.screenVolumeLevel(), 0.2, "and the film starts at it when it comes");
});

test("shown while their film is big; on an iPhone, whose own buttons set it, never", () => {
  const d = device();
  d.showScreenVolume(true);
  assert.equal(d.shown(), true);
  d.showScreenVolume(false);
  assert.equal(d.shown(), false);
  const iPhone = device({ iPhone: true });
  iPhone.showScreenVolume(true);
  assert.equal(iPhone.shown(), false);
});

test("the film starts at the slider's level, and only the other side's film is offered it", () => {
  assert.match(app, /screenSoundOut = document\.createElement\("audio"\);\s*screenSoundOut\.volume = screenVolumeLevel\(\);/);
  assert.match(app, /showScreenVolume\(big && track === peerScreenTrack\);/, "theirs: yours is turned up or down where it plays");
});

test("in the page: hidden until wanted, upright, and named in both languages", () => {
  assert.match(html, /<label id="screenVolume" class="screen-volume hidden"[^>]*data-i18n-title="screenVolume"/);
  assert.match(html, /<input id="screenVolumeRange" type="range" min="0" max="100" step="1" value="100"/);
  const css = fs.readFileSync(path.join(ROOT, "style.css"), "utf8");
  assert.match(css, /\.screen-volume input\[type="range"\]\s*\{[^}]*writing-mode:\s*vertical-lr;\s*direction:\s*rtl;/, "up is louder");
  /* Every key the page names exists in both languages — i18n.test.js checks
     that for all of them; here, that this one is said in each. */
  const words = fs.readFileSync(path.join(ROOT, "i18n.js"), "utf8").match(/^\s*screenVolume:\s*"[^"]+",$/gm) || [];
  assert.equal(words.length, 2, "Mongolian and English");
});
