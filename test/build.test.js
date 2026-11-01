/*
  Tests for the build stamp — what stops a browser running files from two
  different versions.

  The bug it answers was reported as "the new button does nothing, and the
  other person cannot get in". Three mix-ups produced it, all reproduced:

    new page + old script   the button is on screen, with nothing behind it
    old page + new script   the script throws while loading; the whole app is dead
    a tab left open         still runs the old code against the new server, and
                            asks for a PIN the room does not have

  The first is prevented by the stamp, the second by app.js checking the stamp
  it was loaded with, the third by the server announcing its build. The first
  two are tested here; the third's decision is in guards.test.js.

  The first test below is the one that bites in day-to-day work: change any
  client file without restamping and it fails, here and in the pre-commit hook.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const build = require("../tools/sync-build.js");
const G     = require("../guards.js");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const app  = read("app.js");
const html = read("index.html");

/* ══════════════════════════════════════════
   The stamp describes the files
══════════════════════════════════════════ */

test("the build stamp matches the client files — run `npm run sync-build` if this fails", () => {
  const result = build.check();
  assert.ok(result.ok, "the stamp is stale:\n  - " + result.problems.join("\n  - "));
});

test("the stamp is a well-formed build id", () => {
  const { app: id } = build.currentStamps();
  assert.match(id, build.BUILD_ID);
  assert.match(id, /^20\d{10}-/, "the first half should be a UTC date and time");
});

test("every file the page loads from us carries the stamp", () => {
  /* One left out is one a browser may keep an old copy of. */
  const { app: id, html: stamps } = build.currentStamps();
  for (const asset of build.STAMPED_ASSETS) {
    assert.equal(stamps[asset], id, `${asset} is loaded without the current stamp`);
  }
  /* And nothing local slipped in unstamped. */
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
    if (/^https?:/.test(m[1])) continue;                       // the pinned icon font
    assert.match(m[1], /\?v=\d{12}-[0-9a-f]{8}$/, `${m[1]} is loaded with no stamp`);
  }
});

test("the stamp does not depend on line endings", () => {
  /* The same commit is CRLF on a Windows checkout and LF on the server. If the
     hash differed, the check would pass on one and fail on the other. */
  const original = fs.readFileSync;
  const before = build.contentHash();
  fs.readFileSync = (file, ...rest) => {
    const out = original(file, ...rest);
    return typeof out === "string" ? out.split("\r\n").join("\n").split("\n").join("\r\n") : out;
  };
  try { assert.equal(build.contentHash(), before, "CRLF and LF checkouts must hash the same"); }
  finally { fs.readFileSync = original; }
});

