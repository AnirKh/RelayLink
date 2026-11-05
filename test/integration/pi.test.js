/*
  The server as it runs on the Raspberry Pi (deploy/pi): listening on
  127.0.0.1 only (HOST), and under a path a proxy passes on as it came
  (BASE_PATH) — taken off before anything sees it.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const http   = require("node:http");
const { startServer, waitForServer, stopServer } = require("./serve.js");
const os     = require("node:os");
const WebSocket = require("ws");

const PORT  = 3197;
let server;

function get(urlPath, host = "127.0.0.1") {
  return new Promise(resolve => {
    http.get({ host, port: PORT, path: urlPath, timeout: 2000 }, res => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", e => resolve({ status: 0, error: e.code })).on("timeout", function () { this.destroy(); });
  });
}

test.before(async () => {
  server = startServer({ PORT: String(PORT), HOST: "127.0.0.1", BASE_PATH: "/dc", NODE_ENV: "production" });
  await waitForServer(server, async () => (await get("/api/ping")).status === 200);
});

test.after(() => stopServer(server));

test("under its path, everything answers as at the root", async () => {
  const ping = await get("/dc/api/ping");
  assert.equal(ping.status, 200);
  assert.equal(JSON.parse(ping.body).ok, true);
  assert.equal((await get("/dc/api/ping?x=1")).status, 200, "with a query too");
  assert.equal((await get("/dc/app.js")).status, 200);
  const page = await get("/dc");
  assert.equal(page.status, 200, "the path alone is the page");
  assert.match(page.body, /<html/i);
  assert.equal((await get("/dc/")).status, 200);
});

test("only that path is taken off — not one that merely starts the same", async () => {
  assert.equal((await get("/dcx/api/ping")).status, 404);
  assert.equal((await get("/api/ping")).status, 200, "and the root still answers, for a proxy that takes it off itself");
});

test("the live link opens under the path, and a link with no Origin is refused in production", async () => {
  const hello = await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/dc`, { origin: "https://anirkh.github.io" });
    ws.on("message", raw => { resolve(JSON.parse(raw)); ws.close(); });
    ws.on("error", () => resolve(null));
  });
  assert.equal(hello && hello.type, "hello");
  const refused = await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/dc`);
    ws.on("open", () => { ws.close(); resolve(false); });
    ws.on("error", () => resolve(true));
  });
  assert.equal(refused, true, "behind Funnel every link comes from 127.0.0.1: without production, these would get in");
});

test("listening on 127.0.0.1 only: the machine's other addresses get nothing", async () => {
  const other = Object.values(os.networkInterfaces()).flat()
    .find(a => a && a.family === "IPv4" && !a.internal);
  if (!other) return;                                 // no other address to try from here
  const answer = await get("/api/ping", other.address);
  assert.equal(answer.status, 0, `answered on ${other.address}`);
});
