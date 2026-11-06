/*
  A fresh mailbox key each time two saved people meet live.

  A waiting message used to be sealed with a key worked out from the pair's
  secret, the same for as long as they stayed saved: whoever later had it,
  and a copy of what passed through the server, could read every one. Now
  each live chat in a saved person's own room hands over a new random key
  (side "a" offers, side "b" seals with it at once and says yes, side "a"
  then too), and only a few are kept.

  Here: the rules in guards.js; the key in protocol.js; and the app's own
  functions lifted out of app.js and run as two devices — handing keys over,
  and each opening what the other sealed, through every order things can
  happen in.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");
const DC     = require("../protocol.js");
const G      = require("../guards.js");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");
const fn = name => {
  const m = app.match(new RegExp(`^(?:async )?function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(m, `${name} not found as a top-level function in app.js`);
  return m[0];
};
const between = (from, to) => {
  const a = app.indexOf(from), b = app.indexOf(to, a);
  assert.ok(a > 0 && b > a, `${from} … ${to} not found in app.js`);
  return app.slice(a, b);
};

const k = c => c.repeat(43);

/* ══════════════════════════════════════════
   The rules
══════════════════════════════════════════ */

test("a meeting: side a keeps a new key at once but seals with it only after the yes; side b seals with it at once", () => {
  const offered = G.proposeMailKey(undefined, k("A"));
  assert.deepEqual(offered, { mk: { send: 0, keys: { 1: k("A") } }, epoch: 1 });
  const taken = G.acceptMailKey(undefined, { epoch: 1, key: k("A") });
  assert.deepEqual(taken, { mk: { send: 1, keys: { 1: k("A") } }, ack: true });
  assert.deepEqual(G.confirmMailKey(offered.mk, 1), { send: 1, keys: { 1: k("A") } });
  assert.deepEqual(G.mailKeyOrder(offered.mk), [1, 0], "a still opens with the secret's key, and already with the new one");
});

test("only the newest few are kept — and always the one sealed with", () => {
  let a = undefined, b = undefined;
  for (const c of ["A", "B", "C", "D", "E"]) {
    const { mk, epoch } = G.proposeMailKey(a, k(c));
    b = G.acceptMailKey(b, { epoch, key: k(c) }).mk;
    a = G.confirmMailKey(mk, epoch);
  }
  assert.equal(G.MAIL_KEYS_KEPT, 2);
  assert.deepEqual(a, { send: 5, keys: { 3: k("C"), 4: k("D"), 5: k("E") } });
  assert.deepEqual(b, a);
  assert.deepEqual(G.mailKeyOrder(a), [5, 4, 3, 0]);
  /* Offers that went unanswered pile up on side a: the one sealed with stays. */
  let unanswered = { send: 2, keys: { 2: k("B") } };
  for (const c of ["C", "D", "E"]) unanswered = G.proposeMailKey(unanswered, k(c)).mk;
  assert.deepEqual(unanswered, { send: 2, keys: { 2: k("B"), 4: k("D"), 5: k("E") } });
});

test("side b: an offer not newer, or not in shape, is refused; the same one again is said yes to again", () => {
  const b = { send: 3, keys: { 3: k("C"), 2: k("B") } };
  assert.deepEqual(G.acceptMailKey(b, { epoch: 3, key: k("C") }), { mk: b, ack: true }, "the yes may have been lost");
  assert.equal(G.acceptMailKey(b, { epoch: 3, key: k("Z") }).ack, false, "another key for an epoch it has");
  assert.equal(G.acceptMailKey(b, { epoch: 1, key: k("Z") }).ack, false, "an old epoch, replayed");
  for (const bad of [null, {}, { epoch: 4 }, { epoch: 0, key: k("Z") }, { epoch: 1.5, key: k("Z") }, { epoch: 4, key: "short" },
                     { epoch: 4, key: `${k("Z").slice(1)}=` }, { epoch: "4", key: k("Z") }]) {
    assert.deepEqual(G.acceptMailKey(b, bad), { mk: b, ack: false }, JSON.stringify(bad));
  }
  assert.deepEqual(G.confirmMailKey(b, 9), b, "a yes for a key it never offered");
  assert.deepEqual(G.confirmMailKey(b, 2), b, "nor for an older one");
});

