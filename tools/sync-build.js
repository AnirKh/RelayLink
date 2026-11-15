#!/usr/bin/env node
/*
  Stamps the client with a build id, so a browser can never run files from two
  different versions without noticing.

    node tools/sync-build.js            restamp if any client file has changed
    node tools/sync-build.js --check    report a stale stamp and exit 1, changing nothing

  WHY THIS EXISTS

  index.html used to load every script as `app.js?v=202608261800` — a stamp
  that was written once and never changed. GitHub Pages lets a browser keep each
  file for ten minutes, each on its own clock, so after an update a browser
  could hold a new page and an old script, or the reverse. Both were reproduced:

    new page + old script   the new button is on screen and does nothing
    old page + new script   the script looks for an element that is not there,
                            throws while loading, and the whole app is dead

  The stamp is the fix for the first: it changes whenever any client file
  changes, so a new page asks for addresses no browser has cached. The second
  is caught by app.js itself, which compares the stamp it was loaded with
  against the one written into it — see "Is this script running in the page
  that was built with it?" at the top of app.js.

  THE ID

      202610131742-3fa9c1d2
      └─ when ──────┘ └─ what ─┘

  "what" is a hash of every client file, so --check can tell whether the stamp
  still describes the files without knowing when it was made. "when" is there
  so two ids can be put in order: the server announces its id, and a page that
  finds itself older than the server knows to fetch the new one.

  The id lives in two places and this tool is the only thing that writes
  either: `const APP_BUILD` in app.js, and `?v=` on each local file index.html
  loads. server.js reads it out of app.js when it starts.
*/

"use strict";

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");

/** Everything a browser downloads from us. A change to any of them is a new build. */
const CLIENT_FILES = [
  "index.html", "style.css",
  "framebust.js", "protocol.js", "connstats.js", "guards.js", "i18n.js",
  "vendor/noble.js", "pake.js", "app.js",
  "manifest.webmanifest", "icons/icon.svg", "icons/apple-touch-icon.png",
  /* The author's photo, in the lobby's top left corner. */
  "icons/author.jpg",
  /* The icon font's stylesheet. The font itself is not listed: index.html
     does not load it (the stylesheet does, at its own ?v3.31.0), and it
     changes only with the stylesheet, which is. */
  "vendor/tabler/tabler-icons.min.css",
  /* The knock worker. index.html does not load it — app.js registers it, at
     sw.js?v=<the build> — so it is hashed but not stamped there. */
  "sw.js",
  /* The shared sound's dip while talking, an AudioWorklet. app.js loads it,
     at duck.js?v=<the build>, so like sw.js it is hashed but not stamped. */
  "duck.js"
];

/** Client files that index.html does not load itself. */
const NOT_IN_PAGE = ["sw.js", "duck.js"];

/* Pictures are hashed as the bytes they are. Read as text, two different
   pictures could hash the same: every byte that is not valid UTF-8 decodes to
   the same replacement character, and the CRLF fold below would edit them. */
const BINARY = /\.(?:png|jpg)$/;

/** The files index.html loads, which is where the stamp has to appear. */
const STAMPED_ASSETS = CLIENT_FILES.filter(f => f !== "index.html" && !NOT_IN_PAGE.includes(f));

const BUILD_ID = /^\d{12}-[0-9a-f]{8}$/;

const assetPattern = () => new RegExp(
  `((?:src|href)="(?:${STAMPED_ASSETS.map(f => f.replace(".", "\\.")).join("|")}))(?:\\?v=([^"]*))?(")`, "g");
const APP_BUILD_LINE = /^(const APP_BUILD = ")([^"]*)(";)/m;

const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");

/** The same text whatever the checkout's line endings, and with the stamp
    itself taken out — otherwise writing the stamp would change the hash that
    the stamp is supposed to describe. */
function normalised(name, text) {
  let out = text.split("\r\n").join("\n");
  if (name === "index.html") out = out.replace(assetPattern(), "$1$3");
  if (name === "app.js")     out = out.replace(APP_BUILD_LINE, "$1$3");
  return out;
}

function contentHash() {
  const hash = crypto.createHash("sha256");
  for (const name of CLIENT_FILES) {
    hash.update(name + "\n");
    hash.update(BINARY.test(name) ? fs.readFileSync(path.join(ROOT, name)) : normalised(name, read(name)));
    hash.update("\n\u0000");
  }
  return hash.digest("hex").slice(0, 8);
}

/** What is stamped right now. */
function currentStamps() {
  const app  = (read("app.js").match(APP_BUILD_LINE) || [])[2];
  const html = {};
  for (const m of read("index.html").matchAll(assetPattern())) {
    html[m[1].replace(/^(?:src|href)="/, "")] = m[2] === undefined ? null : m[2];
  }
  return { app: app === undefined ? null : app, html };
}

/** @returns {{ok: boolean, problems: string[], build: string|null}} */
function check() {
  const problems = [];
  const { app, html } = currentStamps();

  if (app === null)             problems.push("app.js has no `const APP_BUILD = \"…\";` line");
  else if (!BUILD_ID.test(app)) problems.push(`APP_BUILD is not a build id: "${app}"`);

  for (const asset of STAMPED_ASSETS) {
    if (!(asset in html))           problems.push(`index.html does not load ${asset}`);
    else if (html[asset] === null)  problems.push(`index.html loads ${asset} with no ?v= stamp`);
    else if (html[asset] !== app)   problems.push(`index.html loads ${asset}?v=${html[asset]} but APP_BUILD is ${app}`);
  }

  if (app && BUILD_ID.test(app)) {
    const hash = contentHash();
    if (app.split("-")[1] !== hash) {
      problems.push(`the client files have changed since the stamp was written (stamp ${app.split("-")[1]}, files ${hash})`);
    }
  }
  return { ok: problems.length === 0, problems, build: app };
}

function utcStamp(now = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
}

function write() {
  const build = `${utcStamp()}-${contentHash()}`;

  const appPath = path.join(ROOT, "app.js");
  const app = fs.readFileSync(appPath, "utf8");
  if (!APP_BUILD_LINE.test(app)) throw new Error("app.js has no `const APP_BUILD = \"…\";` line to write into");
  fs.writeFileSync(appPath, app.replace(APP_BUILD_LINE, `$1${build}$3`));

  const htmlPath = path.join(ROOT, "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  fs.writeFileSync(htmlPath, html.replace(assetPattern(), `$1?v=${build}$3`));
  return build;
}

function main() {
  const result = check();
  if (result.ok) {
    console.log(`sync-build: stamp is current (${result.build})`);
    return 0;
  }
  if (process.argv.includes("--check")) {
    console.error("sync-build: the build stamp is STALE");
    for (const p of result.problems) console.error(`  - ${p}`);
    console.error("  fix with: npm run sync-build");
    return 1;
  }
  const build = write();
  const after = check();
  if (!after.ok) {
    console.error("sync-build: wrote a stamp but it does not check out:");
    for (const p of after.problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log(`sync-build: stamped ${build}`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { CLIENT_FILES, STAMPED_ASSETS, BUILD_ID, contentHash, currentStamps, check };
