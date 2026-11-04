/*
  The owner's inbox, as protocol.js seals and opens it: the owner code, the
  keys worked out from it, notes sealed to the lock, and the proof that a
  device is the owner's — each checked against node's own crypto, written
  here from the description, not from protocol.js.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const DC     = require("../protocol.js");
const G      = require("../guards.js");
const { p256 } = require("@noble/curves/p256");

const ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

/** One of the owner's keys, as the description says: HKDF-SHA256 of the
    code, no salt, labelled; 48 bytes mod (n − 1), plus one. */
function nodeKey(code, label) {
  const bytes = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(code), Buffer.alloc(0), Buffer.from(label), 48));
  const d = BigInt(`0x${bytes.toString("hex")}`) % (ORDER - 1n) + 1n;
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(d.toString(16).padStart(64, "0"), "hex"));
  return ecdh;
}

const keysFor = code => DC.ownerKeys(code, p256);

test("an owner code: 24 characters, grouped in fours, from an alphabet with nothing to misread", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const code = DC.makeOwnerCode();
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
    seen.add(code);
  }
  assert.equal(seen.size, 200, "never the same twice");
  const all = [...seen].join("").replace(/-/g, "");
  for (const c of "0123456789ABCDEFGHJKMNPQRSTVWXYZ") assert.ok(all.includes(c), `every character is used: ${c}`);
});

test("an owner code as typed: any case, spaces or dashes, O for 0 and I or L for 1 — or not a code at all", () => {
  const code = "K7QM2X9DABCDEFGH01234567";
  for (const typed of [code, code.toLowerCase(), "k7qm-2x9d-abcd-efgh-0123-4567", " K7QM 2X9D ABCD EFGH 0123 4567 ", "K7QM2X9DABCDEFGHO1234567"]) {
    assert.equal(DC.normalizeOwnerCode(typed), code, typed);
  }
  assert.equal(DC.normalizeOwnerCode("K7QM2X9DABCDEFGHI1234567"), "K7QM2X9DABCDEFGH11234567");
  for (const bad of ["", "K7QM", `${code}9`, "K7QM2X9DABCDEFGH0123456U", "K7QM2X9DABCDEFGH012345!7", null, 42, {}]) {
    assert.equal(DC.normalizeOwnerCode(bad), null, String(bad));
  }
});

test("the keys come from the code alone — the same on every device it is typed into — and are exactly as written down", async () => {
  const code = DC.makeOwnerCode();
  const keys = await keysFor(code);
  assert.equal((await keysFor(code.toLowerCase().replace(/-/g, " "))).lock, keys.lock, "typed another way: the same keys");
  assert.notEqual((await keysFor(DC.makeOwnerCode())).lock, keys.lock);
  const plain = DC.normalizeOwnerCode(code);
  const [box, sign] = keys.lock.split(".").map(part => Buffer.from(part, "base64url"));
  assert.ok(box.equals(nodeKey(plain, "direct-connection/owner-box/v1").getPublicKey()), "the box key, checked against node");
  assert.ok(sign.equals(nodeKey(plain, "direct-connection/owner-sign/v1").getPublicKey()), "the signing key, checked against node");
  assert.ok(!box.equals(sign), "two keys, one for each use");
  assert.equal(await keysFor("not a code"), null);
});

test("a lock is two points, and nothing else is taken for one", async () => {
  const { lock } = await keysFor(DC.makeOwnerCode());
  assert.match(lock, /^[A-Za-z0-9_-]{87}\.[A-Za-z0-9_-]{87}$/);
  const parsed = DC.parseLock(lock);
  assert.equal(parsed.box.length, 65);
  assert.equal(parsed.box[0], 4, "uncompressed");
  for (const bad of [null, "", lock.split(".")[0], `${lock}.x`, lock.replace(".", "!"), `${"A".repeat(87)}.${"A".repeat(87)}`]) {
    assert.equal(DC.parseLock(bad), null, String(bad).slice(0, 30));
  }
  assert.ok(DC.OWNER_LOCK === null || DC.parseLock(DC.OWNER_LOCK), "the app's own lock, if it has one, is one");
});

