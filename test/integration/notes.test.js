/*
  Notes for the owner through a real server: left by anyone, sealed to the
  owner's lock; collected, let go and alerted to by the owner's device alone,
  which shows it is by signing its connection's word. The server is given a
  test lock (OWNER_LOCK), a mailbox folder, knock keys and a stand-in push
  service.
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
const DC     = require("../../protocol.js");
const K      = require("../../knock.js");
const { p256 } = require("@noble/curves/p256");

const PORT   = 3194;
const ORIGIN = "http://localhost:3000";
const DIR    = fs.mkdtempSync(path.join(os.tmpdir(), "dc-notes-"));
const KEYS   = K.makeKnockKeys();
const sleep  = ms => new Promise(r => setTimeout(r, ms));

let server, push, pushOrigin, owner, stranger, BOX;
const pushed = [];

function startServer() {
  server = serve.startServer({ PORT: String(PORT), MAILBOX_DIR: DIR, OWNER_LOCK: owner.lock,
    KNOCK_PUBLIC_KEY: KEYS.publicKey, KNOCK_PRIVATE_KEY: KEYS.privateKey, KNOCK_TEST_ORIGIN: pushOrigin });
}
function waitForServer() {
  return serve.waitForServer(server, async () => { (await connect()).close(); return true; });
}

let nextIp = 0;
function connect(ip) {
  nextIp++;
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: ORIGIN, headers: { "x-forwarded-for": ip || `10.6.${nextIp >> 8}.${nextIp & 255}` } });
  ws.inbox = [];
  ws.on("message", raw => { try { ws.inbox.push(JSON.parse(raw)); } catch (_) {} });
  ws.send_ = obj => ws.send(JSON.stringify(obj));
  return new Promise((resolve, reject) => { ws.on("open", () => resolve(ws)); ws.on("error", reject); });
}
const open = [];
async function client(ip) { const ws = await connect(ip); open.push(ws); return ws; }
async function waitFor(ws, type, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = ws.inbox.find(m => m.type === type);
    if (hit) return hit;
    await sleep(20);
  }
  return null;
}

/** The owner's device: connected, and shown to be the owner's. */
async function ownerDevice(keys = owner) {
  const ws = await client();
  const hello = await waitFor(ws, "hello");
  ws.send_({ type: "owner-hello", proof: await DC.proveOwner(keys, BOX, hello.nonce) });
  return ws;
}

/** A note as a visitor's page leaves it. */
async function note(body, over = {}) {
  const id = DC.makeMailId();
  const sealed = await DC.sealNote(owner.lock, { box: BOX, id }, body);
  return { type: "mail-drop", box: BOX, to: "a", id, at: Date.now(), ...sealed, ...over };
}

function upload(id, bytes) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: "/api/mailbox/file", method: "POST",
      headers: { "x-dc-client": "1", "content-type": "application/octet-stream", "content-length": bytes.length,
                 "x-dc-mail": `${BOX}:a:${id}:${bytes.length}`, "x-forwarded-for": "10.5.0.1" } }, res => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(bytes);
  });
}
function download(id) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: PORT, path: "/api/mailbox/file", headers: { "x-dc-client": "1", "x-dc-mail": `${BOX}:a:${id}` } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

test.before(async () => {
  owner = await DC.ownerKeys(DC.makeOwnerCode(), p256);
  stranger = await DC.ownerKeys(DC.makeOwnerCode(), p256);
  BOX = await DC.inboxName(owner.lock);
  push = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => { pushed.push(req.url); res.statusCode = req.url.includes("gone") ? 410 : 201; res.end(); });
  });
  await new Promise(r => push.listen(0, "127.0.0.1", r));
  pushOrigin = `http://127.0.0.1:${push.address().port}`;
  startServer();
  await waitForServer();
});

test.after(() => {
  for (const ws of open) { try { ws.terminate(); } catch (_) {} }
  if (server) server.kill();
  if (push) push.close();
  fs.rmSync(DIR, { recursive: true, force: true });
});