test("what is kept is held to its shape; a saved person keeps theirs, and loses only a bad one", () => {
  assert.deepEqual(G.mailKeyState({ send: 2, keys: { 1: k("A"), 2: k("B"), x: k("C"), 3: "short", "-1": k("D"), "01": k("E") } }),
                   { send: 2, keys: { 1: k("A"), 2: k("B") } });
  assert.deepEqual(G.mailKeyState({ send: 7, keys: { 1: k("A") } }), { send: 0, keys: { 1: k("A") } }, "sealing with a key it does not have: back to 0");
  for (const nothing of [undefined, null, "x", { keys: null }]) assert.deepEqual(G.mailKeyState(nothing), { send: 0, keys: {} });
  const person = { name: "Anu", secret: "s".repeat(43), room: `~${"r".repeat(43)}`, side: "a", savedAt: 1 };
  assert.deepEqual(G.savedPeople({ v: 1, people: [{ ...person, mk: { send: 1, keys: { 1: k("A") } } }] })[0].mk, { send: 1, keys: { 1: k("A") } });
  const [kept] = G.savedPeople({ v: 1, people: [{ ...person, mk: { send: 1, keys: { 1: "nope" } } }] });
  assert.equal(kept.name, "Anu", "the person is kept");
  assert.equal(Object.hasOwn(kept, "mk"), false, "their keys were not: the secret's, as before");
});

test("a key is 32 random bytes, never the same twice, and cannot be read back out of the page", async () => {
  const seen = new Set();
  for (let i = 0; i < 100; i++) seen.add(DC.makeMailKey());
  assert.equal(seen.size, 100);
  for (const key of seen) assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  const key = await DC.importMailKey([...seen][0]);
  assert.equal(key.extractable, false);
  await assert.rejects(DC.importMailKey("AAAA"), /32 bytes/);
});

/* ══════════════════════════════════════════
   Two devices, run
══════════════════════════════════════════ */

const SOURCE = ["mailKeyAt", "mailKeyFor", "mailKeysToTry", "mailKeyPeer", "rotateMailKey", "receiveMailKey", "receiveMailKeyOk", "setMailKeys"]
  .map(fn).join("\n");
const SECRET = DC.makeRoomSecret();
let ROOM;
test.before(async () => { ROOM = await DC.savedRoomName(SECRET); });

/** One device's side of a saved pair, in their room. */
function device(side, { kind = "saved", green = true, stores = true, mk } = {}) {
  const env = { person: { name: side === "a" ? "Bat" : "Anu", secret: SECRET, room: ROOM, side, savedAt: 1, ...(mk ? { mk } : {}) },
                kind, green, stores, stored: [], sent: [] };
  const api = new Function("G", "DC", "env", `
    let people = [env.person], meeting = people[0], savedInChat = null, roomKind = env.kind;
    let mailKeySent = false, mailKeyOffer = null;
    const mailKeys = new Map();
    function chatGreen() { return env.green; }
    function storePeople(next) { if (!env.stores) return false; env.stored.push(JSON.parse(JSON.stringify(next))); return true; }
    function dcSendE2e(m) { env.sent.push(JSON.parse(JSON.stringify(m))); return Promise.resolve(true); }
    ${SOURCE}
    return { rotateMailKey, receiveMailKey, receiveMailKeyOk, mailKeyFor, mailKeysToTry,
             person: () => people[0], cached: () => [...mailKeys.keys()],
             newChannel: () => { mailKeySent = false; mailKeyOffer = null; } };`)(G, DC, env);
  return { ...api, env };
}