test("the inbox's name: from the lock's box key, labelled — a mailbox's shape, nothing of the key in it", async () => {
  const { lock } = await keysFor(DC.makeOwnerCode());
  const name = await DC.inboxName(lock);
  assert.match(name, G.SAVED_ROOM);
  const expected = `~${crypto.createHash("sha256").update(`direct-connection/owner-inbox/v1:${lock.split(".")[0]}`).digest("base64url")}`;
  assert.equal(name, expected);
  assert.equal(await DC.inboxName("nope"), null);
});

test("a note sealed to the lock opens with the owner's keys, as from nobody in particular — and with nothing else", async () => {
  const keys = await keysFor(DC.makeOwnerCode());
  const box = await DC.inboxName(keys.lock);
  const id = DC.makeMailId();
  const body = { name: "Bat", text: "call me when you can", file: { name: "plan.pdf", type: "application/pdf", size: 1234 } };
  const sealed = await DC.sealNote(keys.lock, { box, id }, body);
  assert.match(sealed.iv, /^[A-Za-z0-9_-]{16}$/, "a mailbox message's shape");
  assert.ok(!JSON.stringify(sealed).includes("call me"));
  assert.deepEqual(await DC.openNote(keys, { box, id, ...sealed }), body);
  const other = await keysFor(DC.makeOwnerCode());
  assert.equal(await DC.openNote(other, { box, id, ...sealed }), null, "another owner's keys");
  assert.equal(await DC.openNote(keys, { box, id: DC.makeMailId(), ...sealed }), null, "another note");
  assert.equal(await DC.openNote(keys, { box: `~${"x".repeat(43)}`, id, ...sealed }), null, "another inbox");
  const flipped = sealed.ct.slice(0, -2) + (sealed.ct.endsWith("AA") ? "BB" : "AA");
  assert.equal(await DC.openNote(keys, { box, id, iv: sealed.iv, ct: flipped }), null, "changed on the way");
  assert.equal(await DC.openNote(keys, { box, id, iv: "!!", ct: "??" }), null);
  const again = await DC.sealNote(keys.lock, { box, id }, body);
  assert.notEqual(again.ct.slice(0, 87), sealed.ct.slice(0, 87), "a fresh one-time key every time");
});

test("a note's seal is exactly as written down — opened with node's own crypto", async () => {
  const code = DC.makeOwnerCode();
  const keys = await keysFor(code);
  const box = await DC.inboxName(keys.lock);
  const id = DC.makeMailId();
  const sealed = await DC.sealNote(keys.lock, { box, id }, { name: "", text: "from the page" });
  const rest = Buffer.from(sealed.ct, "base64url");
  const senderPub = rest.subarray(0, 65);
  const owner = nodeKey(DC.normalizeOwnerCode(code), "direct-connection/owner-box/v1");
  const shared = owner.computeSecret(senderPub);
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.concat([senderPub, owner.getPublicKey()]), Buffer.from("direct-connection/owner-note/v1"), 32));
  const ct = rest.subarray(65);
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64url"));
  d.setAAD(Buffer.from(JSON.stringify(["dc-note-1", box, id])));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.deepEqual(JSON.parse(plain.toString()), { name: "", text: "from the page" });
});

test("a note is believed only in a note's shape", async () => {
  const keys = await keysFor(DC.makeOwnerCode());
  const box = await DC.inboxName(keys.lock);
  const file = { name: "a.png", type: "image/png", size: 10 };
  for (const [ok, body] of [
    [true, { name: "", text: "hi" }], [true, { name: "", text: "", file }], [true, { name: "x".repeat(200), text: "y".repeat(5000) }],
    [false, { name: "", text: "" }], [false, { name: "", text: "   " }], [false, { name: "x".repeat(201), text: "hi" }],
    [false, { name: "", text: "y".repeat(5001) }], [false, { text: "hi" }], [false, { name: "", text: 5 }],
    [false, { name: "", text: "hi", file: { ...file, size: -1 } }], [false, "hi"], [false, null]
  ]) {
    const id = DC.makeMailId();
    const sealed = await DC.sealNote(keys.lock, { box, id }, body);
    const opened = await DC.openNote(keys, { box, id, ...sealed });
    assert.equal(opened !== null, ok, JSON.stringify(body).slice(0, 60));
  }
  const id = DC.makeMailId();
  const extra = await DC.sealNote(keys.lock, { box, id }, { name: "a", text: "b", file: { ...file, path: "/etc" }, admin: true });
  assert.deepEqual(await DC.openNote(keys, { box, id, ...extra }), { name: "a", text: "b", file }, "only what is known is taken");
});

