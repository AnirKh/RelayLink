/*
  A picture opened in the chat, and files pasted or dropped into it — actually run.

  - A picture in the chat opened in a new browser tab, which on a phone took
    the person out of the chat. It now opens over the chat: fitted, a tap to
    zoom in where it lands, a tap to fit again; Save, ✕, Esc, a tap on the
    dark round it, and the phone's Back (see back.test.js) close it.
  - On a computer a file reached the chat only through the paperclip menu.
    A picture pasted into the message box is sent; files dropped on the chat
    are sent one after another; a file dropped anywhere else no longer opens
    in the tab in place of the page.

  The two blocks are lifted out of app.js and run against stand-in elements.
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

const BLOCK = between("/* ══════════════════════════════════════════════\n   PICTURE VIEWER",
                      "/* ══════════════════════════════════════════════\n   REACTIONS");

function classes(initial = []) {
  const set = new Set(initial);
  return { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c) };
}

function element(extra = {}) {
  const listeners = {};
  const el = {
    classList: classes(extra.hidden ? ["hidden"] : []), style: {}, textContent: "", focused: 0,
    addEventListener: (type, f) => { listeners[type] = f; },
    removeAttribute(name) { delete el[name]; },
    focus() { el.focused++; },
    fire: (type, e) => listeners[type] && listeners[type](e),
    ...extra
  };
  return el;
}

/** The chat page: the viewer's elements, the message box, the chat screen. */
function page({ fitted = { left: 20, top: 100, width: 300, height: 200 } } = {}) {
  const log = { sent: [], order: [] };
  const els = {
    imageViewer: element({ hidden: true }),
    imageViewerStage: element({ getBoundingClientRect: () => ({ left: 0, top: 60, width: 340, height: 600 }), scrollLeft: 0, scrollTop: 0 }),
    imageViewerImg: element({ getBoundingClientRect: () => fitted }),
    imageViewerName: element(), imageViewerSave: element(), imageViewerClose: element(),
    dropHint: element({ hidden: true })
  };
  /* Its drawn size follows the width the viewer gives it, keeping its shape. */
  const img = els.imageViewerImg;
  Object.defineProperty(img, "offsetWidth", { get: () => parseFloat(img.style.width) || fitted.width });
  Object.defineProperty(img, "offsetHeight", { get: () => img.offsetWidth * fitted.height / (fitted.width || 1) });
  const opener = element();
  const docListeners = {}, winListeners = {};
  const document = {
    getElementById: id => els[id], get activeElement() { return opener; },
    addEventListener: (type, f) => { docListeners[type] = f; }
  };
  const window = { addEventListener: (type, f) => { winListeners[type] = f; } };
  const messageInput = element(), chatScreen = element();
  let release = null;
  const sendBinary = (file, kind) => {
    log.order.push(`start ${file.name}`);
    return new Promise(r => { release = () => { log.sent.push({ name: file.name, kind }); log.order.push(`end ${file.name}`); r(); }; });
  };
  const api = new Function("G", "t", "document", "window", "messageInput", "chatScreen", "sendBinary", `
    ${BLOCK}
    return { openImageViewer, closeImageViewer, viewingImage, sendFiles };`
  )(G, k => k, document, window, messageInput, chatScreen, sendBinary);
  const event = (extra = {}) => { const e = { prevented: false, preventDefault() { e.prevented = true; }, stopPropagation() {}, ...extra }; return e; };
  return { ...api, els, log, opener, docListeners, winListeners, messageInput, chatScreen, event,
           finishSend: () => release && release(), viewer: els.imageViewer };
}

/* ══════════════════════════════════════════
   The picture viewer
══════════════════════════════════════════ */

