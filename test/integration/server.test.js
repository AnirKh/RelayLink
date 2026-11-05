/*
  Integration tests for the signaling server: join rules, brute-force limits,
  and the heartbeat that drops clients which vanish without disconnecting.

  Spawns a real server on a spare port with a short heartbeat interval, so the
  vanish test finishes in seconds rather than a minute.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const path   = require("node:path");
const { startServer, waitForServer, stopServer } = require("./serve.js");
const http   = require("node:http");
const WebSocket = require("ws");

const PORT   = 3199;
const URL    = `ws://127.0.0.1:${PORT}`;
const ORIGIN = "http://localhost:3000";   // must be in the server's allowlist

let server;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* The server keys its rate limits on the client IP, and getClientIp() trusts
   X-Forwarded-For. Handing every client its own address keeps one test's
   lockout from leaking into the next — without it, the brute-force test locks
   the shared address for 30s and everything after it fails to join. */
let nextIp = 0;
function freshIp() {
  nextIp++;
  return `10.${(nextIp >> 16) & 255}.${(nextIp >> 8) & 255}.${nextIp & 255}`;
}

function connect(ip = freshIp()) {
  const ws = new WebSocket(URL, { origin: ORIGIN, headers: { "x-forwarded-for": ip } });
  ws.inbox = [];
  ws.testIp = ip;
  ws.on("message", raw => { try { ws.inbox.push(JSON.parse(raw)); } catch (_) {} });
  ws.send_ = obj => ws.send(JSON.stringify(obj));
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

async function waitFor(ws, type, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = ws.inbox.find(m => m.type === type);
    if (hit) return hit;
    await sleep(25);
  }
  return null;
}

const open = [];
async function client() {
  const ws = await connect();
  open.push(ws);
  return ws;
}

test.before(async () => {
  server = startServer({ PORT: String(PORT), HEARTBEAT_MS: "1000", HOST_AWAY_MS: "1500" });
  // wait for the port to accept connections
  await waitForServer(server, async () => { (await connect()).close(); return true; });
});

test.after(async () => {
  for (const ws of open) { try { ws.terminate(); } catch (_) {} }
  await stopServer(server);
});

/* ══════════════════════════════════════════
   Session lifecycle
══════════════════════════════════════════ */

test("creating a room returns a 6-digit PIN and a token", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-basic" });
  const created = await waitFor(host, "session-created");
  assert.ok(created, "no session-created");
  assert.match(created.pin, /^\d{6}$/);
  assert.ok(created.token && created.token.length >= 20);
});

test("a duplicate room name is refused", async () => {
  const a = await client();
  a.send_({ type: "create-session", sessionId: "room-dup" });
  await waitFor(a, "session-created");

  const b = await client();
  b.send_({ type: "create-session", sessionId: "room-dup" });
  const refused = await waitFor(b, "error");
  assert.ok(refused, "duplicate name should be refused");
  assert.equal(refused.code, "name-taken", "said with a code, so the page can say it in its own language");
});

/* A create the page sends again, because its link dropped before the answer
   came back: the server had made the room, kept it for its away host, and
   refused the second create as "name taken". The create's own key gets the
   same room back. */
const CREATE_KEY = "k".repeat(10) + "Create_Key-0123";      // 25 base64url characters

test("a create sent again with its key gets the same room back, not \"name taken\"", async () => {
  const first = await client();
  first.send_({ type: "create-session", sessionId: "room-resent", createKey: CREATE_KEY });
  const made = await waitFor(first, "session-created");
  first.terminate();                                         // the link drops; the answer is lost with it
  await sleep(300);
  const again = await client();
  again.send_({ type: "create-session", sessionId: "room-resent", createKey: CREATE_KEY });
  const answer = await waitFor(again, "session-created");
  assert.ok(answer, `got ${JSON.stringify(again.inbox.find(m => m.type === "error"))}`);
  for (const field of ["pin", "token", "hostKey", "kind"]) assert.equal(answer[field], made[field], `the same ${field}`);
  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "room-resent", pin: made.pin });
  assert.ok(await waitFor(guest, "session-joined"), "the PIN already shared still works");
  assert.ok(await waitFor(again, "guest-joined"), "and the page that sent it again is the host");
});

test("on the same link too — an answer lost, the link kept — and never counted as another room", async () => {
  const ws = await client();
  ws.send_({ type: "create-session", sessionId: "room-resent-twice", createKey: CREATE_KEY.replace("k", "j") });
  const made = await waitFor(ws, "session-created");
  for (let i = 0; i < 12; i++) {
    ws.inbox.length = 0;
    ws.send_({ type: "create-session", sessionId: "room-resent-twice", createKey: CREATE_KEY.replace("k", "j") });
    const answer = await waitFor(ws, "session-created", 1500);
    assert.ok(answer && answer.pin === made.pin, `send ${i + 2}: ${JSON.stringify(ws.inbox)}`);
    assert.ok(!ws.inbox.some(m => m.type === "error"), `send ${i + 2} was refused as well: ${JSON.stringify(ws.inbox)}`);
  }
});

test("a malformed key is not kept, so it gets nothing back", async () => {
  const first = await client();
  first.send_({ type: "create-session", sessionId: "room-resent-bad-key", createKey: "short" });
  assert.ok(await waitFor(first, "session-created"), "the room is made as any room is");
  first.terminate();
  await sleep(300);
  const again = await client();
  again.send_({ type: "create-session", sessionId: "room-resent-bad-key", createKey: "short" });
  const refused = await waitFor(again, "error");
  assert.equal(refused && refused.code, "name-taken");
});

test("another key, a malformed one, or none is still \"name taken\"", async () => {
  const owner = await client();
  owner.send_({ type: "create-session", sessionId: "room-resent-others", createKey: CREATE_KEY.replace("k", "m") });
  await waitFor(owner, "session-created");
  for (const createKey of [CREATE_KEY.replace("k", "n"), undefined, "short", CREATE_KEY.replace("k", "m") + "!", 42]) {
    const other = await client();
    other.send_({ type: "create-session", sessionId: "room-resent-others", createKey });
    const refused = await waitFor(other, "error");
    assert.equal(refused && refused.code, "name-taken", JSON.stringify(createKey));
  }
});

test("a guest who arrived while the host was away is introduced when the create comes again", async () => {
  const first = await client();
  first.send_({ type: "create-session", sessionId: "room-resent-guest", open: true, createKey: CREATE_KEY.replace("k", "p") });
  await waitFor(first, "session-created");
  first.terminate();
  await sleep(300);
  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "room-resent-guest" });
  const joined = await waitFor(guest, "session-joined");
  assert.equal(joined && joined.hostAway, true, "setup: the guest waits for the host");
  const again = await client();
  again.send_({ type: "create-session", sessionId: "room-resent-guest", open: true, createKey: CREATE_KEY.replace("k", "p") });
  assert.ok(await waitFor(again, "session-created"));
  assert.ok(await waitFor(again, "guest-joined"), "the host meets the guest");
  assert.ok(await waitFor(guest, "host-back"), "and the guest is told");
});

test("a room whose chat has begun cannot be taken by its create key", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-resent-chat", createKey: CREATE_KEY.replace("k", "q") });
  const made = await waitFor(host, "session-created");
  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "room-resent-chat", pin: made.pin });
  assert.ok(await waitFor(host, "guest-joined"), "setup: the chat begins");
  const late = await client();
  late.send_({ type: "create-session", sessionId: "room-resent-chat", createKey: CREATE_KEY.replace("k", "q") });
  const refused = await waitFor(late, "error");
  assert.equal(refused && refused.code, "name-taken");
  assert.ok(!guest.inbox.some(m => m.type === "host-back" || m.type === "peer-disconnected"), "the chat is left alone");
});

test("invalid room names are refused", async () => {
  const ws = await client();
  for (const bad of ["", "  padded  ", "x".repeat(81), "bad<>name"]) {
    ws.inbox.length = 0;
    ws.send_({ type: "create-session", sessionId: bad });
    const refused = await waitFor(ws, "error", 1500);
    assert.ok(refused, `should reject: ${JSON.stringify(bad)}`);
    assert.equal(refused.code, "invalid-name");
  }
});

test("too many rooms from one address is said with a code too", async () => {
  const ws = await client();
  let refused = null;
  for (let i = 0; i < 12 && !refused; i++) {
    ws.inbox.length = 0;
    ws.send_({ type: "create-session", sessionId: `many-${i}` });
    await sleep(60);
    refused = ws.inbox.find(m => m.type === "error");
  }
  assert.ok(refused, "the create limit should be reached");
  assert.equal(refused.code, "too-many-rooms");
});

test("the correct PIN admits a guest and notifies the host", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-join" });
  const created = await waitFor(host, "session-created");

  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "room-join", pin: created.pin });
  assert.ok(await waitFor(guest, "session-joined"), "guest not admitted");
  assert.ok(await waitFor(host, "guest-joined"),   "host not told");
});

