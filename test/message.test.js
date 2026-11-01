/*
  Long messages, and messages read aloud — actually run.

  The bug: a long paste did nothing. Press Send and the text sat in the box,
  with no bubble and no word as to why. Under the hood the message is sealed
  and sent as one data-channel message; past what the channel (or, in Safari,
  the encoder's argument limit) can carry, a step threw and nothing caught it.

  The fix is a limit the app says out loud: a counter near it, a red one past
  it, a toast instead of silence, and the same limit held by the receiver.

  The second half: bubbles are drawn silently, so a screen reader found a new
  message only by going to look. What arrives, and every system note, is now
  also written into a hidden live region that reads it out.

  sendTextMessage, updateMessageCounter, announce, appendBubble, appendSys and
  the "text" case of the message switch are lifted out of app.js and run
  against stand-ins.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");
const G      = require("../guards.js");
const DC     = require("../protocol.js");

const read = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\r\n/g, "\n");
const app  = read("app.js");
const I18N = new Function("localStorage", `${read("i18n.js")}; return I18N;`)({ getItem: () => null });

const fn = name => {
  const m = app.match(new RegExp(`^(?:async )?function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(m, `${name} not found as a top-level function in app.js`);
  return m[0];
};
const textCase = (() => {
  const from = app.indexOf('    case "text":');
  const to   = app.indexOf('    case "e2e-pubkey":', from);
  assert.ok(from > 0 && to > from, 'case "text" not found in app.js');
  return app.slice(from, to);
})();

const MAX = G.MAX_MESSAGE_CHARS;
const settle = () => new Promise(r => setImmediate(r));

/** A stand-in element: enough of classList, attributes and children. */
function element(tag = "div") {
  const classes = new Set();
  const el = {
    tag, textContent: "", value: "", style: {}, children: [], attrs: {},
    classList: {
      toggle: (c, on) => { (on === undefined ? !classes.has(c) : on) ? classes.add(c) : classes.delete(c); },
      add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c)
    },
    setAttribute: (k, v) => { el.attrs[k] = String(v); },
    removeAttribute: k => { delete el.attrs[k]; },
    appendChild: child => { el.children.push(child); child.remove = () => { el.children.splice(el.children.indexOf(child), 1); }; return child; },
    get childElementCount() { return el.children.length; },
    get firstElementChild() { return el.children[0]; }
  };
  return el;
}

/** One side's chat, with the real functions and stand-in surroundings. */
function chat({ sendThrows = false, lang = "en" } = {}) {
  const log = { sent: [], bubbles: [], sys: [], toasts: [], acks: [], noticed: 0, reactable: [], sealedAs: [], openedAs: [] };
  const aadOf = aad => JSON.parse(new TextDecoder().decode(aad));
  const messageInput   = element("textarea");
  const messageCounter = element();
  const srAnnouncer    = element();
  const chatMessages   = element();
  const env = {
    G, I18N, LANG: lang,
    t: key => I18N[lang][key],
    console: { warn() {}, error() {}, log() {} },
    document: { createElement: element, createTextNode: text => ({ text, textContent: text }) },
    messageInput, messageCounter, srAnnouncer, chatMessages,
    dcReady: () => true, e2eReady: true,
    DC, myRole: () => "g", peerRole: () => "h",
    e2eEncrypt: async (text, aad) => { log.sealedAs.push(aadOf(aad)); return { ct: `sealed(${text.length})`, iv: "iv" }; },
    e2eDecrypt: async (ct, iv, aad) => { log.openedAs.push(aadOf(aad)); return ct; },   // the "ciphertext" is the text itself here
    dataChannel: { send: json => { if (sendThrows) throw new Error("channel closed"); log.sent.push(JSON.parse(json)); } },
    dcSend: obj => { if (obj.type === "ack") log.acks.push(obj.msgId); },
    showToast: msg => log.toasts.push(msg),
    addAckTick() {}, pendingAcks: {}, now: () => "12:00", scrollBottom() {},
    noticeArrival: () => { log.noticed++; },
    markReactable: (row, key) => { log.reactable.push({ who: row.className, key }); }
  };
  const names = Object.keys(env);
  const api = new Function(...names, `
    let msgIdCounter = 0, e2eSendSeq = 0, e2eRecvSeen = DC.sealWindow(), autoN = 0;
    ${["announce", "fillMessage", "appendBubble", "appendSys", "updateMessageCounter", "sendTextMessage"].map(fn).join("\n")}
    /* A frame without a number is given the next one, as the other side would. */
    function deliver(data) { if (data.n === undefined) data = { ...data, n: ++autoN }; switch (data.type) {\n${textCase}\n} }
    return { sendTextMessage, updateMessageCounter, announce, appendBubble, appendSys, deliver };
  `)(...names.map(n => env[n]));

  const type = text => { messageInput.value = text; api.updateMessageCounter(); };
  const bubbles = who => chatMessages.children.filter(r => r.className === `bubble-row ${who}`)
                                              .map(r => r.children[0].textContent);
  /* A bubble as its parts: words, and links with where they go. */
  const parts = who => chatMessages.children.filter(r => r.className === `bubble-row ${who}`).map(r => {
    const b = r.children[0];
    if (!b.children.length) return [b.textContent];
    return b.children.map(c => (c.tag === "a" ? { link: c.textContent, href: c.href, target: c.target, rel: c.rel, title: c.title } : c.text));
  });
  const sys = () => chatMessages.children.filter(r => r.className === "sys-msg").map(r => r.textContent);
  const heard = () => srAnnouncer.children.map(c => c.textContent);
  return { ...api, log, type, bubbles, parts, sys, heard, messageInput, messageCounter };
}

