/*
  Reactions — actually run.

  A message could only be answered with another message. Any message — text,
  picture, voice note or file, either side's — now takes one of six emoji:
  held with a finger, or right-clicked, or through the small button beside
  it, a bar opens; the one picked shows under the message on both screens;
  picked again it is taken back. A reaction goes sealed like everything said,
  and arrives as one of the six on a message both sides can name, or it is
  not drawn. The bar copies a text message too, since holding one no longer
  selects its text.

  The rules are in guards.js. The block "REACTIONS" is lifted out of app.js
  and run against a small stand-in page.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");
const G      = require("../guards.js");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8").replace(/\r\n/g, "\n");
const app  = read("app.js");
const html = read("index.html");
const I18N = new Function("localStorage", `${read("i18n.js")}; return I18N;`)({ getItem: () => null });
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

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

/* ══════════════════════════════════════════
   The rules
══════════════════════════════════════════ */

test("six reactions on offer", () => {
  assert.deepEqual(G.REACTIONS, ["👍", "❤️", "😂", "😮", "😢", "🙏"]);
  assert.throws(() => { G.REACTIONS.push("💩"); }, "not to be added to at run time");
});

test("a message both sides can name — or none, and then no reactions", () => {
  assert.equal(G.reactionKey("text", 5), "t:5");
  assert.equal(G.reactionKey("file", ID), `f:${ID}`);
  for (const [kind, id] of [["text", -1], ["text", 1.5], ["text", "5"], ["text", 1e16], ["file", "not-an-id"], ["file", 7], ["other", 5]]) {
    assert.equal(G.reactionKey(kind, id), null, `${kind} ${JSON.stringify(id)}`);
  }
});

test("only one of the six, or none, on a message both can name, saying whose it is, is shown", () => {
  assert.equal(G.reactionValid({ key: "t:5", mine: false, emoji: "👍" }), true);
  assert.equal(G.reactionValid({ key: `f:${ID}`, mine: true, emoji: "" }), true, "taking one back");
  for (const bad of [
    { key: "t:5", mine: false, emoji: "hello" },
    { key: "t:5", mine: false, emoji: "<b>x</b>" },
    { key: "t:5", mine: false, emoji: "💩" },
    { key: "t:5", mine: "yes", emoji: "👍" },
    { key: "t:5\"]", mine: false, emoji: "👍" },
    { key: "x:5", mine: false, emoji: "👍" },
    { key: 5, mine: false, emoji: "👍" },
    null
  ]) assert.equal(G.reactionValid(bad), false, JSON.stringify(bad));
});

test("picking yours again takes it back; another replaces it", () => {
  assert.equal(G.nextReaction("", "👍"), "👍");
  assert.equal(G.nextReaction("👍", "👍"), "");
  assert.equal(G.nextReaction("👍", "❤️"), "❤️");
});

test("the badge: theirs first, and 2 when you both gave the same", () => {
  assert.deepEqual(G.reactionBadge("", ""), []);
  assert.deepEqual(G.reactionBadge("👍", ""), [{ emoji: "👍", count: 1 }]);
  assert.deepEqual(G.reactionBadge("👍", "❤️"), [{ emoji: "❤️", count: 1 }, { emoji: "👍", count: 1 }]);
  assert.deepEqual(G.reactionBadge("👍", "👍"), [{ emoji: "👍", count: 2 }]);
});

/* ══════════════════════════════════════════
   A small stand-in page
══════════════════════════════════════════ */

/** Does `el` match one simple selector: tag, .classes, [attr] or [attr="v"]? */
function matchesOne(el, sel) {
  const m = sel.trim().match(/^([a-z]*)((?:\.[\w-]+)*)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/);
  if (!m) throw new Error(`stand-in cannot match ${sel}`);
  if (m[1] && el.tag !== m[1]) return false;
  for (const c of m[2].split(".").filter(Boolean)) if (!el.classList.contains(c)) return false;
  if (m[3]) {
    const name = m[3].replace(/^data-/, "").replace(/-(\w)/g, (_, c) => c.toUpperCase());
    if (!(name in el.dataset)) return false;
    if (m[4] !== undefined && el.dataset[name] !== m[4]) return false;
  }
  return true;
}
const matches = (el, sel) => sel.split(",").some(s => matchesOne(el, s));