test("the invite token admits a guest without the PIN", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-token" });
  const created = await waitFor(host, "session-created");

  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "room-token", token: created.token });
  assert.ok(await waitFor(guest, "session-joined"));
});

test("joining an unknown room reports not-found", async () => {
  const ws = await client();
  ws.send_({ type: "join-session", sessionId: "no-such-room", pin: "123456" });
  const err = await waitFor(ws, "pin-error");
  assert.equal(err.code, "not-found");
});

test("a full room refuses a third participant", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-full" });
  const created = await waitFor(host, "session-created");

  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "room-full", pin: created.pin });
  await waitFor(guest, "session-joined");

  const third = await client();
  third.send_({ type: "join-session", sessionId: "room-full", pin: created.pin });
  const err = await waitFor(third, "pin-error");
  assert.equal(err.code, "full");
});

/* ══════════════════════════════════════════
   Brute-force protection
══════════════════════════════════════════ */

test("wrong PINs lock the joiner out after three attempts", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-brute" });
  const created = await waitFor(host, "session-created");
  const wrong = created.pin === "000000" ? "111111" : "000000";

  const guest = await client();
  const codes = [];
  for (let i = 0; i < 4; i++) {
    guest.inbox.length = 0;
    guest.send_({ type: "join-session", sessionId: "room-brute", pin: wrong });
    const err = await waitFor(guest, "pin-error");
    codes.push(err && err.code);
  }
  assert.deepEqual(codes.slice(0, 2), ["wrong-pin", "wrong-pin"]);
  assert.equal(codes[2], "rate-limited", "third wrong PIN should trigger lockout");
  assert.equal(codes[3], "rate-limited", "still locked out afterwards");
});

/* ══════════════════════════════════════════
   Heartbeat — clients that vanish silently
══════════════════════════════════════════ */

test("a peer that stops responding is dropped and the room is freed", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-ghost" });
  const created = await waitFor(host, "session-created");

  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "room-ghost", pin: created.pin });
  await waitFor(guest, "session-joined");
  await waitFor(host, "guest-joined");

  /* Simulate a phone losing signal: the socket stays open at the TCP level but
     the client never reads, so it never answers a ping. A close frame is never
     sent, which is exactly the case the heartbeat exists for. */
  host.inbox.length = 0;
  guest._socket.pause();

  const gone = await waitFor(host, "peer-disconnected", 6000);
  assert.ok(gone, "surviving peer was never told the other side vanished");

  /* The real symptom of a leaked room is its name staying reserved. */
  await sleep(300);
  const reuse = await client();
  reuse.send_({ type: "create-session", sessionId: "room-ghost" });
  assert.ok(await waitFor(reuse, "session-created", 2000), "room name was not released");
});

test("a healthy client survives several heartbeat sweeps", async () => {
  const ws = await client();
  ws.send_({ type: "create-session", sessionId: "room-healthy" });
  await waitFor(ws, "session-created");
  await sleep(3500);                       // ~3 sweeps at HEARTBEAT_MS=1000
  assert.equal(ws.readyState, WebSocket.OPEN);
});

/* ══════════════════════════════════════════
   "Leave a message" by email is gone

   It went through a mail company that read every word; a note is now sealed
   to the owner and left like a waiting message (see OWNER INBOX in server.js,
   and test/integration/notes.test.js). The address it used answers nothing.
══════════════════════════════════════════ */

async function stillServing() {
  const res = await new Promise(resolve => {
    const r = http.get({ host: "127.0.0.1", port: PORT, path: "/api/ping" }, res => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => resolve({ status: res.statusCode }));
    });
    r.on("error", err => resolve({ error: err.code }));
    r.setTimeout(3000, () => { r.destroy(); resolve({ error: "TIMEOUT" }); });
  });
  return res.status === 200;
}

test("the email route is gone, and asking for it changes nothing", async () => {
  const res = await new Promise(resolve => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: "/api/send-message", method: "POST",
      headers: { "Content-Type": "application/json", "X-DC-Client": "1" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    r.on("error", () => resolve(null));
    r.end('{"message":"hi"}');
  });
  assert.equal(res, 404);
  assert.ok(await stillServing());
  const ping = await new Promise(resolve => http.get({ host: "127.0.0.1", port: PORT, path: "/api/ping" }, res => {
    let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d)));
  }));
  assert.equal(ping.maxLeaveAttachBytes, undefined, "no email attachment limit to tell");
});

test("at most 50 open links from one address; one closing makes room for another", async () => {
  /* Found in a security assessment: nothing bounded them. */
  const ip = freshIp();
  const links = [];
  for (let i = 0; i < 50; i++) links.push(await connect(ip));
  await assert.rejects(connect(ip), /429/, "the 51st is refused");
  const other = await connect(freshIp());
  assert.equal(other.readyState, WebSocket.OPEN, "another address is not held to this one's count");
  links.pop().close();
  await sleep(200);
  links.push(await connect(ip));
  for (const ws of [...links, other]) ws.close();
});

/* ══════════════════════════════════════════
   Privacy
══════════════════════════════════════════ */

test("occupied rooms are hidden from the lobby list", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-listing" });
  const created = await waitFor(host, "session-created");

  const probe = await client();
  probe.send_({ type: "list-sessions" });
  const before = await waitFor(probe, "session-list");
  assert.ok(before.sessions.some(s => s.sessionId === "room-listing"), "waiting room should be listed");

  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "room-listing", pin: created.pin });
  await waitFor(guest, "session-joined");

  probe.inbox.length = 0;
  probe.send_({ type: "list-sessions" });
  const after = await waitFor(probe, "session-list");
  assert.ok(!after.sessions.some(s => s.sessionId === "room-listing"), "occupied room should be hidden");
});

/* ══════════════════════════════════════════
   WebSocket input that is valid JSON but not a message
══════════════════════════════════════════ */

test("a JSON value that is not an object does not take the server down", async () => {
  /* JSON.parse is happy with `null`, and reading `.type` off null throws. A
     "message" listener that throws is an uncaught exception, which ends the
     process — so four characters from anyone dropped every room and every call
     in progress. As with the upload tests above, the evidence that matters is
     that a bystander is still connected afterwards. */
  const live = await client();
  live.send_({ type: "create-session", sessionId: "room-survives-null" });
  assert.ok(await waitFor(live, "session-created"), "setup: room not created");

  const hostile = await client();
  for (const frame of ["null", "7", "\"text\"", "[]", "[null]", "true", "{}", "{\"type\":null}"]) {
    hostile.send(frame);
  }
  await sleep(300);

  assert.ok(await stillServing(), "the server stopped answering after a non-object message");
  assert.equal(live.readyState, WebSocket.OPEN, "a live session was dropped with the process");

  /* The socket that sent them is not punished either — it just was not heard. */
  hostile.send_({ type: "list-sessions" });
  assert.ok(await waitFor(hostile, "session-list"), "the sender's own socket should still work");
});

/* ══════════════════════════════════════════
   Which lock applies to which credential
══════════════════════════════════════════ */

/** Sends three wrong PINs from one address and waits for all three answers. */
async function threeWrongPins(sessionId, wrong) {
  const stranger = await client();
  for (let i = 0; i < 3; i++) stranger.send_({ type: "join-session", sessionId, pin: wrong });
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && stranger.inbox.filter(m => m.type === "pin-error").length < 3) await sleep(25);
}

test("a valid invite link still works while wrong PINs have the room locked", async () => {
  /* Room names are listed publicly, so anyone can lock any room: fifteen wrong
     PINs. That used to turn away the invited guest as well, for five minutes
     at a time, for as long as someone kept it up. */
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-locked" });
  const created = await waitFor(host, "session-created");
  const wrong = created.pin === "000000" ? "111111" : "000000";

  for (let i = 0; i < 5; i++) await threeWrongPins("room-locked", wrong);   // 5 addresses x 3

  /* The lock is real, and it holds even against the right PIN — otherwise it
     would stop nothing and a guesser would just carry on. */
  const typed = await client();
  typed.send_({ type: "join-session", sessionId: "room-locked", pin: created.pin });
  const refused = await waitFor(typed, "pin-error");
  assert.equal(refused && refused.code, "session-join-locked", "setup: the room should be locked by now");

  const invited = await client();
  invited.send_({ type: "join-session", sessionId: "room-locked", token: created.token });
  assert.ok(await waitFor(invited, "session-joined"),
    "the holder of a valid invite link was locked out by someone else's wrong PINs");
});

test("a wrong token during a lock learns nothing but that the room is locked", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-locked-2" });
  const created = await waitFor(host, "session-created");
  const wrong = created.pin === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) await threeWrongPins("room-locked-2", wrong);

  const guesser = await client();
  guesser.send_({ type: "join-session", sessionId: "room-locked-2", token: "x".repeat(created.token.length) });
  const err = await waitFor(guesser, "pin-error");
  assert.equal(err && err.code, "session-join-locked");
});