/** Sealed by one, opened by the other — the text, or null if it does not open. */
async function carry(from, to, text) {
  const where = { box: ROOM, from: from.person().side, to: to.person().side, id: DC.makeMailId(), at: Date.now() };
  const sealed = await DC.sealMail(await from.mailKeyFor(from.person()), { ...where, text });
  for (const key of await to.mailKeysToTry(to.person())) {
    const body = await DC.openMailBody(key, { ...where, ...sealed });
    if (body) return body.text;
  }
  return null;
}
const both = async (a, b) => [await carry(a, b, "a→b"), await carry(b, a, "b→a")];

test("a first meeting: a key handed over, and what each sends opens at the other at every step", async () => {
  const a = device("a"), b = device("b");
  assert.deepEqual(await both(a, b), ["a→b", "b→a"], "before: the secret's key, as always");
  a.rotateMailKey();
  const [offer] = a.env.sent;
  assert.equal(offer.type, "mail-key");
  assert.equal(offer.epoch, 1);
  assert.deepEqual(a.person().mk, { send: 0, keys: { 1: offer.key } }, "kept before it went; not sealed with yet");
  assert.deepEqual(a.env.stored.at(-1)[0].mk, a.person().mk, "and stored");
  assert.deepEqual(await both(a, b), ["a→b", "b→a"], "offered, not yet taken");
  b.receiveMailKey(offer);
  assert.deepEqual(b.person().mk, { send: 1, keys: { 1: offer.key } });
  assert.deepEqual(b.env.sent, [{ type: "mail-key-ok", epoch: 1 }]);
  assert.deepEqual(await both(a, b), ["a→b", "b→a"], "taken: b seals with it, a already opens with it");
  a.receiveMailKeyOk(b.env.sent[0]);
  assert.equal(a.person().mk.send, 1);
  assert.deepEqual(await both(a, b), ["a→b", "b→a"], "both seal with it");
});

test("a chat that ends before the yes loses nothing, and the next meeting hands over another", async () => {
  const a = device("a"), b = device("b");
  a.rotateMailKey();
  b.receiveMailKey(a.env.sent[0]);                 // taken — but the yes never arrives
  a.newChannel();
  assert.deepEqual(await both(a, b), ["a→b", "b→a"], "a seals with the old one, b with the new: each opens the other's");
  a.rotateMailKey();
  const second = a.env.sent.at(-1);
  assert.equal(second.epoch, 2);
  b.receiveMailKey(second);
  a.receiveMailKeyOk(b.env.sent.at(-1));
  assert.deepEqual([a.person().mk.send, b.person().mk.send], [2, 2]);
  assert.deepEqual(await both(a, b), ["a→b", "b→a"]);

  const c = device("a"), d = device("b");
  c.rotateMailKey();                               // the offer itself is lost
  c.newChannel();
  c.rotateMailKey();
  d.receiveMailKey(c.env.sent.at(-1));
  c.receiveMailKeyOk(d.env.sent.at(-1));
  assert.deepEqual([c.person().mk.send, d.person().mk.send], [2, 2], "the next one is taken, past the lost one");
  assert.deepEqual(await both(c, d), ["a→b", "b→a"]);
});

test("only side a offers, once a channel, in their own room, in a checked chat", () => {
  const b = device("b");
  b.rotateMailKey();
  assert.deepEqual(b.env.sent, []);
  const a = device("a");
  a.rotateMailKey(); a.rotateMailKey();
  assert.equal(a.env.sent.length, 1, "once a channel");
  for (const opts of [{ kind: "pin" }, { kind: "code" }, { green: false }]) {
    const x = device("a", opts);
    x.rotateMailKey();
    assert.deepEqual(x.env.sent, [], JSON.stringify(opts));
    assert.equal(x.person().mk, undefined);
  }
  const amber = device("b", { green: false });
  amber.receiveMailKey({ type: "mail-key", epoch: 1, key: k("A") });
  assert.deepEqual(amber.env.sent, [], "nor is one taken in an unchecked chat");
  const wrongSide = device("a");
  wrongSide.receiveMailKey({ type: "mail-key", epoch: 1, key: k("A") });
  assert.deepEqual(wrongSide.env.sent, [], "side a takes none: it is the one that offers");
});

