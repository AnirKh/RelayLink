/*
  What runs on the Raspberry Pi (deploy/pi): the service, the updater and its
  timer, the settings file, and the steps. Read as text — they run on Linux —
  to keep what they promise from drifting: the server as its own user with
  nothing it does not need, on 127.0.0.1 behind Funnel, in production; the
  updater running what came from GitHub as that user and never as root, with
  no package's install script; no secret ever filled in here.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8").replace(/\r\n/g, "\n");
const service = read("deploy/pi/direct-connection.service");
const updater = read("deploy/pi/direct-connection-update.service");
const timer   = read("deploy/pi/direct-connection-update.timer");
const update  = read("deploy/pi/update.sh");
const env     = read("deploy/pi/direct-connection.env.example");
const setup   = read("deploy/pi/SETUP.md");

test("the server runs as its own user, from its folder, with its settings, and comes back if it stops", () => {
  for (const line of ["User=dc", "Group=dc", "WorkingDirectory=/opt/direct-connection", "EnvironmentFile=/etc/direct-connection.env",
                      "ExecStart=/usr/bin/node server.js", "Restart=always", "WantedBy=multi-user.target"]) {
    assert.ok(service.split("\n").includes(line), line);
  }
});

test("one place it may write: its state folder, for messages waiting — the server finds it there by itself", () => {
  assert.ok(service.split("\n").includes("StateDirectory=direct-connection"));
  assert.ok(service.split("\n").includes("StateDirectoryMode=0700"), "the server's alone");
  assert.match(read("server.js"), /const MAILBOX_DIR = process\.env\.MAILBOX_DIR \|\| \(process\.env\.STATE_DIRECTORY \|\| ""\)\.split\(":"\)\[0\] \|\| null;/);
});

test("with nothing it does not need", () => {
  for (const line of ["NoNewPrivileges=true", "CapabilityBoundingSet=", "ProtectSystem=strict", "ProtectHome=true", "PrivateTmp=true",
                      "PrivateDevices=true", "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX", "RestrictSUIDSGID=true"]) {
    assert.ok(service.split("\n").includes(line), line);
  }
  assert.doesNotMatch(service, /MemoryDenyWriteExecute=true/, "node compiles as it runs: this would stop it starting");
});

test("its settings: production, 127.0.0.1 only, one proxy — and no secret filled in", () => {
  const values = Object.fromEntries(env.split("\n").filter(l => /^[A-Z_]+=/.test(l)).map(l => l.split(/=(.*)/s).slice(0, 2)));
  assert.equal(values.NODE_ENV, "production");
  assert.equal(values.HOST, "127.0.0.1");
  assert.equal(values.TRUSTED_PROXY_HOPS, "1");
  assert.doesNotMatch(env, /RESEND_API_KEY|MAIL_TO/, "no mail company: notes are sealed to the owner instead");
  for (const secret of ["KNOCK_PUBLIC_KEY", "KNOCK_PRIVATE_KEY"]) {
    assert.equal(values[secret], "", `${secret} is filled in by the person at the Pi, never here`);
  }
  assert.match(env, /^#BASE_PATH=\/dc$/m, "off unless Funnel turns out to pass the path on");
});

test("the updater: what came from GitHub runs as dc, installs run no scripts, and it restarts only on a change", () => {
  assert.match(update, /^#!\/bin\/sh\n/);
  assert.match(update, /^set -eu$/m);
  assert.match(update, /as_dc\(\) \{ runuser -u dc -- env HOME=\/var\/lib\/direct-connection "\$@"; \}/);
  for (const line of update.split("\n").filter(l => /^\s*(TARGET=\$\()?(git|npm|node) /.test(l))) {
    assert.fail(`run as root: ${line}`);
  }
  assert.match(update, /as_dc git fetch --quiet origin main/);
  assert.match(update, /as_dc npm ci --omit=dev --ignore-scripts/);
  assert.ok(update.indexOf("exit 0") < update.indexOf("git merge"), "nothing new: nothing restarted");
  assert.ok(update.indexOf("npm ci") < update.indexOf("systemctl restart direct-connection"));
  assert.match(updater, /^ExecStart=\/usr\/local\/sbin\/direct-connection-update$/m, "the installed copy, not the repository's");
  assert.match(updater, /^Type=oneshot$/m);
  assert.match(timer, /^OnUnitActiveSec=2min$/m);
  assert.match(timer, /^WantedBy=timers.target$/m);
});

test("the updater moves only as far as GitHub's tests have passed", () => {
  const ask = update.indexOf("TARGET=$(as_dc node deploy/pi/ci-passed.js $(as_dc git rev-list --max-count=50 HEAD..origin/main))");
  const none = update.indexOf('if [ -z "$TARGET" ]; then');
  const merge = update.indexOf('as_dc git merge --ff-only --quiet "$TARGET"');
  assert.ok(ask > -1, "it asks which of the new commits passed — as dc, with the copy at HEAD");
  assert.ok(none > ask && merge > none, "and with none passed yet, it stops before merging anything");
  assert.ok(update.slice(none, merge).includes("exit 0"), "waiting is not a failure of the timer's unit");
  assert.doesNotMatch(update, /git merge --ff-only --quiet origin\/main/, "never straight to origin/main, tested or not");
  assert.match(update, /fast-forward|--ff-only/, "fast-forward only: never a merge of its own");
});

/* deploy/pi/ci-passed.js, run against a stand-in GitHub. */
const CI = require("../deploy/pi/ci-passed.js");
const sha = c => c.repeat(40);
function github(runs, status = 200) {
  const asked = [];
  const fetch = async (url, opts) => {
    asked.push({ url, ua: opts.headers["user-agent"] });
    return { ok: status === 200, status, json: async () => ({ workflow_runs: runs }) };
  };
  return { asked, fetch };
}
const passed = s => ({ head_sha: s, status: "completed", conclusion: "success" });

