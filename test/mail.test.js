/*
  Waiting messages — the seal (protocol.js), the mailbox that keeps them
  (mailbox.js), and the rules for what this device keeps (guards.js).
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const os     = require("node:os");
const path   = require("node:path");
const DC     = require("../protocol.js");
const G      = require("../guards.js");
const M      = require("../mailbox.js");
const I18N   = new Function("localStorage", `${fs.readFileSync(path.join(__dirname, "..", "i18n.js"), "utf8")}; return I18N;`)({ getItem: () => null });

const BOX = `~${"b".repeat(43)}`;
const id = n => `${String(n).padStart(4, "0")}${"i".repeat(18)}`;
const item = (n, over = {}) => ({ id: id(n), at: 1_793_000_000_000 + n, iv: "v".repeat(16), ct: "c".repeat(40), ...over });

/* ══════════════════════════════════════════
   The seal
══════════════════════════════════════════ */

test("sealed for the other side: it opens for them, as from us — and nowhere else", async () => {
  const secret = DC.makeRoomSecret();
  const key = await DC.mailboxKey(secret);
  const m = { box: await DC.savedRoomName(secret), from: "a", to: "b", id: DC.makeMailId(), at: Date.now(), text: "сайн уу 👋 — see you at 6" };
  const sealed = await DC.sealMail(key, m);
  assert.match(sealed.iv, /^[A-Za-z0-9_-]{16}$/);
  assert.match(sealed.ct, /^[A-Za-z0-9_-]+$/);
  assert.ok(!sealed.ct.includes("see you"), "nothing of the text shows");
  assert.equal(await DC.openMail(await DC.mailboxKey(secret), { ...m, ...sealed }), m.text, "their device works out the same key");
  for (const [what, changed] of [
    ["handed back to its writer", { from: "b", to: "a" }],
    ["sent to itself", { to: "a" }],
    ["moved to another mailbox", { box: `~${"x".repeat(43)}` }],
    ["given another id", { id: DC.makeMailId() }],
    ["re-dated", { at: m.at + 1 }]
  ]) assert.equal(await DC.openMail(key, { ...m, ...sealed, ...changed }), null, what);
  assert.equal(await DC.openMail(await DC.mailboxKey(DC.makeRoomSecret()), { ...m, ...sealed }), null, "another pair's key");
  const flipped = sealed.ct.slice(0, -2) + (sealed.ct.endsWith("AA") ? "BB" : "AA");
  assert.equal(await DC.openMail(key, { ...m, ...sealed, ct: flipped }), null, "changed on the way");
  assert.equal(await DC.openMail(key, { ...m, iv: "!!", ct: "??" }), null, "not even base64");
});

/** The seal as the RFCs and this app define it, written here with node's own
    crypto — not protocol.js: HKDF-SHA256 of the secret, no salt, labelled;
    AES-256-GCM with the binding as additional data. */
function nodeSeal(secret, aad, plaintext) {
  const key = Buffer.from(require("node:crypto").hkdfSync("sha256", Buffer.from(secret), Buffer.alloc(0), Buffer.from("direct-connection/mailbox/v1"), 32));
  const iv = require("node:crypto").randomBytes(12);
  const c = require("node:crypto").createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(JSON.stringify(aad)));
  const ct = Buffer.concat([c.update(Buffer.from(plaintext)), c.final(), c.getAuthTag()]);
  return { iv: iv.toString("base64url"), ct: ct.toString("base64url") };
}

test("the key and the binding are exactly as written down — checked against node's own crypto", async () => {
  const secret = DC.makeRoomSecret();
  const m = { box: `~${"q".repeat(43)}`, from: "b", to: "a", id: DC.makeMailId(), at: 1_793_000_000_123 };
  const sealed = nodeSeal(secret, ["dc-mail-1", m.box, m.from, m.to, m.id, m.at], JSON.stringify({ text: "from node" }));
  assert.equal(await DC.openMail(await DC.mailboxKey(secret), { ...m, ...sealed }), "from node");
  const notText = nodeSeal(secret, ["dc-mail-1", m.box, m.from, m.to, m.id, m.at], JSON.stringify({ text: 5 }));
  assert.equal(await DC.openMail(await DC.mailboxKey(secret), { ...m, ...notText }), null, "opened, but no text: not a message");
  const notJson = nodeSeal(secret, ["dc-mail-1", m.box, m.from, m.to, m.id, m.at], "not json");
  assert.equal(await DC.openMail(await DC.mailboxKey(secret), { ...m, ...notJson }), null);
});

