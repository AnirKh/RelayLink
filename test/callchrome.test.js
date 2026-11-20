/*
  The call's controls step aside.

  Reported: during a call the "connected" label and the buttons stayed on
  screen for good, and a shared screen was hard to see behind them. Now, once
  the call is connected and nothing has touched it for a few seconds, the
  status, the figures and the buttons fade; any tap, click, key or movement
  brings them back.

  G.callChromeMayHide decides; showCallChrome(), hideCallChrome() and
  stopCallChrome() are lifted out of app.js and run with a stand-in clock.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const G   = require("../guards.js");
const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");
const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/* ══════════════════════════════════════════
   The decision
══════════════════════════════════════════ */

test("they fade only in a connected video call that nobody is using", () => {
  const ok = { inCall: true, connected: true, video: true, pointerOnControls: false, keyboardInControls: false };
  assert.equal(G.callChromeMayHide(ok), true);
  assert.equal(G.callChromeMayHide({ ...ok, connected: false }), false, "still connecting: the label says what is happening");
  assert.equal(G.callChromeMayHide({ ...ok, video: false }), false, "a voice call: nothing behind them to see");
  assert.equal(G.callChromeMayHide({ ...ok, inCall: false }), false);
  assert.equal(G.callChromeMayHide({ ...ok, pointerOnControls: true }), false, "a pointer resting on a button");
  assert.equal(G.callChromeMayHide({ ...ok, keyboardInControls: true }), false, "someone moving through them by keyboard");
  assert.equal(G.callChromeMayHide({ ...ok, inCall: "true" }), false);
  assert.equal(G.callChromeMayHide(undefined), false);
});

/* ══════════════════════════════════════════
   showCallChrome() / hideCallChrome(), actually run
══════════════════════════════════════════ */

const grab = (pattern, what) => {
  const m = app.match(pattern);
  assert.ok(m, `${what} not found in app.js`);
  return m[0];
};
const SOURCE = [
  grab(/^const CALL_CHROME_IDLE_MS = [^\n]*;$/m,          "CALL_CHROME_IDLE_MS"),
  grab(/^function showCallChrome\(\)\s*\{[\s\S]*?^\}/m,    "showCallChrome"),
  grab(/^function hideCallChrome\(\)\s*\{[\s\S]*?^\}/m,    "hideCallChrome"),
  grab(/^function stopCallChrome\(\)\s*\{[\s\S]*?^\}/m,    "stopCallChrome")
].join("\n");

function classes(initial = []) {
  const set = new Set(initial);
  return { add: (...c) => c.forEach(x => set.add(x)), remove: (...c) => c.forEach(x => set.delete(x)),
           contains: c => set.has(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)) };
}

function stage({ connected = true, voice = false, hover = false, realPointer = true, keyboard = false, inCall = true, mini = false,
                sliderHover = false, sliderKeyboard = false } = {}) {
  const timers = [];
  const clock = {
    setTimeout: (f, ms) => { const t = { f, ms, live: true }; timers.push(t); return t; },
    clearTimeout: t => { if (t) t.live = false; }
  };
  const callOverlay = { classList: classes(voice ? ["voice-only"] : []) };
  const callControls = { matches: q => q === ":hover" && hover, querySelector: q => (q === ":focus-visible" && keyboard ? {} : null) };
  const screenVolume = { matches: q => q === ":hover" && sliderHover, querySelector: q => (q === ":focus-visible" && sliderKeyboard ? {} : null) };
  const window = { matchMedia: q => ({ matches: q === "(hover: hover)" && realPointer }) };
  const api = new Function("G", "callOverlay", "callControls", "screenVolume", "window", "setTimeout", "clearTimeout", "inCall", "callPc", "callMini",
    `let callChromeTimer = null;\n${SOURCE}\nreturn { showCallChrome, hideCallChrome, stopCallChrome, timer: () => callChromeTimer };`
  )(G, callOverlay, callControls, screenVolume, window, clock.setTimeout, clock.clearTimeout, inCall, { connectionState: connected ? "connected" : "connecting" }, mini);
  /** Runs whatever is due: the one live idle timer, or every live timer of a given length. */
  const run = ms => timers.filter(t => t.live && t.ms === ms).forEach(t => { t.live = false; t.f(); });
  return { ...api, overlay: callOverlay.classList, timers, run };
}

test("left alone for four seconds, they fade", () => {
  const s = stage();
  s.showCallChrome();
  assert.equal(s.overlay.contains("chrome-hidden"), false);
  assert.equal(s.timers.filter(t => t.live)[0].ms, 4000);
  s.run(4000);
  assert.equal(s.overlay.contains("chrome-hidden"), true);
});

test("any touch brings them back, and the four seconds start again", () => {
  const s = stage();
  s.showCallChrome();
  s.run(4000);
  s.showCallChrome();
  assert.equal(s.overlay.contains("chrome-hidden"), false);
  assert.equal(s.timers.filter(t => t.live && t.ms === 4000).length, 1, "one idle timer, not one per touch");
});