/* ══════════════════════════════════════════
   One room per socket
══════════════════════════════════════════ */

test("a host cannot join their own room", async () => {
  /* It is in the lobby list like any other room and the PIN is on screen. It
     used to be admitted, leaving one browser negotiating with itself. */
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-own" });
  const created = await waitFor(host, "session-created");

  host.send_({ type: "join-session", sessionId: "room-own", pin: created.pin });
  const err = await waitFor(host, "pin-error");
  assert.equal(err && err.code, "own-room");

  /* ...and the attempt did not damage the room. */
  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "room-own", token: created.token });
  assert.ok(await waitFor(guest, "session-joined"), "the room should still accept its real guest");
});

test("opening a second room lets go of the first", async () => {
  /* The first used to stay listed with nobody behind it: a guest who joined
     waited on a host who was elsewhere, and its expiry ten minutes later ended
     the chat in the second room. */
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-first" });
  const first = await waitFor(host, "session-created");
  host.inbox.length = 0;
  host.send_({ type: "create-session", sessionId: "room-second" });
  const second = await waitFor(host, "session-created");
  assert.equal(second && second.sessionId, "room-second");

  const late = await client();
  late.send_({ type: "join-session", sessionId: "room-first", token: first.token });
  const err = await waitFor(late, "pin-error");
  assert.equal(err && err.code, "not-found", "the abandoned room should be gone, not waiting on a host who left it");

  const other = await client();
  other.send_({ type: "create-session", sessionId: "room-first" });
  assert.ok(await waitFor(other, "session-created", 2000), "the abandoned room's name was not released");
});

test("a failed attempt to open a second room leaves the first alone", async () => {
  const taken = await client();
  taken.send_({ type: "create-session", sessionId: "room-taken" });
  await waitFor(taken, "session-created");

  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-keeps" });
  const kept = await waitFor(host, "session-created");
  host.send_({ type: "create-session", sessionId: "room-taken" });   // refused: name in use
  assert.ok(await waitFor(host, "error"), "setup: the duplicate name should be refused");

  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "room-keeps", token: kept.token });
  assert.ok(await waitFor(guest, "session-joined"), "a refused create must not cost the host the room they had");
});

test("joining someone else's room lets go of your own", async () => {
  const other = await client();
  other.send_({ type: "create-session", sessionId: "room-theirs" });
  const theirs = await waitFor(other, "session-created");

  const mover = await client();
  mover.send_({ type: "create-session", sessionId: "room-mine" });
  const mine = await waitFor(mover, "session-created");
  mover.send_({ type: "join-session", sessionId: "room-theirs", token: theirs.token });
  assert.ok(await waitFor(mover, "session-joined"), "setup: the move should succeed");

  const late = await client();
  late.send_({ type: "join-session", sessionId: "room-mine", token: mine.token });
  const err = await waitFor(late, "pin-error");
  assert.equal(err && err.code, "not-found", "the room its host walked away from should be gone");
});

test("a peer leaving is reported with the room it happened in", async () => {
  /* Without a name the client had to assume its current room, and was wrong
     whenever it had moved on. */
  const host = await client();
  host.send_({ type: "create-session", sessionId: "room-named" });
  const created = await waitFor(host, "session-created");
  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "room-named", token: created.token });
  await waitFor(guest, "session-joined");

  guest.send_({ type: "leave-session" });
  const gone = await waitFor(host, "peer-disconnected");
  assert.equal(gone && gone.sessionId, "room-named");
});

/* ══════════════════════════════════════════
   Open rooms — created without a PIN
══════════════════════════════════════════ */

async function listed(sessionId) {
  const probe = await client();
  probe.send_({ type: "list-sessions" });
  const list = await waitFor(probe, "session-list");
  return list.sessions.find(s => s.sessionId === sessionId) || null;
}

test("an open room is created without a PIN and listed as open", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "open-basic", open: true });
  const created = await waitFor(host, "session-created");
  assert.ok(created, "no session-created");
  assert.equal(created.open, true);
  assert.equal(created.pin, null, "an open room has no PIN to hand out");
  assert.ok(created.token && created.token.length >= 20, "it still gets a token for the invite link");

  const entry = await listed("open-basic");
  assert.ok(entry, "the open room should be in the list");
  assert.equal(entry.open, true);
});

test("an ordinary room is listed as not open", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "open-not" });
  const created = await waitFor(host, "session-created");
  assert.equal(created.open, false);
  assert.match(created.pin, /^\d{6}$/);
  assert.equal((await listed("open-not")).open, false);
});

test("only exactly open:true makes a room open", async () => {
  /* A room must never become open by accident — not from a string, a number,
     or a field someone added for another reason. */
  let n = 0;
  for (const value of ["true", 1, "yes", {}, [], null]) {
    const host = await client();
    const name = `open-strict-${n++}`;
    host.send_({ type: "create-session", sessionId: name, open: value });
    const created = await waitFor(host, "session-created");
    assert.equal(created.open, false, `open:${JSON.stringify(value)} must still make a PIN room`);
    assert.match(created.pin, /^\d{6}$/);

    const stranger = await client();
    stranger.send_({ type: "join-session", sessionId: name });
    const refused = await waitFor(stranger, "pin-error");
    assert.equal(refused && refused.code, "pin-required", `open:${JSON.stringify(value)} let a stranger in`);
  }
});

test("anyone can join an open room with nothing but its name", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "open-join", open: true });
  await waitFor(host, "session-created");

  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "open-join" });
  assert.ok(await waitFor(guest, "session-joined"), "the guest should be let straight in");
  assert.ok(await waitFor(host, "guest-joined"), "the host should be told");
});

test("an open room still holds only one guest", async () => {
  /* "No PIN" is not "no limit". */
  const host = await client();
  host.send_({ type: "create-session", sessionId: "open-one", open: true });
  await waitFor(host, "session-created");

  const first = await client();
  first.send_({ type: "join-session", sessionId: "open-one" });
  assert.ok(await waitFor(first, "session-joined"));

  const second = await client();
  second.send_({ type: "join-session", sessionId: "open-one" });
  const refused = await waitFor(second, "pin-error");
  assert.equal(refused && refused.code, "full");

  assert.equal(await listed("open-one"), null, "an occupied open room should leave the list");
});

test("an open room lets in someone whose address is locked out of a PIN room", async () => {
  /* The lockout is for PIN guessing. It says nothing about a room with no PIN. */
  const pinHost = await client();
  pinHost.send_({ type: "create-session", sessionId: "open-vs-lock-pin" });
  const pinRoom = await waitFor(pinHost, "session-created");
  const wrong = pinRoom.pin === "000000" ? "111111" : "000000";

  const person = await client();
  for (let i = 0; i < 3; i++) person.send_({ type: "join-session", sessionId: "open-vs-lock-pin", pin: wrong });
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && person.inbox.filter(m => m.type === "pin-error").length < 3) await sleep(25);
  assert.equal(person.inbox.filter(m => m.code === "rate-limited").length >= 1, true, "setup: the address should be locked out");

  const openHost = await client();
  openHost.send_({ type: "create-session", sessionId: "open-vs-lock-open", open: true });
  await waitFor(openHost, "session-created");
  person.send_({ type: "join-session", sessionId: "open-vs-lock-open" });
  assert.ok(await waitFor(person, "session-joined"), "a PIN lockout must not keep someone out of an open room");
});

test("knocking on a PIN room with nothing is not counted as a wrong guess", async () => {
  /* A stale list, or a client that has not asked for the PIN yet. Counting it
     would lock people out for looking — and lock the room for everyone. */
  const host = await client();
  host.send_({ type: "create-session", sessionId: "open-knock" });
  const created = await waitFor(host, "session-created");

  const guest = await client();
  for (let i = 0; i < 6; i++) {
    guest.inbox.length = 0;
    guest.send_({ type: "join-session", sessionId: "open-knock" });
    const answer = await waitFor(guest, "pin-error");
    assert.equal(answer && answer.code, "pin-required", `knock ${i + 1}`);
    assert.equal(answer.sessionId, "open-knock", "the answer should say which room wants a PIN");
  }
  /* Six knocks would be two lockouts' worth of wrong PINs. The right PIN still works. */
  guest.send_({ type: "join-session", sessionId: "open-knock", pin: created.pin });
  assert.ok(await waitFor(guest, "session-joined"), "knocking must not have used up the guest's attempts");
});

test("a host cannot join their own open room either", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "open-own", open: true });
  await waitFor(host, "session-created");
  host.send_({ type: "join-session", sessionId: "open-own" });
  const refused = await waitFor(host, "pin-error");
  assert.equal(refused && refused.code, "own-room");
});

