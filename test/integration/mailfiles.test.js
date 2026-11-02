/*
  Waiting photos and files through a real server: sent to /api/mailbox/file,
  described in a mail-drop, fetched by the other side, and gone once they say
  they have it — kept on disk in MAILBOX_DIR/files meanwhile.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const path   = require("node:path");
const http   = require("node:http");
const fs     = require("node:fs");
const os     = require("node:os");
const crypto = require("node:crypto");
const WebSocket = require("ws");
const serve  = require("./serve.js");

const PORT   = 3195;
const ORIGIN = "http://localhost:3000";
const DIR    = fs.mkdtempSync(path.join(os.tmpdir(), "dc-mailfiles-"));
const FILES  = path.join(DIR, "files");
const sleep  = ms => new Promise(r => setTimeout(r, ms));

let server;
let nextIp = 0;

/** One request to the server, from its own address unless `ip` is given. */
function request({ method = "GET", headers = {}, body = null, chunked = false, ip = null, url = "/api/mailbox/file" }) {
  nextIp++;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: url, method,
      headers: { "x-forwarded-for": ip || `10.8.${nextIp >> 8}.${nextIp & 255}`, ...headers } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString()); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on("error", reject);
    if (body && !chunked) req.setHeader("content-length", body.length);
    if (body) req.write(body);
    req.end();
  });
}

const box = tag => `~${(tag + "_".repeat(43)).slice(0, 43)}`;
let n = 0;
const newId = () => `${String(++n).padStart(6, "0")}${"f".repeat(16)}`;
const CLIENT = { "x-dc-client": "1" };

function upload(b, to, id, bytes, over = {}) {
  return request({ method: "POST", body: bytes, ...over,
    headers: { ...CLIENT, "content-type": "application/octet-stream", "x-dc-mail": `${b}:${to}:${id}:${over.size ?? bytes.length}`, ...(over.headers || {}) } });
}
function download(b, side, id, over = {}) {
  return request({ ...over, headers: { ...CLIENT, "x-dc-mail": `${b}:${side}:${id}`, ...(over.headers || {}) } });
}

function connect() {
  nextIp++;
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: ORIGIN, headers: { "x-forwarded-for": `10.9.${nextIp >> 8}.${nextIp & 255}` } });
  ws.inbox = [];
  ws.on("message", raw => { try { ws.inbox.push(JSON.parse(raw)); } catch (_) {} });
  ws.send_ = obj => ws.send(JSON.stringify(obj));
  return new Promise((resolve, reject) => { ws.on("open", () => resolve(ws)); ws.on("error", reject); });
}
const open = [];
async function client() { const ws = await connect(); open.push(ws); return ws; }
async function waitFor(ws, type, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = ws.inbox.find(m => m.type === type);
    if (hit) return hit;
    await sleep(20);
  }
  return null;
}
const describe = (id, over = {}) => ({ id, at: Date.now(), iv: "v".repeat(16), ct: "Sealed_description-0123", file: true, ...over });

test.before(async () => {
  server = serve.startServer({ PORT: String(PORT), MAILBOX_DIR: DIR });
  await serve.waitForServer(server, async () => (await request({ url: "/api/ping" })).status === 200);
});

test.after(() => {
  for (const ws of open) { try { ws.terminate(); } catch (_) {} }
  if (server) server.kill();
  fs.rmSync(DIR, { recursive: true, force: true });
});

test("a file sent, described, fetched by the other side exactly as sent — and gone once they have it", async () => {
  const b = box("photo"), id = newId();
  const bytes = crypto.randomBytes(300_000);
  const sent = await upload(b, "b", id, bytes);
  assert.deepEqual([sent.status, sent.json], [200, { ok: true }]);
  assert.equal((await download(b, "b", id)).status, 404, "not handed over before its message comes");
  const a = await client();
  a.send_({ type: "mail-drop", box: b, to: "b", ...describe(id) });
  assert.deepEqual(await waitFor(a, "mail-dropped"), { type: "mail-dropped", id });
  const them = await client();
  them.send_({ type: "mail-fetch", files: true, boxes: [{ box: b, side: "b" }] });
  const got = await waitFor(them, "mail");
  assert.deepEqual(got.items.map(m => [m.id, m.file]), [[id, bytes.length]], "its size said with it");
  const file = await download(b, "b", id);
  assert.equal(file.status, 200);
  assert.equal(file.headers["content-type"], "application/octet-stream");
  assert.equal(file.headers["cache-control"], "no-store");
  assert.ok(file.raw.equals(bytes), "exactly the bytes sent");
  assert.equal((await download(b, "a", id)).status, 404, "not the other side's");
  const onDisk = fs.readdirSync(FILES);
  assert.equal(onDisk.length >= 1, true);
  assert.ok(onDisk.every(name => /^[0-9a-f]{64}$/.test(name)), "named by nothing of whose it is");
  them.send_({ type: "mail-ack", box: b, side: "b", ids: [id] });
  await sleep(300);
  assert.equal((await download(b, "b", id)).status, 404, "gone once they have it");
  assert.equal(fs.readdirSync(FILES).filter(name => fs.statSync(path.join(FILES, name)).size === bytes.length).length, 0, "gone from disk");
});

