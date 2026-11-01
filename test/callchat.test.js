/*
  The chat during a call — actually run.

  A call covered the whole chat: nothing could be read, typed or sent, nor a
  file looked at, until it ended. The chat button among the call's controls
  now makes the call small — the other side's picture in the corner for a
  video call, a strip for a voice call — with the chat usable underneath. A
  tap on it brings it back; its red button hangs up. While the call fills the
  screen, what arrives in the chat is counted on the chat button.

  The block "The call made small, to use the chat" is lifted out of app.js
  and run against stand-in elements; the markup and the stylesheet are read.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8").replace(/\r\n/g, "\n");
const app  = read("app.js");
const html = read("index.html");
const css  = read("style.css").replace(/\/\*[\s\S]*?\*\//g, "");
const between = (from, to) => {
  const a = app.indexOf(from), b = app.indexOf(to, a);
  assert.ok(a > 0 && b > a, `${from} … ${to} not found in app.js`);
  return app.slice(a, b);
};
const fn = name => {
  const m = app.match(new RegExp(`^(?:async )?function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(m, `${name} not found as a top-level function in app.js`);
  return m[0];
};

/* ══════════════════════════════════════════
   The block, run
══════════════════════════════════════════ */

const BLOCK = between("/* ── The call made small, to use the chat ──", "function tablerIcon(");

function classes(initial = []) {
  const set = new Set(initial);
  return { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c),
           toggle: (c, on) => (on ? set.add(c) : set.delete(c)) };
}