function element(tag) {
  const listeners = {};
  const el = {
    tag, type: "", dataset: {}, style: {}, attrs: {}, children: [], parent: null, onclick: null,
    _text: "", _class: "",
    get className() { return el._class; },
    set className(v) { el._class = v; },
    classList: {
      contains: c => el._class.split(/\s+/).includes(c),
      add: c => { if (!el.classList.contains(c)) el._class = `${el._class} ${c}`.trim(); },
      remove: c => { el._class = el._class.split(/\s+/).filter(x => x && x !== c).join(" "); },
      toggle: (c, on) => (on ? el.classList.add(c) : el.classList.remove(c))
    },
    get textContent() { return el._text + el.children.map(c => c.textContent).join(""); },
    set textContent(v) { el._text = String(v); el.children = []; },
    setAttribute: (k, v) => { el.attrs[k] = String(v); },
    getAttribute: k => el.attrs[k],
    appendChild: c => { c.parent = el; el.children.push(c); return c; },
    after: c => { const kids = el.parent.children; c.parent = el.parent; kids.splice(kids.indexOf(el) + 1, 0, c); },
    remove: () => { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); el.parent = null; },
    contains: x => { for (let n = x; n; n = n.parent) if (n === el) return true; return false; },
    closest: sel => { for (let n = el; n; n = n.parent) if (n.tag && matches(n, sel)) return n; return null; },
    querySelectorAll: sel => {
      const out = [];
      const walk = n => { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); } };
      walk(el);
      return out;
    },
    querySelector: sel => el.querySelectorAll(sel)[0] || null,
    getBoundingClientRect: () => ({ left: 20, top: 300, right: 220, bottom: 340, width: 200, height: 40 }),
    offsetWidth: 280, offsetHeight: 48,
    addEventListener: (type, f, capture) => { (listeners[type] = listeners[type] || []).push({ f, capture }); },
    fire: (type, e) => (listeners[type] || []).forEach(l => l.f(e)),
    select() {}
  };
  return el;
}

const BLOCK = between("/* ══════════════════════════════════════════════\n   REACTIONS",
                      "/* ══════════════════════════════════════════════\n   BUBBLE RENDERERS");

function chat({ connected = true, sendWorks = true } = {}) {
  const log = { sent: [], toasts: [], heard: [], noticed: 0, copied: [] };
  const timers = [];
  const reactionBar = element("div");
  reactionBar.className = "reaction-bar hidden";
  const chatMessages = element("div");
  const chatScreen = element("div");
  const docListeners = {};
  const document = {
    getElementById: id => (id === "reactionBar" ? reactionBar : null),
    createElement: element,
    addEventListener: (type, f) => { (docListeners[type] = docListeners[type] || []).push(f); },
    body: element("body"),
    execCommand() {}
  };
  const env = {
    G, I18N, LANG: "en", t: k => I18N.en[k], document, chatMessages, chatScreen,
    CSS: { escape: s => s },
    tablerIcon: name => { const i = element("i"); i.className = `ti ti-${name}`; return i; },
    dcReady: () => connected, e2eReady: connected,
    dcSendE2e: async msg => { if (!sendWorks) return false; log.sent.push(msg); return true; },
    showToast: m => log.toasts.push(m),
    announce: m => log.heard.push(m),
    noticeArrival: () => { log.noticed++; },
    navigator: { clipboard: { writeText: async text => { log.copied.push(text); } } },
    setTimeout: (f, ms) => { timers.push({ f, ms, live: true }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].live = false; }
  };
  const names = Object.keys(env);
  const api = new Function(...names, `${BLOCK}
    return { markReactable, react, receiveReaction, openReactionBar, closeReactionBar, drawReactions,
             open: () => reactingTo };`)(...names.map(n => env[n]));

  /** A message row as the chat draws one: a bubble, then its time. */
  const row = (who, text, key) => {
    const r = element("div");
    r.className = `bubble-row ${who}`;
    const bubble = element("div");
    bubble.className = "bubble";
    bubble.textContent = text;
    r.appendChild(bubble);
    const meta = element("div");
    meta.className = "bubble-meta";
    r.appendChild(meta);
    chatMessages.appendChild(r);
    api.markReactable(r, key);
    return r;
  };
  const badge = r => { const b = r.querySelector(".reactions"); return b ? b.textContent : null; };
  const choices = () => reactionBar.querySelectorAll(".reaction-choice");
  const barOpen = () => !reactionBar.classList.contains("hidden");
  const event = (target, extra = {}) => ({ target, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });
  const runTimers = () => timers.filter(t => t.live).forEach(t => { t.live = false; t.f(); });
  return { ...api, log, row, badge, choices, barOpen, event, timers, runTimers, reactionBar, chatMessages, docListeners };
}

