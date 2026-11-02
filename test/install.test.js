/*
  Installing as an app — an icon on the home screen or desktop.

  Chrome, Edge and Samsung Internet offer to install a site with a manifest;
  the page's own Install button, bottom left of the lobby, takes that offer.
  No page can install itself on an iPhone, so there the button shows the taps
  that do it. Already installed, or Firefox: no button.

  The rule is G.installOffer. The button's code — the block in app.js from
  "Install as an app" to the lobby tabs — is lifted out and run against a
  stand-in window, so the real listeners are the ones exercised. The manifest
  and icons are read from disk: a missing or mis-sized icon is the usual
  reason a browser silently declines to offer the install at all.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");
const G      = require("../guards.js");

const ROOT = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\r\n/g, "\n");
const app  = read("app.js");
const html = read("index.html");

const UA = {
  iphone:  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ipad:    "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  ipadOS:  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  mac:     "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0"
};

/* ══════════════════════════════════════════
   The rule
══════════════════════════════════════════ */

test("an iPhone or iPad is recognised, including an iPad calling itself a Mac", () => {
  assert.equal(G.isAppleTouchDevice(UA.iphone, 5), true);
  assert.equal(G.isAppleTouchDevice(UA.ipad, 5), true);
  assert.equal(G.isAppleTouchDevice(UA.ipadOS, 5), true, "iPadOS sends a Mac user agent; the touch screen gives it away");
  assert.equal(G.isAppleTouchDevice(UA.mac, 0), false, "a real Mac has no touch screen");
  assert.equal(G.isAppleTouchDevice(UA.android, 5), false);
  assert.equal(G.isAppleTouchDevice(undefined, undefined), false);
});

test("the browser's own offer is used wherever one comes", () => {
  assert.equal(G.installOffer({ canPrompt: true, userAgent: UA.android, maxTouchPoints: 5 }), "prompt");
  assert.equal(G.installOffer({ canPrompt: true, userAgent: UA.firefox, maxTouchPoints: 0 }), "prompt");
});

test("on an iPhone or iPad with no offer, the button explains the taps", () => {
  assert.equal(G.installOffer({ canPrompt: false, userAgent: UA.iphone, maxTouchPoints: 5 }), "ios-help");
  assert.equal(G.installOffer({ canPrompt: false, userAgent: UA.ipadOS, maxTouchPoints: 5 }), "ios-help");
});

test("no offer and no iPhone — Firefox, say — means no button", () => {
  assert.equal(G.installOffer({ canPrompt: false, userAgent: UA.firefox, maxTouchPoints: 0 }), "none");
  assert.equal(G.installOffer({ canPrompt: false, userAgent: UA.mac, maxTouchPoints: 0 }), "none");
});

test("running as the installed app means no button, whatever else is true", () => {
  for (const userAgent of Object.values(UA)) {
    for (const canPrompt of [true, false]) {
      assert.equal(G.installOffer({ standalone: true, canPrompt, userAgent, maxTouchPoints: 5 }), "none");
    }
  }
  assert.equal(G.installOffer(undefined), "none");
  assert.equal(G.installOffer({ canPrompt: "yes" }), "none", "only a real offer counts");
});

/* ══════════════════════════════════════════
   The button, run
══════════════════════════════════════════ */

const BLOCK = (() => {
  const from = app.indexOf("/* ── Install as an app ──");
  const to   = app.indexOf("/* ── Opened inside another app's browser ───", from);
  assert.ok(from > 0 && to > from, "the install block was not found in app.js");
  return app.slice(from, to);
})();

function element() {
  const set = new Set();
  return { dataset: {}, onclick: null,
           classList: { add: c => set.add(c), remove: c => set.delete(c),
                        toggle: (c, on) => (on ? set.add(c) : set.delete(c)), contains: c => set.has(c) } };
}

function page({ userAgent, maxTouchPoints = 0, standalone = false, iosStandalone = false, inApp = null }) {
  const listeners = {};
  const toasts = [];
  const els = { installBtn: element(), installOverlay: element(), installCloseBtn: element() };
  els.installOverlay.classList.add("hidden");
  const window = {
    matchMedia: q => ({ matches: standalone && q.includes("display-mode: standalone") }),
    addEventListener: (type, fn) => { listeners[type] = fn; }
  };
  const navigator = { userAgent, maxTouchPoints, standalone: iosStandalone || undefined };
  new Function("window", "navigator", "document", "G", "showToast", "t", "_inApp", BLOCK)(
    window, navigator, { getElementById: id => els[id] }, G, (m, k) => toasts.push(m), k => k, inApp);

  /** The browser's install offer, as Chrome sends it. */
  const offer = () => {
    const o = { prevented: 0, prompts: 0, preventDefault() { this.prevented++; },
                prompt() { this.prompts++; }, userChoice: Promise.resolve({ outcome: "accepted" }) };
    listeners.beforeinstallprompt(o);
    return o;
  };
  const shown = () => !els.installBtn.classList.contains("hidden");
  return { ...els, listeners, toasts, offer, shown, click: () => els.installBtn.onclick() };
}

test("Chrome: no button until the browser offers; then one tap opens the browser's install window", async () => {
  const p = page({ userAgent: UA.android, maxTouchPoints: 5 });
  assert.equal(p.shown(), false, "nothing to offer yet");

  const o = p.offer();
  assert.equal(o.prevented, 1, "the browser's own banner is held back; the button is the offer");
  assert.equal(p.shown(), true);

  await p.click();
  assert.equal(o.prompts, 1);
  assert.equal(p.shown(), false, "an offer is good once; the button goes with it");

  await p.click();
  assert.equal(o.prompts, 1, "a spent offer is not shown again");
});

