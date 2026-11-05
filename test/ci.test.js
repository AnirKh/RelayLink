/*
  The tests, run on GitHub — .github/workflows/tests.yml.

  The local hooks only guard the machine they are installed on, and two
  computers push here. So GitHub runs the same checks on every push to main
  and every pull request, on the oldest Node the app supports and on the one
  the Pi runs.

  `npm run test:ci` is `npm test` with one more reporter,
  tools/github-reporter.mjs: a job's log is shown only to people signed in,
  so each failure is also put on the run's public page. Two ways that could
  quietly go wrong are checked here: test:ci drifting from test (a file
  pattern added to one only), and the reporter options moving after the file
  patterns — where node --test ignores them without a word.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const os     = require("node:os");
const path   = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8").replace(/\r\n/g, "\n");
const pkg = JSON.parse(read("package.json"));
const workflow = read(".github/workflows/tests.yml");

/** The quoted file patterns a script hands node --test. */
const patterns = script => [...script.matchAll(/"([^"]+)"/g)].map(m => m[1]);

test("GitHub runs the checks the hooks run, on every push to main and every pull request", () => {
  assert.match(workflow, /^on:\n  push:\n    branches: \[main\]\n  pull_request:/m);
  const runs = [...workflow.matchAll(/^\s+- run: (.+)$/gm)].map(m => m[1]);
  assert.deepEqual(runs, ["npm ci --no-audit --no-fund", "npm run check-csp", "npm run check-build", "npm run test:ci"]);
  assert.match(workflow, /node: \[22, 24\]/, "the oldest Node engines allows, and the Pi's");
  assert.equal(pkg.engines.node, ">=22", "the oldest one tested is the oldest one allowed");
  assert.match(workflow, /^permissions:\n  contents: read$/m, "it only reads the code");
});

test("test:ci runs exactly what npm test runs, with its reporters before the files", () => {
  const ci = pkg.scripts["test:ci"];
  assert.deepEqual(patterns(ci), patterns(pkg.scripts.test), "the same files — one cannot gain a directory the other lacks");
  const firstFile = ci.indexOf('"');
  for (const option of ["--test-reporter=spec", "--test-reporter=./tools/github-reporter.mjs"]) {
    const at = ci.indexOf(option);
    assert.ok(at > -1 && at < firstFile, `${option} comes before the files, or node --test ignores it`);
  }
  assert.equal((ci.match(/--test-reporter-destination=stdout/g) || []).length, 2, "one destination for each reporter");
});

/** Runs the reporter over the given events, as node --test would. */
async function report(events, summaryFile) {
  const { default: reporter } = await import(pathToFileURL(path.join(ROOT, "tools/github-reporter.mjs")).href);
  async function* source() { yield* events; }
  const before = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) process.env.GITHUB_STEP_SUMMARY = summaryFile; else delete process.env.GITHUB_STEP_SUMMARY;
  try {
    let out = "";
    for await (const chunk of reporter(source())) out += chunk;
    return out;
  } finally {
    if (before === undefined) delete process.env.GITHUB_STEP_SUMMARY; else process.env.GITHUB_STEP_SUMMARY = before;
  }
}

const failure = (name, file, line, cause, failureType = "testCodeFailure") =>
  ({ type: "test:fail", data: { name, file, line, details: { error: Object.assign(new Error("test failed"), { failureType, cause }) } } });

test("each failure becomes an annotation on its file and line, and a section of the run's summary", async () => {
  const summary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ci-test-")), "summary.md");
  const file = path.join(process.cwd(), "test", "integration", "notes.test.js");
  const out = await report([
    { type: "test:pass", data: { name: "fine" } },
    failure("a note, kept: until deleted", file, 42, new Error("expected 2\nbut got 1")),
    failure("a parent", file, 10, null, "subtestsFailed")
  ], summary);
  assert.equal(out, "::error file=test/integration/notes.test.js,line=42,title=a note%2C kept%3A until deleted::Error: expected 2\n",
    "one line, encoded as GitHub reads it; the parent of a failed subtest is not reported again");
  const md = fs.readFileSync(summary, "utf8");
  assert.match(md, /^## 1 failing test \(Node \d+\.\d+\.\d+\)/);
  assert.match(md, /### ✖ a note, kept: until deleted/);
  assert.match(md, /`test\/integration\/notes\.test\.js:42`/);
  assert.match(md, /expected 2\nbut got 1/, "the whole error, in the summary");
});

test("nothing failed, or no summary to write to: no annotation and no summary", async () => {
  assert.equal(await report([{ type: "test:pass", data: { name: "fine" } }], null), "");
  const summary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ci-test-")), "summary.md");
  await report([{ type: "test:pass", data: { name: "fine" } }], summary);
  assert.equal(fs.existsSync(summary), false);
  const out = await report([failure("off GitHub", path.join(process.cwd(), "x.test.js"), 1, new Error("no"))], null);
  assert.match(out, /^::error /, "still said, where the log is all there is");
});