test("the mailbox file is written aside and moved into place — never half a file", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "mailbox.js"), "utf8");
  assert.match(src, /const tmp = `\$\{file\}\.tmp`;\s*\n\s*fs\.writeFileSync\(tmp, JSON\.stringify\(out\), \{ mode: 0o600 \}\);\s*\n\s*fs\.renameSync\(tmp, file\);/);
});

test("the key is the pair's alone — worked out from their secret, labelled for this one use", async () => {
  const secret = DC.makeRoomSecret();
  const key = await DC.mailboxKey(secret);
  assert.equal(key.extractable, false);
  assert.deepEqual(key.algorithm, { name: "AES-GCM", length: 256 });
  assert.deepEqual([...DC.mailAad("~b", "a", "b", "id", 5)], [...new TextEncoder().encode(JSON.stringify(["dc-mail-1", "~b", "a", "b", "id", 5]))]);
  assert.match(DC.makeMailId(), /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(DC.makeMailId(), DC.makeMailId());
});

/* ══════════════════════════════════════════
   The mailbox
══════════════════════════════════════════ */

test("a message is believed only in the shape a device sends", () => {
  const now = 1_793_000_100_000;
  assert.equal(M.dropValid(BOX, "b", item(1), now), true);
  for (const [what, box, to, it] of [
    ["not a room", "room", "b", item(1)], ["no side", BOX, "c", item(1)], ["short id", BOX, "b", item(1, { id: "x" })],
    ["no time", BOX, "b", item(1, { at: "soon" })], ["from long ago", BOX, "b", item(1, { at: 1_000 })],
    ["from the future", BOX, "b", item(1, { at: now + 2 * 86_400_000 })], ["odd iv", BOX, "b", item(1, { iv: "v" })],
    ["too long", BOX, "b", item(1, { ct: "c".repeat(M.CT_MAX_CHARS + 1) })], ["not base64", BOX, "b", item(1, { ct: "<b>" })],
    ["nothing", BOX, "b", null]
  ]) assert.equal(M.dropValid(box, to, it, now), false, what);
});

test("kept until taken and acknowledged — each once, oldest first, for its own side only", () => {
  const box = M.createMailboxes({ now: () => 1_793_000_100_000 });
  assert.equal(box.drop(BOX, "b", item(2)), "new");
  assert.equal(box.drop(BOX, "b", item(1)), "new");
  assert.equal(box.drop(BOX, "b", item(1)), "ok", "the same message sent again: kept once");
  assert.equal(box.drop(BOX, "b", { ...item(9), id: "bad" }), "invalid");
  assert.deepEqual(box.take(BOX, "b").map(m => m.id), [id(2), id(1)], "as they came");
  assert.deepEqual(box.take(BOX, "a"), [], "the other side's mailbox is its own");
  assert.deepEqual(Object.keys(box.take(BOX, "b")[0]).sort(), ["at", "ct", "id", "iv"], "nothing of the server's own");
  assert.deepEqual(box.take(BOX, "b").length, 2, "taking removes nothing");
  assert.equal(box.ack(BOX, "b", [id(2), "not-there"]), 1);
  assert.deepEqual(box.take(BOX, "b").map(m => m.id), [id(1)]);
  assert.equal(box.ack(BOX, "a", [id(1)]), 0, "only the mailbox's own");
  assert.equal(box.ack(BOX, "b", [id(1)]), 1);
  assert.deepEqual(box.stats().messages, 0);
});

test("a mailbox holds a hundred, or two million characters; the server fifty million", () => {
  const box = M.createMailboxes({ now: () => 1_793_000_100_000 });
  for (let i = 0; i < M.BOX_MAX_ITEMS; i++) assert.equal(box.drop(BOX, "b", item(i)), "new");
  assert.equal(box.drop(BOX, "b", item(500)), "full");
  assert.equal(box.drop(BOX, "a", item(500)), "new", "another mailbox is not full");
  const big = M.createMailboxes({ now: () => 1_793_000_100_000 });
  const huge = n => item(n, { ct: "c".repeat(M.CT_MAX_CHARS) });
  let n = 0;
  while (big.drop(BOX, "b", huge(n)) === "new") n++;
  assert.ok(n * M.CT_MAX_CHARS <= M.BOX_MAX_CHARS && (n + 1) * (M.CT_MAX_CHARS + 16) > M.BOX_MAX_CHARS, `${n} kept`);
  const all = M.createMailboxes({ now: () => 1_793_000_100_000 });
  let refused = null;
  for (let b = 0; b < 2000 && !refused; b++) {
    const r = all.drop(`~${String(b).padStart(43, "0")}`, "b", huge(b));
    if (r !== "new") refused = r;
  }
  assert.equal(refused, "server-full");
  assert.ok(all.stats().chars <= M.ALL_MAX_CHARS);
});

test("a week, then gone unread", () => {
  let now = 1_793_000_100_000;
  const box = M.createMailboxes({ now: () => now });
  box.drop(BOX, "b", item(1));
  now += M.MAIL_TTL_MS;
  assert.equal(box.sweep(), 0, "a week to the moment is still a week");
  box.drop(BOX, "b", item(2, { at: now }));
  now += 1;
  assert.equal(box.sweep(), 1);
  assert.deepEqual(box.take(BOX, "b").map(m => m.id), [id(2)]);
});

test("kept in a file: a restart loses nothing, half a file is never written, and nothing in it is believed unchecked", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-mail-"));
  const file = path.join(dir, "mailbox.json");
  let now = 1_793_000_100_000;
  const first = M.createMailboxes({ file, now: () => now, saveDelayMs: 10 });
  first.drop(BOX, "b", item(1));
  first.drop(BOX, "a", item(2));
  await new Promise(r => setTimeout(r, 40));
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(`${file}.tmp`), "written aside, then moved into place");
  const again = M.createMailboxes({ file, now: () => now });
  assert.deepEqual(again.take(BOX, "b").map(m => m.id), [id(1)]);
  assert.deepEqual(again.take(BOX, "a").map(m => m.id), [id(2)]);
  again.ack(BOX, "b", [id(1)]);
  again.flush();
  assert.deepEqual(M.createMailboxes({ file, now: () => now }).take(BOX, "b"), [], "acknowledged is gone for good");

  const kept = JSON.parse(fs.readFileSync(file, "utf8"));
  kept.boxes[`${BOX}:b`] = [{ ...item(3), keptAt: now }, { ...item(4, { ct: "<script>" }), keptAt: now }, { ...item(5), keptAt: now - M.MAIL_TTL_MS - 1 }, "junk"];
  kept.boxes["not-a-room:b"] = [{ ...item(6), keptAt: now }];
  fs.writeFileSync(file, JSON.stringify(kept));
  const checked = M.createMailboxes({ file, now: () => now });
  assert.deepEqual(checked.take(BOX, "b").map(m => m.id), [id(3)], "the good one; not the bad, the expired, the junk");
  assert.equal(checked.stats().messages, 2);

  fs.writeFileSync(file, "{ not json");
  assert.equal(M.createMailboxes({ file, now: () => now }).stats().messages, 0, "a broken file: start empty");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("without a file, memory only — and flush does nothing", () => {
  const box = M.createMailboxes();
  box.drop(BOX, "b", item(1, { at: Date.now() }));
  box.flush();
  assert.equal(box.stats().file, null);
  assert.equal(box.stats().messages, 1);
});

/* ══════════════════════════════════════════
   What this device keeps
══════════════════════════════════════════ */

test("the conversations kept here are believed only as far as they are well-formed", () => {
  const room = `~${"r".repeat(43)}`;
  const mine = { id: id(1), at: 5, mine: true, text: "hi", state: "kept" };
  const theirs = { id: id(2), at: 3, mine: false, text: "hello" };
  const out = G.mailStore({ v: 1, threads: { [room]: { read: 4, items: [mine, theirs] } }, seen: { [room]: [id(2), "bad"] } });
  assert.deepEqual(out.threads[room], { read: 4, items: [theirs, mine] }, "in time order");
  assert.deepEqual(out.seen[room], [id(2)]);
  for (const bad of [
    { ...mine, state: "sent?" }, { ...theirs, state: "kept" }, { ...mine, id: "x" }, { ...mine, at: "now" },
    { ...mine, text: "x".repeat(G.MAX_MESSAGE_CHARS + 1) }, { ...mine, mine: "yes" }, null
  ]) assert.deepEqual(G.mailStore({ v: 1, threads: { [room]: { items: [bad] } } }).threads[room].items, [], JSON.stringify(bad).slice(0, 60));
  assert.deepEqual(G.mailStore({ v: 1, threads: { "not-a-room": { items: [mine] } } }).threads, {});
  for (const notOurs of [null, "x", { v: 2 }, []]) assert.deepEqual(G.mailStore(notOurs), { v: 1, threads: {}, seen: {} });
  const many = Array.from({ length: 300 }, (_, i) => ({ id: id(i), at: i, mine: false, text: "x" }));
  const kept = G.mailStore({ v: 1, threads: { [room]: { items: many } }, seen: { [room]: many.map(m => m.id).concat(many.map(m => m.id)) } });
  assert.equal(kept.threads[room].items.length, G.MAIL_THREAD_MAX);
  assert.equal(kept.threads[room].items[0].at, 300 - G.MAIL_THREAD_MAX, "the newest kept");
  assert.equal(kept.seen[room].length, G.MAIL_SEEN_MAX);
});

test("new from them: theirs since last read — never our own", () => {
  assert.equal(G.mailUnread({ read: 10, items: [{ mine: false, at: 5 }, { mine: false, at: 11 }, { mine: true, at: 12 }, { mine: false, at: 13 }] }), 2);
  assert.equal(G.mailUnread(undefined), 0);
  assert.equal(G.mailUnread({ items: [{ mine: false, at: 1 }] }), 1);
});

test("the other side of a pair, and the server's refusals in our words", () => {
  assert.equal(G.otherSide("a"), "b");
  assert.equal(G.otherSide("b"), "a");
  assert.equal(G.otherSide("c"), null);
  assert.equal(G.mailRefusalKey("full"), "mailBoxFull");
  assert.equal(G.mailRefusalKey("server-full"), "mailServerFull");
  assert.equal(G.mailRefusalKey("too-many"), "mailTooMany");
  for (const other of ["invalid", "constructor", "__proto__", undefined, 7]) assert.equal(G.mailRefusalKey(other), "mailNotSent", String(other));
});

/* ══════════════════════════════════════════
   Photos and files
══════════════════════════════════════════ */

test("a file sealed for the other side opens for them, as this message's — and nowhere else", async () => {
  const secret = DC.makeRoomSecret();
  const key = await DC.mailboxKey(secret);
  const where = { box: BOX, from: "a", to: "b", id: DC.makeMailId() };
  const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
  const sealed = await DC.sealMailFile(key, where, bytes);
  assert.equal(sealed.length, bytes.length + 28, "12 of IV, 16 of tag");
  assert.deepEqual(await DC.openMailFile(key, where, sealed), bytes);
  for (const [what, changed] of [["another box", { box: `~${"c".repeat(43)}` }], ["from them", { from: "b", to: "a" }],
                                 ["another message", { id: DC.makeMailId() }]]) {
    assert.equal(await DC.openMailFile(key, { ...where, ...changed }, sealed), null, what);
  }
  assert.equal(await DC.openMailFile(await DC.mailboxKey(DC.makeRoomSecret()), where, sealed), null, "another pair's key");
  const flipped = sealed.slice();
  flipped[40] ^= 1;
  assert.equal(await DC.openMailFile(key, where, flipped), null, "changed on the way");
  assert.equal(await DC.openMailFile(key, where, sealed.slice(0, 27)), null, "too short to be one");
  assert.deepEqual(await DC.openMailFile(key, where, await DC.sealMailFile(key, where, new Uint8Array(0))), new Uint8Array(0), "an empty file is a file");
});

test("a file's seal is exactly as written down — checked against node's own crypto", async () => {
  const nodeCrypto = require("node:crypto");
  const secret = DC.makeRoomSecret();
  const where = { box: BOX, from: "b", to: "a", id: DC.makeMailId() };
  const key = Buffer.from(nodeCrypto.hkdfSync("sha256", Buffer.from(secret), Buffer.alloc(0), Buffer.from("direct-connection/mailbox/v1"), 32));
  const iv = nodeCrypto.randomBytes(12);
  const c = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(JSON.stringify(["dc-mailfile-1", where.box, where.from, where.to, where.id])));
  const sealed = Buffer.concat([iv, c.update(Buffer.from("from node")), c.final(), c.getAuthTag()]);
  assert.equal(Buffer.from(await DC.openMailFile(await DC.mailboxKey(secret), where, sealed)).toString(), "from node");
});