test("a note may carry the sender's location, in range, and opens with it rounded", async () => {
  const keys = await keysFor(DC.makeOwnerCode());
  const box = await DC.inboxName(keys.lock);
  const loc = { lat: 47.918873, lon: 106.917701, acc: 15.6 };
  const seal = (body, id = DC.makeMailId()) => DC.sealNote(keys.lock, { box, id }, body).then(s => ({ id, ...s }));
  const good = await seal({ name: "Bat", text: "I'm here", loc });
  assert.deepEqual(await DC.openNote(keys, { box, ...good }),
    { name: "Bat", text: "I'm here", loc: { lat: 47.918873, lon: 106.917701, acc: 16 } }, "the accuracy rounded, the rest kept");
  for (const bad of [{ lat: 91, lon: 0, acc: 5 }, { lat: 0, lon: 181, acc: 5 }, { lat: 0, lon: 0, acc: -1 },
                     { lat: "47", lon: 0, acc: 5 }, { lat: NaN, lon: 0, acc: 5 }, { lon: 0, acc: 5 }, null]) {
    const one = await seal({ name: "", text: "hi", loc: bad });
    assert.equal(await DC.openNote(keys, { box, ...one }), null, `a note with ${JSON.stringify(bad)} is no note`);
  }
  const without = await seal({ name: "", text: "hi" });
  assert.equal(Object.hasOwn(await DC.openNote(keys, { box, ...without }), "loc"), false, "none when the sender left it off");
});

test("a note's file is sealed whole to the lock, bound to its note", async () => {
  const keys = await keysFor(DC.makeOwnerCode());
  const box = await DC.inboxName(keys.lock);
  const id = DC.makeMailId();
  const bytes = crypto.randomBytes(5000);
  const sealed = await DC.sealNoteFile(keys.lock, { box, id }, bytes);
  assert.equal(sealed.length, bytes.length + DC.NOTE_SEAL_EXTRA);
  assert.ok(Buffer.from(await DC.openNoteFile(keys, { box, id }, sealed)).equals(bytes));
  assert.equal(await DC.openNoteFile(keys, { box, id: DC.makeMailId() }, sealed), null, "another note's");
  assert.equal(await DC.openNoteFile(keys, { box, id }, sealed.slice(0, 50)), null, "cut short");
  assert.equal(await DC.openNoteFile(await keysFor(DC.makeOwnerCode()), { box, id }, sealed), null, "another owner's");
  const flipped = sealed.slice();
  flipped[100] ^= 1;
  assert.equal(await DC.openNoteFile(keys, { box, id }, flipped), null);
});

test("the owner's proof: the inbox and the connection's word, signed — checked by node as the server checks it", async () => {
  const keys = await keysFor(DC.makeOwnerCode());
  const box = await DC.inboxName(keys.lock);
  const proof = await DC.proveOwner(keys, box, "word-1");
  assert.match(proof, /^[A-Za-z0-9_-]{86}$/, "64 bytes: r and s");
  const raw = Buffer.from(keys.lock.split(".")[1], "base64url");
  const key = crypto.createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256",
    x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") } });
  const check = (b, nonce) => crypto.verify("sha256", Buffer.from(JSON.stringify(["dc-owner-1", b, nonce])),
    { key, dsaEncoding: "ieee-p1363" }, Buffer.from(proof, "base64url"));
  assert.equal(check(box, "word-1"), true);
  assert.equal(check(box, "word-2"), false, "another connection's word");
  assert.equal(check(`~${"x".repeat(43)}`, "word-1"), false, "another inbox");
});
