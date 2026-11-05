/*
  Knocks through a real server: spawned with a knock key pair and a local
  stand-in for a push service (KNOCK_TEST_ORIGIN), which records what it is
  sent so the test can open it with the receiving browser's keys.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const http   = require("node:http");
const { startServer, waitForServer, stopServer } = require("./serve.js");
const crypto = require("node:crypto");
const WebSocket = require("ws");
const K = require("../../knock.js");

const PORT   = 3198;
const ORIGIN = "http://localhost:3000";
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const KEYS   = K.makeKnockKeys();

let server, push, pushOrigin, rogue, rogueOrigin;
const received = [];
const rogueReceived = [];     // a server that is not a push service: must never be sent to
let pushStatus = 201;

let nextIp = 0;
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
async function waitFor(ws, type, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = ws.inbox.find(m => m.type === type);
    if (hit) return hit;
    await sleep(25);
  }
  return null;
}

/** A browser's subscription, with its private half to read the knock with. */
function subscription(tag) {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, authBytes: auth, to: { endpoint: `${pushOrigin}/push/${tag}`, p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
}

function open_(body, sub) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), record = body.subarray(21 + idlen);
  const shared = sub.ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), sub.ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, sub.authBytes, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.length - 1).toString());
}

const savedRoom = tag => `~${(tag + "_".repeat(43)).slice(0, 43)}`;

async function waiting(tag) {
  const a = await client();
  a.send_({ type: "meet-session", sessionId: savedRoom(tag), side: "a" });
  assert.ok(await waitFor(a, "session-created"));
  return a;
}

test.before(async () => {
  push = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => { received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.statusCode = pushStatus; res.end(); });
  });
  await new Promise(r => push.listen(0, "127.0.0.1", r));
  pushOrigin = `http://127.0.0.1:${push.address().port}`;
  rogue = http.createServer((req, res) => { rogueReceived.push(req.url); res.statusCode = 201; res.end(); });
  await new Promise(r => rogue.listen(0, "127.0.0.1", r));
  rogueOrigin = `http://127.0.0.1:${rogue.address().port}`;
  server = startServer({ PORT: String(PORT), KNOCK_PUBLIC_KEY: KEYS.publicKey, KNOCK_PRIVATE_KEY: KEYS.privateKey,
                         KNOCK_SUBJECT: "mailto:test@example.com", KNOCK_TEST_ORIGIN: pushOrigin });
  await waitForServer(server, async () => { (await connect()).close(); return true; });
});

test.after(async () => {
  for (const ws of open) { try { ws.terminate(); } catch (_) {} }
  await stopServer(server);
  if (push) push.close();
  if (rogue) rogue.close();
});

test("the server says its knock key, for a browser to subscribe with", async () => {
  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/api/ping`, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); }).on("error", reject);
  });
  assert.equal(body.knockKey, KEYS.publicKey);
});

test("first in a saved person's room: the knock reaches their push service, and opens to name the room", async () => {
  const a = await waiting("knock1");
  const sub = subscription("one");
  const before = received.length;
  a.send_({ type: "knock", sessionId: savedRoom("knock1"), to: sub.to });
  const result = await waitFor(a, "knock-result");
  assert.deepEqual(result, { type: "knock-result", sessionId: savedRoom("knock1"), ok: true, gone: false });
  assert.equal(received.length, before + 1);
  const req = received.at(-1);
  assert.equal(req.url, "/push/one");
  assert.match(req.headers.authorization, new RegExp(`, k=${KEYS.publicKey}$`));
  const jwt = JSON.parse(Buffer.from(req.headers.authorization.split(" t=")[1].split(".")[1], "base64url"));
  assert.equal(jwt.aud, pushOrigin);
  assert.equal(jwt.sub, "mailto:test@example.com");
  assert.deepEqual(open_(req.body, sub), { t: "knock", room: savedRoom("knock1") }, "the room, and nothing else");
});

test("only the one waiting in a saved person's room may knock, and only while alone in it", async () => {
  const sub = subscription("only");
  const before = received.length;
  /* A guest in the room. */
  const a = await waiting("knock2");
  const b = await client();
  b.send_({ type: "meet-session", sessionId: savedRoom("knock2"), side: "b" });
  await waitFor(b, "session-joined");
  b.send_({ type: "knock", sessionId: savedRoom("knock2"), to: sub.to });
  a.send_({ type: "knock", sessionId: savedRoom("knock2"), to: sub.to });       // they are here already
  /* Not in the room at all. */
  const stranger = await client();
  stranger.send_({ type: "knock", sessionId: savedRoom("knock2"), to: sub.to });
  /* Another kind of room. */
  const host = await client();
  host.send_({ type: "create-session", sessionId: "knock-open-room", open: true });
  await waitFor(host, "session-created");
  host.send_({ type: "knock", sessionId: "knock-open-room", to: sub.to });
  await sleep(500);
  assert.equal(received.length, before, "nothing sent");
  for (const ws of [a, b, stranger, host]) assert.ok(!ws.inbox.some(m => m.type === "knock-result"), "nor answered");
});

test("only to a push service's address, with a subscription's keys", async () => {
  const before = received.length;
  const sub = subscription("bad");
  for (const [i, to] of [
    { ...sub.to, endpoint: `${rogueOrigin}/push` },                 // would answer — but is no push service
    { ...sub.to, endpoint: `${pushOrigin}0/push` },                 // not that origin exactly
    { ...sub.to, p256dh: "short" },
    { ...sub.to, auth: undefined },
    null
  ].entries()) {
    const a = await waiting(`bad${i}`);
    a.send_({ type: "knock", sessionId: savedRoom(`bad${i}`), to });
    const result = await waitFor(a, "knock-result");
    assert.deepEqual(result && [result.ok, result.gone], [false, false], JSON.stringify(to));
  }
  await sleep(200);
  assert.equal(received.length, before);
  assert.deepEqual(rogueReceived, [], "nothing sent anywhere but a push service");
});

test("someone not in the room cannot knock for it, though its one person waits alone", async () => {
  const a = await waiting("stranger");
  const stranger = await client();
  const before = received.length;
  stranger.send_({ type: "knock", sessionId: savedRoom("stranger"), to: subscription("s").to });
  await sleep(400);
  assert.equal(received.length, before);
  assert.ok(!stranger.inbox.some(m => m.type === "knock-result"));
  a.send_({ type: "knock", sessionId: savedRoom("stranger"), to: subscription("s2").to });
  assert.equal((await waitFor(a, "knock-result")).ok, true, "its own host still can");
});

test("one knock per room in a while", async () => {
  const a = await waiting("twice");
  const sub = subscription("twice");
  a.send_({ type: "knock", sessionId: savedRoom("twice"), to: sub.to });
  await waitFor(a, "knock-result");
  a.inbox.length = 0;
  const before = received.length;
  a.send_({ type: "knock", sessionId: savedRoom("twice"), to: sub.to });
  const second = await waitFor(a, "knock-result");
  assert.equal(second.ok, false);
  assert.equal(received.length, before);
});

test("an address the push service says is gone is said to be gone", async () => {
  pushStatus = 410;
  try {
    const a = await waiting("gone");
    a.send_({ type: "knock", sessionId: savedRoom("gone"), to: subscription("gone").to });
    const result = await waitFor(a, "knock-result");
    assert.deepEqual([result.ok, result.gone], [false, true]);
  } finally { pushStatus = 201; }
});