/* ══════════════════════════════════════════
   The limit itself
══════════════════════════════════════════ */

test("a message at the limit fits; one character more does not", () => {
  assert.equal(G.messageFits("a".repeat(MAX)), true);
  assert.equal(G.messageFits("a".repeat(MAX + 1)), false);
  for (const v of [undefined, null, 5, {}, ["a"]]) assert.equal(G.messageFits(v), false);
});

test("the longest message, sealed, fits in one data-channel message in every browser", () => {
  /* The worst case is a character that takes 3 bytes in UTF-8 (CJK, say) —
     Mongolian Cyrillic takes 2, an emoji 4 bytes for 2 characters. */
  const worst = "中".repeat(MAX);
  const sealedBytes = Buffer.byteLength(worst, "utf8") + 16;   // + AES-GCM tag
  const wire = JSON.stringify({ type: "text", ct: Buffer.alloc(sealedBytes).toString("base64"),
                                iv: Buffer.alloc(12).toString("base64"), msgId: 1e9 });
  assert.ok(wire.length < 64 * 1024, `${wire.length} bytes on the wire`);
  /* e2eEncrypt spreads the sealed bytes into String.fromCharCode, and Safari
     refuses more than 65 536 arguments to one call. */
  assert.ok(sealedBytes < 65536, `${sealedBytes} sealed bytes`);
});

test("the counter appears near the limit and is marked past it", () => {
  assert.deepEqual(G.draftState(0), { counter: false, over: false });
  assert.deepEqual(G.draftState(MAX * 0.9 - 1), { counter: false, over: false });
  assert.deepEqual(G.draftState(MAX * 0.9), { counter: true, over: false });
  assert.deepEqual(G.draftState(MAX), { counter: true, over: false });
  assert.deepEqual(G.draftState(MAX + 1), { counter: true, over: true });
  assert.deepEqual(G.draftState(undefined), { counter: false, over: false });
});

/* ══════════════════════════════════════════
   Sending
══════════════════════════════════════════ */

test("a message at the limit is sent", async () => {
  const c = chat();
  c.type("a".repeat(MAX));
  await c.sendTextMessage();
  assert.equal(c.log.sent.filter(m => m.type === "text").length, 1);
  assert.equal(c.messageInput.value, "", "the box is cleared");
  assert.deepEqual(c.log.toasts, []);
});

test("a message over the limit is not sent, says why, and stays in the box", async () => {
  const c = chat();
  const long = "a".repeat(MAX + 1);
  c.type(long);
  await c.sendTextMessage();

  assert.deepEqual(c.log.sent, [], "nothing went out");
  assert.deepEqual(c.bubbles("me"), []);
  assert.equal(c.messageInput.value, long, "nothing was cut off or lost");
  assert.equal(c.log.toasts.length, 1);
  assert.match(c.log.toasts[0], new RegExp(String(MAX)), "the toast names the limit");
  assert.ok(c.heard().includes(c.log.toasts[0]), "and a screen reader hears it too");
});

