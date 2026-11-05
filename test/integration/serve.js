/*
  Starting server.js for a test file — shared by every file in this folder.

  Each file used to start its own and give it six seconds, with the server's
  output thrown away. After three updates in a row, the first full run after
  new files arrived failed every test in these files at once, and the next
  run passed, with nothing to say why: most likely the server was slow to
  start while the rest of the suite ran beside it and the new files were
  still being scanned. Now it is given thirty seconds — waited for only as
  long as it takes — and if it still does not come up, or ends first, the
  failure says so and carries what the server printed.

  Stopping it is waited for too. On Linux the server saves its mailbox as it
  exits (SIGTERM → mail.flush() in server.js), so a test that killed it and
  deleted its folder straight away raced that last save: GitHub's runs on
  Node 22 failed with ENOTEMPTY removing the folder, and a restart after a
  fixed half second could find the old process still there. Windows ends a
  process without running its handlers, which is why it never showed here.
  stopServer() resolves only once the process has exited.

  Not a test file itself: npm test runs test/integration/*.test.js.
*/

"use strict";

const { spawn } = require("node:child_process");
const path      = require("node:path");

const READY_WITHIN_MS = 30_000;
const STOP_WITHIN_MS  = 10_000;

/** server.js, started with `env` over this process's own. */
function startServer(env) {
  const server = spawn(process.execPath, [path.join(__dirname, "..", "..", "server.js")], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  /* Read as it comes — a pipe nobody reads fills and stalls the server — and
     the last of it kept, for a failure to show. */
  server.output = "";
  const keep = chunk => { server.output = (server.output + chunk).slice(-4000); };
  server.stdout.on("data", keep);
  server.stderr.on("data", keep);
  server.ended = null;
  server.on("exit", (code, signal) => { server.ended = signal || `code ${code}`; });
  return server;
}

/** Waits until `ready()` is true — no longer than that takes — or fails
    saying why, with what the server printed. */
async function waitForServer(server, ready) {
  const end = Date.now() + READY_WITHIN_MS;
  while (Date.now() < end) {
    if (server.ended) throw new Error(`server ended (${server.ended}) before it was ready. It printed:\n${server.output}`);
    try { if (await ready()) return; } catch (_) { /* not listening yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`server not ready within ${READY_WITHIN_MS / 1000}s. It printed:\n${server.output}`);
}

/** Stops the server and resolves once it has exited — after its last save,
    so its folder can go and its port be taken again. Killed outright if it
    is still there after STOP_WITHIN_MS. */
function stopServer(server) {
  if (!server || server.ended) return Promise.resolve();
  return new Promise(resolve => {
    const hard = setTimeout(() => server.kill("SIGKILL"), STOP_WITHIN_MS);
    server.once("exit", () => { clearTimeout(hard); resolve(); });
    server.kill();
  });
}

module.exports = { startServer, waitForServer, stopServer, READY_WITHIN_MS, STOP_WITHIN_MS };