test("a picture opens over the chat, named, with Save — not in a new tab", () => {
  const p = page();
  p.openImageViewer("blob:x/1", "cat.png");
  assert.equal(p.viewingImage(), true);
  assert.equal(p.els.imageViewerImg.src, "blob:x/1");
  assert.equal(p.els.imageViewerImg.alt, "cat.png");
  assert.equal(p.els.imageViewerName.textContent, "cat.png");
  assert.equal(p.els.imageViewerSave.href, "blob:x/1");
  assert.equal(p.els.imageViewerSave.download, "cat.png", "Save keeps it under its own name");
  assert.equal(p.els.imageViewerClose.focused, 1, "the keyboard lands on Close");
  assert.ok(!/window\.open\(/.test(app), "nothing in the app opens a new tab any more");
});

test("a tap zooms in where it lands; another fits it again", () => {
  const p = page();
  p.openImageViewer("blob:x/1", "cat.png");
  const img = p.els.imageViewerImg, stage = p.els.imageViewerStage;
  img.fire("click", p.event({ clientX: 245, clientY: 150 }));    // three quarters across, a quarter down
  assert.equal(p.viewer.classList.contains("zoomed"), true);
  assert.equal(img.style.width, "750px", "two and a half times the fitted width");
  assert.equal(stage.scrollLeft, 0.75 * 750 - 245, "the point tapped stays under the finger");
  assert.equal(stage.scrollTop, 0.25 * 500 - 90);
  img.fire("click", p.event({ clientX: 10, clientY: 10 }));
  assert.equal(p.viewer.classList.contains("zoomed"), false);
  assert.equal(img.style.width, "");
});

test("a picture not yet drawn is not zoomed into nothing", () => {
  const p = page({ fitted: { left: 0, top: 0, width: 0, height: 0 } });
  p.openImageViewer("blob:x/1", "cat.png");
  p.els.imageViewerImg.fire("click", p.event({ clientX: 5, clientY: 5 }));
  assert.equal(p.viewer.classList.contains("zoomed"), false);
});

test("a tap on the dark round it: out of a zoom first, then closed", () => {
  const p = page();
  p.openImageViewer("blob:x/1", "cat.png");
  const stage = p.els.imageViewerStage;
  p.els.imageViewerImg.fire("click", p.event({ clientX: 100, clientY: 150 }));
  stage.fire("click", p.event({ target: stage }));
  assert.equal(p.viewer.classList.contains("zoomed"), false);
  assert.equal(p.viewingImage(), true, "still open");
  stage.fire("click", p.event({ target: stage }));
  assert.equal(p.viewingImage(), false);
  stage.fire("click", p.event({ target: p.els.imageViewerImg }));     // a click that began on the picture is not this
});

test("✕ and Esc close it, letting go of the picture and giving the focus back", () => {
  const p = page();
  p.openImageViewer("blob:x/1", "cat.png");
  p.docListeners.keydown({ key: "a" });
  assert.equal(p.viewingImage(), true, "other keys do nothing");
  p.docListeners.keydown({ key: "Escape" });
  assert.equal(p.viewingImage(), false);
  assert.equal(p.els.imageViewerImg.src, undefined, "the picture is let go of");
  assert.equal(p.opener.focused, 1, "back where the keyboard was");
  p.openImageViewer("blob:x/2", "");
  assert.equal(p.els.imageViewerSave.download, "image", "a picture with no name still saves under one");
  p.els.imageViewerClose.onclick();
  assert.equal(p.viewingImage(), false);
  p.closeImageViewer();                                             // twice: nothing more happens
  assert.equal(p.opener.focused, 2);
});

test("opened from both kinds of picture bubble; closed before a chat is left", () => {
  assert.match(fn("resolveImageNow"), /img\.onclick = \(\) => openImageViewer\(url, name\);/);
  assert.match(fn("resolveImagePlaceholder"), /img\.onload  = \(\) => \{ img\.onclick = \(\) => openImageViewer\(url, name\); \};/);
  assert.match(between("leaveBtn.onclick = (e) => {", "keepScreenOn(false);"), /closeImageViewer\(\);/,
    "first, before the chat's pictures are let go of");
  const back = between('window.addEventListener("popstate", () => {', "\n});");
  assert.match(back, /viewing: viewingImage\(\)/);
  assert.match(back, /if \(action === "close"\) \{ closeImageViewer\(\); armBackGuard\(\); return; \}/);
});

test("the viewer is a dialog over the call and every window — the offline messages it opens from among them — under only an incoming call", () => {
  assert.match(html, /<div id="imageViewer" class="image-viewer hidden" role="dialog" aria-modal="true"/);
  assert.match(html, /<a id="imageViewerSave"[^>]*download data-i18n-aria="imageSave"/);
  assert.match(html, /<button id="imageViewerClose"[^>]*data-i18n-aria="imageClose"/);
  /* The z-index of the rule that starts a line with `sel {`. */
  const layer = sel => {
    const rule = css.slice(css.indexOf(`\n${sel} {`) + 1);
    return Number(rule.slice(0, rule.indexOf("}")).match(/z-index:\s*(\d+)/)[1]);
  };
  const z = layer(".image-viewer");
  assert.ok(z > layer(".overlay"), `z-index ${z}: over every window, the offline messages among them`);
  assert.ok(z > layer(".author") && z > layer(".lang-switcher"), "and over the corner buttons");
  assert.ok(z < layer("#callRequestModal"), "under an incoming call's question, which still comes first");
  assert.match(html, /<div id="callRequestModal" class="overlay hidden">/);
});

/* ══════════════════════════════════════════
   Paste or drop a file
══════════════════════════════════════════ */

const file = (name, type) => ({ name, type });

test("what a pasted or dropped file is sent as", () => {
  assert.equal(G.droppedKind("image/png"), "image");
  assert.equal(G.droppedKind("IMAGE/JPEG; q=1"), "image");
  assert.equal(G.droppedKind("image/svg+xml"), "image", "presentAs still sends it as a file — see receive.test.js");
  assert.equal(G.droppedKind("application/pdf"), "file");
  assert.equal(G.droppedKind(""), "file");
  assert.equal(G.droppedKind(undefined), "file");
});

test("several photos, or files, can be chosen at once — the pickers took one", () => {
  assert.match(html, /<input type="file" id="imageInput" accept="image\/\*" multiple class="hidden">/);
  assert.match(html, /<input type="file" id="fileInput" multiple class="hidden">/);
});

test("every one chosen is sent, as the button said, and the picker is emptied for the same ones again", () => {
  for (const [picker, kind] of [["imageInput", "image"], ["fileInput", "file"]]) {
    const handler = between(`${picker}.onchange = () => {`, "\n};") + "\n};";
    const calls = [];
    const input = { files: [file("a.png", "image/png"), file("b.jpg", "image/jpeg"), file("c.pdf", "application/pdf")], value: "C:\\fakepath\\a.png" };
    const seenAtSend = [];
    new Function(picker, "sendFiles", `${handler}\n${picker}.onchange();`)(input, (files, k) => { calls.push({ names: files.map(f => f.name), k }); seenAtSend.push(input.value); });
    assert.deepEqual(calls, [{ names: ["a.png", "b.jpg", "c.pdf"], k: kind }], picker);
    assert.deepEqual(seenAtSend, [""], `${picker}: emptied, so picking the same ones again is a change`);
  }
});

test("the photo and file buttons decide what each is sent as; a drop decides by the file", async () => {
  const p = page();
  const sending = p.sendFiles([file("a.png", "image/png")], "file");
  p.finishSend();
  await sending;
  assert.deepEqual(p.log.sent, [{ name: "a.png", kind: "file" }], "a picture sent with the file button stays a file");
});

test("a picture pasted into the message box is sent; text pastes as text", async () => {
  const p = page();
  const shot = p.event({ clipboardData: { files: [file("Screenshot.png", "image/png")] } });
  p.messageInput.fire("paste", shot);
  assert.equal(shot.prevented, true, "not pasted into the box as well");
  p.finishSend();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(p.log.sent, [{ name: "Screenshot.png", kind: "image" }]);

  const words = p.event({ clipboardData: { files: [] } });
  p.messageInput.fire("paste", words);
  assert.equal(words.prevented, false, "text goes in the box as always");
});

test("files dropped on the chat are sent one after another, each as what it is", async () => {
  const p = page();
  const drop = p.event({ dataTransfer: { types: ["Files"], files: [file("a.png", "image/png"), file("b.pdf", "application/pdf")] } });
  p.chatScreen.fire("drop", drop);
  assert.equal(drop.prevented, true, "not opened in the tab");
  assert.deepEqual(p.log.order, ["start a.png"], "the second waits for the first");
  p.finishSend();
  await new Promise(r => setImmediate(r));
  p.finishSend();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(p.log.sent, [{ name: "a.png", kind: "image" }, { name: "b.pdf", kind: "file" }]);
  assert.deepEqual(p.log.order, ["start a.png", "end a.png", "start b.pdf", "end b.pdf"]);
});

test("while files are dragged over the chat it says where to drop them", () => {
  const p = page();
  const files = () => p.event({ dataTransfer: { types: ["Files"], files: [] } });
  p.chatScreen.fire("dragenter", files());
  assert.equal(p.els.dropHint.classList.contains("hidden"), false);
  p.chatScreen.fire("dragenter", files());          // over a child
  p.chatScreen.fire("dragleave", files());          // off that child
  assert.equal(p.els.dropHint.classList.contains("hidden"), false, "still over the chat");
  p.chatScreen.fire("dragleave", files());
  assert.equal(p.els.dropHint.classList.contains("hidden"), true, "gone once off it");
  const over = files();
  p.chatScreen.fire("dragover", over);
  assert.equal(over.prevented, true, "the chat takes the drop");
  p.chatScreen.fire("dragenter", files());
  p.chatScreen.fire("drop", files());
  assert.equal(p.els.dropHint.classList.contains("hidden"), true, "and goes on the drop");
});

test("dragging text or a link over the chat is left alone", () => {
  const p = page();
  const text = p.event({ dataTransfer: { types: ["text/plain"], files: [] } });
  p.chatScreen.fire("dragenter", text);
  p.chatScreen.fire("drop", text);
  assert.equal(text.prevented, false);
  assert.equal(p.els.dropHint.classList.contains("hidden"), true);
  assert.deepEqual(p.log.order, []);
});

test("a file dropped anywhere else no longer opens in place of the page — which ended the chat", () => {
  const p = page();
  for (const type of ["dragover", "drop"]) {
    const e = p.event({ dataTransfer: { types: ["Files"], files: [] } });
    p.winListeners[type](e);
    assert.equal(e.prevented, true, type);
    const words = p.event({ dataTransfer: { types: ["text/plain"] } });
    p.winListeners[type](words);
    assert.equal(words.prevented, false, `${type}: text is not stopped`);
  }
  assert.match(css, /\.drop-hint \{[^}]*pointer-events:\s*none;/, "the drop lands on the chat, not on the hint");
});