/* The chat is 390 × 800; the small call 120 × 160, in its corner at (260, 84). */
function call({ onScreen = true } = {}) {
  const log = { chromeShown: 0, chromeStopped: 0, ended: [], captured: [] };
  const listeners = {};
  const vars = {};
  const timers = [];
  let resized = null;
  const callOverlay = {
    classList: classes(onScreen ? [] : ["hidden"]),
    addEventListener: (type, f) => { listeners[type] = f; },
    style: { setProperty: (k, v) => { vars[k] = v; } },
    offsetWidth: 120, offsetHeight: 160,
    getBoundingClientRect: () => (vars["--mini-x"] && callOverlay.classList.contains("moved")
      ? { left: parseFloat(vars["--mini-x"]), top: parseFloat(vars["--mini-y"]) } : { left: 260, top: 84 }),
    setPointerCapture: id => log.captured.push(id)
  };
  const chatScreen = { clientWidth: 390, clientHeight: 800, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const els = {
    callChatBtn: { onclick: null }, callChatCount: { textContent: "", classList: classes(["hidden"]) },
    callExpandBtn: { onclick: null }, callMiniEndBtn: { onclick: null }
  };
  const window = { ResizeObserver: class { constructor(f) { resized = f; } observe() {} } };
  const api = new Function("document", "callOverlay", "chatScreen", "window", "ResizeObserver", "setTimeout",
    "showCallChrome", "stopCallChrome", "endCall", `
    let callSwapped = false;                     // the pictures swapped (THE SELF-VIEW): not here
    function setCallSwapped(on) { callSwapped = on; }
    ${fn("selfViewPosition")}
    ${BLOCK}
    return { setCallMini, resetCallMini, noteCallChat, mini: () => callMini };`
  )({ getElementById: id => els[id] }, callOverlay, chatScreen, window, window.ResizeObserver, (f, ms) => timers.push({ f, ms }),
    () => { log.chromeShown++; }, () => { log.chromeStopped++; }, notify => log.ended.push(notify));
  /* A button pressed. */
  const click = id => els[id].onclick({});
  const button = { closest: s => (s === ".call-mini-btn" ? {} : null) }, picture = { closest: () => null };
  const pointer = (type, x, y, target = picture) =>
    listeners[type] && listeners[type]({ type, pointerId: 1, button: 0, clientX: x, clientY: y, target });
  /* A finger put down at (x, y), moved by (mx, my) in steps, and lifted —
     or, with `cancel`, taken over by the browser (a scroll, a system gesture). */
  const drag = (x, y, mx, my, { target = picture, cancel = false } = {}) => {
    pointer("pointerdown", x, y, target);
    for (let i = 1; i <= 4; i++) pointer("pointermove", x + mx * i / 4, y + my * i / 4, target);
    pointer(cancel ? "pointercancel" : "pointerup", x + mx, y + my, target);
    pointer("lostpointercapture", x + mx, y + my, target);
  };
  const tap = (x, y) => drag(x, y, 0, 0);
  const at = () => (callOverlay.classList.contains("moved") ? { x: parseFloat(vars["--mini-x"]), y: parseFloat(vars["--mini-y"]) } : null);
  const count = () => (els.callChatCount.classList.contains("hidden") ? null : els.callChatCount.textContent);
  return { ...api, log, click, drag, tap, at, count, timers, small: () => callOverlay.classList.contains("mini"),
           callOverlay, chatScreen, listeners, resize: () => resized && resized() };
}

test("the chat button makes the call small, with the chat usable underneath", () => {
  const c = call();
  c.click("callChatBtn");
  assert.equal(c.small(), true);
  assert.equal(c.mini(), true);
  assert.equal(c.log.chromeStopped, 1, "nothing to fade in the small call");
});

test("a tap on the small call, or its expand button, brings it back", () => {
  const c = call();
  c.click("callChatBtn");
  c.tap(300, 150);                      // the picture itself
  assert.equal(c.small(), false);
  assert.equal(c.log.chromeShown, 1, "with its controls showing");
  c.click("callChatBtn");
  c.click("callExpandBtn");
  assert.equal(c.small(), false);
});

test("a tap is told by the finger lifting, not by a click — a finger held for dragging is sent none", () => {
  const c = call();
  assert.equal(c.listeners.click, undefined, "nothing waits for the call's own click");
  c.click("callChatBtn");
  c.tap(300, 150);
  assert.equal(c.small(), false, "brought back with no click at all");
});

test("brought back under the finger, its buttons take nothing for a moment — not End call by accident", () => {
  const c = call();
  c.click("callChatBtn");
  c.tap(300, 150);
  assert.equal(c.callOverlay.classList.contains("chrome-waking"), true);
  assert.deepEqual(c.timers.map(t => t.ms), [350]);
  c.timers[0].f();
  assert.equal(c.callOverlay.classList.contains("chrome-waking"), false, "and then they do");
});

test("a tap on the call at full size does nothing of the kind", () => {
  const c = call();
  c.tap(200, 400);
  assert.equal(c.small(), false);
  assert.equal(c.log.chromeShown, 0);
  assert.equal(c.callOverlay.classList.contains("chrome-waking"), false);
});

test("the small call's red button hangs up, telling the other side — and does not make it big first", () => {
  const c = call();
  c.click("callChatBtn");
  c.click("callMiniEndBtn");
  assert.deepEqual(c.log.ended, [true]);
  assert.equal(c.small(), true, "the end of the call tidies it, not the tap");
});

test("while the call fills the screen, what arrives is counted on the chat button, and shown", () => {
  const c = call();
  c.noteCallChat();
  assert.equal(c.count(), "1");
  assert.equal(c.log.chromeShown, 1, "faded controls come back, so the count is seen");
  for (let i = 0; i < 11; i++) c.noteCallChat();
  assert.equal(c.count(), "9+");
});

test("opening the chat clears the count; while it is open, nothing is counted", () => {
  const c = call();
  c.noteCallChat(); c.noteCallChat();
  c.click("callChatBtn");
  assert.equal(c.count(), null);
  c.noteCallChat();
  assert.equal(c.count(), null, "it is in view");
  c.tap(300, 150);
  c.noteCallChat();
  assert.equal(c.count(), "1", "full size again: counting again");
});

test("with no call on screen, nothing is counted", () => {
  const c = call({ onScreen: false });
  c.noteCallChat();
  assert.equal(c.count(), null);
});

test("the next call starts full size, with nothing counted", () => {
  const c = call();
  c.noteCallChat();
  c.click("callChatBtn");
  c.noteCallChat();
  c.resetCallMini();
  assert.equal(c.small(), false);
  assert.equal(c.mini(), false);
  assert.equal(c.count(), null);
});

/* ══════════════════════════════════════════
   Moving the small call
══════════════════════════════════════════ */

test("the small call can be dragged, and stays where it is put", () => {
  const c = call();
  c.click("callChatBtn");
  c.drag(300, 150, -200, 400);          // a finger on the picture, moved down and left
  assert.deepEqual(c.at(), { x: 60, y: 484 }, "the picture went with the finger");
  assert.equal(c.small(), true, "a drag is not a tap: it stays small");
  assert.deepEqual(c.log.captured, [1], "the finger is held, so a fast drag cannot slip off it");
});

test("it cannot be dragged out of the chat", () => {
  const c = call();
  c.click("callChatBtn");
  c.drag(300, 150, 500, 900);
  assert.deepEqual(c.at(), { x: 390 - 120 - 8, y: 800 - 160 - 8 }, "held 8px inside the far corner");
  c.drag(300, 700, -900, -900);
  assert.deepEqual(c.at(), { x: 8, y: 8 });
});

test("a finger that wobbles but does not travel is still a tap", () => {
  const c = call();
  c.click("callChatBtn");
  c.drag(300, 150, 3, 2);               // inside the slop
  assert.equal(c.at(), null, "not moved");
  assert.equal(c.small(), false, "brought back");
});

test("a press the browser takes over is neither a drag's end nor a tap", () => {
  const c = call();
  c.click("callChatBtn");
  c.drag(300, 150, 0, 0, { cancel: true });
  assert.equal(c.small(), true);
  c.tap(300, 150);
  assert.equal(c.small(), false, "and the next tap works");
});

test("its buttons are for pressing, not dragging by; the full call is not dragged", () => {
  const c = call();
  c.click("callChatBtn");
  c.drag(300, 220, -100, 100, { target: { closest: s => (s === ".call-mini-btn" ? {} : null) } });
  assert.equal(c.at(), null, "a finger that starts on a button does not move the call");
  assert.equal(c.small(), true, "nor does lifting it there count as a tap on the call");
  c.click("callExpandBtn");
  c.drag(200, 400, -100, 100);
  assert.equal(c.at(), null, "nor does one on the call at full size");
});

test("where it was put is kept: back to full size and small again, and inside as the chat gets smaller", () => {
  const c = call();
  c.click("callChatBtn");
  c.drag(300, 150, -200, 400);
  c.click("callExpandBtn");
  c.click("callChatBtn");
  assert.deepEqual(c.at(), { x: 60, y: 484 }, "small again, where it was");
  c.chatScreen.clientHeight = 420;      // a keyboard opened
  c.resize();
  assert.deepEqual(c.at(), { x: 60, y: 420 - 160 - 8 }, "kept in view");
});

/* ══════════════════════════════════════════
   The wiring
══════════════════════════════════════════ */

test("ending a call puts it back to full size; the small call never fades; arrivals are told to it first", () => {
  const stop = fn("stopCallMedia");
  assert.match(stop, /if \(clearOverlay\) \{[\s\S]*resetCallMini\(\);[\s\S]*\}/);
  assert.match(fn("hideCallChrome"), /if \(callMini\) return;/);
  assert.match(fn("noticeArrival"), /^function noticeArrival\(\) \{\n\s*noteCallChat\(\);/,
    "before the looked-at check: someone looking at the call is not looking at the chat");
});

test("the chat button is among the call's controls, before hanging up; the small call has its own two", () => {
  const controls = html.match(/<div class="call-controls">([\s\S]*?)\n      <\/div>/);
  assert.ok(controls, "call controls not found");
  const chat = controls[1].indexOf('id="callChatBtn"'), end = controls[1].indexOf('id="endCallBtn"');
  assert.ok(chat > -1 && end > chat);
  assert.match(controls[1], /<button id="callChatBtn" class="call-btn" type="button" data-i18n-aria="callShowChat"/);
  assert.match(controls[1], /<span id="callChatCount" class="call-chat-count hidden"><\/span>/);
  const bar = html.match(/<div class="call-mini-bar">([\s\S]*?)<\/div>/);
  assert.ok(bar, "the small call's bar not found");
  assert.match(bar[1], /id="callExpandBtn"[^>]*data-i18n-aria="callBackToCall"/);
  assert.match(bar[1], /id="callMiniEndBtn" class="call-mini-btn end-call"[^>]*data-i18n-aria="callEnd"/);
  assert.ok(html.indexOf('<div class="call-mini-bar">') > html.indexOf('id="callOverlay"') &&
            html.indexOf('<div class="call-mini-bar">') < html.indexOf('<header class="chat-header">'), "inside the call");
});

/* ══════════════════════════════════════════
   How it looks
══════════════════════════════════════════ */

const rule = selector => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `${selector} not found in style.css`);
  return m[1];
};