test("a message that describes a file: its name, type and size — believed only in that shape", async () => {
  const secret = DC.makeRoomSecret();
  const key = await DC.mailboxKey(secret);
  const m = { box: BOX, from: "a", to: "b", id: DC.makeMailId(), at: 1_793_000_000_123 };
  const meta = { name: "cat.jpg", type: "image/jpeg", size: 12345 };
  const sealed = await DC.sealMailBody(key, m, { file: meta });
  assert.deepEqual(await DC.openMailBody(key, { ...m, ...sealed }), { file: meta });
  assert.equal(await DC.openMail(key, { ...m, ...sealed }), null, "not a text");
  const extra = await DC.sealMailBody(key, m, { file: { ...meta, path: "/etc" } });
  assert.deepEqual(await DC.openMailBody(key, { ...m, ...extra }), { file: meta }, "only what is known is taken");
  for (const bad of [{ ...meta, name: "" }, { ...meta, name: "x".repeat(256) }, { ...meta, type: 5 }, { ...meta, type: "x".repeat(101) },
                     { ...meta, size: -1 }, { ...meta, size: 1.5 }, { ...meta, size: "12" }, null, "file"]) {
    const s = await DC.sealMailBody(key, m, { file: bad });
    assert.equal(await DC.openMailBody(key, { ...m, ...s }), null, JSON.stringify(bad));
  }
  assert.ok(G.mailFileValid(meta));
  assert.ok(!G.mailFileValid({ ...meta, size: G.MAIL_FILE_MAX + 1 }), "the page takes no more than it can send");
  assert.deepEqual(await DC.openMailBody(key, { ...m, ...(await DC.sealMail(key, { ...m, text: "hi" })) }), { text: "hi" });
});

