/*
  Waiting messages through a real server: kept in a file (MAILBOX_DIR), with
  knock keys and a local stand-in for a push service, so "a message waits"
  can be opened and read as the receiving browser would.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const path   = require("node:path");
const serve  = require("./serve.js");
const http   = require("node:http");
const fs     = require("node:fs");
const os     = require("node:os");
const crypto = require("node:crypto");
const WebSocket = require("ws");
const K = require("../../knock.js");

const PORT   = 3196;
const ORIGIN = "http://localhost:3000";
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const KEYS   = K.makeKnockKeys();
const DIR    = fs.mkdtempSync(path.join(os.tmpdir(), "dc-mailbox-"));

let server, push, pushOrigin, rogue, rogueOrigin;
const pushed = [];
const rogueGot = [];          // answers like a push service, but is not one: never to be sent to

function startServer() {
  server = serve.startServer({ PORT: String(PORT), MAILBOX_DIR: DIR, KNOCK_PUBLIC_KEY: KEYS.publicKey, KNOCK_PRIVATE_KEY: KEYS.privateKey, KNOCK_TEST_ORIGIN: pushOrigin });
}
function waitForServer() {
  return serve.waitForServer(server, async () => { (await connect()).close(); return true; });
}

let nextIp = 0;
function connect() {
  nextIp++;
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: ORIGIN, headers: { "x-forwarded-for": `10.7.${nextIp >> 8}.${nextIp & 255}` } });
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

const box = tag => `~${(tag + "_".repeat(43)).slice(0, 43)}`;
let n = 0;
const message = (over = {}) => ({ id: `${String(++n).padStart(6, "0")}${"m".repeat(16)}`, at: Date.now(), iv: "v".repeat(16), ct: "Sealed_text-0123456789", ...over });

function alertAddress() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, to: { endpoint: `${pushOrigin}/push/${crypto.randomBytes(4).toString("hex")}`, p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
}
function openPush(body, addr) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), record = body.subarray(21 + idlen);
  const shared = addr.ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, addr.auth, Buffer.concat([Buffer.from("WebPush: info\0"), addr.ecdh.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.length - 1).toString());
}

test.before(async () => {
  push = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => { pushed.push({ url: req.url, body: Buffer.concat(chunks) }); res.statusCode = 201; res.end(); });
  });
  await new Promise(r => push.listen(0, "127.0.0.1", r));
  pushOrigin = `http://127.0.0.1:${push.address().port}`;
  rogue = http.createServer((req, res) => { rogueGot.push(req.url); res.statusCode = 201; res.end(); });
  await new Promise(r => rogue.listen(0, "127.0.0.1", r));
  rogueOrigin = `http://127.0.0.1:${rogue.address().port}`;
  startServer();
  await waitForServer();
});

test.after(async () => {
  for (const ws of open) { try { ws.terminate(); } catch (_) {} }
  await serve.stopServer(server);                     // its last save done before the folder goes
  if (push) push.close();
  if (rogue) rogue.close();
  fs.rmSync(DIR, { recursive: true, force: true });
});

test("left for them, kept, handed over when they ask — and gone once they say they have it", async () => {
  const a = await client(), b = await client();
  const m = message();
  a.send_({ type: "mail-drop", box: box("hand"), to: "b", ...m });
  assert.deepEqual(await waitFor(a, "mail-dropped"), { type: "mail-dropped", id: m.id });
  b.send_({ type: "mail-fetch", boxes: [{ box: box("hand"), side: "b" }] });
  const got = await waitFor(b, "mail");
  assert.deepEqual(got, { type: "mail", box: box("hand"), side: "b", items: [m] }, "exactly as left, nothing added");
  const other = await client();
  other.send_({ type: "mail-fetch", boxes: [{ box: box("hand"), side: "a" }] });
  await sleep(300);
  assert.ok(!other.inbox.some(x => x.type === "mail"), "the other side's mailbox is empty");
  b.send_({ type: "mail-ack", box: box("hand"), side: "b", ids: [m.id] });
  await sleep(200);
  const later = await client();
  later.send_({ type: "mail-fetch", boxes: [{ box: box("hand"), side: "b" }] });
  await sleep(300);
  assert.ok(!later.inbox.some(x => x.type === "mail"), "gone for good");
});

test("sent again after a lost answer: kept once, and those listening told once", async () => {
  const listener = await client();
  listener.send_({ type: "mail-fetch", boxes: [{ box: box("twice"), side: "b" }] });
  await sleep(200);
  const a = await client();
  const m = message();
  a.send_({ type: "mail-drop", box: box("twice"), to: "b", ...m });
  a.send_({ type: "mail-drop", box: box("twice"), to: "b", ...m });
  await sleep(300);
  assert.equal(a.inbox.filter(x => x.type === "mail-dropped").length, 2, "both answered");
  assert.equal(listener.inbox.filter(x => x.type === "mail-waiting").length, 1, "told of it once");
  const b = await client();
  b.send_({ type: "mail-fetch", boxes: [{ box: box("twice"), side: "b" }] });
  assert.equal((await waitFor(b, "mail")).items.length, 1);
});

test("refused when malformed or full — said, with why", async () => {
  const a = await client();
  for (const bad of [{ box: "plain-room" }, { to: "c" }, { id: "short" }, { ct: "<script>" }, { at: 12 }]) {
    a.inbox.length = 0;
    const m = message();
    a.send_({ type: "mail-drop", box: box("bad"), to: "b", ...m, ...bad });
    const r = await waitFor(a, "mail-refused");
    assert.equal(r && r.code, "invalid", JSON.stringify(bad));
  }
  const filler = [];
  for (let i = 0; i < 4; i++) filler.push(await client());     // each under its own network's limit
  for (let i = 0; i < 100; i++) filler[Math.floor(i / 30)].send_({ type: "mail-drop", box: box("full"), to: "b", ...message() });
  await sleep(500);
  assert.ok(!filler.some(ws => ws.inbox.some(x => x.type === "mail-refused")), "a hundred kept");
  filler[3].send_({ type: "mail-drop", box: box("full"), to: "b", ...message() });
  const full = await waitFor(filler[3], "mail-refused");
  assert.equal(full && full.code, "full", "then full");
});

test("someone with the app open hears of it at once and takes it — and is not alerted as well", async () => {
  const b = await client();
  b.send_({ type: "mail-fetch", boxes: [{ box: box("live"), side: "b" }] });
  await sleep(200);
  const a = await client();
  const addr = alertAddress();
  const before = pushed.length;
  a.send_({ type: "mail-drop", box: box("live"), to: "b", ...message(), knock: addr.to });
  assert.deepEqual(await waitFor(b, "mail-waiting"), { type: "mail-waiting", box: box("live") });
  b.send_({ type: "mail-fetch", boxes: [{ box: box("live"), side: "b" }] });     // as the page does
  assert.equal((await waitFor(b, "mail")).items.length, 1);
  await sleep(4500);
  assert.equal(pushed.length, before, "they are there: no alert");
});

test("a page told that does not ask for it — a locked phone, a page gone — is taken as away, and alerted", async () => {
  const b = await client();
  b.send_({ type: "mail-fetch", boxes: [{ box: box("asleep"), side: "b" }] });
  await sleep(200);
  const a = await client();
  const addr = alertAddress();
  const before = pushed.length;
  a.send_({ type: "mail-drop", box: box("asleep"), to: "b", ...message(), knock: addr.to });
  assert.ok(await waitFor(b, "mail-waiting"), "told, as a live page would be");
  await sleep(1000);
  assert.equal(pushed.length, before, "given a moment to answer first");
  for (let i = 0; i < 80 && pushed.length === before; i++) await sleep(50);
  assert.equal(pushed.length, before + 1, "no answer: alerted");
  assert.deepEqual(openPush(pushed.at(-1).body, addr), { t: "mail", room: box("asleep") });
});

test("nobody there: their device is told a message waits — once a minute", async () => {
  const a = await client();
  const addr = alertAddress();
  const before = pushed.length;
  a.send_({ type: "mail-drop", box: box("away"), to: "b", ...message(), knock: addr.to });
  for (let i = 0; i < 50 && pushed.length === before; i++) await sleep(50);
  assert.equal(pushed.length, before + 1);
  assert.deepEqual(openPush(pushed.at(-1).body, addr), { t: "mail", room: box("away") }, "which mailbox, nothing more");
  a.send_({ type: "mail-drop", box: box("away"), to: "b", ...message(), knock: addr.to });
  await sleep(400);
  assert.equal(pushed.length, before + 1, "a second message in the minute: no second alert");
  const elsewhere = alertAddress();
  elsewhere.to.endpoint = `${rogueOrigin}/push`;
  a.send_({ type: "mail-drop", box: box("away2"), to: "b", ...message(), knock: elsewhere.to });
  await sleep(500);
  assert.equal(pushed.length, before + 1);
  assert.deepEqual(rogueGot, [], "only to a push service, never wherever it is told");
});

test("a link that closes stops listening: the next message alerts instead", async () => {
  const b = await client();
  b.send_({ type: "mail-fetch", boxes: [{ box: box("gone"), side: "b" }] });
  await sleep(200);
  b.close();
  await sleep(300);
  const a = await client();
  const before = pushed.length;
  a.send_({ type: "mail-drop", box: box("gone"), to: "b", ...message(), knock: alertAddress().to });
  for (let i = 0; i < 50 && pushed.length === before; i++) await sleep(50);
  assert.equal(pushed.length, before + 1);
});

test("asking after a mailbox that is not one changes nothing", async () => {
  const b = await client();
  b.send_({ type: "mail-fetch", boxes: [{ box: "nope", side: "b" }, { box: box("x"), side: "z" }, null, 7] });
  b.send_({ type: "mail-fetch", boxes: "all" });
  b.send_({ type: "mail-ack", box: "nope", side: "b", ids: ["x"] });
  await sleep(300);
  assert.deepEqual(b.inbox.filter(x => x.type !== "hello"), []);
});

/* ── Someone waiting for a saved person ──
   Asked for: when someone taps a saved person's name and waits, that
   person's open lobby shows it on their name. Their page already listens
   under the room's name for its mailbox, so it is told there. */

