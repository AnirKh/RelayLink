/*
  Knocks — the push sent (knock.js) and the notification it becomes (sw.js).

  A knock is a Web Push message: encrypted for one browser (RFC 8291), in the
  aes128gcm form (RFC 8188), and signed by this server (VAPID, RFC 8292). The
  encryption is checked against the RFC's own example, byte for byte, and
  against a decryption written here from the RFC; the signature against node's
  own ES256 verification. The worker is run against a stand-in for the
  browser's.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");
const http   = require("node:http");
const crypto = require("node:crypto");
const K      = require("../knock.js");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8").replace(/\r\n/g, "\n");
const I18N_SRC = read("i18n.js");
const I18N = new Function("localStorage", `${I18N_SRC}; return I18N;`)({ getItem: () => null });

/** A browser's subscription keys, with the private half kept to decrypt with. */
function browserKeys() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") };
}

/** RFC 8291 §3.4 / RFC 8188, from the receiving side — written from the RFC,
    not from knock.js. */
function decrypt(body, { ecdh, auth }) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  assert.equal(rs, 4096);
  const shared = ecdh.computeSecret(asPublic);
  const authSecret = Buffer.from(auth, "base64url");
  const prkKey = crypto.createHmac("sha256", authSecret).update(shared).digest();
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]);
  const ikm = crypto.createHmac("sha256", prkKey).update(Buffer.concat([keyInfo, Buffer.from([1])])).digest();
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  const cek = crypto.createHmac("sha256", prk).update(Buffer.from("Content-Encoding: aes128gcm\0\x01")).digest().subarray(0, 16);
  const nonce = crypto.createHmac("sha256", prk).update(Buffer.from("Content-Encoding: nonce\0\x01")).digest().subarray(0, 12);
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  assert.equal(plain[plain.length - 1], 2, "the last record's delimiter");
  return plain.subarray(0, plain.length - 1).toString();
}

/* ══════════════════════════════════════════
   The message: encryption
══════════════════════════════════════════ */