const settle = () => new Promise(r => setImmediate(r));

/* ══════════════════════════════════════════
   Run
══════════════════════════════════════════ */

test("the bar holds the six, then Copy", () => {
  const c = chat();
  assert.deepEqual(c.choices().map(b => b.textContent), G.REACTIONS);
  const copy = c.reactionBar.querySelector(".reaction-copy");
  assert.ok(copy, "Copy");
  assert.equal(copy.dataset.i18nAria, "copyBtn");
});

test("a message both sides can name gets a way in; one that cannot, nothing", () => {
  const c = chat();
  const named = c.row("peer", "hi", "t:3");
  assert.equal(named.dataset.reactKey, "t:3");
  assert.ok(named.querySelector(".react-open"), "the small button, for a mouse");
  const unnamed = c.row("peer", "⚠️ [decrypt error]", null);
  assert.equal(unnamed.dataset.reactKey, undefined);
  assert.equal(unnamed.querySelector(".react-open"), null);
});

test("a reaction is sent sealed, shown under the message, and taken back when picked again", async () => {
  const c = chat();
  const theirs = c.row("peer", "hello", "t:7");
  await c.react(theirs, "👍");
  assert.deepEqual(c.log.sent, [{ type: "reaction", key: "t:7", mine: false, emoji: "👍" }]);
  assert.equal(c.badge(theirs), "👍");
  assert.ok(theirs.querySelector(".reactions").classList.contains("mine"), "ringed: yours");
  await c.react(theirs, "❤️");
  assert.equal(c.badge(theirs), "❤️", "another replaces it");
  await c.react(theirs, "❤️");
  assert.equal(c.badge(theirs), null, "the same again takes it back");
  assert.deepEqual(c.log.sent.map(m => m.emoji), ["👍", "❤️", ""]);
  const own = c.row("me", "my words", "t:2");
  await c.react(own, "😂");
  assert.equal(c.log.sent.at(-1).mine, true, "your own message: says so, so the other side finds it");
});

test("with nothing to send it on, nothing is shown as given", async () => {
  for (const c of [chat({ connected: false }), chat({ sendWorks: false })]) {
    const r = c.row("peer", "hello", "t:7");
    await c.react(r, "👍");
    assert.equal(c.badge(r), null);
    assert.deepEqual(c.log.toasts, [I18N.en.messageNotSent]);
  }
});

test("their reaction to your message shows, is read out, and is noticed", () => {
  const c = chat();
  const yours = c.row("me", "my words", "t:4");
  c.receiveReaction({ type: "reaction", key: "t:4", mine: false, emoji: "😮" });
  assert.equal(c.badge(yours), "😮");
  assert.deepEqual(c.log.heard, [I18N.en.srReaction("😮")]);
  assert.equal(c.log.noticed, 1);
  c.receiveReaction({ type: "reaction", key: "t:4", mine: false, emoji: "" });
  assert.equal(c.badge(yours), null, "taken back");
  assert.equal(c.log.noticed, 1, "a reaction taken back is not news");
});

