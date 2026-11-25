#!/usr/bin/env node
/*
  The icon font, cut down to the icons the app uses.

    npm run build-icons      writes vendor/tabler/tabler-icons.min.css and
                             vendor/tabler/fonts/tabler-icons.woff2

  Asked about speed: the page loaded Tabler's whole icon font — about 5,900
  icons, 801 KB, and a 242 KB stylesheet naming each — to draw some sixty of
  them. The whole release is kept, unchanged, in vendor/tabler/full/, and this
  cuts from it a font holding only the icons named anywhere in the page's own
  files, with a stylesheet for just those.

  "Named anywhere" is wide on purpose: every \`ti-<name>\` and every quoted word
  in index.html and the scripts it loads that is the name of an icon. Icons
  are named in pieces of code that pass the name along — tablerIcon("bell"),
  ["phone", "voiceCall"], { icon: "shield-check" } — and a word that happens to
  be an icon's name costs a few hundred bytes, where an icon left out is an
  empty square on someone's screen. A name put together at run time from
  pieces would not be seen: write icon names out whole.

  After adding an icon to the app, run this again. test/icons.test.js fails,
  saying so, until it has been. Needs subset-font (a development package: the
  server never loads it, and the Pi does not install it).
*/

"use strict";

const fs   = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT      = path.join(__dirname, "..");
const VENDOR    = path.join(ROOT, "vendor", "tabler");
const FULL_CSS  = path.join(VENDOR, "full", "tabler-icons.min.css");
const FULL_FONT = path.join(VENDOR, "full", "tabler-icons.woff2");
const CSS       = path.join(VENDOR, "tabler-icons.min.css");
const FONT      = path.join(VENDOR, "fonts", "tabler-icons.woff2");

/** Every icon in the release: name → its character's code, as hex. */
function fullIcons(css = fs.readFileSync(FULL_CSS, "utf8")) {
  const icons = new Map();
  for (const m of css.matchAll(/\.ti-([a-z0-9-]+):before\{content:"\\([0-9a-f]+)"\}/g)) icons.set(m[1], m[2]);
  return icons;
}

/** The page and every script it loads, as text. */
function clientSources() {
  const page = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const scripts = [...page.matchAll(/<script src="([^"?]+)/g)].map(m => m[1]);
  return [page, ...scripts.map(file => fs.readFileSync(path.join(ROOT, file), "utf8"))];
}

/** The icons the app names: sorted, each one in the release. */
function usedIcons(sources = clientSources(), icons = fullIcons()) {
  const named = new Set();
  for (const text of sources) {
    for (const m of text.matchAll(/\bti-([a-z0-9]+(?:-[a-z0-9]+)*)/g)) named.add(m[1]);
    for (const m of text.matchAll(/["'`]([a-z0-9]+(?:-[a-z0-9]+)*)["'`]/g)) named.add(m[1]);
  }
  return [...named].filter(name => icons.has(name)).sort();
}

/** The icons a stylesheet draws: name → code. */
function cssIcons(css) {
  return fullIcons(css);
}

/** The stylesheet for these icons, its font asked for by that font's own hash. */
function stylesheet(names, icons, fontHash) {
  const full = fs.readFileSync(FULL_CSS, "utf8");
  const banner = full.match(/^\/\*![\s\S]*?\*\//)[0];
  const base = full.match(/\.ti\{[^}]*\}/)[0];
  const rules = names.map(name => `.ti-${name}:before{content:"\\${icons.get(name)}"}`).join("");
  return `${banner}\n/* Cut down by tools/build-icons.js to the ${names.length} icons the app names — npm run build-icons after adding one. */\n` +
    `@font-face{font-family:"tabler-icons";font-style:normal;font-weight:400;font-display:block;` +
    `src:url("./fonts/tabler-icons.woff2?h=${fontHash}") format("woff2")}${base}${rules}\n`;
}

const fontHash = bytes => crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12);

async function build() {
  let subsetFont;
  try { subsetFont = require("subset-font"); }
  catch (_) { throw new Error("subset-font is not installed here — in this folder: npm install --save-dev --save-exact subset-font@2.9.0"); }
  const icons = fullIcons();
  const names = usedIcons(clientSources(), icons);
  const text = names.map(name => String.fromCodePoint(parseInt(icons.get(name), 16))).join("");
  const font = await subsetFont(fs.readFileSync(FULL_FONT), text, { targetFormat: "woff2" });
  fs.mkdirSync(path.dirname(FONT), { recursive: true });
  fs.writeFileSync(FONT, font);
  fs.writeFileSync(CSS, stylesheet(names, icons, fontHash(font)));
  const was = fs.statSync(FULL_FONT).size + fs.statSync(FULL_CSS).size;
  const now = font.length + fs.statSync(CSS).size;
  console.log(`build-icons: ${names.length} icons, ${Math.round(now / 1024)} KB (the whole font and its stylesheet: ${Math.round(was / 1024)} KB)`);
}

module.exports = { fullIcons, usedIcons, cssIcons, clientSources, fontHash, FULL_CSS, FULL_FONT, CSS, FONT };

if (require.main === module) {
  build().catch(err => { console.error("build-icons:", err.message); process.exit(1); });
}