test("an app from before photos and files is not handed one — so it cannot throw it away — and the words still reach it", async () => {
  const b = box("oldapp"), fileId = newId(), textId = newId();
  assert.equal((await upload(b, "b", fileId, crypto.randomBytes(500))).status, 200);
  const a = await client();
  a.send_({ type: "mail-drop", box: b, to: "b", ...describe(fileId) });
  a.send_({ type: "mail-drop", box: b, to: "b", ...describe(textId, { file: undefined }) });
  await sleep(300);
  const old = await client();
  old.send_({ type: "mail-fetch", boxes: [{ box: b, side: "b" }] });
  assert.deepEqual((await waitFor(old, "mail")).items.map(m => m.id), [textId], "the words only");
  old.send_({ type: "mail-ack", box: b, side: "b", ids: [textId] });
  await sleep(200);
  const updated = await client();
  updated.send_({ type: "mail-fetch", files: true, boxes: [{ box: b, side: "b" }] });
  assert.deepEqual((await waitFor(updated, "mail")).items.map(m => [m.id, m.file]), [[fileId, 500]], "the photo still waits for an app that can take it");
  assert.equal((await download(b, "b", fileId)).status, 200);
});

test("a message for a file that was never sent is refused", async () => {
  const a = await client();
  const id = newId();
  a.send_({ type: "mail-drop", box: box("nofile"), to: "b", ...describe(id) });
  assert.deepEqual(await waitFor(a, "mail-refused"), { type: "mail-refused", id, code: "invalid" });
});

test("sent again after a lost answer: taken as already here — but not a different one under the same name", async () => {
  const b = box("again"), id = newId();
  const bytes = crypto.randomBytes(1000);
  assert.equal((await upload(b, "b", id, bytes)).status, 200);
  assert.equal((await upload(b, "b", id, bytes)).status, 200);
  const other = await upload(b, "b", id, crypto.randomBytes(1001));
  assert.deepEqual([other.status, other.json.code], [409, "invalid"]);
});

test("turned away: without the app's header, misnamed, too big, or not the size it said — and nothing kept", async () => {
  const b = box("refuse");
  const before = fs.existsSync(FILES) ? fs.readdirSync(FILES).length : 0;
  const bytes = crypto.randomBytes(100);
  const noClient = await request({ method: "POST", body: bytes, headers: { "x-dc-mail": `${b}:b:${newId()}:100` } });
  assert.equal(noClient.status, 403);
  for (const named of ["", `${b}:b:${newId()}`, `${b}:c:${newId()}:100`, `not-a-box:b:${newId()}:100`, `${b}:b:short:100`, `${b}:b:${newId()}:lots`]) {
    const res = await request({ method: "POST", body: bytes, headers: { ...CLIENT, "x-dc-mail": named } });
    assert.deepEqual([res.status, res.json.code], [400, "invalid"], named);
  }
  const big = await upload(b, "b", newId(), bytes, { size: 25 * 1024 * 1024 + 29, chunked: true });
  assert.deepEqual([big.status, big.json.code], [413, "too-large"], "said before a byte is read");
  const tiny = await upload(b, "b", newId(), Buffer.alloc(10));
  assert.deepEqual([tiny.status, tiny.json.code], [413, "too-large"], "smaller than any sealed file");
  const lied = await upload(b, "b", newId(), bytes, { size: 50 });
  assert.equal(lied.status, 400, "its length is not what it said");
  const longer = await upload(b, "b", newId(), crypto.randomBytes(5000), { size: 100, chunked: true });
  assert.deepEqual([longer.status, longer.json.code], [413, "upload-failed"], "cut off past what it said");
  const shorter = await upload(b, "b", newId(), bytes, { size: 4000, chunked: true });
  assert.deepEqual([shorter.status, shorter.json.code], [400, "upload-failed"]);
  await sleep(100);
  assert.equal(fs.readdirSync(FILES).length, before, "nothing kept, not even half");
  assert.equal((await download(b, "b", "../../mailbox")).status, 404);
  assert.equal((await request({ headers: { "x-dc-mail": `${b}:b:${newId()}` } })).status, 403);
});

test("asked from the app's page: the browser is told it may send the file's name", async () => {
  const pre = await request({ method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-headers": "x-dc-client,x-dc-mail" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers["access-control-allow-origin"], ORIGIN);
  assert.match(pre.headers["access-control-allow-headers"], /x-dc-mail/i);
});

test("the server says how big a file can wait here", async () => {
  const ping = await request({ url: "/api/ping" });
  assert.equal(ping.json.mailFileMaxBytes, 25 * 1024 * 1024 + 28);
});

test("sending files is limited per network", async () => {
  let refused = null;
  for (let i = 0; i < 45 && !refused; i++) {
    const res = await upload(box(`many${i}`), "b", newId(), crypto.randomBytes(40), { ip: "10.77.77.77" });
    if (res.status === 429) refused = res.json.code;
  }
  assert.equal(refused, "too-many");
});