test("every connection gets a word of its own to sign", async () => {
  const a = await client(), b = await client();
  const [ha, hb] = [await waitFor(a, "hello"), await waitFor(b, "hello")];
  assert.match(ha.nonce, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(ha.nonce, hb.nonce);
});

test("only the owner's key, signing this connection's word, makes it the owner's", async () => {
  const good = await ownerDevice();
  assert.ok(await waitFor(good, "owner-ok"));
  const other = await ownerDevice(stranger);
  assert.ok(await waitFor(other, "owner-refused"), "another key");
  const replay = await client();
  await waitFor(replay, "hello");
  replay.send_({ type: "owner-hello", proof: await DC.proveOwner(owner, BOX, (await waitFor(good, "hello")).nonce) });
  assert.ok(await waitFor(replay, "owner-refused"), "another connection's word, replayed");
  for (const proof of [undefined, "", "x".repeat(86), 42]) {
    const ws = await client();
    await waitFor(ws, "hello");
    ws.send_({ type: "owner-hello", proof });
    assert.ok(await waitFor(ws, "owner-refused"), String(proof));
  }
});

test("anyone leaves a note; nobody but the owner collects it, or has it let go — and the owner opens it", async () => {
  const visitor = await client();
  const n = await note({ name: "Bat", text: "are you around this weekend?" });
  visitor.send_(n);
  assert.deepEqual(await waitFor(visitor, "mail-dropped"), { type: "mail-dropped", id: n.id });
  const nosy = await client();
  nosy.send_({ type: "mail-fetch", files: true, boxes: [{ box: BOX, side: "a" }] });
  nosy.send_({ type: "mail-ack", box: BOX, side: "a", ids: [n.id] });
  await sleep(300);
  assert.ok(!nosy.inbox.some(m => m.type === "mail"), "not handed to a stranger");
  const me = await ownerDevice();
  await waitFor(me, "owner-ok");
  me.send_({ type: "mail-fetch", files: true, boxes: [{ box: BOX, side: "a" }] });
  const got = await waitFor(me, "mail");
  const item = got.items.find(m => m.id === n.id);
  assert.ok(item, "still there: the stranger's word let nothing go");
  assert.deepEqual(await DC.openNote(owner, { box: BOX, id: item.id, iv: item.iv, ct: item.ct }), { name: "Bat", text: "are you around this weekend?" });
  me.send_({ type: "mail-ack", box: BOX, side: "a", ids: [n.id] });
  await sleep(200);
  me.inbox.length = 0;
  me.send_({ type: "mail-fetch", files: true, boxes: [{ box: BOX, side: "a" }] });
  await sleep(300);
  assert.ok(!me.inbox.some(m => m.type === "mail" && m.items.some(x => x.id === n.id)), "let go for good");
});

test("notes stay until the owner deletes them: every device of the owner's gets the same list — an empty one too", async () => {
  const visitor = await client();
  const n = await note({ name: "Bat", text: "for all your devices" });
  visitor.send_(n);
  await waitFor(visitor, "mail-dropped");
  const phone = await ownerDevice();
  await waitFor(phone, "owner-ok");
  phone.send_({ type: "mail-fetch", files: true, boxes: [{ box: BOX, side: "a" }] });
  assert.ok((await waitFor(phone, "mail")).items.some(m => m.id === n.id));
  await sleep(300);
  const laptop = await ownerDevice();
  await waitFor(laptop, "owner-ok");
  laptop.send_({ type: "mail-fetch", files: true, boxes: [{ box: BOX, side: "a" }] });
  const list = await waitFor(laptop, "mail");
  assert.ok(list.items.some(m => m.id === n.id), "the phone took it; it is still there for the laptop");
  laptop.send_({ type: "mail-ack", box: BOX, side: "a", ids: list.items.map(m => m.id) });
  await sleep(300);
  phone.inbox.length = 0;
  phone.send_({ type: "mail-fetch", files: true, boxes: [{ box: BOX, side: "a" }] });
  assert.deepEqual(await waitFor(phone, "mail"), { type: "mail", box: BOX, side: "a", items: [] }, "all deleted on the laptop: the phone is told, with an empty list");
});

test("the server keeps the owner's inbox as its one lasting mailbox — no week", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");
  assert.match(server, /createMailboxes\(\{[^}]*lasting: OWNER_BOX \}\)/);
  assert.ok(server.indexOf("const OWNER_BOX") < server.indexOf("const mail = createMailboxes"), "worked out before the mailboxes are made");
});