test("an open room lets in someone who typed a PIN anyway", async () => {
  /* A browser that believed the room wanted a PIN sends one. There is no PIN
     to compare it with — the room's is null — and that must be a plain "no
     match", not an error that leaves the join unanswered. */
  const host = await client();
  host.send_({ type: "create-session", sessionId: "open-with-pin", open: true });
  await waitFor(host, "session-created");

  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "open-with-pin", pin: "123456" });
  assert.ok(await waitFor(guest, "session-joined"), "a PIN sent to an open room should be ignored, not choked on");
});

/* ══════════════════════════════════════════
   Telling pages which build the server is
══════════════════════════════════════════ */

test("the server names its build the moment a socket connects", async () => {
  /* Every open page reconnects a few seconds after the server restarts for an
     update, so this is how a page left open learns that it is old. */
  const ws = await client();
  const hello = await waitFor(ws, "hello", 2000);
  assert.ok(hello, "no hello on connecting");
  assert.match(hello.build, /^\d{12}-[0-9a-f]{8}$/);

  const fs = require("node:fs");
  const inApp = fs.readFileSync(path.join(__dirname, "..", "..", "app.js"), "utf8").match(/^const APP_BUILD = "([^"]+)";/m)[1];
  assert.equal(hello.build, inApp, "the server must announce the build of the client it ships");
  assert.equal(ws.inbox[0].type, "hello", "it should be the first thing said");
});

test("a page too old to update itself is told to reload", async () => {
  /* Pages from before the handshake cannot act on a build id, but they do show
     the text of an error. They ask for the room list the moment they connect,
     without saying hello — which is how the server recognises them. */
  const oldPage = await client();
  oldPage.send_({ type: "list-sessions" });
  assert.ok(await waitFor(oldPage, "session-list"), "it must still get its list");
  const notice = await waitFor(oldPage, "error", 2000);
  assert.ok(notice, "an old page was not told to reload");
  assert.match(notice.message, /reopen|reload/i);

  /* Once per connection, not on every refresh of the list. */
  oldPage.send_({ type: "list-sessions" });
  oldPage.send_({ type: "list-sessions" });
  await sleep(400);
  assert.equal(oldPage.inbox.filter(m => m.type === "error").length, 1, "the notice should not repeat");
});

test("a current page is not nagged", async () => {
  const page = await client();
  page.send_({ type: "hello", build: "202610131742-3fa9c1d2" });
  page.send_({ type: "list-sessions" });
  assert.ok(await waitFor(page, "session-list"));
  await sleep(400);
  assert.equal(page.inbox.filter(m => m.type === "error").length, 0, "a page that said hello must not get the reload notice");
});

test("a hello with nonsense in it is harmless", async () => {
  const live = await client();
  const ws = await client();
  for (const build of [null, 42, {}, [], "x".repeat(5000), "<script>"]) ws.send_({ type: "hello", build });
  ws.send_({ type: "list-sessions" });
  assert.ok(await waitFor(ws, "session-list"), "the socket should still work");
  assert.ok(await stillServing());
  assert.equal(live.readyState, WebSocket.OPEN);
});

/* ══════════════════════════════════════════
   Code rooms — created without a PIN, admit first-come
══════════════════════════════════════════ */

test("a code room is created without a PIN and listed as a code room", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "code-basic", code: true });
  const created = await waitFor(host, "session-created");
  assert.equal(created.kind, "code");
  assert.equal(created.pin, null, "a code room has no server PIN — the word is proven between the peers");
  assert.ok(created.token, "it still gets a token");

  const probe = await client();
  probe.send_({ type: "list-sessions" });
  const list = await waitFor(probe, "session-list");
  const entry = list.sessions.find(s => s.sessionId === "code-basic");
  assert.ok(entry && entry.kind === "code", "the list must mark it a code room");
});

test("anyone is admitted to a code room with just its name — the word is not a join credential", async () => {
  /* The server never sees the word; it admits like an open room, and the SPAKE2
     handshake between the two browsers is the real gate. */
  const host = await client();
  host.send_({ type: "create-session", sessionId: "code-admit", code: true });
  await waitFor(host, "session-created");

  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "code-admit" });
  assert.ok(await waitFor(guest, "session-joined"), "the guest is admitted; the word is proven afterwards");
  assert.ok(await waitFor(host, "guest-joined"));
});

test("only an explicit code flag makes a code room", async () => {
  let n = 0;
  for (const value of ["code", 1, {}, "true"]) {
    const host = await client();
    const name = `code-strict-${n++}`;
    host.send_({ type: "create-session", sessionId: name, code: value });
    const created = await waitFor(host, "session-created");
    assert.notEqual(created.kind, "code", `code:${JSON.stringify(value)} must not make a code room`);
    assert.match(created.pin, /^\d{6}$/, "it stays a PIN room with a PIN");
  }
});

/* ══════════════════════════════════════════
   A code room outlives its guest

   Admission to a code room is first-come; the word is proven afterwards,
   between the browsers. A guest leaving used to delete the room, so one wrong
   guess — or one stranger joining and leaving — destroyed it, and the right
   word could only find "not found". Now the seat is freed and the host told.
══════════════════════════════════════════ */

async function codeRoomWithGuest(name) {
  const host = await client();
  host.send_({ type: "create-session", sessionId: name, code: true });
  assert.ok(await waitFor(host, "session-created"), "setup: room not created");
  const guest = await client();
  guest.send_({ type: "join-session", sessionId: name });
  assert.ok(await waitFor(guest, "session-joined"), "setup: guest not admitted");
  assert.ok(await waitFor(host, "guest-joined"));
  return { host, guest };
}

async function listedNames() {
  const probe = await client();
  probe.send_({ type: "list-sessions" });
  const list = await waitFor(probe, "session-list");
  return list.sessions.map(s => s.sessionId);
}

test("a code room's guest leaving frees the seat, keeps the room, and tells the host", async () => {
  const { host, guest } = await codeRoomWithGuest("code-keep-leave");
  guest.send_({ type: "leave-session" });
  const left = await waitFor(host, "guest-left");
  assert.ok(left, "the host is told the seat is free");
  assert.equal(left.sessionId, "code-keep-leave");
  assert.ok(!host.inbox.some(m => m.type === "peer-disconnected"), "not told the room is gone");
  assert.ok((await listedNames()).includes("code-keep-leave"), "listed again for the next attempt");

  const next = await client();
  next.send_({ type: "join-session", sessionId: "code-keep-leave" });
  assert.ok(await waitFor(next, "session-joined"), "the next guest gets in");
});

test("a code room's guest vanishing also frees the seat rather than deleting the room", async () => {
  const { host, guest } = await codeRoomWithGuest("code-keep-close");
  guest.close();
  assert.ok(await waitFor(host, "guest-left"));
  assert.ok((await listedNames()).includes("code-keep-close"));
});

test("the host of a code room can turn its guest away, and the seat is free again", async () => {
  const { host, guest } = await codeRoomWithGuest("code-release");
  host.send_({ type: "release-guest", sessionId: "code-release" });
  const told = await waitFor(guest, "peer-disconnected");
  assert.ok(told && told.sessionId === "code-release", "the guest is told");
  assert.ok((await listedNames()).includes("code-release"));
  /* The guest leaving afterwards changes nothing: it is no longer in the room. */
  guest.send_({ type: "leave-session" });
  await sleep(300);
  assert.ok((await listedNames()).includes("code-release"));
  assert.ok(!("reason" in told), "a wrong word is not a lock");
});

test("turned away from a locked code room, the guest is told so, and for how long", async () => {
  const { host, guest } = await codeRoomWithGuest("code-locked");
  host.send_({ type: "release-guest", sessionId: "code-locked", reason: "locked", retryIn: 240 });
  const told = await waitFor(guest, "peer-disconnected");
  assert.equal(told && told.reason, "code-locked");
  assert.equal(told.retryIn, 240);

  /* Only the one reason, and only a sensible wait, are passed on. */
  for (const [extra, expect] of [
    [{ reason: "locked", retryIn: 99999 }, { reason: "code-locked", retryIn: undefined }],
    [{ reason: "locked", retryIn: "soon" }, { reason: "code-locked", retryIn: undefined }],
    [{ reason: "<b>go away</b>", retryIn: 5 }, { reason: undefined, retryIn: undefined }]
  ]) {
    const next = await client();
    next.send_({ type: "join-session", sessionId: "code-locked" });
    assert.ok(await waitFor(next, "session-joined"), "the seat is free for the next try");
    host.send_({ type: "release-guest", sessionId: "code-locked", ...extra });
    const heard = await waitFor(next, "peer-disconnected");
    assert.equal(heard.reason, expect.reason, JSON.stringify(extra));
    assert.equal(heard.retryIn, expect.retryIn, JSON.stringify(extra));
  }
});

