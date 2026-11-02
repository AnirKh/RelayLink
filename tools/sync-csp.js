#!/usr/bin/env node
/*
  Rewrites the <meta> Content-Security-Policy in index.html from csp.js.

    node tools/sync-csp.js            rewrite index.html if it has drifted
    node tools/sync-csp.js --check    report drift and exit 1, changing nothing

  The check form is the one to run before deploying: the meta tag is the only
  policy the GitHub Pages build gets, so a stale one there is a real bug that
  the server's own copy will not reveal.
*/

"use strict";

const fs   = require("fs");
const path = require("path");
const { META_CSP, META_TAG_PATTERN } = require("../csp");

const INDEX_PATH = path.join(__dirname, "..", "index.html");
const checkOnly  = process.argv.includes("--check");

let html;
try {
  html = fs.readFileSync(INDEX_PATH, "utf8");
} catch (err) {
  console.error(`sync-csp: cannot read ${INDEX_PATH} — ${err.message}`);
  process.exit(1);
}

const match = html.match(META_TAG_PATTERN);
if (!match) {
  console.error("sync-csp: no Content-Security-Policy meta tag found in index.html.");
  console.error("          Expected: <meta http-equiv=\"Content-Security-Policy\" content=\"...\">");
  process.exit(1);
}

if (match[2] === META_CSP) {
  console.log("sync-csp: index.html is already in sync with csp.js");
  process.exit(0);
}

if (checkOnly) {
  console.error("sync-csp: index.html CSP has DRIFTED from csp.js");
  console.error(`  meta tag: ${match[2]}`);
  console.error(`  expected: ${META_CSP}`);
  console.error("  fix with: npm run sync-csp");
  process.exit(1);
}

fs.writeFileSync(INDEX_PATH, html.replace(META_TAG_PATTERN, `$1${META_CSP}$3`));
console.log("sync-csp: index.html meta tag updated from csp.js");