test("once installed, the button goes and the app says so", () => {
  const p = page({ userAgent: UA.android, maxTouchPoints: 5 });
  p.offer();
  p.listeners.appinstalled();
  assert.equal(p.shown(), false);
  assert.deepEqual(p.toasts, ["appInstalled"]);
});

test("iPhone: the button is there from the start and opens the steps, not an install", async () => {
  const p = page({ userAgent: UA.iphone, maxTouchPoints: 5 });
  assert.equal(p.shown(), true);
  await p.click();
  assert.equal(p.installOverlay.classList.contains("hidden"), false);

  p.installCloseBtn.onclick();
  assert.equal(p.installOverlay.classList.contains("hidden"), true, "Got it closes the steps");

  await p.click();
  p.installOverlay.onclick({ target: {} });
  assert.equal(p.installOverlay.classList.contains("hidden"), false, "a tap inside the box keeps it open");
  p.installOverlay.onclick({ target: p.installOverlay });
  assert.equal(p.installOverlay.classList.contains("hidden"), true, "a tap outside it closes it");
});

test("opened from the home-screen icon, there is no button — on an iPhone or anywhere else", () => {
  assert.equal(page({ userAgent: UA.iphone, maxTouchPoints: 5, iosStandalone: true }).shown(), false);
  const desktop = page({ userAgent: UA.android, standalone: true });
  desktop.offer();
  assert.equal(desktop.shown(), false);
});

test("Firefox: no button", () => {
  assert.equal(page({ userAgent: UA.firefox }).shown(), false);
});

/* ══════════════════════════════════════════
   What the browser reads
══════════════════════════════════════════ */

const manifest = JSON.parse(read("manifest.webmanifest"));

/** Width, height and PNG colour type (2 = no transparency, 6 = with). */
function png(file) {
  const b = fs.readFileSync(path.join(ROOT, file));
  assert.deepEqual([...b.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colourType: b[25] };
}

test("the manifest has what Chrome needs before it will offer to install", () => {
  assert.equal(typeof manifest.name, "string");
  assert.ok(manifest.short_name && manifest.short_name.length <= 12, "short enough not to be cut under the icon");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  const any = manifest.icons.filter(i => i.purpose === "any" && i.type === "image/png").map(i => i.sizes);
  assert.ok(any.includes("192x192") && any.includes("512x512"), "192 and 512 pixel icons");
  assert.ok(manifest.icons.some(i => i.purpose === "maskable"), "an icon Android may crop to its own shape");
});

test("every address in the manifest is relative, so it works on GitHub Pages' sub-path and on the server's own copy alike", () => {
  for (const u of [manifest.start_url, manifest.scope, ...manifest.icons.map(i => i.src)]) {
    assert.ok(!/^(\/|https?:)/.test(u), `${u} is not relative`);
  }
});

test("every icon exists at the size the manifest says", () => {
  for (const icon of manifest.icons) {
    assert.ok(fs.existsSync(path.join(ROOT, icon.src)), `${icon.src} is missing`);
    if (icon.type !== "image/png") continue;
    const { width, height } = png(icon.src);
    assert.equal(`${width}x${height}`, icon.sizes, icon.src);
  }
});

test("the icons that are cropped or masked have no see-through corners", () => {
  /* Android crops a maskable icon to its own shape and iOS rounds the
     home-screen icon itself; a transparent corner would show as black. */
  const maskable = manifest.icons.find(i => i.purpose === "maskable");
  assert.equal(png(maskable.src).colourType, 2);
  const apple = png("icons/apple-touch-icon.png");
  assert.equal(apple.colourType, 2);
  assert.equal(`${apple.width}x${apple.height}`, "180x180");
});

test("the page links the manifest and the icons, and the server serves every one", () => {
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest\?v=/);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="icons\/icon\.svg\?v=/);
  assert.match(html, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon\.png\?v=/);
  assert.match(html, /<meta name="theme-color" content="#15151a">/);
  const server = read("server.js");
  for (const file of ["manifest.webmanifest", "icons/apple-touch-icon.png", ...manifest.icons.map(i => i.src)]) {
    assert.ok(server.includes(`"/${file}"`), `server.js does not serve /${file}`);
  }
});

test("the button and the steps are on the page, the button in the lobby", () => {
  const lobby = html.slice(html.indexOf('<div id="lobbyScreen"'), html.indexOf("<!-- JOIN PIN MODAL -->"));
  assert.match(lobby, /<button id="installBtn" class="install-btn hidden"/, "hidden until there is something to offer");
  assert.match(html, /<div id="installOverlay" class="overlay hidden">/);
  assert.match(read("style.css"), /\.install-btn\s*\{[^}]*position:\s*fixed;[^}]*left:[^}]*bottom:/);
});

test("inside another app's browser there is no Install button — nothing can be installed from there", () => {
  assert.equal(G.installOffer({ inApp: true, canPrompt: true, userAgent: UA.android }), "none");
  assert.equal(G.installOffer({ inApp: true, userAgent: UA.iphone, maxTouchPoints: 5 }), "none",
    "not the iPhone steps either: Instagram's browser has no Add to Home Screen");
  assert.equal(page({ userAgent: UA.iphone, maxTouchPoints: 5, inApp: { app: "Instagram", os: "ios" } }).shown(), false);
});