test("on this device, a photo or file is kept as its description — never with text too, never half-formed", () => {
  const room = `~${"r".repeat(43)}`;
  const photo = { id: id(1), at: 5, mine: false, file: { name: "a.png", type: "image/png", size: 10 } };
  const ours = { id: id(2), at: 6, mine: true, file: { name: "b.pdf", type: "", size: 0 }, state: "sending" };
  assert.deepEqual(G.mailStore({ v: 1, threads: { [room]: { items: [photo, ours] } } }).threads[room].items, [photo, ours]);
  for (const bad of [{ ...photo, text: "and words" }, { ...photo, file: { ...photo.file, size: -1 } }, { ...photo, file: "a.png" },
                     { ...photo, file: null }, { ...photo, file: { ...photo.file, name: 7 } }]) {
    assert.deepEqual(G.mailStore({ v: 1, threads: { [room]: { items: [bad] } } }).threads[room].items, [], JSON.stringify(bad));
  }
});

test("the server's refusals of a file, in our words", () => {
  assert.equal(G.mailRefusalKey("off"), "mailFilesOff");
  assert.equal(G.mailRefusalKey("too-large"), "mailFileTooBig");
  assert.equal(G.mailRefusalKey("busy"), "mailTryLater");
  for (const key of ["mailFilesOff", "mailFileTooBig", "mailTryLater", "mailFileGone", "mailFileMissing", "mailAttach"]) {
    assert.equal(typeof I18N.mn[key], "string", key);
    assert.equal(typeof I18N.en[key], "string", key);
  }
});