test("spaces around a message do not count against it", async () => {
  const c = chat();
  c.type(`   ${"a".repeat(MAX)}\n\n  `);
  await c.sendTextMessage();
  assert.equal(c.log.sent.filter(m => m.type === "text").length, 1);
});

test("a send that fails for any other reason says so, and keeps the text", async () => {
  const c = chat({ sendThrows: true });
  c.type("hello");
  await c.sendTextMessage();          // must not reject
  assert.deepEqual(c.log.toasts, [I18N.en.messageNotSent]);
  assert.equal(c.messageInput.value, "hello");
  assert.deepEqual(c.bubbles("me"), [], "no bubble for a message that never left");
});

test("the counter: hidden, then shown, then red with the box marked invalid, then gone after sending", async () => {
  const c = chat();
  c.type("a".repeat(100));
  assert.ok(c.messageCounter.classList.contains("hidden"));

  c.type("a".repeat(9500));
  assert.ok(!c.messageCounter.classList.contains("hidden"));
  assert.equal(c.messageCounter.textContent, `9500 / ${MAX}`);
  assert.ok(!c.messageCounter.classList.contains("over"));

  c.type("a".repeat(MAX + 5));
  assert.ok(c.messageCounter.classList.contains("over"));
  assert.equal(c.messageInput.attrs["aria-invalid"], "true");

  c.type("a".repeat(9500));
  await c.sendTextMessage();
  assert.ok(c.messageCounter.classList.contains("hidden"), "an empty box shows no counter");
  assert.equal(c.messageInput.attrs["aria-invalid"], undefined);
});

/* ══════════════════════════════════════════
   Receiving
══════════════════════════════════════════ */

test("a message at the limit is shown and acknowledged", async () => {
  const c = chat();
  c.deliver({ type: "text", ct: "a".repeat(MAX), iv: "iv", msgId: 7 });
  await settle();
  assert.equal(c.bubbles("peer").length, 1);
  assert.deepEqual(c.log.acks, [7]);
});

/* ── Whose it is, and where it goes ──
   Found in a security assessment: nothing said who sealed a message or in
   what order, so whoever stood between the two could hand one back to the
   side that sent it, or deliver it again later as new. */

test("a message sent is sealed as ours, numbered, with its id — and the number goes with it", async () => {
  const c = chat();
  c.type("one");
  await c.sendTextMessage();
  c.type("two");
  await c.sendTextMessage();
  assert.deepEqual(c.log.sealedAs, [["dc-msg-1", "g", 1, "text", 1], ["dc-msg-1", "g", 2, "text", 2]]);
  assert.deepEqual(c.log.sent.map(f => [f.msgId, f.n]), [[1, 1], [2, 2]]);
});

test("a message received is opened only as the other side's, at the number and id it came with", async () => {
  const c = chat();
  c.deliver({ type: "text", ct: "hi", iv: "iv", msgId: 4, n: 9 });
  await settle();
  assert.deepEqual(c.log.openedAs, [["dc-msg-1", "h", 9, "text", 4]],
    "one of ours handed back would be opened as theirs — and so does not open");
});

test("a message delivered again is shown once and acknowledged once", async () => {
  const c = chat();
  c.deliver({ type: "text", ct: "I'm outside", iv: "iv", msgId: 1, n: 1 });
  c.deliver({ type: "text", ct: "I'm outside", iv: "iv", msgId: 1, n: 1 });
  await settle();
  assert.deepEqual(c.bubbles("peer"), ["I'm outside"]);
  assert.deepEqual(c.log.acks, [1]);
});

test("a message with no proper number is not shown", async () => {
  const c = chat();
  for (const n of [0, -1, 1.5, "1", null]) c.deliver({ type: "text", ct: "x", iv: "iv", msgId: 1, n });
  await settle();
  assert.deepEqual(c.bubbles("peer"), []);
});

test("a message over the limit from a changed app is not shown, and says so", async () => {
  const c = chat();
  c.deliver({ type: "text", ct: "a".repeat(MAX + 1), iv: "iv", msgId: 8 });
  await settle();
  assert.deepEqual(c.bubbles("peer"), []);
  assert.deepEqual(c.log.acks, [], "not acknowledged as delivered");
  assert.deepEqual(c.sys(), [I18N.en.messageTooLongArrived]);
});