test("a key b cannot keep is not said yes to — so a never seals with it", async () => {
  const a = device("a"), b = device("b", { stores: false });
  a.rotateMailKey();
  b.receiveMailKey(a.env.sent[0]);
  assert.deepEqual(b.env.sent, []);
  assert.equal(b.person().mk, undefined);
  assert.deepEqual(await both(a, b), ["a→b", "b→a"]);
  a.receiveMailKeyOk({ type: "mail-key-ok", epoch: 7 });
  assert.equal(a.person().mk.send, 0, "a yes for another key changes nothing");
});

test("old keys go: what was sealed with one no longer opens, nor does the page still hold it", async () => {
  const a = device("a"), b = device("b");
  const meet = () => { a.newChannel(); a.rotateMailKey(); b.receiveMailKey(a.env.sent.at(-1)); a.receiveMailKeyOk(b.env.sent.at(-1)); };
  meet();
  const where = { box: ROOM, from: "a", to: "b", id: DC.makeMailId(), at: Date.now() };
  const early = await DC.sealMail(await a.mailKeyFor(a.person()), { ...where, text: "sent after the first meeting" });
  const opens = async () => { for (const key of await b.mailKeysToTry(b.person())) if (await DC.openMailBody(key, { ...where, ...early })) return true; return false; };
  assert.equal(await opens(), true);
  meet(); meet();
  assert.equal(await opens(), true, "still kept, two meetings on");
  meet();
  assert.equal(await opens(), false, "three meetings on, its key is gone from both devices");
  assert.deepEqual(Object.keys(a.person().mk.keys).map(Number).sort(), [2, 3, 4]);
  assert.ok(!a.cached().some(id => id.endsWith(":1")), "nor held in the page");
  assert.deepEqual(await both(a, b), ["a→b", "b→a"]);
});

test("the secret's key still opens what a device not yet updated sends", async () => {
  const old = device("a");                         // no keys of its own: seals as it always did
  const b = device("b", { mk: { send: 3, keys: { 3: k("C"), 2: k("B") } } });
  assert.equal(await carry(old, b, "from an old page"), "from an old page");
});

/* ══════════════════════════════════════════
   The wiring
══════════════════════════════════════════ */

test("the two messages are sealed only, and each reaches its own handler", () => {
  for (const type of ["mail-key", "mail-key-ok"]) assert.equal(G.CLEAR_TYPES.includes(type), false, type);
  assert.match(between('    case "mail-key":', "      break;"), /receiveMailKey\(data\);/);
  assert.match(between('    case "mail-key-ok":', "      break;"), /receiveMailKeyOk\(data\);/);
});

test("offered as the chat starts, beside the knock address; let go with the channel", () => {
  assert.match(fn("e2eActivate"), /if \(!isHost\) \{ sendPeerInfo\(\); shareKnockAddress\(\); rotateMailKey\(\); flushOutbox\(\); \}/);
  assert.match(app, /if \(isHost\) \{ shareKnockAddress\(\); rotateMailKey\(\); flushOutbox\(\); \}/);
  assert.match(fn("closePeerConnection"), /mailKeySent = false;[^\n]*\n\s*mailKeyOffer = null;/);
});

test("ours are sealed with the key of the moment; theirs, and their files, are tried with every key kept", () => {
  for (const name of ["sendMail", "sendMailFile", "deliverMailFile"]) assert.match(fn(name), /await mailKeyFor\(p\)/, name);
  const take = fn("takeMail");
  assert.match(take, /const keys = await mailKeysToTry\(p\);/);
  assert.match(take, /for \(const key of keys\) if \(\(body = await DC\.openMailBody\(key,/);
  assert.match(take, /fetchMailFile\(p, keys, where, file\)/);
  assert.match(fn("fetchMailFile"), /for \(const key of keys\) \{\s*const bytes = await DC\.openMailFile\(key, where, sealed\);/);
});