test("a saved person's open lobby hears when someone starts waiting for them, and when nobody does", async () => {
  const room = box("waitfor");
  const b = await client();
  b.send_({ type: "mail-fetch", boxes: [{ box: room, side: "b" }] });
  await sleep(150);
  const a = await client();
  a.send_({ type: "meet-session", sessionId: room, side: "a" });
  assert.ok(await waitFor(a, "session-created"));
  assert.deepEqual(await waitFor(b, "meet-waiting"), { type: "meet-waiting", room, waiting: true });
  b.inbox.length = 0;
  a.send_({ type: "leave-session", sessionId: room });
  assert.deepEqual(await waitFor(b, "meet-waiting"), { type: "meet-waiting", room, waiting: false }, "gave up: said too");
});

test("a lobby opened while someone already waits is told at once", async () => {
  const room = box("already");
  const a = await client();
  a.send_({ type: "meet-session", sessionId: room, side: "b" });
  assert.ok(await waitFor(a, "session-created"));
  const late = await client();
  late.send_({ type: "mail-fetch", boxes: [{ box: room, side: "a" }] });
  assert.deepEqual(await waitFor(late, "meet-waiting"), { type: "meet-waiting", room, waiting: true });
});

test("the one waited for comes: nobody waits now — said to its other devices as well", async () => {
  const room = box("comes");
  const phone = await client(), laptop = await client();
  for (const d of [phone, laptop]) d.send_({ type: "mail-fetch", boxes: [{ box: room, side: "b" }] });
  await sleep(150);
  const a = await client();
  a.send_({ type: "meet-session", sessionId: room, side: "a" });
  assert.ok(await waitFor(laptop, "meet-waiting"));
  laptop.inbox.length = 0;
  phone.send_({ type: "meet-session", sessionId: room, side: "b" });
  assert.ok(await waitFor(phone, "session-joined"));
  assert.deepEqual(await waitFor(laptop, "meet-waiting"), { type: "meet-waiting", room, waiting: false },
    "the laptop stops showing it once the phone has answered");
});