/* ══════════════════════════════════════════
   The Enter key
══════════════════════════════════════════ */

test("Enter sends on a computer; Shift+Enter, a phone's Enter, or a word still being composed starts a line", () => {
  assert.equal(G.enterSends({ touch: false, shift: false, composing: false }), true, "a computer");
  assert.equal(G.enterSends({ touch: false, shift: true, composing: false }), false, "Shift+Enter: a new line");
  assert.equal(G.enterSends({ touch: true, shift: false, composing: false }), false, "a phone: a new line, the button sends");
  assert.equal(G.enterSends({ touch: false, shift: false, composing: true }), false, "finishing a Chinese, Japanese or Korean word");
  assert.equal(G.enterSends(undefined), false);
});

const ENTER = (() => {
  const from = app.indexOf("/* Enter sends on a computer and starts a new line on a phone");
  const to = app.indexOf('messageInput.addEventListener("input"', from);
  assert.ok(from > 0 && to > from, "the Enter key's block not found in app.js");
  return app.slice(from, to);
})();

/** The message box's Enter key on a device with a finger (`touch`) or a mouse. */
function enterKey({ touch }) {
  let onKey = null;
  const box = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener: (type, f) => { if (type === "keydown") onKey = f; } };
  let sent = 0;
  new Function("G", "window", "messageInput", "sendTextMessage", ENTER)(
    G, { matchMedia: q => ({ matches: q === "(pointer: coarse)" && touch }) }, box, () => { sent++; });
  const press = (extra = {}) => {
    const e = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
    onKey(e);
    return { sent, newLine: !e.prevented };
  };
  return { press, hint: box.attrs.enterkeyhint, sent: () => sent };
}

test("on a computer Enter sends, and Shift+Enter is a new line, as before", () => {
  const k = enterKey({ touch: false });
  assert.deepEqual(k.press(), { sent: 1, newLine: false });
  assert.deepEqual(k.press({ shiftKey: true }), { sent: 1, newLine: true });
  assert.equal(k.hint, "send", "the keyboard's key says Send");
});

test("on a phone Enter is a new line — it used to send, so no message could have two lines", () => {
  const k = enterKey({ touch: true });
  assert.deepEqual(k.press(), { sent: 0, newLine: true });
  assert.equal(k.hint, "enter", "and the keyboard's key says so");
});

test("an Enter that finishes a word still being composed never sends", () => {
  const k = enterKey({ touch: false });
  assert.deepEqual(k.press({ isComposing: true }), { sent: 0, newLine: true });
  assert.deepEqual(k.press({ keyCode: 229 }), { sent: 0, newLine: true }, "as older browsers report it");
});

test("other keys are typed as always", () => {
  const k = enterKey({ touch: false });
  assert.deepEqual(k.press({ key: "a" }), { sent: 0, newLine: true });
});

test("a message written on several lines is shown on several lines", () => {
  /* The bubble folded them into spaces, so even Shift+Enter on a computer
     arrived as one line. */
  const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const bubble = css.match(/\n\.bubble \{([^}]*)\}/);
  assert.ok(bubble, ".bubble not found in style.css");
  assert.match(bubble[1], /white-space:\s*pre-wrap;/);
});

/* ══════════════════════════════════════════
   Links
══════════════════════════════════════════ */

test("a web address in a message is a link, opening in a new tab; the words round it stay words", async () => {
  const c = chat();
  c.deliver({ type: "text", ct: "see https://example.com/a. and www.mn.mn", iv: "iv", msgId: 1 });
  await settle();
  const tab = { target: "_blank", rel: "noopener noreferrer" };
  assert.deepEqual(c.parts("peer"), [[
    "see ",
    { link: "https://example.com/a", href: "https://example.com/a", title: "https://example.com/a", ...tab },
    ". and ",
    { link: "www.mn.mn", href: "https://www.mn.mn/", title: "https://www.mn.mn/", ...tab }
  ]], "shown as written, going where it really goes, and the full stop left to the sentence");
});

test("your own links too", async () => {
  const c = chat();
  c.type("https://anirkh.github.io/RelayLink/");
  await c.sendTextMessage();
  assert.equal(c.parts("me")[0][0].href, "https://anirkh.github.io/RelayLink/");
});

