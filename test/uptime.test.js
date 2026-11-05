/*
  Knowing when the Pi is down — tools/pi-uptime.js, run every ten minutes by
  .github/workflows/pi-uptime.yml.

  The Pi is the app's one server: when it stops answering, new chats cannot
  start and notes cannot be left. The check runs from GitHub, outside the
  home network, the way users reach it, and the alert is a GitHub issue —
  opened once when it stops answering, closed once when it answers again.

  Here the script is run against a stand-in Pi and a stand-in GitHub: what
  counts as down, how many tries, and exactly what is written when.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");
const U      = require("../tools/pi-uptime.js");

const ROOT = path.join(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8").replace(/\r\n/g, "\n");

const API = "https://api.test";
const ENV = { GITHUB_TOKEN: "t0ken", GITHUB_REPOSITORY: "AnirKh/RelayLink", GITHUB_API_URL: API };
const NOW = () => new Date("2026-11-05T10:00:30Z");

const reply = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  text: async () => (typeof body === "string" ? body : JSON.stringify(body))
});

/** A Pi that answers each try as listed, and a GitHub with these issues open. */
function world({ pings, open = [], github = {} }) {
  const log = { pinged: 0, waits: [], calls: [] };
  const fetch = async (url, opts = {}) => {
    if (url === U.PING_URL) {
      const next = pings[log.pinged++];
      if (next instanceof Error) throw next;
      return reply(next.status, next.body);
    }
    const method = opts.method || "GET";
    const where = url.slice(`${API}/repos/AnirKh/RelayLink`.length);
    log.calls.push({ method, where, body: opts.body ? JSON.parse(opts.body) : undefined, auth: opts.headers.authorization });
    const key = `${method} ${where.split("?")[0]}`;
    if (github[key]) return github[key];
    if (key === "GET /issues") return reply(200, open);
    if (key === "POST /issues") return reply(201, { number: 7 });
    return reply(method === "POST" ? 201 : 200, {});
  };
  return { log, run: () => U.run({ env: ENV, fetch, wait: async ms => { log.waits.push(ms); }, now: NOW }) };
}

const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
const up = { status: 200, body: { ok: true, knockKey: null, mailFileMaxBytes: 0 } };
const writes = log => log.calls.filter(c => c.method !== "GET");

test("down three times, no alert open: one issue, mentioning the owner, with each try's reason", async () => {
  const w = world({ pings: [refused(), { status: 502, body: "Bad Gateway" }, refused()] });
  assert.equal(await w.run(), "down: opened #7");
  assert.equal(w.log.pinged, 3);
  assert.deepEqual(w.log.waits, [30_000, 30_000], "half a minute between tries, none after the last");
  const [label, issue] = writes(w.log);
  assert.deepEqual(label, { method: "POST", where: "/labels", auth: "Bearer t0ken",
    body: { name: "pi-down", color: "d73a4a", description: "The Raspberry Pi server is not answering" } });
  assert.equal(issue.where, "/issues");
  assert.equal(issue.body.title, "🔴 The Pi is not answering (since 2026-11-05 10:00 UTC)");
  assert.deepEqual(issue.body.labels, ["pi-down"]);
  assert.match(issue.body.body, /^@AnirKh — /, "mentioned, so GitHub emails them");
  assert.match(issue.body.body, /- try 1: ECONNREFUSED\n- try 2: HTTP 502\n- try 3: ECONNREFUSED/);
  assert.ok(issue.body.body.includes(U.PING_URL));
  assert.equal(writes(w.log).length, 2);
});

test("still down with the alert open: nothing more is sent", async () => {
  const w = world({ pings: [refused(), refused(), refused()], open: [{ number: 7, title: "🔴 …" }] });
  assert.equal(await w.run(), "still down: #7 stays open");
  assert.deepEqual(writes(w.log), []);
});

test("answering again: a comment saying when, and the alert closed", async () => {
  const w = world({ pings: [up], open: [{ number: 7 }] });
  assert.equal(await w.run(), "up again: closed #7");
  assert.deepEqual(writes(w.log), [
    { method: "POST", where: "/issues/7/comments", auth: "Bearer t0ken", body: { body: "🟢 Answering again at 2026-11-05 10:00 UTC." } },
    { method: "PATCH", where: "/issues/7", auth: "Bearer t0ken", body: { state: "closed", state_reason: "completed" } }
  ]);
});

test("up, and no alert open: one try, nothing written", async () => {
  const w = world({ pings: [up] });
  assert.equal(await w.run(), "up");
  assert.equal(w.log.pinged, 1);
  assert.deepEqual(w.log.waits, []);
  assert.deepEqual(writes(w.log), []);
});

test("one missed answer is not an outage", async () => {
  const w = world({ pings: [refused(), up] });
  assert.equal(await w.run(), "up");
  assert.deepEqual(w.log.waits, [30_000]);
  assert.deepEqual(writes(w.log), []);
});

test("what counts as no answer", async () => {
  const one = async answer => U.pingOnce(async () => { if (answer instanceof Error) throw answer; return reply(answer.status, answer.body); }, U.PING_URL);
  assert.equal(await one(up), null);
  assert.equal(await one({ status: 502, body: "" }), "HTTP 502", "Funnel up, the server behind it not");
  assert.equal(await one({ status: 200, body: { ok: false } }), "answered, but not with ok: true");
  assert.equal(await one({ status: 200, body: "<html>not the app</html>" }), "answered, but not with ok: true");
  assert.equal(await one(refused()), "ECONNREFUSED");
  assert.equal(await one(Object.assign(new Error("timed out"), { name: "TimeoutError" })), "no answer in 15 s");
});

test("a pull request with the label is not the alert; a label that already exists is fine", async () => {
  const w = world({ pings: [refused(), refused(), refused()], open: [{ number: 3, pull_request: {} }],
                    github: { "POST /labels": reply(422, { message: "already_exists" }) } });
  assert.equal(await w.run(), "down: opened #7");
});

test("GitHub refusing the check fails the job — the monitoring is what is broken", async () => {
  const w = world({ pings: [up], github: { "GET /issues": reply(401, { message: "Bad credentials" }) } });
  await assert.rejects(w.run(), /GitHub GET \/issues\?state=open&labels=pi-down&per_page=20: 401/);
  await assert.rejects(U.run({ env: {}, fetch: async () => reply(200, {}) }), /GITHUB_TOKEN and GITHUB_REPOSITORY are needed/);
});

test("it checks the address the app itself uses", () => {
  const server = read("app.js").match(/^const DEFAULT_SERVER_URL = "([^"]+)";/m);
  assert.ok(server, "DEFAULT_SERVER_URL not found in app.js");
  assert.equal(U.PING_URL, `${server[1]}/api/ping`, "if the app moves, the check moves with it");
});

test("the workflow: every ten minutes and by hand, one at a time, allowed to write issues and nothing else", () => {
  const wf = read(".github/workflows/pi-uptime.yml");
  assert.match(wf, /^on:\n  schedule:\n    - cron: "\*\/10 \* \* \* \*"\n  workflow_dispatch:/m);
  assert.match(wf, /^permissions:\n  contents: read\n  issues: write$/m);
  assert.match(wf, /^concurrency:\n  group: pi-uptime\n  cancel-in-progress: false$/m);
  assert.match(wf, /- run: node tools\/pi-uptime\.js\n\s+env:\n\s+GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(read("tools/pi-uptime.js"), /run\(\)\.then\(said => console\.log\(said\), err => \{ console\.error\(err\.message\); process\.exit\(1\); \}\);/,
    "down is a success for the job — only a check that could not be made fails it");
});
