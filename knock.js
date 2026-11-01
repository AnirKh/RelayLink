/*
  ─────────────────────────────────────────────
  RelayLink — knock.js
  ─────────────────────────────────────────────

  A knock: when one of two people who saved each other taps the other's name
  and is first there, the other's device is told — a notification, even with
  the app closed — so they know to open it. See "Knocks" in the README.

  It goes the one way a closed page can be reached: Web Push. The server signs
  a request to the push service that browser uses (Google's, Apple's,
  Microsoft's, Mozilla's) and that service wakes the device. Three standards:

    RFC 8291  the message is encrypted for the receiving browser alone — the
              push service carries it and cannot read it
    RFC 8188  the "aes128gcm" form that encryption is sent in
    RFC 8292  VAPID: this server signs every request, so a push service only
              delivers to a subscription made for this server's key

  The message says only which room is knocked on (`{"t":"knock","room":…}`,
  the hash both devices already name it by); the device turns that into the
  name it gave the person. Nothing here is kept: the address to knock on comes
  with each knock, from the device that holds it.

  Pure functions and one request, no dependencies — node's own crypto does all
  of it. Covered by test/knock.test.js, including the RFC's own example.
*/

"use strict";

const crypto = require("crypto");
const https  = require("https");
const http   = require("http");

const b64u   = bytes => Buffer.from(bytes).toString("base64url");
const unb64u = text => Buffer.from(String(text), "base64url");

/** The record size written in the header. A knock is one short record. */
const RECORD_SIZE = 4096;
/** A knock is worth having for as long as the room waits for them. */
const KNOCK_TTL_S = 600;

/* The push services browsers use. Only these are ever sent to: the address
   comes from a device, and a server that posted wherever it was told would
   be anyone's way into anywhere. */
const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"];
const PUSH_HOST_SUFFIXES = [".notify.windows.com", ".push.apple.com"];

/**
 * May a knock be sent to this address? https, a push service's own host, the
 * standard port, no credentials, and not absurdly long. `testOrigin` lets the
 * tests stand a local server in for a push service (KNOCK_TEST_ORIGIN) — it
 * is never set on a real server.
 */
function isPushEndpoint(endpoint, testOrigin = null) {
  if (typeof endpoint !== "string" || endpoint.length > 1024) return false;
  if (testOrigin && endpoint.startsWith(`${testOrigin}/`)) return true;
  let u;
  try { u = new URL(endpoint); } catch (_) { return false; }
  if (u.protocol !== "https:" || u.port || u.username || u.password) return false;
  return PUSH_HOSTS.includes(u.hostname) || PUSH_HOST_SUFFIXES.some(s => u.hostname.endsWith(s));
}

/** A subscription's two keys: the browser's public key (a P-256 point) and
    its 16-byte authentication secret. */
function pushKeysValid(p256dh, auth) {
  if (typeof p256dh !== "string" || typeof auth !== "string") return false;
  if (!/^[A-Za-z0-9_-]+$/.test(p256dh) || !/^[A-Za-z0-9_-]+$/.test(auth)) return false;
  const point = unb64u(p256dh);
  return point.length === 65 && point[0] === 4 && unb64u(auth).length === 16;
}

/**
 * RFC 8291: `plaintext` encrypted for one browser, in RFC 8188's aes128gcm
 * form — header (salt, record size, this server's one-time public key), then
 * the single record. `salt` and `serverPrivateKey` are chosen afresh for each
 * message; the tests pass the RFC's own, to check against its example.
 */
function encryptForPush(plaintext, { p256dh, auth }, { salt = crypto.randomBytes(16), serverPrivateKey = null } = {}) {
  const uaPublic   = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const ecdh = crypto.createECDH("prime256v1");
  if (serverPrivateKey) ecdh.setPrivateKey(unb64u(serverPrivateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared   = ecdh.computeSecret(uaPublic);
  const keyInfo  = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm   = Buffer.from(crypto.hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const cek   = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  /* 0x02: the last record, with no padding after it. */
  const record = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, record]);
}

/**
 * RFC 8292: the Authorization header proving the request is this server's —
 * a JWT for the push service's origin, good for twelve hours, signed with the
 * private key whose public half the browser subscribed with.
 */
function vapidAuthorization(endpoint, { publicKey, privateKey, subject }, now = Date.now()) {
  const pub = unb64u(publicKey);
  const key = crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: "jwk"
  });
  const head   = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const signature = crypto.sign("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${claims}.${b64u(signature)}, k=${publicKey}`;
}

/** The server's VAPID keys, from its environment — or null, and no knocks:
    a key made up at start would change with every restart, and every
    subscription made for the old one would stop working. */
function knockKeysFromEnv(env) {
  const publicKey = env.KNOCK_PUBLIC_KEY, privateKey = env.KNOCK_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  try {
    const pub = unb64u(publicKey);
    if (pub.length !== 65 || pub[0] !== 4 || unb64u(privateKey).length !== 32) return null;
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.setPrivateKey(unb64u(privateKey));
    if (!ecdh.getPublicKey().equals(pub)) return null;          // a pair, or nothing
  } catch (_) { return null; }
  return { publicKey, privateKey, subject: env.KNOCK_SUBJECT || "https://anirkh.github.io/RelayLink/" };
}

/** A fresh key pair for KNOCK_PUBLIC_KEY / KNOCK_PRIVATE_KEY — see tools/knock-keys.js. */
function makeKnockKeys() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  /* Padded to its 32 bytes: node drops a private key's leading zero bytes —
     about one key in 250 — and knockKeysFromEnv rightly takes only 32, so
     such a pair turned knocks off without a word. Found as a test of
     tools/knock-keys.js that failed now and then. */
  const priv = ecdh.getPrivateKey();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(Buffer.concat([Buffer.alloc(32 - priv.length), priv])) };
}

/**
 * Sends one knock. Resolves { ok, gone, status }: `gone` when the push service
 * says the subscription no longer exists (404, 410) — the device that holds
 * it should forget it. Never rejects: a knock that does not arrive is a knock
 * that does not arrive, and the room still waits.
 */
function sendKnock({ to, room, keys, kind = "knock", now = Date.now(), timeoutMs = 10_000 }) {
  return new Promise(resolve => {
    let body, authorization;
    try {
      /* "knock": they are waiting in the room; "mail": a message waits for them. */
      body = encryptForPush(JSON.stringify({ t: kind === "mail" ? "mail" : "knock", room }), to);
      authorization = vapidAuthorization(to.endpoint, keys, now);
    } catch (_) { resolve({ ok: false, gone: false, status: 0 }); return; }
    const url = new URL(to.endpoint);
    const request = (url.protocol === "http:" ? http : https).request(url, {
      method: "POST",
      timeout: timeoutMs,
      headers: {
        "Authorization": authorization,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "Content-Length": body.length,
        "TTL": String(KNOCK_TTL_S),
        "Urgency": "high",
        /* A second knock on the same room replaces one not yet delivered —
           and a second "a message waits" the first. */
        "Topic": crypto.createHash("sha256").update(`${kind === "mail" ? "mail:" : ""}${room}`).digest("base64url").slice(0, 32)
      }
    }, res => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, gone: res.statusCode === 404 || res.statusCode === 410, status: res.statusCode });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve({ ok: false, gone: false, status: 0 }));
    request.end(body);
  });
}

module.exports = {
  RECORD_SIZE, KNOCK_TTL_S, PUSH_HOSTS, PUSH_HOST_SUFFIXES,
  isPushEndpoint, pushKeysValid, encryptForPush, vapidAuthorization, knockKeysFromEnv, makeKnockKeys, sendKnock
};