test("the tap that brings them back presses nothing", () => {
  /* For a moment the buttons take no taps: a tap on the empty screen must not
     land on a button that was invisible when the finger came down. */
  const s = stage();
  s.showCallChrome();
  s.run(4000);
  s.showCallChrome();
  assert.equal(s.overlay.contains("chrome-waking"), true);
  s.run(350);
  assert.equal(s.overlay.contains("chrome-waking"), false, "and then they do");
});

test("a touch while they are showing does not stop the buttons working", () => {
  const s = stage();
  s.showCallChrome();
  s.showCallChrome();
  assert.equal(s.overlay.contains("chrome-waking"), false);
});

test("still connecting, a voice call, a pointer on them, or the keyboard among them: they stay — and are looked at again later", () => {
  for (const setup of [{ connected: false }, { voice: true }, { hover: true }, { keyboard: true }]) {
    const s = stage(setup);
    s.showCallChrome();
    s.run(4000);
    assert.equal(s.overlay.contains("chrome-hidden"), false, JSON.stringify(setup));
    assert.equal(s.timers.filter(t => t.live && t.ms === 4000).length, 1, `${JSON.stringify(setup)}: checked again, not given up on`);
  }
});

test("on a phone, a button's leftover :hover after a tap does not keep them up", () => {
  const s = stage({ hover: true, realPointer: false });
  s.showCallChrome();
  s.run(4000);
  assert.equal(s.overlay.contains("chrome-hidden"), true);
});

test("the call made small, to use the chat, has nothing to fade", () => {
  const s = stage({ mini: true });
  s.showCallChrome();
  s.run(4000);
  assert.equal(s.overlay.contains("chrome-hidden"), false);
});

test("ending the call clears it all for the next", () => {
  const s = stage();
  s.showCallChrome();
  s.run(4000);
  s.stopCallChrome();
  assert.equal(s.overlay.contains("chrome-hidden"), false);
  assert.equal(s.timers.some(t => t.live), false);
});

/* ══════════════════════════════════════════
   That it is wired up
══════════════════════════════════════════ */

test("a call on screen starts it, any touch over the call wakes it, and ending the call stops it", () => {
  assert.match(grab(/^function showCallOverlay\([^)]*\)\s*\{[\s\S]*?^\}/m, "showCallOverlay"), /showCallChrome\(\);/);
  assert.match(grab(/^function stopCallMedia\([^)]*\)\s*\{[\s\S]*?^\}/m, "stopCallMedia"), /stopCallChrome\(\);/);
  assert.match(app, /for \(const type of \["pointermove", "pointerdown", "focusin"\]\) \{\s*\n\s*callOverlay\.addEventListener\(type,/);
  assert.match(app, /document\.addEventListener\("keydown", \(\) => \{ if \(!callOverlay\.classList\.contains\("hidden"\)\) showCallChrome\(\); \}\);/);
});

test("faded is see-through and untouchable; the self-view and the away note are not part of it", () => {
  const hidden = css.match(/((?:\.call-overlay\.chrome-hidden [^,{]+,\s*)+\.call-overlay\.chrome-hidden [^{]+)\{([^}]*)\}/);
  assert.ok(hidden, "the faded rule not found");
  const selectors = hidden[1];
  for (const part of [".call-status-label", ".call-stats", ".call-controls", ".screen-volume"]) assert.ok(selectors.includes(part), `${part} does not fade`);
  assert.ok(!/localVideo|call-pause-note/.test(selectors), "the self-view and the away note stay");
  assert.match(hidden[2], /opacity:\s*0/);
  assert.match(hidden[2], /pointer-events:\s*none/, "an invisible button must not take a tap");
  const waking = css.match(/((?:\.call-overlay\.chrome-waking [^,{]+,\s*)*\.call-overlay\.chrome-waking [^{]+)\{\s*pointer-events:\s*none;/);
  assert.ok(waking, "the waking rule not found");
  for (const part of [".call-controls", ".screen-volume"]) assert.ok(waking[1].includes(part), `${part} takes the tap that wakes it`);
});

test("the film's volume fades with the buttons: a pointer resting on it, or the keyboard in it, keeps them", () => {
  /* Asked for: while watching, the slider goes. */
  const fadesAfterIdle = o => { const s = stage(o); s.showCallChrome(); s.run(4000); return s.overlay.contains("chrome-hidden"); };
  assert.equal(fadesAfterIdle(), true);
  assert.equal(fadesAfterIdle({ sliderHover: true }), false, "a mouse resting on the slider");
  assert.equal(fadesAfterIdle({ sliderHover: true, realPointer: false }), true, "a finger's :hover sticks after a tap: not counted");
  assert.equal(fadesAfterIdle({ sliderKeyboard: true }), false, "the keyboard on the slider");
});