test("the newest new commit whose tests passed — one question to GitHub, however many commits", async () => {
  const gh = github([passed(sha("b")), passed(sha("a")), passed(sha("9"))]);
  assert.equal(await CI.newestPassed([sha("c"), sha("b"), sha("a")], { fetch: gh.fetch }), sha("b"),
    "c is still being tested, or failed: the Pi goes as far as b");
  assert.deepEqual(gh.asked, [{ url: "https://api.github.com/repos/AnirKh/RelayLink/actions/workflows/tests.yml/runs?branch=main&status=success&per_page=50",
                                ua: "relaylink-pi-update" }]);
});

test("none passed, GitHub refusing, or nothing to ask about: no commit to move to", async () => {
  assert.equal(await CI.newestPassed([sha("c")], { fetch: github([passed(sha("9"))]).fetch }), null, "only older ones passed");
  assert.equal(await CI.newestPassed([sha("c")], { fetch: github([{ head_sha: sha("c"), conclusion: "failure" }]).fetch }), null,
    "a run that did not succeed, should one be listed");
  await assert.rejects(CI.newestPassed([sha("c")], { fetch: github([], 403).fetch }), /GitHub answered 403/,
    "an hour's 60 questions used up, say: an error, which the script turns into nothing printed");
  const gh = github([passed(sha("c"))]);
  assert.equal(await CI.newestPassed([], { fetch: gh.fetch }), null);
  assert.equal(await CI.newestPassed(["HEAD", "; rm -rf /", ""], { fetch: gh.fetch }), null, "only full commit names are taken");
  assert.deepEqual(gh.asked, [], "and GitHub is not asked for nothing");
});

test("the script prints a commit or nothing, and never fails the update for want of an answer", () => {
  const src = read("deploy/pi/ci-passed.js");
  assert.match(src, /\.then\(sha => \{ if \(sha\) process\.stdout\.write\(`\$\{sha\}\\n`\); \}\)/);
  assert.match(src, /\.catch\(err => \{ process\.stderr\.write\(/, "why it could not tell: to the journal, not to TARGET");
  assert.equal(CI.REPO, "AnirKh/RelayLink");
  assert.match(setup, /git clone https:\/\/github\.com\/AnirKh\/RelayLink\.git/, "the repository the Pi clones is the one it asks about");
  assert.ok(fs.existsSync(path.join(__dirname, "..", ".github", "workflows", CI.WORKFLOW)), "the workflow it asks about exists");
});

test("the steps leave Funnel's own route alone, and ask for no secret", () => {
  assert.match(setup, /sudo tailscale funnel --bg --set-path=\/dc http:\/\/127\.0\.0\.1:3000/);
  assert.doesNotMatch(setup, /funnel (reset|off)|--set-path=\/ /, "the existing / route stays");
  assert.match(setup, /nobody pastes a key\s+into a chat/i);
  assert.match(setup, /--ignore-scripts/);
  assert.match(setup, /sudo install -m 640 -o root -g dc deploy\/pi\/direct-connection\.env\.example \/etc\/direct-connection\.env/,
    "readable by root and the server only");
  assert.match(setup, /sudo install -m 755 deploy\/pi\/update\.sh \/usr\/local\/sbin\/direct-connection-update/);
});

test("the Pi's files keep Linux line endings on any checkout", () => {
  assert.match(read(".gitattributes"), /^deploy\/pi\/\* text eol=lf$/m);
});

test("the page talks to the Pi, under /dc — and may, by its own rules", () => {
  const { DEFAULT_ALLOWED_ORIGINS, META_CSP } = require("../csp.js");
  assert.match(read("app.js"), /^const DEFAULT_SERVER_URL = "https:\/\/raspberrypi\.vulture-manta\.ts\.net\/dc";$/m);
  assert.ok(DEFAULT_ALLOWED_ORIGINS.includes("https://raspberrypi.vulture-manta.ts.net"));
  assert.match(META_CSP, /wss:\/\/raspberrypi\.vulture-manta\.ts\.net/);
  assert.ok(!DEFAULT_ALLOWED_ORIGINS.some(o => /onrender\.com/.test(o)), "Render is gone: no copy there may talk to the Pi");
  assert.doesNotMatch(META_CSP, /onrender\.com/, "nor is the page let reach it");
});