test("only the host can turn a guest away, and only in a code room", async () => {
  const { host, guest } = await codeRoomWithGuest("code-release-guest-tries");
  guest.send_({ type: "release-guest", sessionId: "code-release-guest-tries" });
  const stranger = await client();
  stranger.send_({ type: "release-guest", sessionId: "code-release-guest-tries" });
  await sleep(400);
  assert.ok(!guest.inbox.some(m => m.type === "peer-disconnected"), "nobody but the host may free the seat");
  assert.ok(!(await listedNames()).includes("code-release-guest-tries"), "still occupied, so still unlisted");

  const pinHost = await client();
  pinHost.send_({ type: "create-session", sessionId: "pin-no-release" });
  const created = await waitFor(pinHost, "session-created");
  const pinGuest = await client();
  pinGuest.send_({ type: "join-session", sessionId: "pin-no-release", pin: created.pin });
  assert.ok(await waitFor(pinGuest, "session-joined"));
  pinHost.send_({ type: "release-guest", sessionId: "pin-no-release" });
  await sleep(400);
  assert.ok(!pinGuest.inbox.some(m => m.type === "peer-disconnected"), "a PIN room's guest is not turned away");
  host.close();
});

test("PIN and open rooms still close when their guest leaves; a code room still closes when its host does", async () => {
  const pinHost = await client();
  pinHost.send_({ type: "create-session", sessionId: "pin-closes" });
  const created = await waitFor(pinHost, "session-created");
  const pinGuest = await client();
  pinGuest.send_({ type: "join-session", sessionId: "pin-closes", pin: created.pin });
  assert.ok(await waitFor(pinGuest, "session-joined"));
  pinGuest.send_({ type: "leave-session" });
  assert.ok(await waitFor(pinHost, "peer-disconnected"), "a PIN room's host is told the room is gone");
  assert.ok(!(await listedNames()).includes("pin-closes"));

  const { host, guest } = await codeRoomWithGuest("code-host-leaves");
  host.send_({ type: "leave-session" });
  assert.ok(await waitFor(guest, "peer-disconnected"), "the guest is told");
  assert.ok(!(await listedNames()).includes("code-host-leaves"));
});

/* ══════════════════════════════════════════
   A host whose link drops — the room waits

   To send the link, the host switches to a messaging app, and the phone cuts
   the page's link to the server. The room used to be deleted on the spot, so
   the link was dead by the time the friend tapped it. A waiting room is now
   kept for HOST_AWAY_MS (1.5 s here, ten minutes for real), and the host takes
   it back with its host key.
══════════════════════════════════════════ */

async function roomThenDrop(name, extra = {}) {
  const host = await client();
  host.send_({ type: "create-session", sessionId: name, ...extra });
  const created = await waitFor(host, "session-created");
  assert.ok(created, "setup: room not created");
  host.terminate();                        // the link drops: no leave, no goodbye
  await sleep(200);
  return created;
}

test("a new room comes with a host key, which is nothing like its token and is in no list", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "key-room" });
  const created = await waitFor(host, "session-created");
  assert.ok(typeof created.hostKey === "string" && created.hostKey.length >= 20);
  assert.notEqual(created.hostKey, created.token, "the link carries the token; the host key must be another secret");
  const probe = await client();
  probe.send_({ type: "list-sessions" });
  const list = await waitFor(probe, "session-list");
  assert.ok(!JSON.stringify(list).includes(created.hostKey));
});

test("the host's link dropping keeps the room; its host key takes it back, with the same PIN and token", async () => {
  const created = await roomThenDrop("away-reclaim");
  assert.ok((await listedNames()).includes("away-reclaim"), "still listed while its host is away");

  const back = await client();
  back.send_({ type: "reclaim-session", sessionId: "away-reclaim", hostKey: created.hostKey });
  const reclaimed = await waitFor(back, "session-reclaimed");
  assert.ok(reclaimed, "taken back");
  assert.equal(reclaimed.pin, created.pin);
  assert.equal(reclaimed.token, created.token, "the link already sent still works");
  assert.equal(reclaimed.guestWaiting, false);
});

test("a wrong host key takes nothing", async () => {
  const created = await roomThenDrop("away-wrong-key");
  const thief = await client();
  for (const hostKey of ["nope", created.token, undefined, null, 7]) {
    thief.inbox.length = 0;
    thief.send_({ type: "reclaim-session", sessionId: "away-wrong-key", hostKey });
    assert.ok(await waitFor(thief, "reclaim-failed", 1500), `${JSON.stringify(hostKey)} must not take the room`);
  }
  assert.ok(!thief.inbox.some(m => m.type === "session-reclaimed"));
  const back = await client();
  back.send_({ type: "reclaim-session", sessionId: "away-wrong-key", hostKey: created.hostKey });
  assert.ok(await waitFor(back, "session-reclaimed"), "the real host still can");
});

test("a guest who arrives while the host is away gets in and is told to wait; the host's return connects them", async () => {
  const created = await roomThenDrop("away-guest", { open: true });
  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "away-guest" });
  const joined = await waitFor(guest, "session-joined");
  assert.ok(joined, "admitted");
  assert.equal(joined.hostAway, true, "and told the host is away");

  const back = await client();
  back.send_({ type: "reclaim-session", sessionId: "away-guest", hostKey: created.hostKey });
  const reclaimed = await waitFor(back, "session-reclaimed");
  assert.equal(reclaimed.guestWaiting, true);
  assert.ok(await waitFor(back, "guest-joined"), "the host hears of the guest on returning");
  assert.ok(await waitFor(guest, "host-back"), "the guest hears the host is back");
});

test("a guest with a PIN who arrives while the host is away is told too", async () => {
  const created = await roomThenDrop("away-pin-guest");
  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "away-pin-guest", pin: created.pin });
  const joined = await waitFor(guest, "session-joined");
  assert.equal(joined && joined.hostAway, true);
});

test("a guest leaving a room whose host is away frees the seat and keeps the room", async () => {
  const created = await roomThenDrop("away-guest-leaves", { open: true });
  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "away-guest-leaves" });
  assert.ok(await waitFor(guest, "session-joined"));
  guest.send_({ type: "leave-session" });
  await sleep(200);
  assert.ok((await listedNames()).includes("away-guest-leaves"));
  const back = await client();
  back.send_({ type: "reclaim-session", sessionId: "away-guest-leaves", hostKey: created.hostKey });
  const reclaimed = await waitFor(back, "session-reclaimed");
  assert.equal(reclaimed && reclaimed.guestWaiting, false);
});

test("leaving on purpose still closes the room at once", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "away-leaves" });
  const created = await waitFor(host, "session-created");
  host.send_({ type: "leave-session" });
  await sleep(200);
  assert.ok(!(await listedNames()).includes("away-leaves"));
  const back = await client();
  back.send_({ type: "reclaim-session", sessionId: "away-leaves", hostKey: created.hostKey });
  assert.ok(await waitFor(back, "reclaim-failed"));
});

test("a host who does not come back in time loses the room: not listed, not joinable, not taken back", async () => {
  const created = await roomThenDrop("away-too-long");
  await sleep(1800);                       // past HOST_AWAY_MS
  assert.ok(!(await listedNames()).includes("away-too-long"));
  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "away-too-long" });
  const refused = await waitFor(guest, "pin-error");
  assert.equal(refused && refused.code, "not-found");
  const back = await client();
  back.send_({ type: "reclaim-session", sessionId: "away-too-long", hostKey: created.hostKey });
  assert.ok(await waitFor(back, "reclaim-failed"));
});

test("a host whose link drops mid-chat is waited for — and the room goes only if it never comes back", async () => {
  /* It used to end the room at once, and nothing could repair the chat after. */
  const host = await client();
  host.send_({ type: "create-session", sessionId: "away-mid-chat" });
  const created = await waitFor(host, "session-created");
  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "away-mid-chat", pin: created.pin });
  assert.ok(await waitFor(guest, "session-joined"));
  host.terminate();
  assert.ok(await waitFor(guest, "peer-away"), "the guest is told the host's link dropped");
  assert.ok(!guest.inbox.some(m => m.type === "peer-disconnected"), "not that the room is gone");
  assert.ok(await waitFor(guest, "peer-disconnected", 4000), "past HOST_AWAY_MS with no return, it is");
});

/* ══════════════════════════════════════════
   A seat kept through a dropped link
══════════════════════════════════════════ */

/* Assessing why calls did not survive a phone changing networks: a room was
   deleted the moment either side's link to the server dropped mid-chat, and
   every repair of the chat goes through the room. Now the seat is kept, and
   the page takes it back on its new link. */

async function chatRoom(sessionId) {
  const host = await client();
  host.send_({ type: "create-session", sessionId });
  const created = await waitFor(host, "session-created");
  const guest = await client();
  guest.send_({ type: "join-session", sessionId, pin: created.pin });
  const joined = await waitFor(guest, "session-joined");
  assert.ok(joined && await waitFor(host, "guest-joined"), "setup: no chat");
  return { host, guest, created, joined };
}