test("small, the call is a picture in the corner under the header, not the whole screen", () => {
  const mini = rule(".call-overlay.mini");
  assert.match(mini, /inset:\s*auto;/);
  const top = mini.match(/top:\s*calc\((\d+)px \+ var\(--safe-top\)\)/);
  assert.ok(top && Number(top[1]) >= 80, "below the header and the figures under it, so their buttons stay usable");
  assert.doesNotMatch(mini, /(?:^|[\s;])width:|aspect-ratio:/, "as wide as its pictures, not a set box");
});

test("once moved it sits where it was put — only while small — and a finger drags it rather than scrolling the chat", () => {
  assert.match(rule(".call-overlay.mini.moved"), /left:\s*var\(--mini-x\);\s*top:\s*var\(--mini-y\);\s*right:\s*auto;/);
  assert.match(rule(".call-overlay.mini"), /touch-action:\s*none;/);
  assert.match(rule(".call-overlay.mini"), /cursor:\s*grab;/);
});

test("small, only the pictures (or who it is) and the two buttons show", () => {
  const hidden = css.match(/((?:\.call-overlay\.mini [^,{]+,\s*)+\.call-overlay\.mini [^{]+)\{\s*display:\s*none;\s*\}/);
  assert.ok(hidden, "the rule hiding the rest not found");
  for (const part of [".call-status-label", ".call-stats", ".call-pause-note", ".call-controls"]) {
    assert.ok(hidden[1].includes(part), `${part} still shows in the small call`);
  }
  assert.ok(!hidden[1].includes("#remoteVideo"), "the other side's picture stays — and with it the sound");
  assert.ok(!hidden[1].includes("#localVideo"), "and yours: it used to be hidden, so you could not see yourself");
  assert.match(rule(".call-mini-bar"), /display:\s*none;/, "the two buttons only in the small call");
  assert.match(rule(".call-overlay.mini .call-mini-bar"), /display:\s*flex;/);
});

test("small, you are beside them, not over their picture — a tile each, untouchable, and only with the camera on", () => {
  assert.doesNotMatch(css, /\.call-overlay\.mini #localVideo\s*\{/, "the old rule putting you inside their picture is gone");
  /* One rule for both, so the two tiles cannot drift apart in size or shape;
     never in a voice call, whose picture is kept 1px for the sound. */
  const tile = rule(".call-overlay.mini:not(.voice-only) #remoteVideo,\n.call-overlay.mini:not(.voice-only) #localVideo");
  assert.match(tile, /position:\s*static;/, "in the row — and the inline place you were dragged to in the full call moves nothing");
  assert.match(tile, /flex:\s*none;/);
  assert.match(tile, /width:\s*var\(--mini-tile\);/);
  assert.match(tile, /aspect-ratio:\s*var\(--mini-shape\);/);
  assert.match(tile, /min-width:\s*0;/, "not the full self-view's minimum");
  assert.match(tile, /max-height:\s*none;/, "nor its maximum, which would make yours shorter than theirs");
  assert.match(tile, /object-fit:\s*cover;/, "each fills its tile");
  assert.match(tile, /pointer-events:\s*none;/, "the small call drags as one piece");
  assert.doesNotMatch(tile, /transform/, "yours stays mirrored, theirs never is");
  const mini = rule(".call-overlay.mini");
  assert.match(mini, /--mini-shape:\s*3 \/ 4;/, "a phone's camera is upright");
  assert.match(css, /@media \(min-width: 769px\) \{ \.call-overlay\.mini \{ --mini-tile: \d+px; --mini-shape: 4 \/ 3; \} \}/, "a computer's lies on its side");
  assert.match(rule(".call-overlay.mini #localVideo.cam-off"), /display:\s*none;/, "no black square with the camera off");
  assert.match(fn("keepSelfViewInside"), /if \(callMini \|\| callSwapped\) return;/, "its full-call place is kept while small (and while swapped big)");
  assert.match(between("toggleCamBtn.onclick = () => {", "\n};"), /localVideo\.classList\.toggle\("cam-off", isCamOff\);/);
  assert.match(fn("stopCallMedia"), /isCamOff = false;\s*\n\s*localVideo\.classList\.remove\("cam-off"\);/, "and the next call starts with it on");
});

test("side by side, the two pictures still leave most of a phone's chat in view", () => {
  const mini = rule(".call-overlay.mini");
  const [, min, vw, max] = mini.match(/--mini-tile:\s*clamp\((\d+)px, (\d+)vw, (\d+)px\);/).map(Number);
  const gap = Number(mini.match(/gap:\s*(\d+)px;/)[1]);
  const pad = Number(mini.match(/padding:\s*(\d+)px;/)[1]);
  assert.ok(min >= 80, "however narrow the screen, each big enough to make out a face");
  for (const screen of [320, 375, 430]) {
    const tile = Math.min(max, Math.max(min, screen * vw / 100));
    const wide = 2 * tile + gap + 2 * pad + 2;            // and its 1px border
    assert.ok(wide <= screen * 0.6, `${wide}px of a ${screen}px screen`);
    assert.ok(tile >= 80, "each still big enough to make out a face");
  }
});

test("six call buttons fit across a phone", () => {
  /* An iPhone in a video call: mute, camera, flip, loudspeaker, chat, end. */
  const fits = (media, screen) => {
    const block = css.match(new RegExp(`@media \\(max-width: ${media}px\\) \\{([\\s\\S]*?)\\n\\}`));
    assert.ok(block, `${media}px media query not found`);
    const size = Number(block[1].match(/\.call-btn \{ width: (\d+)px;/)[1]);
    const gap  = Number(block[1].match(/\.call-controls \{ gap: (\d+)px;/)[1]);
    const row = 6 * size + 5 * gap;
    assert.ok(row <= screen - 16, `${row}px of buttons on a ${screen}px screen`);
    assert.ok(size >= 44, "still big enough to hit");
  };
  fits(480, 375);
  fits(360, 320);
});