/** Mailboxes with a place for files, in a fresh folder. */
function withFiles(now = () => Date.now()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-mail-files-"));
  const filesDir = path.join(dir, "files");
  const box = M.createMailboxes({ file: path.join(dir, "mailbox.json"), filesDir, now, saveDelayMs: 10 });
  /** As the server writes one: to its .part, then moved into place. */
  const send = (b, to, n, bytes) => {
    const target = box.fileTarget(b, to, id(n));
    fs.writeFileSync(target.part, bytes);
    fs.renameSync(target.part, target.path);
    box.fileStored(b, to, id(n), bytes.length);
    return target.path;
  };
  return { dir, filesDir, box, send, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a file is kept only with the message that describes it — sent first, taken up by it, handed over with it", () => {
  const { box, send, filesDir, done } = withFiles();
  const now = Date.now();
  assert.equal(box.drop(BOX, "b", item(1, { at: now, file: true })), "invalid", "a file never sent: no message for it");
  const where = send(BOX, "b", 1, Buffer.alloc(100, 7));
  assert.equal(box.fileFor(BOX, "b", id(1)), null, "not handed over before its message comes");
  assert.equal(box.fileHere(BOX, "b", id(1)), 100, "but known to be here, if sent again");
  assert.equal(box.drop(BOX, "a", item(1, { at: now, file: true })), "invalid", "for the other side: not that file");
  assert.equal(box.drop(BOX, "b", item(1, { at: now, file: true })), "new");
  assert.equal(box.drop(BOX, "b", item(1, { at: now, file: true })), "ok", "sent again: kept once");
  assert.deepEqual(box.take(BOX, "b").map(m => [m.id, m.file]), [[id(1), 100]]);
  assert.deepEqual(box.fileFor(BOX, "b", id(1)), { path: where, size: 100 });
  assert.equal(box.fileFor(BOX, "a", id(1)), null, "not the other side's");
  assert.equal(box.fileFor(BOX, "b", "../../etc/passwd"), null);
  assert.ok(!path.basename(where).includes(BOX.slice(1, 10)), "its name on disk says nothing of whose it is");
  assert.equal(path.dirname(where), filesDir);
  assert.deepEqual(box.stats().fileBytes, 100);
  box.ack(BOX, "b", [id(1)]);
  assert.equal(box.fileFor(BOX, "b", id(1)), null);
  assert.equal(box.stats().fileBytes, 0);
  return new Promise(r => setTimeout(r, 30)).then(() => {
    assert.ok(!fs.existsSync(where), "gone from disk with its message");
    done();
  });
});