test("joining hands the guest a key of its own, nothing like the room's token, and in no list", async () => {
  const { created, joined } = await chatRoom("keep-key");
  assert.match(joined.guestKey, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(joined.guestKey, created.token);
  assert.notEqual(joined.guestKey, created.hostKey);
  const probe = await client();
  probe.send_({ type: "list-sessions" });
  const list = await waitFor(probe, "session-list");
  assert.ok(!JSON.stringify(list).includes(joined.guestKey));
});

test("a guest whose link drops mid-chat takes its seat back with its key; the host is told both ways", async () => {
  const { host, guest, joined } = await chatRoom("keep-guest");
  guest.terminate();                        // a phone changing networks
  assert.ok(await waitFor(host, "peer-away"), "the host is told the guest's link dropped");
  assert.ok(!host.inbox.some(m => m.type === "peer-disconnected"), "not that the room is gone");

  const back = await client();              // the same page, on its new link
  back.send_({ type: "rejoin-session", sessionId: "keep-guest", guestKey: joined.guestKey });
  const rejoined = await waitFor(back, "session-rejoined");
  assert.ok(rejoined, "the seat is taken back");
  assert.equal(rejoined.hostAway, false);
  assert.ok(await waitFor(host, "peer-back"), "and the host is told the way to repair the chat is open");

  /* The repair goes through again, both ways. */
  host.send_({ type: "renegotiate-offer", sessionId: "keep-guest", offer: { type: "offer", sdp: "x" } });
  assert.ok(await waitFor(back, "renegotiate-offer"), "host to guest");
  back.send_({ type: "repair-request", sessionId: "keep-guest" });
  assert.ok(await waitFor(host, "repair-request"), "guest to host");
});

test("a host whose link drops mid-chat takes the room back — the chat goes on, nothing starts again", async () => {
  const { host, guest, created } = await chatRoom("keep-host");
  host.inbox.length = 0;
  host.terminate();
  assert.ok(await waitFor(guest, "peer-away"));

  const back = await client();
  back.send_({ type: "reclaim-session", sessionId: "keep-host", hostKey: created.hostKey });
  const reclaimed = await waitFor(back, "session-reclaimed");
  assert.equal(reclaimed && reclaimed.resumed, true, "back to a chat, not a waiting room");
  assert.ok(await waitFor(guest, "peer-back"));
  await sleep(200);
  assert.ok(!back.inbox.some(m => m.type === "guest-joined"), "a guest-joined would start the chat over");
  assert.ok(!guest.inbox.some(m => m.type === "host-back"), "nor is the guest told to wait for a new start");
  back.send_({ type: "renegotiate-offer", sessionId: "keep-host", offer: { type: "offer", sdp: "x" } });
  assert.ok(await waitFor(guest, "renegotiate-offer"), "and the repair goes through");
});

test("the seat is not free while it is kept: not listed, and a newcomer is turned away", async () => {
  const { host, guest, created } = await chatRoom("keep-full");
  guest.terminate();
  assert.ok(await waitFor(host, "peer-away"));
  assert.ok(!(await listedNames()).includes("keep-full"));
  const stranger = await client();
  stranger.send_({ type: "join-session", sessionId: "keep-full", pin: created.pin });
  const refused = await waitFor(stranger, "pin-error");
  assert.equal(refused && refused.code, "full");
});

test("a guest that never comes back: the host is told once the wait is over, and the room is gone", async () => {
  const { host, guest, joined } = await chatRoom("keep-expire");
  guest.terminate();
  assert.ok(await waitFor(host, "peer-away"));
  assert.ok(await waitFor(host, "peer-disconnected", 4000), "past HOST_AWAY_MS");
  const late = await client();
  late.send_({ type: "rejoin-session", sessionId: "keep-expire", guestKey: joined.guestKey });
  assert.ok(await waitFor(late, "rejoin-failed"), "too late to take it back");
});

test("only the right key takes a seat back", async () => {
  const { guest, joined, created } = await chatRoom("keep-wrong-key");
  guest.terminate();
  await sleep(200);
  for (const guestKey of ["A".repeat(32), created.token, created.hostKey, undefined]) {
    const thief = await client();
    thief.send_({ type: "rejoin-session", sessionId: "keep-wrong-key", guestKey });
    assert.ok(await waitFor(thief, "rejoin-failed"), `refused: ${String(guestKey).slice(0, 6)}`);
  }
  const back = await client();
  back.send_({ type: "rejoin-session", sessionId: "keep-wrong-key", guestKey: joined.guestKey });
  assert.ok(await waitFor(back, "session-rejoined"), "and the right one still does");
});

test("a page back on a new link before its old one is noticed gone takes the seat; the old one closing later ends nothing", async () => {
  const { host, guest, joined } = await chatRoom("keep-overlap");
  const back = await client();
  back.send_({ type: "rejoin-session", sessionId: "keep-overlap", guestKey: joined.guestKey });
  assert.ok(await waitFor(back, "session-rejoined"));
  host.inbox.length = 0;
  guest.terminate();                        // the old link, noticed only now
  await sleep(400);
  assert.ok(!host.inbox.some(m => m.type === "peer-away" || m.type === "peer-disconnected"), "the old link is no longer the guest");
  host.send_({ type: "renegotiate-offer", sessionId: "keep-overlap", offer: { type: "offer", sdp: "x" } });
  assert.ok(await waitFor(back, "renegotiate-offer"));
});

test("leaving on purpose still ends the room at once", async () => {
  const { host, guest } = await chatRoom("keep-leave");
  guest.send_({ type: "leave-session" });
  assert.ok(await waitFor(host, "peer-disconnected", 1000), "no waiting for a guest that said goodbye");
});

test("a host who comes back too late cannot take the room back, even if nobody else touched it", async () => {
  const created = await roomThenDrop("away-late-reclaim");
  await sleep(1800);                       // past HOST_AWAY_MS, nothing else asks about the room
  const back = await client();
  back.send_({ type: "reclaim-session", sessionId: "away-late-reclaim", hostKey: created.hostKey });
  assert.ok(await waitFor(back, "reclaim-failed"), "a room kept too long is gone, whoever asks first");
  assert.ok(!back.inbox.some(m => m.type === "session-reclaimed"));
});

/* ══════════════════════════════════════════
   The same invite link, opened again
══════════════════════════════════════════ */

/* Reported: a link sent through Messenger opens in Messenger's own browser
   first, which took the seat. The guest then chose Safari and was told the
   room was full — and once the copy left in Messenger dropped, the room was
   deleted with it. The newer copy of the link now takes the seat. */

async function waitForMatch(ws, match, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = ws.inbox.find(match);
    if (hit) return hit;
    await sleep(25);
  }
  return null;
}

async function linkRoomWithGuest(sessionId) {
  const host = await client();
  host.send_({ type: "create-session", sessionId });
  const created = await waitFor(host, "session-created");
  const first = await client();
  first.send_({ type: "join-session", sessionId, token: created.token });
  assert.ok(await waitFor(first, "session-joined"));
  assert.ok(await waitFor(host, "guest-joined"));
  return { host, first, created };
}

test("the link opened again in another browser takes the seat, and the room stays", async () => {
  const { host, first, created } = await linkRoomWithGuest("link-again");

  const second = await client();
  second.send_({ type: "join-session", sessionId: "link-again", token: created.token, visible: true });
  assert.ok(await waitFor(second, "session-joined"), "the newer copy gets in, not 'full'");

  const taken = await waitFor(first, "seat-taken");
  assert.equal(taken && taken.sessionId, "link-again", "the copy left behind is told, so it stops");

  const moved = await waitForMatch(host, m => m.type === "guest-joined" && m.replaced === true);
  assert.ok(moved, "the host is told it is a new copy, so it starts the connection again");
  assert.ok(!host.inbox.some(m => m.type === "peer-disconnected"), "the room was not ended");

  /* The host's signalling now reaches the new copy, and only it. */
  host.send_({ type: "offer", sessionId: "link-again", offer: { type: "offer", sdp: "x" } });
  assert.ok(await waitFor(second, "offer"), "the new copy is the guest now");
  await sleep(200);
  assert.ok(!first.inbox.some(m => m.type === "offer"), "the old copy hears nothing more");
});

test("the copy left behind closing afterwards ends nothing", async () => {
  const { host, first, created } = await linkRoomWithGuest("link-left-behind");
  const second = await client();
  second.send_({ type: "join-session", sessionId: "link-left-behind", token: created.token, visible: true });
  assert.ok(await waitFor(second, "session-joined"));
  assert.ok(await waitFor(first, "seat-taken"));

  first.terminate();                       // the app's browser, closed or put to sleep
  await sleep(2500);                       // past two heartbeat sweeps
  assert.ok(!host.inbox.some(m => m.type === "peer-disconnected"), "the host is not told anyone left");
  assert.ok(!second.inbox.some(m => m.type === "peer-disconnected"), "nor the guest");
  host.send_({ type: "offer", sessionId: "link-left-behind", offer: { type: "offer", sdp: "x" } });
  assert.ok(await waitFor(second, "offer"), "the room is still there, with the newer copy in it");
});

