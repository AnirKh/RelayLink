/*
  What a shared link shows.

  Pasted into Messenger, Telegram, Facebook or WhatsApp, the address used to
  arrive bare: no name, no picture, nothing to say what it was. The og:* and
  twitter:* lines in index.html give it a card — name, one line of what it
  is, and icons/link-preview-relaylink.png — and the description is what search
  engines show under the name.

  These check the lines are there and agree with each other and with the
  picture on disk. A preview fetcher reports nothing when it gives up — a
  relative image address, a picture too big, a size that does not match —
  the link simply goes back to arriving bare.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

const meta = (attr, name) => {
  const m = html.match(new RegExp(`<meta ${attr}="${name.replace(/[.:]/g, "\\$&")}" content="([^"]*)">`));
  assert.ok(m, `<meta ${attr}="${name}"> is missing`);
  return m[1];
};
const og = name => meta("property", `og:${name}`);
const tw = name => meta("name", `twitter:${name}`);

const SITE = "https://anirkh.github.io/RelayLink/";

test("the page says what it is, for search engines and for every card", () => {
  const description = meta("name", "description");
  assert.ok(description.length >= 50 && description.length <= 300, `${description.length} characters`);
  assert.equal(og("type"), "website");
  assert.ok(og("title").startsWith("Өртөө"));
  assert.ok(og("description").length >= 30);
  assert.equal(tw("title"), og("title"));
});

test("every address in the card is absolute and points at the address people share", () => {
  /* Preview fetchers do not resolve relative addresses: a relative og:image is
     simply no image. */
  for (const url of [og("url"), og("image"), tw("image")]) {
    assert.ok(url.startsWith(SITE), `${url} is not under ${SITE}`);
  }
  const canonical = html.match(/<link rel="canonical" href="([^"]+)">/);
  assert.ok(canonical, "no canonical link");
  assert.equal(canonical[1], og("url"), "the canonical address and the card's address agree");
});

test("no address in the card carries a fragment or a query", () => {
  /* An invite link's secret lives in its #fragment. Nothing here may ever be
     built from the page's own address, or a shared invite could put its secret
     into a card that the preview service stores. */
  for (const url of [og("url"), og("image"), tw("image"), html.match(/<link rel="canonical" href="([^"]+)">/)[1]]) {
    assert.doesNotMatch(url, /[#?]/, url);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "app.js"), "utf8"), /og:|twitter:/,
    "app.js must not write these lines from the live address");
});

test("the picture exists, at the size the card says, small enough for every app", () => {
  const file = path.join(ROOT, og("image").slice(SITE.length));
  assert.ok(fs.existsSync(file), `${file} is missing`);
  const b = fs.readFileSync(file);
  assert.deepEqual([...b.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "a PNG");
  assert.equal(og("image:type"), "image/png");
  assert.equal(String(b.readUInt32BE(16)), og("image:width"));
  assert.equal(String(b.readUInt32BE(20)), og("image:height"));
  assert.equal(`${og("image:width")}x${og("image:height")}`, "1200x630", "the shape Facebook, Messenger and Telegram draw full width");
  assert.ok(b.length < 300 * 1024, `${Math.round(b.length / 1024)} KB — WhatsApp drops a preview picture over 300 KB`);
  assert.ok(og("image:alt").length > 10, "described for screen readers");
});

test("the large card is asked for, with the same picture", () => {
  assert.equal(tw("card"), "summary_large_image");
  assert.equal(tw("image"), og("image"));
});

test("the Render copy serves the picture too", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.ok(server.includes(`"/${og("image").slice(SITE.length)}"`), "server.js does not serve the preview picture");
});