test("their reaction to their own message shows on theirs, quietly; the same as yours counts 2", () => {
  const c = chat();
  const theirs = c.row("peer", "their words", "t:4");
  const yours = c.row("me", "my words", "t:4");
  c.receiveReaction({ type: "reaction", key: "t:4", mine: true, emoji: "👍" });
  assert.equal(c.badge(theirs), "👍", "the peer's own message, numbered by the peer");
  assert.equal(c.badge(yours), null, "not yours, which has the same number in your own count");
  assert.equal(c.log.noticed, 0);
  theirs.dataset.reactMine = "👍";
  c.drawReactions(theirs);
  assert.equal(c.badge(theirs), "👍 2");
});

test("a reaction that is not one of the six, or names no message on screen, is not drawn", () => {
  const c = chat();
  const yours = c.row("me", "my words", "t:4");
  c.receiveReaction({ type: "reaction", key: "t:4", mine: false, emoji: "<img src=x onerror=alert(1)>" });
  c.receiveReaction({ type: "reaction", key: "t:99", mine: false, emoji: "👍" });
  c.receiveReaction({ type: "reaction", key: "t:4", mine: "no", emoji: "👍" });
  assert.equal(c.badge(yours), null);
  assert.equal(c.log.noticed, 0);
});

test("pictures, voice notes and files take reactions too, by their transfer id", () => {
  const c = chat();
  const picture = c.row("peer", "", `f:${ID}`);
  c.receiveReaction({ type: "reaction", key: `f:${ID}`, mine: true, emoji: "❤️" });
  assert.equal(c.badge(picture), "❤️");
});

test("a mouse: right-click opens the bar in place of the browser's menu", () => {
  const c = chat();
  const r = c.row("peer", "hello", "t:1");
  const e = c.event(r.querySelector(".bubble"));
  c.chatMessages.fire("contextmenu", e);
  assert.equal(e.prevented, true);
  assert.equal(c.barOpen(), true);
  assert.equal(c.open(), r);
  const sys = element("div");
  sys.className = "sys-msg";
  c.chatMessages.appendChild(sys);
  const other = c.event(sys);
  c.closeReactionBar();
  c.chatMessages.fire("contextmenu", other);
  assert.equal(other.prevented, false, "a note that is no message keeps the browser's menu");
  assert.equal(c.barOpen(), false);
});

test("a finger held still opens it; the lift after is not a tap", () => {
  const c = chat();
  const r = c.row("peer", "https://example.com", "t:1");
  const bubble = r.querySelector(".bubble");
  c.chatMessages.fire("pointerdown", c.event(bubble, { pointerType: "touch", clientX: 50, clientY: 300 }));
  assert.equal(c.timers[0].ms, 450);
  c.runTimers();
  assert.equal(c.barOpen(), true);
  c.chatMessages.fire("pointerup", c.event(bubble));
  const click = c.event(bubble);
  c.chatMessages.fire("click", click);
  assert.equal(click.prevented && click.stopped, true, "no link followed, no picture opened");
  const next = c.event(bubble);
  c.chatMessages.fire("click", next);
  assert.equal(next.prevented, false, "the next tap is a tap");
});

test("a finger that moves — a scroll — or lifts early opens nothing; a mouse press is not a hold", () => {
  const c = chat();
  const bubble = c.row("peer", "hello", "t:1").querySelector(".bubble");
  c.chatMessages.fire("pointerdown", c.event(bubble, { pointerType: "touch", clientX: 50, clientY: 300 }));
  c.chatMessages.fire("pointermove", c.event(bubble, { clientX: 50, clientY: 330 }));
  c.runTimers();
  assert.equal(c.barOpen(), false, "moved");
  c.chatMessages.fire("pointerdown", c.event(bubble, { pointerType: "touch", clientX: 50, clientY: 300 }));
  c.chatMessages.fire("pointerup", c.event(bubble));
  c.runTimers();
  assert.equal(c.barOpen(), false, "lifted early");
  c.chatMessages.fire("pointerdown", c.event(bubble, { pointerType: "mouse", clientX: 50, clientY: 300 }));
  c.runTimers();
  assert.equal(c.barOpen(), false, "a mouse right-clicks instead");
});