test("the link does not move a guest who came in with the PIN", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "link-vs-pin" });
  const created = await waitFor(host, "session-created");
  const pinGuest = await client();
  pinGuest.send_({ type: "join-session", sessionId: "link-vs-pin", pin: created.pin });
  assert.ok(await waitFor(pinGuest, "session-joined"));

  const linkGuest = await client();
  linkGuest.send_({ type: "join-session", sessionId: "link-vs-pin", token: created.token });
  const refused = await waitFor(linkGuest, "pin-error");
  assert.equal(refused && refused.code, "full");
  await sleep(200);
  assert.ok(!pinGuest.inbox.some(m => m.type === "seat-taken"), "the PIN guest keeps the seat");
});

test("the PIN does not move a guest who came in with the link", async () => {
  const { first, created } = await linkRoomWithGuest("pin-vs-link");
  const pinGuest = await client();
  pinGuest.send_({ type: "join-session", sessionId: "pin-vs-link", pin: created.pin });
  const refused = await waitFor(pinGuest, "pin-error");
  assert.equal(refused && refused.code, "full");
  await sleep(200);
  assert.ok(!first.inbox.some(m => m.type === "seat-taken"));
});

test("the same page sending its join twice does not lose the room", async () => {
  /* "Replacing" itself would run the guest-left clean-up on the room's own
     guest, and delete the room. */
  const { host, first, created } = await linkRoomWithGuest("link-twice");
  first.send_({ type: "join-session", sessionId: "link-twice", token: created.token });
  const answer = await waitFor(first, "pin-error");
  assert.equal(answer && answer.code, "full", "told as before, and nothing else happens");
  await sleep(200);
  assert.ok(!first.inbox.some(m => m.type === "seat-taken"), "it is not told it was replaced by itself");
  assert.ok(!host.inbox.some(m => m.type === "peer-disconnected"), "the room is still there");
  host.send_({ type: "offer", sessionId: "link-twice", offer: { type: "offer", sdp: "x" } });
  assert.ok(await waitFor(first, "offer"), "and it is still the guest");
});

test("a copy nobody is looking at does not take the seat from the one in use", async () => {
  /* Reported after the first version: the guest was looking at Safari when it
     said the chat had moved to another browser — a copy in the background had
     taken the seat, and the host's connection to it never came up. */
  const { host, first, created } = await linkRoomWithGuest("link-hidden");
  const behind = await client();
  behind.send_({ type: "join-session", sessionId: "link-hidden", token: created.token, visible: false });
  const refused = await waitFor(behind, "pin-error");
  assert.equal(refused && refused.code, "held-elsewhere", "told the link is open elsewhere, not 'full'");
  await sleep(200);
  assert.ok(!first.inbox.some(m => m.type === "seat-taken"), "the copy in use keeps the seat");
  assert.ok(!host.inbox.some(m => m.type === "guest-joined" && m.replaced), "the host is not sent to a page nobody has open");

  /* "Continue here" on that copy, tapped — so on screen — does take it. */
  behind.send_({ type: "join-session", sessionId: "link-hidden", token: created.token, visible: true });
  assert.ok(await waitFor(behind, "session-joined"));
  assert.ok(await waitFor(first, "seat-taken"));
});

test("a page too old to say whether it is on screen cannot take a seat", async () => {
  const { first, created } = await linkRoomWithGuest("link-old-page");
  const old = await client();
  old.send_({ type: "join-session", sessionId: "link-old-page", token: created.token });
  const refused = await waitFor(old, "pin-error");
  assert.equal(refused && refused.code, "held-elsewhere");
  await sleep(200);
  assert.ok(!first.inbox.some(m => m.type === "seat-taken"));
});

/* ══════════════════════════════════════════
   Meeting a saved person (meet-session)
══════════════════════════════════════════ */

/** A saved person's room's name: "~" and 43 base64url characters. */
const savedRoom = tag => `~${(tag + "_".repeat(43)).slice(0, 43)}`;

test("the first to tap makes the room and waits in it — no PIN, no token, never listed", async () => {
  const a = await client();
  a.send_({ type: "meet-session", sessionId: savedRoom("first"), side: "a" });
  const made = await waitFor(a, "session-created");
  assert.ok(made, `got ${JSON.stringify(a.inbox)}`);
  assert.equal(made.kind, "saved");
  assert.equal(made.pin, null, "nothing to type");
  assert.equal(made.token, null, "and no link to send");
  assert.equal(made.open, false);
  assert.ok(typeof made.hostKey === "string" && made.hostKey.length >= 20, "a host key, to take the room back if the link drops");
  const looker = await client();
  looker.send_({ type: "list-sessions" });
  const list = await waitFor(looker, "session-list");
  assert.ok(!list.sessions.some(s => s.sessionId === savedRoom("first")), "the two of them's alone");
});

test("the second to tap joins it, and the two are introduced", async () => {
  const a = await client(), b = await client();
  a.send_({ type: "meet-session", sessionId: savedRoom("second"), side: "a" });
  await waitFor(a, "session-created");
  b.send_({ type: "meet-session", sessionId: savedRoom("second"), side: "b" });
  const joined = await waitFor(b, "session-joined");
  assert.ok(joined, `got ${JSON.stringify(b.inbox)}`);
  assert.equal(joined.hostAway, false);
  assert.ok(typeof joined.guestKey === "string" && joined.guestKey.length >= 20, "a guest key, to take the seat back if the link drops");
  assert.ok(await waitFor(a, "guest-joined"), "the one waiting is told");
  a.send_({ type: "offer", sessionId: savedRoom("second"), offer: { type: "offer", sdp: "x" } });
  assert.ok(await waitFor(b, "offer"), "and they connect as any room does");
});

test("either side may come first", async () => {
  const a = await client(), b = await client();
  b.send_({ type: "meet-session", sessionId: savedRoom("either"), side: "b" });
  assert.ok(await waitFor(b, "session-created"));
  a.send_({ type: "meet-session", sessionId: savedRoom("either"), side: "a" });
  assert.ok(await waitFor(a, "session-joined"));
  assert.ok(await waitFor(b, "guest-joined"));
});

test("two taps at once: one makes the room, the other joins it — never two rooms, never a refusal", async () => {
  for (let i = 0; i < 5; i++) {
    const a = await client(), b = await client();
    const room = savedRoom(`atonce${i}`);
    a.send_({ type: "meet-session", sessionId: room, side: "a" });
    b.send_({ type: "meet-session", sessionId: room, side: "b" });
    await sleep(300);
    const made = [a, b].filter(ws => ws.inbox.some(m => m.type === "session-created"));
    const joined = [a, b].filter(ws => ws.inbox.some(m => m.type === "session-joined"));
    assert.equal(made.length, 1, `round ${i}: ${JSON.stringify([a.inbox, b.inbox])}`);
    assert.equal(joined.length, 1);
    assert.notEqual(made[0], joined[0]);
    assert.ok(![a, b].some(ws => ws.inbox.some(m => m.type === "error")));
  }
});

test("a saved person's room cannot be joined, made or listed any other way", async () => {
  const a = await client();
  a.send_({ type: "meet-session", sessionId: savedRoom("only"), side: "a" });
  await waitFor(a, "session-created");
  for (const join of [{}, { pin: "123456" }, { token: "x".repeat(32) }]) {
    const other = await client();
    other.send_({ type: "join-session", sessionId: savedRoom("only"), visible: true, ...join });
    const refused = await waitFor(other, "pin-error");
    assert.equal(refused && refused.code, "not-found", `a join with ${JSON.stringify(join)}: as if not there`);
  }
  const maker = await client();
  maker.send_({ type: "create-session", sessionId: savedRoom("taken-by-name"), open: true });
  const refused = await waitFor(maker, "error");
  assert.equal(refused && refused.code, "invalid-name", "no room made by name may take a saved person's name");
  await sleep(200);
  assert.ok(!a.inbox.some(m => m.type === "guest-joined"), "nobody got in");
});

test("a malformed meet is refused, and makes nothing", async () => {
  for (const bad of [
    { sessionId: "plain-name", side: "a" },
    { sessionId: savedRoom("x").slice(0, 40), side: "a" },
    { sessionId: `${savedRoom("x")}y`, side: "a" },
    { sessionId: savedRoom("x").replace("~", "!"), side: "a" },
    { sessionId: savedRoom("x"), side: "c" },
    { sessionId: savedRoom("x") },
    { sessionId: 7, side: "a" }
  ]) {
    const ws = await client();
    ws.send_({ type: "meet-session", ...bad });
    const refused = await waitFor(ws, "error");
    assert.equal(refused && refused.code, "invalid-name", JSON.stringify(bad));
    assert.ok(!ws.inbox.some(m => m.type === "session-created"));
  }
});