test("the server announces the same build the client carries", () => {
  /* One copy, read by the server out of app.js — not a second constant. */
  const server = read("server.js");
  assert.match(server, /const CLIENT_BUILD\b[\s\S]{0,200}?readFileSync\(path\.join\(__dirname, "app\.js"\)/,
    "server.js should read the build id out of app.js");
  const pattern = server.match(/src\.match\((\/\^const APP_BUILD[^\n]*?\/m)\)/);
  assert.ok(pattern, "the pattern server.js uses to find APP_BUILD was not found");
  const found = app.match(eval(pattern[1]));            // the server's own regex, run on the real file
  assert.ok(found, "server.js would not find APP_BUILD in app.js as it is written today");
  assert.equal(found[1], build.currentStamps().app);
});

/* ══════════════════════════════════════════
   app.js refuses to run in a page built for another version — actually run
══════════════════════════════════════════ */

const guardSource = (app.match(/^function refuseToRunInAStalePage\(\)\s*\{[\s\S]*?^\}/m) || [])[0];

/** Runs the real function with a stand-in page and reports what it did. */
function load({ scriptUrl, search = "", hash = "", pathname = "/RelayLink/", scriptBuild = "202610131742-3fa9c1d2" }) {
  const did = { wentTo: null, showedNotice: false, threw: null };
  const document = { currentScript: scriptUrl === null ? null : { src: scriptUrl } };
  const location = { pathname, search, hash, replace: url => { did.wentTo = url; } };
  const showStalePageNotice = () => { did.showedNotice = true; };
  try {
    new Function("document", "location", "showStalePageNotice", "APP_BUILD", "URL", "URLSearchParams",
      `${guardSource}; refuseToRunInAStalePage();`)(document, location, showStalePageNotice, scriptBuild, URL, URLSearchParams);
  } catch (err) { did.threw = err.message; }
  return did;
}
const SITE = "https://anirkh.github.io/RelayLink/";

test("the guard is where the test expects it, and runs before anything else", () => {
  assert.ok(guardSource, "refuseToRunInAStalePage not found as a top-level function in app.js");
  const call = app.search(/^refuseToRunInAStalePage\(\);/m);
  assert.ok(call > -1, "the guard is defined but never called");
  for (const [what, pattern] of [
    ["reading the invite", /DC\.parseInviteHash\(location\.hash\)/],
    ["touching the page", /document\.getElementById\(/],
    ["opening the socket", /^connectWebSocket\(\);/m]
  ]) {
    const at = app.search(pattern);
    assert.ok(at > call, `the guard must run before ${what}`);
  }
});

test("a page and script from the same build start normally", () => {
  const did = load({ scriptUrl: SITE + "app.js?v=202610131742-3fa9c1d2" });
  assert.deepEqual(did, { wentTo: null, showedNotice: false, threw: null });
});

test("a script loaded by an older page fetches a fresh page and does not start", () => {
  /* The reproduced crash: the old page has no open-room button, the new script
     reaches for it, and nothing on the page works afterwards. */
  const did = load({ scriptUrl: SITE + "app.js?v=202608261800" });
  assert.equal(did.wentTo, "/RelayLink/?r=202610131742-3fa9c1d2");
  assert.ok(did.threw, "the script must stop, not carry on into a page it does not match");
  assert.equal(did.showedNotice, false);
});

test("the invite survives the trip to a fresh page, and stays out of the query string", () => {
  const invite = "#room:token123:secretABC";
  const did = load({ scriptUrl: SITE + "app.js?v=202608261800", hash: invite });
  assert.ok(did.wentTo.endsWith(invite), "the invite fragment must be carried over");
  assert.ok(!did.wentTo.split("#")[0].includes("secretABC"), "the room secret must never move into the query string");
});

test("if fetching a fresh page did not help, it says so instead of looping", () => {
  const did = load({ scriptUrl: SITE + "app.js?v=202608261800", search: "?r=202610131742-3fa9c1d2" });
  assert.equal(did.wentTo, null, "must not redirect a second time");
  assert.equal(did.showedNotice, true);
  assert.ok(did.threw, "and must still not start");
});

test("a manual retry from the notice is recognised as a retry too", () => {
  const did = load({ scriptUrl: SITE + "app.js?v=202608261800", search: "?r=202610131742-3fa9c1d2.1791234567890" });
  assert.equal(did.wentTo, null);
  assert.equal(did.showedNotice, true);
});

test("with no stamp to read, the script starts rather than guessing", () => {
  /* A proxy that strips query strings, or a page that loads the script some
     other way. Refusing here would break the app for a reason nobody could see. */
  assert.equal(load({ scriptUrl: SITE + "app.js" }).threw, null);
  assert.equal(load({ scriptUrl: null }).threw, null);
});

/* ══════════════════════════════════════════
   A page left open
══════════════════════════════════════════ */

const OLD = "202610130900-aaaaaaaa", NEW = "202610131742-bbbbbbbb";
const page = o => Object.assign({ serverBuild: NEW, pageBuild: OLD, retriedFor: null, recentlyReloaded: false, busy: false }, o);

test("an idle page that is older than the server fetches the new one", () => {
  /* The tab left open on the other person's phone: it showed a room with no
     PIN as one that needs one, and they could not get in. */
  assert.equal(G.updateAction(page({})), "reload");
});

test("a page in the middle of something waits until it is done", () => {
  assert.equal(G.updateAction(page({ busy: true })), "later");
});

test("the same build, or an older server, changes nothing", () => {
  assert.equal(G.updateAction(page({ serverBuild: OLD })), "none");
  /* The static site updated first and the server is still restarting. */
  assert.equal(G.updateAction(page({ serverBuild: OLD, pageBuild: NEW })), "none");
});

test("a page that already fetched for this build does not fetch again", () => {
  assert.equal(G.updateAction(page({ retriedFor: NEW })), "notify");
  assert.equal(G.updateAction(page({ retriedFor: NEW + ".1791234567890" })), "notify");
  assert.equal(G.updateAction(page({ recentlyReloaded: true })), "notify");
});

test("fetching for an earlier build does not block fetching for a later one", () => {
  assert.equal(G.updateAction(page({ retriedFor: "202610131200-cccccccc" })), "reload");
});

test("nothing malformed can talk a page into reloading", () => {
  for (const bad of [undefined, null, "", "latest", "999999999999", "202610131742", "202610131742-XYZ", 202610131742, {}, "202610131742-bbbbbbbb<script>"]) {
    assert.equal(G.updateAction(page({ serverBuild: bad })), "none", `serverBuild=${JSON.stringify(bad)}`);
    assert.equal(G.isNewerBuild(bad, OLD), false);
    assert.equal(G.isNewerBuild(NEW, bad), false);
  }
  assert.equal(G.updateAction(undefined), "none");
});

test("builds are ordered by when they were made, not by their hash", () => {
  assert.equal(G.isNewerBuild("202610131742-00000000", "202610131741-ffffffff"), true);
  assert.equal(G.isNewerBuild("202610131741-ffffffff", "202610131742-00000000"), false);
  assert.equal(G.isNewerBuild(NEW, NEW), false);
});

test("a changed picture changes the stamp, even where a text reading could not tell", () => {
  /* The icons are part of the build. Read as text, every byte that is not
     valid UTF-8 decodes to the same replacement character — so changing the
     PNG signature's 0x89 to 0x8A, both invalid on their own, would leave the
     hash unchanged and an old icon in browsers' caches. Pictures are hashed
     as the bytes they are. */
  const icon = path.join(__dirname, "..", "icons", "apple-touch-icon.png");
  assert.ok(build.CLIENT_FILES.includes("icons/apple-touch-icon.png"));
  const before = build.contentHash();
  const realRead = fs.readFileSync;
  fs.readFileSync = function (file, ...rest) {
    const out = realRead.call(this, file, ...rest);
    if (path.resolve(String(file)) !== path.resolve(icon) || rest.length) return out;
    const copy = Buffer.from(out);
    copy[0] = 0x8a;
    return copy;
  };
  try {
    assert.notEqual(build.contentHash(), before);
  } finally {
    fs.readFileSync = realRead;
  }
  assert.equal(build.contentHash(), before);
});