test("only the side waited for is told — not the waiting side's own other devices, nor anyone else", async () => {
  const room = box("onlythem");
  const own = await client(), other = await client();
  own.send_({ type: "mail-fetch", boxes: [{ box: room, side: "a" }] });
  other.send_({ type: "mail-fetch", boxes: [{ box: box("elsewhere"), side: "b" }] });
  await sleep(150);
  const a = await client();
  a.send_({ type: "meet-session", sessionId: room, side: "a" });
  assert.ok(await waitFor(a, "session-created"));
  await sleep(300);
  assert.equal(own.inbox.some(m => m.type === "meet-waiting"), false, "its own other tab is the one waiting, not waited for");
  assert.equal(other.inbox.some(m => m.type === "meet-waiting"), false);
});

test("a restart loses nothing waiting", async () => {
  const a = await client();
  const m = message();
  a.send_({ type: "mail-drop", box: box("restart"), to: "b", ...m });
  await waitFor(a, "mail-dropped");
  await sleep(2600);                         // kept to the file within two seconds
  await serve.stopServer(server);
  startServer();
  await waitForServer();
  const b = await client();
  b.send_({ type: "mail-fetch", boxes: [{ box: box("restart"), side: "b" }] });
  const got = await waitFor(b, "mail");
  assert.deepEqual(got && got.items.map(x => x.id), [m.id]);
  assert.ok(fs.existsSync(path.join(DIR, "mailbox.json")));
});

test("leaving messages is limited per network", async () => {
  const links = [];
  for (let i = 0; i < 3; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: ORIGIN, headers: { "x-forwarded-for": "10.99.99.99" } });
    ws.inbox = [];
    ws.on("message", raw => { try { ws.inbox.push(JSON.parse(raw)); } catch (_) {} });
    await new Promise(r => ws.on("open", r));
    open.push(ws);
    links.push(ws);
  }
  let refused = null;
  for (let i = 0; i < 70 && !refused; i++) {
    const ws = links[i % 3];
    ws.send(JSON.stringify({ type: "mail-drop", box: box(`limit${i}`), to: "b", ...message() }));
    await sleep(5);
    refused = ws.inbox.find(x => x.type === "mail-refused");
  }
  for (let i = 0; i < 20 && !refused; i++) { await sleep(50); refused = links.flatMap(l => l.inbox).find(x => x.type === "mail-refused"); }
  assert.equal(refused && refused.code, "too-many");
});