test("a note's file: sent first, fetched by the owner, opened only by the owner", async () => {
  const visitor = await client();
  const n = await note({ name: "", text: "", file: { name: "cat.jpg", type: "image/jpeg", size: 4000 } }, { file: true });
  const bytes = crypto.randomBytes(4000);
  assert.equal(await upload(n.id, await DC.sealNoteFile(owner.lock, { box: BOX, id: n.id }, bytes)), 200);
  visitor.send_(n);
  assert.ok(await waitFor(visitor, "mail-dropped"));
  const me = await ownerDevice();
  await waitFor(me, "owner-ok");
  me.send_({ type: "mail-fetch", files: true, boxes: [{ box: BOX, side: "a" }] });
  const item = (await waitFor(me, "mail")).items.find(m => m.id === n.id);
  assert.equal(item.file, 4000 + DC.NOTE_SEAL_EXTRA);
  const file = await download(n.id);
  assert.equal(file.status, 200);
  assert.ok(Buffer.from(await DC.openNoteFile(owner, { box: BOX, id: n.id }, file.body)).equals(bytes));
  me.send_({ type: "mail-ack", box: BOX, side: "a", ids: [n.id] });
});

test("a note for the inbox's other side is refused; notes are limited per network", async () => {
  const visitor = await client("10.4.4.4");
  const wrong = await note({ name: "", text: "x" }, { to: "b" });
  visitor.send_(wrong);
  assert.deepEqual(await waitFor(visitor, "mail-refused"), { type: "mail-refused", id: wrong.id, code: "invalid" });
  visitor.inbox.length = 0;
  let refused = null;
  for (let i = 0; i < 12 && !refused; i++) {
    visitor.send_(await note({ name: "", text: `note ${i}` }));
    await sleep(30);
    refused = visitor.inbox.find(m => m.type === "mail-refused");
  }
  assert.equal(refused && refused.code, "too-many");
});

test("the owner says where to be alerted — and a note with nobody there alerts it; kept across a restart", async () => {
  const address = () => { const e = crypto.createECDH("prime256v1"); e.generateKeys();
    return { endpoint: `${pushOrigin}/push/${crypto.randomBytes(4).toString("hex")}`, p256dh: e.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") }; };
  for (const ws of open.splice(0)) ws.terminate();                      // nobody else looking at the inbox
  await sleep(200);
  const me = await ownerDevice();
  await waitFor(me, "owner-ok");
  const mine = address();
  me.send_({ type: "owner-alert", knock: mine });
  await sleep(200);
  const nosy = await client();
  nosy.send_({ type: "owner-alert", knock: address() });                 // after the owner, and not the owner: not taken
  await sleep(200);
  nosy.close();
  me.close();
  await sleep(200);
  pushed.length = 0;
  const theirs = address();
  (await client()).send_(await note({ name: "", text: "while you were out" }, { knock: theirs }));
  for (let i = 0; i < 50 && !pushed.length; i++) await sleep(50);
  await sleep(200);
  assert.deepEqual(pushed, [new URL(mine.endpoint).pathname],
    "to the owner's device — not the stranger's alert address, nor one a visitor names with the note");
  const kept = JSON.parse(fs.readFileSync(path.join(DIR, "owner.json"), "utf8"));
  assert.equal(kept.alert.endpoint, mine.endpoint);
  assert.equal(kept.box, BOX);
  server.kill();
  await sleep(500);
  startServer();
  await waitForServer();
  pushed.length = 0;
  (await client()).send_(await note({ name: "", text: "after the restart" }));
  for (let i = 0; i < 50 && !pushed.length; i++) await sleep(50);
  assert.deepEqual(pushed, [new URL(mine.endpoint).pathname], "still known after a restart");
});

test("an alert address the push service says is gone is let go of", async () => {
  for (const ws of open.splice(0)) ws.terminate();
  const me = await ownerDevice();
  await waitFor(me, "owner-ok");
  const e = crypto.createECDH("prime256v1"); e.generateKeys();
  me.send_({ type: "owner-alert", knock: { endpoint: `${pushOrigin}/push/gone`, p256dh: e.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") } });
  await sleep(200);
  me.close();
  await sleep(300);
  pushed.length = 0;
  server.kill();                                                        // a fresh process: no once-a-minute gap in the way
  await sleep(500);
  startServer();
  await waitForServer();
  (await client()).send_(await note({ name: "", text: "to a gone address" }));
  for (let i = 0; i < 50 && !pushed.length; i++) await sleep(50);
  assert.deepEqual(pushed, ["/push/gone"]);
  await sleep(300);
  assert.equal(JSON.parse(fs.readFileSync(path.join(DIR, "owner.json"), "utf8")).alert, null, "forgotten");
});