test("nothing but a web page becomes a link — and a message with none is plain text", async () => {
  const c = chat();
  for (const [i, text] of ["javascript:alert(1)", "data:text/html,<b>x</b>", "https://google.com@evil.com", "no address here"].entries()) {
    c.deliver({ type: "text", ct: text, iv: "iv", msgId: 10 + i });
  }
  await settle();
  assert.deepEqual(c.parts("peer"), [["javascript:alert(1)"], ["data:text/html,<b>x</b>"], ["https://google.com@evil.com"], ["no address here"]]);
});

test("the splitting, by its rule", () => {
  assert.deepEqual(G.splitLinks("(https://en.wikipedia.org/wiki/Foo_(bar))"),
    [{ text: "(" }, { text: "https://en.wikipedia.org/wiki/Foo_(bar)", href: "https://en.wikipedia.org/wiki/Foo_(bar)" }, { text: ")" }],
    "a bracket the address opened is kept; the sentence's is not");
  assert.deepEqual(G.splitLinks("go http://a.io!"), [{ text: "go " }, { text: "http://a.io", href: "http://a.io/" }, { text: "!" }]);
  assert.deepEqual(G.splitLinks("xhttps://a.io"), [{ text: "xhttps://a.io" }], "only at the start of a word");
  assert.deepEqual(G.splitLinks("https://"), [{ text: "https://" }], "no host, no link");
  assert.deepEqual(G.splitLinks(""), []);
  assert.deepEqual(G.splitLinks(undefined), []);
  const words = "Шууд холбоос https://anirkh.github.io/ — нээ";
  assert.equal(G.splitLinks(words).map(p => p.text).join(""), words, "nothing is lost or added");
});

test("links are built from words and <a> alone, never from markup", () => {
  const fill = fn("fillMessage");
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(fill));
  assert.match(fn("appendBubble"), /fillMessage\(bubble, text\);/);
});

/* ══════════════════════════════════════════
   Read aloud
══════════════════════════════════════════ */

test("a message from the other side is read out; your own is not", async () => {
  const c = chat();
  c.deliver({ type: "text", ct: "hello there", iv: "iv", msgId: 1 });
  await settle();
  c.type("my reply");
  await c.sendTextMessage();
  assert.deepEqual(c.heard(), [`${I18N.en.srNewMessage}: hello there`]);
  assert.equal(c.log.noticed, 1, "theirs is noticed — a chime if nobody is looking; yours is not");
});

test("a message too long to show is not noticed either; a system note is not", async () => {
  const c = chat();
  c.deliver({ type: "text", ct: "a".repeat(MAX + 1), iv: "iv", msgId: 9 });
  await settle();
  c.appendSys("Connected");
  assert.equal(c.log.noticed, 0);
});

test("system notes are read out", () => {
  const c = chat();
  c.appendSys("Connected");
  assert.deepEqual(c.heard(), ["Connected"]);
});

test("the read-out region keeps only the last few lines, newest last", () => {
  const c = chat();
  for (const s of ["one", "two", "three", "four", "five"]) c.announce(s);
  assert.deepEqual(c.heard(), ["three", "four", "five"]);
  c.announce("");
  assert.deepEqual(c.heard(), ["three", "four", "five"], "nothing empty is announced");
});

test("in Mongolian too", async () => {
  const c = chat({ lang: "mn" });
  c.deliver({ type: "text", ct: "сайн уу", iv: "iv", msgId: 1 });
  await settle();
  assert.deepEqual(c.heard(), [`${I18N.mn.srNewMessage}: сайн уу`]);
  c.type("a".repeat(MAX + 1));
  await c.sendTextMessage();
  assert.equal(c.log.toasts[0], I18N.mn.messageTooLong(MAX));
});

test("the page carries the read-out region and the counter, hidden from view", () => {
  const html = read("index.html");
  const region = html.match(/<div id="srAnnouncer"[^>]*>/);
  assert.ok(region, "index.html has #srAnnouncer");
  assert.match(region[0], /aria-live="polite"/);
  assert.match(region[0], /class="sr-only"/);
  assert.match(read("style.css"), /\.sr-only\s*\{[^}]*clip:\s*rect\(0,\s*0,\s*0,\s*0\)/);
  assert.match(html, /<textarea id="messageInput"[^>]*aria-describedby="messageCounter"/);
  assert.match(html, /<div id="messageCounter" class="message-counter hidden">/);
});
