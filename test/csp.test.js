/*
  The Content-Security-Policy exists twice: as a header from server.js and as a
  <meta> tag in index.html, because GitHub Pages cannot set headers. csp.js is
  the single definition both come from — this makes drift a test failure rather
  than something you notice in production, on the static deployment only.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const { buildCsp, DEFAULT_ALLOWED_ORIGINS, META_CSP, META_TAG_PATTERN } = require("../csp.js");

const indexHtml = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

test("index.html carries a CSP meta tag", () => {
  assert.ok(META_TAG_PATTERN.test(indexHtml));
});

test("the meta tag matches what csp.js generates", () => {
  const match = indexHtml.match(META_TAG_PATTERN);
  assert.equal(match[2], META_CSP, "run `npm run sync-csp` to regenerate index.html");
});

test("frame-ancestors is header-only", () => {
  /* Browsers ignore frame-ancestors in a meta tag; emitting it there would be
     a false sense of protection. The static build gets no header at all — see
     the framebust tests below, which are its only cover. */
  const header = buildCsp(DEFAULT_ALLOWED_ORIGINS, { asHeader: true });
  assert.ok(header.includes("frame-ancestors 'none'"));
  assert.ok(!META_CSP.includes("frame-ancestors"));
});

/* ══════════════════════════════════════════
   Framing — the static deployment

   GitHub Pages sets no headers, so neither frame-ancestors nor
   X-Frame-Options applies there. framebust.js is the whole defence, and it
   only works if it is present, loaded first, and paired with the CSS that
   hides the page until it runs.
══════════════════════════════════════════ */

const framebustSrc = fs.readFileSync(path.join(__dirname, "..", "framebust.js"), "utf8");

test("the page is hidden until the frame check has run", () => {
  /* Failing closed is the point: if framebust.js does not load, a blank page
     is correct and a visible one is a clickable target. */
  assert.match(indexHtml, /<style id="antiClickjack">[^<]*visibility:\s*hidden/,
    "index.html must hide the body up front");
  assert.ok(framebustSrc.includes("antiClickjack"),
    "framebust.js must be the thing that reveals it");
});

test("the frame check loads before any other script", () => {
  const scripts = Array.from(indexHtml.matchAll(/<script[^>]*\bsrc="([^"?]+)/g)).map(m => m[1]);
  assert.ok(scripts.length > 1, "expected the app scripts as well");
  assert.equal(scripts[0], "framebust.js",
    "framebust.js must come first — app.js opens a WebSocket as soon as it parses");
});

test("the frame check refuses to run the app inside a frame", () => {
  assert.match(framebustSrc, /window\.self\s*!==\s*window\.top/,
    "no frame detection found");
  assert.ok(framebustSrc.includes("window.stop()"),
    "must halt parsing so app.js never loads inside a frame");
  assert.match(framebustSrc, /catch\s*\([^)]*\)\s*\{[\s\S]{0,200}framed\s*=\s*true/,
    "a cross-origin throw when reading window.top must count as framed");
});

test("the server serves the frame check", () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/["']\/framebust\.js["']/.test(serverSrc),
    "server.js does not serve framebust.js — its own copy of the page would 404 on it");
});

test("the two forms differ only by frame-ancestors", () => {
  const header = buildCsp(DEFAULT_ALLOWED_ORIGINS, { asHeader: true });
  assert.equal(header.replace("frame-ancestors 'none'; ", ""), META_CSP);
});

test("every allowed origin gets its WebSocket counterpart", () => {
  const csp = buildCsp(["https://example.com", "http://localhost:3000"], { asHeader: true });
  const connect = csp.match(/connect-src ([^;]*)/)[1];
  for (const expected of [
    "https://example.com", "wss://example.com",
    "http://localhost:3000", "ws://localhost:3000", "'self'"
  ]) {
    assert.ok(connect.includes(expected), `connect-src is missing ${expected}`);
  }
});

/* ══════════════════════════════════════════
   Third-party assets
══════════════════════════════════════════ */