test("from the bar: a reaction, or Copy for a text — and the bar closes", async () => {
  const c = chat();
  const r = c.row("peer", "copy me", "t:1");
  c.openReactionBar(r);
  const heart = c.choices().find(b => b.dataset.emoji === "❤️");
  c.reactionBar.fire("click", c.event(heart));
  await settle();
  assert.equal(c.badge(r), "❤️");
  assert.equal(c.barOpen(), false);
  c.openReactionBar(r);
  assert.ok(c.choices().find(b => b.dataset.emoji === "❤️").classList.contains("chosen"), "yours marked in the bar");
  c.reactionBar.fire("click", c.event(c.reactionBar.querySelector(".reaction-copy")));
  await settle();
  assert.deepEqual(c.log.copied, ["copy me"]);
  const picture = c.row("peer", "", `f:${ID}`);
  c.openReactionBar(picture);
  assert.ok(c.reactionBar.querySelector(".reaction-copy").classList.contains("hidden"), "nothing to copy from a picture");
});

test("closed by a touch elsewhere, Esc, or the chat scrolling", () => {
  const c = chat();
  const r = c.row("peer", "hello", "t:1");
  c.openReactionBar(r);
  c.docListeners.pointerdown.forEach(f => f({ target: c.reactionBar.querySelector(".reaction-choice") }));
  assert.equal(c.barOpen(), true, "a touch on the bar itself keeps it");
  c.docListeners.pointerdown.forEach(f => f({ target: c.chatMessages }));
  assert.equal(c.barOpen(), false);
  c.openReactionBar(r);
  c.docListeners.keydown.forEach(f => f({ key: "Escape" }));
  assert.equal(c.barOpen(), false);
  c.openReactionBar(r);
  c.chatMessages.fire("scroll", {});
  assert.equal(c.barOpen(), false);
});

/* ══════════════════════════════════════════
   The wiring
══════════════════════════════════════════ */

test("every message both sides can name is made reactable — texts both ways, files both ways", () => {
  assert.match(fn("sendSealedText"), /markReactable\(row, G\.reactionKey\("text", msgId\)\);/, "sent now, or after waiting for the link");
  assert.match(between('    case "text":', '    case "e2e-pubkey":'), /markReactable\(appendBubble\("peer", plain\), G\.reactionKey\("text", data\.msgId\)\);/);
  assert.match(fn("sendBinary"), /attachSendProgress\(id\);\s*\n\s*markReactable\(findTransferRow\(id\), G\.reactionKey\("file", id\)\);/);
  assert.match(fn("handleTransferMeta"), /markReactable\(findTransferRow\(data\.id\), G\.reactionKey\("file", data\.id\)\);/);
});

test("a reaction is believed only sealed, and the bar goes with the chat", () => {
  assert.ok(!G.CLEAR_TYPES.includes("reaction"), "whoever carries the packets cannot add one");
  assert.match(between('    case "reaction":', "      break;"), /receiveReaction\(data\);/);
  assert.match(between("leaveBtn.onclick = (e) => {", "keepScreenOn(false);"), /closeReactionBar\(\);/);
  assert.match(fn("switchToChat"), /closeReactionBar\(\);\s*\n\s*chatMessages\.replaceChildren\(\);/);
  assert.match(html, /<div id="reactionBar" class="reaction-bar hidden" role="toolbar" data-i18n-aria="react"/);
  for (const lang of ["mn", "en"]) {
    assert.equal(typeof I18N[lang].react, "string");
    assert.equal(typeof I18N[lang].srReaction, "function");
  }
});

test("on a phone, holding a message opens the bar, not the phone's selection or menu", () => {
  const css = read("style.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const touch = css.match(/@media \(hover: none\) \{([\s\S]*?)\n\}/);
  assert.ok(touch, "the touch media query not found");
  assert.match(touch[1], /\.react-open \{ display: none; \}/, "no hover button where nothing hovers");
  assert.match(touch[1], /\.bubble-row\[data-react-key\] \.bubble \{[^}]*user-select: none;[^}]*-webkit-touch-callout: none;/);
});