test("files: 25 MB each, 200 MB a mailbox, 2 GB in all — and none where there is nowhere to keep them", () => {
  const { box, done } = withFiles();
  assert.equal(M.createMailboxes().fileRoom(BOX, "b", 100), "off");
  assert.equal(M.createMailboxes().filesOn, false);
  assert.equal(box.filesOn, true);
  assert.equal(box.fileRoom(BOX, "b", M.FILE_MAX_BYTES), "ok");
  assert.equal(box.fileRoom(BOX, "b", M.FILE_MAX_BYTES + 1), "too-large");
  assert.equal(box.fileRoom(BOX, "b", 27), "too-large", "smaller than any sealed file");
  assert.equal(box.fileRoom(BOX, "b", 1.5), "too-large");
  box.fileStored(BOX, "b", id(1), M.BOX_MAX_FILE_BYTES - 100);
  assert.equal(box.fileRoom(BOX, "b", 100), "ok");
  assert.equal(box.fileRoom(BOX, "b", 101), "full", "this mailbox, counting what is still coming");
  assert.equal(box.fileRoom(BOX, "a", 101), "ok", "the other side's is its own");
  const others = Math.ceil(M.ALL_MAX_FILE_BYTES / M.BOX_MAX_FILE_BYTES);
  for (let i = 0; i < others; i++) box.fileStored(`~${String(i).padStart(43, "x")}`, "b", id(i), M.BOX_MAX_FILE_BYTES - 100);
  assert.equal(box.fileRoom(`~${"z".repeat(43)}`, "b", 1000), "server-full");
  done();
});

test("a file never described goes after ten minutes; one past its week goes with its message; one no message names goes too", async () => {
  let now = Date.now();
  const { box, send, filesDir, done } = withFiles(() => now);
  const orphan = send(BOX, "b", 1, Buffer.alloc(50));
  const kept = send(BOX, "b", 2, Buffer.alloc(60));
  box.drop(BOX, "b", item(2, { at: now, file: true }));
  const stray = path.join(filesDir, "f".repeat(64));
  fs.writeFileSync(stray, "left from before a restart");
  box.sweep();
  await new Promise(r => setTimeout(r, 30));
  assert.ok(fs.existsSync(orphan) && fs.existsSync(kept) && fs.existsSync(stray), "all young yet");
  now += M.ORPHAN_MS + 1000;
  box.sweep();
  await new Promise(r => setTimeout(r, 30));
  assert.ok(!fs.existsSync(orphan), "never described: gone");
  assert.equal(box.fileHere(BOX, "b", id(1)), 0);
  assert.ok(!fs.existsSync(stray), "named by nothing: gone");
  assert.ok(fs.existsSync(kept), "its message still waits");
  now += M.MAIL_TTL_MS;
  box.sweep();
  await new Promise(r => setTimeout(r, 30));
  assert.ok(!fs.existsSync(kept), "a week: gone with its message");
  assert.equal(box.stats().fileBytes, 0);
  done();
});

test("a restart keeps each file with its message — counted again, and handed over as before", async () => {
  const { box, send, dir, filesDir, done } = withFiles();
  send(BOX, "b", 1, Buffer.alloc(80, 1));
  box.drop(BOX, "b", item(1, { at: Date.now(), file: true }));
  box.flush();
  const again = M.createMailboxes({ file: path.join(dir, "mailbox.json"), filesDir });
  assert.equal(again.stats().fileBytes, 80);
  assert.equal(again.fileFor(BOX, "b", id(1)).size, 80);
  assert.equal(M.createMailboxes({ file: path.join(dir, "mailbox.json") }).fileFor(BOX, "b", id(1)), null, "no place for files: none handed over");
  done();
});