test("encrypted exactly as RFC 8291's own example", () => {
  const body = K.encryptForPush("When I grow up, I want to be a watermelon", {
    p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg"
  }, { salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"), serverPrivateKey: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw" });
  assert.equal(body.toString("base64url"),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_" +
    "yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

test("a knock opens for the browser it was made for — and only that one", () => {
  const keys = browserKeys();
  const body = K.encryptForPush('{"t":"knock","room":"~x"}', keys);
  assert.equal(decrypt(body, keys), '{"t":"knock","room":"~x"}');
  assert.throws(() => decrypt(body, browserKeys()), "another browser's keys open nothing");
  const again = K.encryptForPush('{"t":"knock","room":"~x"}', keys);
  assert.notDeepEqual(again.subarray(0, 16), body.subarray(0, 16), "a fresh salt each time");
  assert.notDeepEqual(again.subarray(21, 86), body.subarray(21, 86), "and a fresh key of this server's");
});

/* ══════════════════════════════════════════
   The signature: VAPID
══════════════════════════════════════════ */

test("each request is signed for the push service's origin, for twelve hours, by this server's key", () => {
  const keys = { ...K.makeKnockKeys(), subject: "mailto:someone@example.com" };
  const now = Date.UTC(2026, 9, 29, 8, 0, 0);
  const header = K.vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, now);
  const m = header.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
  assert.ok(m, header);
  assert.equal(m[4], keys.publicKey);
  assert.deepEqual(JSON.parse(Buffer.from(m[1], "base64url")), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(JSON.parse(Buffer.from(m[2], "base64url")),
    { aud: "https://fcm.googleapis.com", exp: now / 1000 + 12 * 3600, sub: "mailto:someone@example.com" });
  const pub = Buffer.from(keys.publicKey, "base64url");
  const key = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  assert.ok(crypto.verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url")));
});

test("the keys come from the server's environment, as a pair, or there are no knocks", () => {
  const pair = K.makeKnockKeys();
  assert.deepEqual(K.knockKeysFromEnv({ KNOCK_PUBLIC_KEY: pair.publicKey, KNOCK_PRIVATE_KEY: pair.privateKey }),
    { ...pair, subject: "https://anirkh.github.io/RelayLink/" });
  assert.equal(K.knockKeysFromEnv({ KNOCK_PUBLIC_KEY: pair.publicKey, KNOCK_PRIVATE_KEY: pair.privateKey, KNOCK_SUBJECT: "mailto:a@b.c" }).subject, "mailto:a@b.c");
  const other = K.makeKnockKeys();
  for (const env of [{}, { KNOCK_PUBLIC_KEY: pair.publicKey }, { KNOCK_PRIVATE_KEY: pair.privateKey },
                     { KNOCK_PUBLIC_KEY: pair.publicKey, KNOCK_PRIVATE_KEY: other.privateKey },
                     { KNOCK_PUBLIC_KEY: "short", KNOCK_PRIVATE_KEY: pair.privateKey },
                     { KNOCK_PUBLIC_KEY: pair.publicKey, KNOCK_PRIVATE_KEY: "!!" }]) {
    assert.equal(K.knockKeysFromEnv(env), null, JSON.stringify(Object.keys(env)));
  }
});

test("every pair made is one the server takes — a private key with leading zero bytes too", () => {
  /* Node drops a private key's leading zero bytes, about one in 250; such a
     pair used to be turned away, and knocks were off. Three thousand makes
     the chance of meeting none of them about one in a hundred thousand. */
  for (let i = 0; i < 3000; i++) {
    const k = K.makeKnockKeys();
    assert.equal(Buffer.from(k.privateKey, "base64url").length, 32);
    assert.ok(K.knockKeysFromEnv({ KNOCK_PUBLIC_KEY: k.publicKey, KNOCK_PRIVATE_KEY: k.privateKey }), `pair ${i} turned away`);
  }
});

test("node tools/knock-keys.js prints a working pair, and nothing else", () => {
  const out = require("node:child_process").execFileSync(process.execPath, [path.join(__dirname, "..", "tools", "knock-keys.js")]).toString();
  const lines = out.trim().split(/\r?\n/);
  assert.equal(lines.length, 2);
  const env = Object.fromEntries(lines.map(l => l.split("=")));
  assert.ok(K.knockKeysFromEnv(env), "a pair the server takes");
});

/* ══════════════════════════════════════════
   Where it may go
══════════════════════════════════════════ */

test("only to a push service's own address", () => {
  for (const ok of [
    "https://fcm.googleapis.com/fcm/send/abc:def",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAA",
    "https://web.push.apple.com/QGuT",
    "https://wns2-par02p.notify.windows.com/w/?token=BQYAAA"
  ]) assert.equal(K.isPushEndpoint(ok), true, ok);
  for (const bad of [
    "http://fcm.googleapis.com/fcm/send/abc", "https://fcm.googleapis.com:444/x", "https://user:pw@fcm.googleapis.com/x",
    "https://evil.example/fcm.googleapis.com/", "https://fcm.googleapis.com.evil.example/x", "https://notify.windows.com.evil/x",
    "https://localhost/x", "https://127.0.0.1/x", "https://169.254.169.254/latest", "file:///etc/passwd", "not a url",
    `https://fcm.googleapis.com/${"x".repeat(1100)}`, 7, null
  ]) assert.equal(K.isPushEndpoint(bad), false, String(bad).slice(0, 60));
  assert.equal(K.isPushEndpoint("http://127.0.0.1:3299/push/1", "http://127.0.0.1:3299"), true, "the tests' stand-in, when named");
  assert.equal(K.isPushEndpoint("http://127.0.0.1:3299/push/1"), false, "and only then");
  assert.equal(K.isPushEndpoint("http://127.0.0.1:32990/x", "http://127.0.0.1:3299"), false, "that origin exactly");
});

test("a subscription's keys: a P-256 point and a 16-byte secret", () => {
  const keys = browserKeys();
  assert.equal(K.pushKeysValid(keys.p256dh, keys.auth), true);
  for (const [p, a] of [[keys.p256dh.slice(1), keys.auth], [keys.p256dh, keys.auth.slice(2)], [keys.p256dh, `${keys.auth}==`],
                        [crypto.randomBytes(65).toString("base64url").replace(/^./, "A"), keys.auth], [7, keys.auth], [keys.p256dh, null]]) {
    assert.equal(K.pushKeysValid(p, a), false, `${String(p).slice(0, 8)} ${a}`);
  }
});

/* ══════════════════════════════════════════
   Sending
══════════════════════════════════════════ */

function pushService(status = 201) {
  const got = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => { got.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.statusCode = server.status; res.end(); });
  });
  server.status = status;
  return new Promise(r => server.listen(0, "127.0.0.1", () => r({ server, got, origin: `http://127.0.0.1:${server.address().port}` })));
}

test("a knock is sent signed, encrypted, short-lived and urgent — and says only which room", async () => {
  const svc = await pushService(201);
  const keys = browserKeys();
  const vapid = { ...K.makeKnockKeys(), subject: "mailto:a@b.c" };
  const room = `~${"r".repeat(43)}`;
  const result = await K.sendKnock({ to: { endpoint: `${svc.origin}/push/1`, p256dh: keys.p256dh, auth: keys.auth }, room, keys: vapid });
  svc.server.close();
  assert.deepEqual(result, { ok: true, gone: false, status: 201 });
  const [req] = svc.got;
  assert.equal(req.url, "/push/1");
  assert.equal(req.headers["content-encoding"], "aes128gcm");
  assert.equal(req.headers.ttl, String(K.KNOCK_TTL_S));
  assert.equal(req.headers.urgency, "high");
  assert.match(req.headers.topic, /^[A-Za-z0-9_-]{32}$/, "a second knock on the room replaces this one");
  assert.match(req.headers.authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${vapid.publicKey}$`));
  assert.deepEqual(JSON.parse(decrypt(req.body, keys)), { t: "knock", room });
});

test("an address the push service says is gone is said to be gone; any other failure is just a failure", async () => {
  const keys = browserKeys();
  const vapid = K.makeKnockKeys();
  for (const [status, gone, ok] of [[410, true, false], [404, true, false], [400, false, false], [429, false, false], [500, false, false], [202, false, true]]) {
    const svc = await pushService(status);
    const r = await K.sendKnock({ to: { endpoint: `${svc.origin}/p`, ...keys }, room: "~x", keys: vapid });
    svc.server.close();
    assert.deepEqual([r.ok, r.gone], [ok, gone], String(status));
  }
});

test("never fails loudly: nobody listening, or keys that are not keys, is a knock that did not go", async () => {
  const keys = browserKeys();
  const vapid = K.makeKnockKeys();
  assert.deepEqual(await K.sendKnock({ to: { endpoint: "http://127.0.0.1:1/p", ...keys }, room: "~x", keys: vapid }), { ok: false, gone: false, status: 0 });
  assert.deepEqual(await K.sendKnock({ to: { endpoint: "http://127.0.0.1:1/p", p256dh: "AAAA", auth: keys.auth }, room: "~x", keys: vapid }), { ok: false, gone: false, status: 0 });
});

/* ══════════════════════════════════════════
   The worker
══════════════════════════════════════════ */

const ROOM = `~${"k".repeat(43)}`;

/** sw.js, run against a stand-in for the browser's worker. */
function worker({ kept = null, i18n = true, pages = [] } = {}) {
  const log = { shown: [], opened: [], focused: 0, posted: [] };
  const listeners = {};
  const self = {
    registration: { scope: "https://anirkh.github.io/RelayLink/", showNotification: async (title, options) => { log.shown.push({ title, options }); } },
    clients: {
      matchAll: async () => pages.map(url => ({ url, focus: async () => { log.focused++; }, postMessage: m => log.posted.push(m) })),
      openWindow: async url => { log.opened.push(url); },
      claim: async () => {}
    },
    skipWaiting() {},
    addEventListener: (type, f) => { listeners[type] = f; }
  };
  const indexedDB = {
    open: () => {
      const req = {};
      const db = { close() {}, createObjectStore() {},
        transaction: () => ({ objectStore: () => ({ get: () => { const g = {}; setTimeout(() => { g.result = kept; g.onsuccess(); }); return g; } }) }) };
      setTimeout(() => { req.result = db; req.onsuccess(); });
      return req;
    }
  };
  const importScripts = () => { if (!i18n) throw new Error("offline"); };
  new Function("self", "indexedDB", "importScripts", "I18N", read("sw.js"))(self, indexedDB, importScripts, i18n ? I18N : undefined);
  const fire = async (type, event) => { let wait; listeners[type]({ ...event, waitUntil: p => { wait = p; } }); await wait; };
  const push = data => fire("push", { data: data === undefined ? null : { json: () => (typeof data === "string" ? JSON.parse(data) : data) } });
  const clickWith = data => fire("notificationclick", { notification: { data, close() { log.closedNote = true; } } });
  const click = room => clickWith({ room });
  return { log, push, click, clickWith, listeners };
}

test("a knock from someone saved is shown by the name this device gave them, in its language", async () => {
  const w = worker({ kept: { lang: "en", names: [[ROOM, "Anu"]] } });
  await w.push({ t: "knock", room: ROOM });
  assert.deepEqual(w.log.shown, [{ title: I18N.en.knockTitle("Anu"),
    options: { body: I18N.en.knockBody, tag: ROOM, renotify: true, icon: "icons/icon-192.png", data: { room: ROOM, kind: "knock" } } }]);
  const mn = worker({ kept: { lang: "mn", names: [[ROOM, "Ану"]] } });
  await mn.push({ t: "knock", room: ROOM });
  assert.equal(mn.log.shown[0].title, I18N.mn.knockTitle("Ану"));
});

test("every push is shown — without a name when there is none to give, or nothing to read", async () => {
  for (const [kept, data] of [
    [{ lang: "en", names: [] }, { t: "knock", room: ROOM }],                 // forgotten here
    [null, { t: "knock", room: ROOM }],                                       // nothing kept
    [{ lang: "en", names: [[ROOM, "Anu"]] }, { t: "knock", room: "~short" }], // not a room
    [{ lang: "en", names: [[ROOM, "Anu"]] }, { t: "other", room: ROOM }],
    [{ lang: "en", names: [[ROOM, "Anu"]] }, "not json"],
    [{ lang: "en", names: [[ROOM, "Anu"]] }, undefined]
  ]) {
    const w = worker({ kept });
    if (data === "not json") await w.push({ get t() { throw new Error("x"); } });
    else await w.push(data);
    assert.equal(w.log.shown.length, 1, JSON.stringify(data));
    assert.match(w.log.shown[0].title, /saved|Хадгалсан/);
    assert.deepEqual(w.log.shown[0].options.data, { room: null, kind: "knock" }, "and opens to no one in particular");
    assert.equal(w.log.shown[0].options.tag, "knock");
  }
});

test("a message waiting: shown by name as a message, not a knock — its own tag, opening their messages", async () => {
  const w = worker({ kept: { lang: "en", names: [[ROOM, "Anu"]] } });
  await w.push({ t: "mail", room: ROOM });
  assert.deepEqual(w.log.shown, [{ title: I18N.en.mailNoticeTitle("Anu"),
    options: { body: I18N.en.mailNoticeBody, tag: `mail:${ROOM}`, renotify: true, icon: "icons/icon-192.png", data: { room: ROOM, kind: "mail" } } }]);
  const unnamed = worker({ kept: { lang: "mn", names: [] } });
  await unnamed.push({ t: "mail", room: ROOM });
  assert.equal(unnamed.log.shown[0].title, I18N.mn.mailNoticeSomeone);
  assert.equal(unnamed.log.shown[0].options.tag, "mail");
  const english = worker({ kept: { lang: "mn", names: [[ROOM, "Anu"]] }, i18n: false });
  await english.push({ t: "mail", room: ROOM });
  assert.equal(english.log.shown[0].title, "Anu sent you a message", "English without the words file, as for a knock");
});

test("a message waiting, tapped: an open page is told it is a message; a closed one opens at the messages", async () => {
  const open = worker({ pages: ["https://anirkh.github.io/RelayLink/"] });
  await open.clickWith({ room: ROOM, kind: "mail" });
  assert.deepEqual(open.log.posted, [{ type: "mail", room: ROOM }]);
  const closed = worker();
  await closed.clickWith({ room: ROOM, kind: "mail" });
  assert.deepEqual(closed.log.opened, [`https://anirkh.github.io/RelayLink/#mail=${ROOM}`]);
  const odd = worker();
  await odd.clickWith({ room: ROOM, kind: "<script>" });
  assert.deepEqual(odd.log.opened, [`https://anirkh.github.io/RelayLink/#knock=${ROOM}`], "an unknown kind is a knock");
});

test("without the words file, English stands in", async () => {
  const w = worker({ kept: { lang: "mn", names: [[ROOM, "Anu"]] }, i18n: false });
  await w.push({ t: "knock", room: ROOM });
  assert.equal(w.log.shown[0].title, "Anu wants to talk");
});

test("tapped: an open page is brought forward and told who; otherwise one opens, naming them", async () => {
  const open = worker({ pages: ["https://anirkh.github.io/RelayLink/?x"] });
  await open.click(ROOM);
  assert.equal(open.log.focused, 1);
  assert.deepEqual(open.log.posted, [{ type: "knock", room: ROOM }]);
  assert.deepEqual(open.log.opened, []);

  const closed = worker({ pages: ["https://elsewhere.example/"] });
  await closed.click(ROOM);
  assert.deepEqual(closed.log.opened, [`https://anirkh.github.io/RelayLink/#knock=${ROOM}`]);

  const nobody = worker();
  await nobody.click(null);
  assert.deepEqual(nobody.log.opened, ["https://anirkh.github.io/RelayLink/"]);
  const odd = worker();
  await odd.click("~not-a-room\"><script>");
  assert.deepEqual(odd.log.opened, ["https://anirkh.github.io/RelayLink/"], "only a room's own shape goes in the address");
});

test("the worker answers no requests: every page and file still comes from the network", () => {
  const src = read("sw.js").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(src, /addEventListener\("fetch"/);
  assert.doesNotMatch(src, /caches\./);
});
