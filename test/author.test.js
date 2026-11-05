/*
  The author, at the top left of the lobby.

  Asked for: the author's photo and name in the app — a small round photo at
  the lobby's top left that, tapped, says briefly who made it, with LinkedIn,
  Facebook and YouTube as icons. No degree, workplace, email or phone number:
  the app is the way to reach them.

  The page's markup and words are checked as text; the closing — a tap
  elsewhere, or Escape — is lifted out of app.js and run.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const root = path.join(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8").replace(/\r\n/g, "\n");
const html = read("index.html");
const app  = read("app.js");
const I18N = new Function("localStorage", `${read("i18n.js")}; return I18N;`)({ getItem: () => null });
const build = require("../tools/sync-build.js");

const lobby = html.slice(html.indexOf('<div id="lobbyScreen"'), html.indexOf('<div class="lobby-wrap">'));
const panel = (lobby.match(/<details id="authorDropdown"[\s\S]*?<\/details>/) || [""])[0];

test("a small round photo at the lobby's top left, named in the page's language", () => {
  assert.ok(panel, "the author's panel is in the lobby, before its content");
  const summary = panel.match(/<summary class="author-btn" data-i18n-aria="([^"]+)"[^>]*>\s*<img src="icons\/author\.jpg\?v=[^"]+" alt=""/);
  assert.ok(summary, "the photo is the button, stamped with the build");
  for (const lang of ["mn", "en"]) assert.equal(typeof I18N[lang][summary[1]], "string", `${lang}.${summary[1]}`);
  const css = read("style.css");
  assert.match(css, /\.author \{ position: fixed; top: 10px; left: 10px;/, "top left — the language switch is top right");
});

test("tapped: the name and a few words, in both languages", () => {
  assert.match(panel, /<div class="author-name">Anir Khurelbaatar<\/div>/);
  assert.match(panel, /<p data-i18n="authorAbout">/);
  for (const lang of ["mn", "en"]) {
    assert.ok(I18N[lang].authorAbout.length > 20, `${lang}.authorAbout`);
    assert.ok(I18N[lang].authorAbout.length < 220, "briefly");
  }
});

test("no degree, workplace, email or phone — the app is the way to reach them", () => {
  /* Without the build stamps: "…1239-7070…" in one reads as a phone number. */
  const text = [panel.replace(/\?v=[^"]*/g, ""), I18N.mn.authorAbout, I18N.en.authorAbout].join("\n");
  /* An address: name@domain.tld — not a YouTube handle's @. */
  for (const kept of [/[a-z0-9._%+-]+@[a-z0-9-]+\.[a-z]{2,}/i, /\+\d/, /\d{3}-\d{4}/, /\bMD\b/, /\bPh\.?D\b/i, /Jichi/i, /University/i, /mailto:|tel:/i]) {
    assert.doesNotMatch(text, kept);
  }
});

test("LinkedIn, Facebook and YouTube as icons — each a new tab, giving nothing of this page away, and named for a screen reader", () => {
  const links = [...panel.matchAll(/<a href="([^"]+)" target="_blank" rel="([^"]+)" title="([^"]+)">\s*<i class="ti ti-brand-([a-z]+)" aria-hidden="true"><\/i><span class="sr-only">([^<]+)<\/span>/g)];
  assert.deepEqual(links.map(l => l[3]), ["LinkedIn", "Facebook", "YouTube"]);
  for (const [, href, rel, title, icon, name] of links) {
    assert.match(href, /^https:\/\/www\.(linkedin|facebook|youtube)\.com\//);
    assert.ok(rel.split(" ").includes("noopener") && rel.split(" ").includes("noreferrer"), `${title}: ${rel}`);
    assert.equal(icon, title.toLowerCase());
    assert.equal(name, title);
  }
  assert.equal((panel.match(/<a /g) || []).length, 3, "and no other link");
});

test("the photo is small, a JPEG, served by the server, and part of the build", () => {
  const bytes = fs.readFileSync(path.join(root, "icons", "author.jpg"));
  assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xd8, "a JPEG");
  assert.ok(bytes.length < 20_000, `${bytes.length} bytes: a photo for a 38-pixel circle need not weigh more`);
  assert.ok(read("server.js").includes('"/icons/author.jpg"'), "server.js serves it");
  assert.ok(build.CLIENT_FILES.includes("icons/author.jpg"), "a new photo is a new build");
  assert.match(read("tools/sync-build.js"), /const BINARY = \/\\\.\(\?:png\|jpg\)\$\//, "hashed as the bytes it is");
});

/* ── Opening and closing, actually run ── */

function lobbyPage() {
  const block = app.slice(app.indexOf("const authorDropdown"), app.indexOf("/** Both create buttons"));
  const listeners = {};
  const author = { id: "author", open: false, contains: el => el === "author" || el === "author-inside" };
  new Function("document", block)(
    { getElementById: id => (id === "authorDropdown" ? author : null),
      addEventListener: (type, f) => { listeners[type] = f; } });
  return { author, tap: target => listeners.click({ target }), key: key => listeners.keydown({ key }) };
}

test("a tap elsewhere closes the author panel; a tap inside it does not", () => {
  const p = lobbyPage();
  p.author.open = true;
  p.tap("author-inside");
  assert.equal(p.author.open, true, "reading it, or a link inside it");
  p.tap("somewhere");
  assert.equal(p.author.open, false);
});

test("Escape closes it", () => {
  const p = lobbyPage();
  p.author.open = true;
  p.key("a");
  assert.equal(p.author.open, true);
  p.key("Escape");
  assert.equal(p.author.open, false);
});