test("the waiting side again — another tab, a reload — takes the seat; the copy left behind is told", async () => {
  const room = savedRoom("hostagain");
  const old = await client();
  old.send_({ type: "meet-session", sessionId: room, side: "a" });
  const first = await waitFor(old, "session-created");
  const fresh = await client();
  fresh.send_({ type: "meet-session", sessionId: room, side: "a" });
  const again = await waitFor(fresh, "session-created");
  assert.ok(again, "not refused as taken");
  assert.equal(again.hostKey, first.hostKey, "the same room");
  assert.equal(again.pin, null, "still nothing to type");
  assert.equal(again.token, null);
  assert.ok(await waitFor(old, "seat-taken"), "the old copy stops");
  const b = await client();
  b.send_({ type: "meet-session", sessionId: room, side: "b" });
  assert.ok(await waitFor(b, "session-joined"));
  assert.ok(await waitFor(fresh, "guest-joined"), "the newer copy is the one met");
  await sleep(200);
  assert.ok(!old.inbox.some(m => m.type === "guest-joined"));
});

test("the waiting side's link dropped and it taps again: the same room, and whoever came meanwhile is introduced", async () => {
  const room = savedRoom("hostback");
  const gone = await client();
  gone.send_({ type: "meet-session", sessionId: room, side: "a" });
  await waitFor(gone, "session-created");
  gone.terminate();
  await sleep(200);
  const b = await client();
  b.send_({ type: "meet-session", sessionId: room, side: "b" });
  const joined = await waitFor(b, "session-joined");
  assert.equal(joined && joined.hostAway, true, "told to wait for them");
  const back = await client();
  back.send_({ type: "meet-session", sessionId: room, side: "a" });
  assert.ok(await waitFor(back, "session-created"));
  assert.ok(await waitFor(back, "guest-joined"), "introduced at once");
  const hostBack = await waitFor(b, "host-back");
  assert.ok(hostBack && hostBack.restart !== true, "a chat that never began has nothing to start again");
});

test("the waiting side opened afresh mid-chat: the other starts again with the new copy", async () => {
  const room = savedRoom("restart");
  const a = await client(), b = await client();
  a.send_({ type: "meet-session", sessionId: room, side: "a" });
  await waitFor(a, "session-created");
  b.send_({ type: "meet-session", sessionId: room, side: "b" });
  await waitFor(b, "session-joined");
  await waitFor(a, "guest-joined");
  const fresh = await client();
  fresh.send_({ type: "meet-session", sessionId: room, side: "a" });
  assert.ok(await waitFor(fresh, "session-created"));
  assert.ok(await waitFor(fresh, "guest-joined"));
  const told = await waitForMatch(b, m => m.type === "host-back");
  assert.equal(told && told.restart, true, "the chat with the old copy is over: start again");
  assert.ok(await waitFor(a, "seat-taken"));
});

test("the other side again — another tab — takes the seat, and the one waiting starts again with it", async () => {
  const room = savedRoom("guestagain");
  const a = await client(), b = await client();
  a.send_({ type: "meet-session", sessionId: room, side: "a" });
  await waitFor(a, "session-created");
  b.send_({ type: "meet-session", sessionId: room, side: "b" });
  await waitFor(b, "session-joined");
  await waitFor(a, "guest-joined");
  const b2 = await client();
  b2.send_({ type: "meet-session", sessionId: room, side: "b" });
  assert.ok(await waitFor(b2, "session-joined"), "not 'full'");
  assert.ok(await waitFor(b, "seat-taken"));
  assert.ok(await waitForMatch(a, m => m.type === "guest-joined" && m.replaced === true), "the host starts again with the new copy");
  a.send_({ type: "offer", sessionId: room, offer: { type: "offer", sdp: "x" } });
  assert.ok(await waitFor(b2, "offer"));
  await sleep(200);
  assert.ok(!b.inbox.some(m => m.type === "offer"), "the old copy hears nothing more");
});

test("a link already seated does not change sides", async () => {
  const room = savedRoom("sides");
  const a = await client(), b = await client();
  a.send_({ type: "meet-session", sessionId: room, side: "a" });
  await waitFor(a, "session-created");
  b.send_({ type: "meet-session", sessionId: room, side: "b" });
  await waitFor(b, "session-joined");
  await waitFor(a, "guest-joined");
  a.inbox.length = 0; b.inbox.length = 0;
  b.send_({ type: "meet-session", sessionId: room, side: "a" });
  a.send_({ type: "meet-session", sessionId: room, side: "b" });
  await sleep(300);
  assert.deepEqual([a.inbox, b.inbox], [[], []], "nothing moves, nobody is told anything");
  a.send_({ type: "offer", sessionId: room, offer: { type: "offer", sdp: "x" } });
  assert.ok(await waitFor(b, "offer"), "the room is as it was");
});

test("leaving on purpose ends a saved person's room, and the next tap makes it afresh", async () => {
  const room = savedRoom("leave");
  const a = await client(), b = await client();
  a.send_({ type: "meet-session", sessionId: room, side: "a" });
  await waitFor(a, "session-created");
  b.send_({ type: "meet-session", sessionId: room, side: "b" });
  await waitFor(b, "session-joined");
  b.send_({ type: "leave-session", sessionId: room });
  assert.ok(await waitFor(a, "peer-disconnected"));
  const again = await client();
  again.send_({ type: "meet-session", sessionId: room, side: "b" });
  const made = await waitFor(again, "session-created");
  assert.ok(made, "made afresh: whoever taps first waits");
});

test("the waiting side's link dropping keeps the room, and its host key takes it back", async () => {
  const room = savedRoom("reclaim");
  const a = await client();
  a.send_({ type: "meet-session", sessionId: room, side: "a" });
  const made = await waitFor(a, "session-created");
  a.terminate();
  await sleep(200);
  const back = await client();
  back.send_({ type: "reclaim-session", sessionId: room, hostKey: made.hostKey });
  const reclaimed = await waitFor(back, "session-reclaimed");
  assert.ok(reclaimed, `got ${JSON.stringify(back.inbox)}`);
  assert.equal(reclaimed.kind, "saved");
});

test("a server without knock keys offers no knocks, and sends none", async () => {
  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/api/ping`, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); }).on("error", reject);
  });
  assert.equal(body.knockKey, null);
  const a = await client();
  a.send_({ type: "meet-session", sessionId: savedRoom("nokeys"), side: "a" });
  await waitFor(a, "session-created");
  a.send_({ type: "knock", sessionId: savedRoom("nokeys"), to: { endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: "B", auth: "x" } });
  await sleep(300);
  assert.ok(!a.inbox.some(m => m.type === "knock-result"), "not even an answer");
});

test("tapping a saved person counts as making a room, for the limit on rooms from one network", async () => {
  const ip = freshIp();
  let refused = null;
  for (let i = 0; i < 12 && !refused; i++) {
    const ws = await connect(ip);
    open.push(ws);
    ws.send_({ type: "meet-session", sessionId: savedRoom(`limit${i}`), side: "a" });
    await sleep(80);
    refused = ws.inbox.find(m => m.type === "error");
  }
  assert.equal(refused && refused.code, "too-many-rooms");
});

test("one room per link: tapping a saved person lets go of a room this link was hosting", async () => {
  const host = await client();
  host.send_({ type: "create-session", sessionId: "given-up-for-a-person", open: true });
  await waitFor(host, "session-created");
  host.inbox.length = 0;
  host.send_({ type: "meet-session", sessionId: savedRoom("instead"), side: "a" });
  assert.ok(await waitFor(host, "session-created"));
  const guest = await client();
  guest.send_({ type: "join-session", sessionId: "given-up-for-a-person" });
  const refused = await waitFor(guest, "pin-error");
  assert.equal(refused && refused.code, "not-found", "the old room is gone");
});

test("a seat whose chat is over cannot be taken back by the copy that left it", async () => {
  const room = savedRoom("stalekey");
  const a = await client(), b = await client();
  a.send_({ type: "meet-session", sessionId: room, side: "a" });
  await waitFor(a, "session-created");
  b.send_({ type: "meet-session", sessionId: room, side: "b" });
  const joined = await waitFor(b, "session-joined");
  await waitFor(a, "guest-joined");
  b.terminate();                                   // the other side's link drops: its seat is kept
  await sleep(200);
  const fresh = await client();
  fresh.send_({ type: "meet-session", sessionId: room, side: "a" });  // and this side opens it afresh
  assert.ok(await waitFor(fresh, "session-created"));
  const late = await client();
  late.send_({ type: "rejoin-session", sessionId: room, guestKey: joined.guestKey });
  assert.ok(await waitFor(late, "rejoin-failed"), "the chat it would take back is gone");
  const b2 = await client();
  b2.send_({ type: "meet-session", sessionId: room, side: "b" });
  assert.ok(await waitFor(b2, "session-joined"), "a tap on the name gets in");
  assert.ok(await waitFor(fresh, "guest-joined"));
});