/** Every <link> and <script> in index.html pointing off-origin. */
function externalAssetTags() {
  return Array.from(indexHtml.matchAll(/<(?:link|script)\b[^>]*\bhttps?:\/\/[^>]*>/g))
    .map(m => m[0])
    /* The CSP meta tag lists origins in its content attribute; it fetches nothing. */
    .filter(tag => !/http-equiv=/i.test(tag))
    /* Nor does the canonical link: it names the page's own main address for
       search engines, and the browser never loads it. Exactly rel="canonical" —
       anything that does load something still has to carry a hash. */
    .filter(tag => !/^<link rel="canonical" href="https:\/\/[^"]+">$/.test(tag));
}

test("the page loads nothing from another site", () => {
  /* The icon font came from a CDN, which saw every visit — who opened the
     page, and when — and whose trouble took every icon with it. It is served
     from here now. Anything added from elsewhere fails this; if one is ever
     truly needed, it must carry an integrity hash and crossorigin, and this
     test says so rather than letting it in quietly. */
  assert.deepEqual(externalAssetTags(), []);
});

test("styles and fonts may only come from our own origin", () => {
  /* CSS alone can restyle an element — a stylesheet from elsewhere could turn
     the amber shield green, the only thing telling the user nobody has
     verified the connection. */
  for (const csp of [META_CSP, buildCsp(DEFAULT_ALLOWED_ORIGINS, { asHeader: true })]) {
    assert.match(csp, /style-src 'self' 'unsafe-inline';/);
    assert.match(csp, /font-src 'self' data:;/);
    assert.ok(!/jsdelivr|https:\/\/cdn/.test(csp), "no CDN is allowed any more");
  }
});

/* ══════════════════════════════════════════
   The icon font, served from here
══════════════════════════════════════════ */

const crypto = require("node:crypto");
const vendor = name => path.join(__dirname, "..", "vendor", "tabler", name);

test("our copy of the icon stylesheet is Tabler icons 3.31.0 exactly as released", () => {
  /* The hash the page used to demand of the CDN's copy, sha384 of the
     release's own file. The same bytes here mean the same icons, and a copy
     edited by accident — or re-saved with other line endings — fails. */
  const hash = crypto.createHash("sha384").update(fs.readFileSync(vendor("tabler-icons.min.css"))).digest("base64");
  assert.equal(`sha384-${hash}`, "sha384-XAeMOW3g/ahgKWjRcH7Xp+LVEQ/hkKrV0zkAUTnFwlaWK1aXfd9vVufdwqr/836i");
});

test("the font the stylesheet asks for is here, and is a WOFF2 font", () => {
  const css = fs.readFileSync(vendor("tabler-icons.min.css"), "utf8");
  assert.match(css, /url\("\.\/fonts\/tabler-icons\.woff2\?v3\.31\.0"\) format\("woff2"\)/, "it asks for WOFF2 first");
  const font = fs.readFileSync(vendor("fonts/tabler-icons.woff2"));
  assert.equal(font.subarray(0, 4).toString("latin1"), "wOF2", "a WOFF2 file, not a page or an error saved under its name");
  assert.ok(font.length > 500_000, "the whole font, not a cut-down one");
  assert.match(fs.readFileSync(vendor("LICENSE"), "utf8"), /^MIT License/, "with its licence");
});

test("the page and the server both serve it", () => {
  assert.match(indexHtml, /<link rel="stylesheet" href="vendor\/tabler\/tabler-icons\.min\.css\?v=[^"]+">/);
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  for (const file of ["/vendor/tabler/tabler-icons.min.css", "/vendor/tabler/fonts/tabler-icons.woff2"]) {
    assert.ok(serverSrc.includes(`"${file}"`), `server.js does not serve ${file} — its own copy of the page would show no icons`);
  }
  const attributes = fs.readFileSync(path.join(__dirname, "..", ".gitattributes"), "utf8");
  assert.match(attributes, /^vendor\/tabler\/\*\* -text$/m, "kept byte for byte by git, so the hash above holds on every checkout");
});

test("scripts may only come from our own origin", () => {
  /* The app's confidentiality rests on the served JavaScript being ours; a CDN
     or inline allowance here would undo the end-to-end encryption entirely. */
  const csp = buildCsp(DEFAULT_ALLOWED_ORIGINS, { asHeader: true });
  assert.ok(csp.includes("script-src 'self'"));
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
  assert.ok(!/script-src[^;]*unsafe-eval/.test(csp));
});
