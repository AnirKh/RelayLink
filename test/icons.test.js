/*
  The icon font, cut down to the icons the app uses.

  Asked about speed: the page loaded Tabler's whole icon font — about 5,900
  icons, 801 KB plus a 242 KB stylesheet — to draw some sixty. Now
  tools/build-icons.js cuts a font and stylesheet holding only the icons the
  page's own files name, from the whole release kept in vendor/tabler/full/.

  Mostly this is here for the day an icon is added: until the cut-down font is
  made again it would be an empty square on screen, and here it fails first,
  saying what to run.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const B = require("../tools/build-icons.js");

const RUN = "run `npm run build-icons` and commit what it writes";
const css  = fs.readFileSync(B.CSS, "utf8");
const font = fs.readFileSync(B.FONT);
const full = B.fullIcons();
const used = B.usedIcons();
const kept = B.cssIcons(css);

test("every icon the app names is in the cut-down font — and nothing it no longer names", () => {
  const missing = used.filter(name => !kept.has(name));
  assert.deepEqual(missing, [], `named in the app but not in the font, so drawn as an empty square: ${missing.join(", ")} — ${RUN}`);
  const extra = [...kept.keys()].filter(name => !used.includes(name));
  assert.deepEqual(extra, [], `in the font but no longer named anywhere: ${extra.join(", ")} — ${RUN}`);
});

test("each icon drawn with the same character as in the whole release", () => {
  for (const [name, code] of kept) assert.equal(code, full.get(name), name);
});

test("the stylesheet and the font were made together: it asks for this font by its own hash", () => {
  const asked = css.match(/tabler-icons\.woff2\?h=([0-9a-f]{12})/);
  assert.ok(asked, "the stylesheet does not ask for the font by hash");
  assert.equal(asked[1], B.fontHash(font), `the font is not the one this stylesheet was made with — ${RUN}`);
  assert.equal(font.subarray(0, 4).toString("latin1"), "wOF2");
});

test("cut down: a few dozen kilobytes, not a megabyte", () => {
  assert.ok(font.length < 60_000, `the font is ${font.length} bytes`);
  assert.ok(css.length < 10_000, `the stylesheet is ${css.length} bytes`);
  assert.ok(used.length >= 50 && used.length < 200, `${used.length} icons`);
  assert.match(css, /^\/\*![\s\S]*Tabler Icons 3\.31\.0[\s\S]*?\*\//, "Tabler's own notice kept at the top");
  assert.match(fs.readFileSync(path.join(path.dirname(B.CSS), "LICENSE"), "utf8"), /^MIT License/);
});

test("icons are found however the app names them: a class, tablerIcon(), a name kept in a list", () => {
  const found = B.usedIcons([
    `<i class="ti ti-microphone"></i>`,
    `toggleMuteBtn.replaceChildren(tablerIcon(isMuted ? "microphone-off" : "camera"));`,
    `const look = { ok: { icon: 'shield-check' } };`,
    "const [icon] = [`bell-ringing`];",
    `const word = "not-an-icon-name";`
  ], full);
  assert.deepEqual(found, ["bell-ringing", "camera", "microphone", "microphone-off", "shield-check"]);
});

test("the whole release is kept to cut from, and the page loads only the cut-down copy", () => {
  assert.ok(full.size > 5000, `${full.size} icons in the whole stylesheet`);
  assert.ok(fs.statSync(B.FULL_FONT).size > 500_000);
  const page = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.ok(!/vendor\/tabler\/full\//.test(page), "the page never loads the whole font");
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.equal(pkg.scripts["build-icons"], "node tools/build-icons.js");
});
