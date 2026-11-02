/*
  ─────────────────────────────────────────────
  RelayLink — protocol.js
  ─────────────────────────────────────────────

  The parts of the wire protocol that are pure functions of their inputs:
  invite-link encoding, key derivation, the verification code, and the binary
  chunk framing. Everything here is security-relevant and none of it touches
  the DOM, a socket, or module state — which is exactly why it lives apart from
  app.js: it can be tested directly (see test/protocol.test.js).

  Loaded as a plain script in the browser (window.DCProtocol) and required by
  the tests in Node. No build step, no dependencies.
*/

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DCProtocol = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /** Transfer ids are UUID-shaped, so every chunk carries a fixed 36-byte prefix. */
  const TRANSFER_ID_LEN   = 36;
  /** AES-GCM nonce length, in bytes. */
  const E2E_BIN_IV_LEN    = 12;
  /** Domain separator for HKDF. Bump the version if the derivation changes. */
  const E2E_INFO_LABEL    = "direct-connection/e2e/v2";
  /** Room-secret size. Large enough that guessing is hopeless, so mixing it
      straight into HKDF is sufficient and no password-style exchange is needed. */
  const ROOM_SECRET_BYTES = 32;

  const subtle = globalThis.crypto.subtle;
  const utf8   = new TextEncoder();

  /* ══════════════════════════════════════════
     Encoding helpers
  ══════════════════════════════════════════ */

  function b64urlBytes(bytes) {
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /** Fresh per-room secret, generated in the host's browser and never sent to
      the server. See parseInviteHash for how it reaches the guest. */
  function makeRoomSecret() {
    return b64urlBytes(globalThis.crypto.getRandomValues(new Uint8Array(ROOM_SECRET_BYTES)));
  }

  /** Domain separator for a saved person's room name. */
  const SAVED_ROOM_LABEL = "direct-connection/saved-room/v1:";

  /**
   * The room two people who saved each other meet in: "~" and a SHA-256 of
   * their shared secret. The server needs a name both devices can work out
   * on their own; this one tells it nothing of the secret, which stays the
   * key's — mixed into it exactly as an invite link's is. No room made by
   * name can take one (see the server's isSavedRoomId).
   */
  async function savedRoomName(secret) {
    const hash = await subtle.digest("SHA-256", utf8.encode(SAVED_ROOM_LABEL + secret));
    return `~${b64urlBytes(new Uint8Array(hash))}`;
  }

  /* ══════════════════════════════════════════
     Invite link
     #<encoded room name>:<join token>:<room secret>

     The room name is URI-encoded (a literal ":" becomes %3A) and the token and
     secret are base64url, so no part can contain ":" — splitting is safe.

     The secret rides in the fragment because fragments are never sent in HTTP
     requests. Only sessionId + token ever go over the WebSocket.
  ══════════════════════════════════════════ */

  function buildInviteHash(sessionId, token, secret) {
    return `${encodeURIComponent(sessionId)}:${token}:${secret}`;
  }

  /**
   * Never throws: a malformed fragment must not take the whole app down at
   * load time, which is what a bare decodeURIComponent would do on input like
   * "#%".
   */
  function parseInviteHash(hash) {
    const empty = { sessionId: null, token: null, secret: null, isInvite: false };
    const raw   = String(hash == null ? "" : hash).replace(/^#/, "");
    if (!raw) return empty;

    const parts = raw.split(":");
    if (parts.length < 2) return empty;

    let sessionId;
    try {
      sessionId = decodeURIComponent(parts[0]);
    } catch (_) {
      return empty;   // malformed percent-encoding
    }
    const token  = parts[1];
    const secret = parts.length >= 3 && parts[2] ? parts[2] : null;
    return { sessionId, token, secret, isInvite: Boolean(sessionId && token) };
  }

  /**
   * Guards the invariant the whole man-in-the-middle defence rests on: the room
   * secret must never leave the browser. Returns true if `payload` contains it
   * anywhere — nested or in an array counts, since a secret one level down
   * leaks exactly as thoroughly as one at the top.
   *
   * Worth enforcing rather than merely documenting: adding the secret to an
   * outgoing message would remove the protection while everything carried on
   * working, with no error and nothing visibly wrong.
   */
  function payloadLeaksSecret(payload, secret) {
    if (!secret) return false;
    const seen = new Set();
    let found = false;
    (function walk(value) {
      if (found || value === null || value === undefined) return;
      if (typeof value === "string") {
        if (value.includes(secret)) found = true;
        return;
      }
      if (typeof value !== "object") return;
      if (seen.has(value)) return;        // tolerate cycles
      seen.add(value);
      if (Array.isArray(value)) { value.forEach(walk); return; }
      for (const key of Object.keys(value)) walk(value[key]);
    })(payload);
    return found;
  }

  /* ══════════════════════════════════════════
     Key agreement
  ══════════════════════════════════════════ */

  /**
   * ECDH → HKDF → AES-GCM. Passing a different `secret` (or none) yields a
   * different key, which is what stops a signaling server that swapped the
   * public keys from reaching a usable one.
   */
  async function deriveSharedKey(privateKey, peerPublicKey, secret) {
    const bits = await subtle.deriveBits(
      { name: "ECDH", public: peerPublicKey }, privateKey, 256);
    const hkdf = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    return subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: secret ? utf8.encode(secret) : new Uint8Array(0),
        info: utf8.encode(E2E_INFO_LABEL)
      },
      hkdf, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  /* ══════════════════════════════════════════
     Verification code
  ══════════════════════════════════════════ */

  function compareBytes(a, b) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
  }

  /**
   * Both peers must arrive at the same string, so the two public keys are
   * sorted before hashing rather than concatenated in local-then-remote order.
   */
  async function makeSharedVerificationCode(localRaw, peerRaw) {
    const local  = new Uint8Array(localRaw);
    const peer   = new Uint8Array(peerRaw);
    const first  = compareBytes(local, peer) <= 0 ? local : peer;
    const second = first === local ? peer : local;
    const joined = new Uint8Array(first.length + second.length);
    joined.set(first, 0);
    joined.set(second, first.length);
    const hash = await subtle.digest("SHA-256", joined);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 20)
      .replace(/(.{4})/g, "$1 ")
      .trim()
      .toUpperCase();
  }

  function normalizeVerifyCode(value) {
    return String(value == null ? "" : value).replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  }

  /* ══════════════════════════════════════════
     Binary chunk framing
     [ 36-byte transfer id ][ 12-byte IV ][ ciphertext ]
  ══════════════════════════════════════════ */

  function packChunk(idBytes, iv, ct) {
    const packet = new Uint8Array(TRANSFER_ID_LEN + E2E_BIN_IV_LEN + ct.byteLength);
    packet.set(idBytes, 0);
    packet.set(iv, TRANSFER_ID_LEN);
    packet.set(ct, TRANSFER_ID_LEN + E2E_BIN_IV_LEN);
    return packet;
  }

  /** Splits off the transfer id; the remainder still holds IV + ciphertext. */
  function unpackChunk(buffer) {
    const id   = new TextDecoder().decode(new Uint8Array(buffer, 0, TRANSFER_ID_LEN));
    const body = new Uint8Array(buffer.slice(TRANSFER_ID_LEN));
    return { id, body };
  }

  /** null when the body is too short to hold an IV — i.e. a corrupt chunk. */
  function splitChunkBody(body) {
    if (body.byteLength < E2E_BIN_IV_LEN) return null;
    return { iv: body.slice(0, E2E_BIN_IV_LEN), ct: body.slice(E2E_BIN_IV_LEN) };
  }

  /* ══════════════════════════════════════════
     What each sealed message is bound to
     ──────────────────────────────────────────
     Found in a security assessment: both sides sealed with the one key and
     nothing said who sealed what, or in what order. Whoever could stand
     between the two — a signaling server that also swapped the transport's
     keys — could not read or change a message, but could hand one back to
     the side that sent it, where it opened as if the other had written it,
     or deliver one again later as new. Now every message is sealed with
     "additional data" that AES-GCM checks but does not send: who sealed it
     (h, the host; g, the guest), and its place — a number for a message,
     the transfer and its count for a file's chunk. A message opened as the
     other side's, or anywhere but its own place, does not open at all; a
     number seen before is turned away (takeSeal).
  ══════════════════════════════════════════ */

  const SEAL_ROLES = Object.freeze(["h", "g"]);

  function sealData(parts) {
    return utf8.encode(JSON.stringify(parts));
  }

  /** A sealed message: who sealed it, its number, its type — and for a text,
      the id its tick and reactions are found by. */
  function messageAad(role, n, type, msgId = null) {
    return sealData(["dc-msg-1", role, n, type, msgId]);
  }

  /** A file's chunk: who sealed it, the transfer, and which chunk it is. */
  function chunkAad(role, transferId, index) {
    return sealData(["dc-chunk-1", role, transferId, index]);
  }

  /** The key confirmation: who sealed it, so one cannot be handed back. */
  function confirmAad(role) {
    return sealData(["dc-confirm-1", role]);
  }

  /** How far behind the highest number a late message may still be taken.
      The channel keeps order, but sealing is asynchronous, so two sealed at
      once may leave in either order. */
  const SEAL_WINDOW = 1024;

  function sealWindow() {
    return { top: 0, seen: new Set() };
  }

  /** Takes message number `n` if it is new — marking it seen — or says no:
      not a counter, seen already, or too far behind to tell. */
  function takeSeal(win, n) {
    if (!Number.isSafeInteger(n) || n < 1) return false;
    if (n <= win.top - SEAL_WINDOW || win.seen.has(n)) return false;
    win.seen.add(n);
    if (n > win.top) {
      win.top = n;
      for (const k of win.seen) if (k <= win.top - SEAL_WINDOW) win.seen.delete(k);
    }
    return true;
  }

  /* ══════════════════════════════════════════
     Waiting messages
     ──────────────────────────────────────────
     A message to a saved person who is not there waits on the server until
     they open the app. The two devices seal it with a key of their own,
     worked out from the secret they share — which the server keeping it has
     never had — and bind it, like everything sealed, to where it belongs:
     which pair's mailbox, who wrote it, to whom, its id and when. Opened as
     anything else — handed back to its writer, moved to another mailbox,
     dated otherwise — it does not open at all.
  ══════════════════════════════════════════ */

  const MAILBOX_INFO_LABEL = "direct-connection/mailbox/v1";

  /** The pair's key for waiting messages, from their shared secret. */
  async function mailboxKey(secret) {
    const ikm = await subtle.importKey("raw", utf8.encode(secret), "HKDF", false, ["deriveKey"]);
    return subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8.encode(MAILBOX_INFO_LABEL) },
      ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  /** What a waiting message is bound to. */
  function mailAad(box, from, to, id, at) {
    return sealData(["dc-mail-1", box, from, to, id, at]);
  }

  /** A waiting message's id: 16 random bytes. */
  function makeMailId() {
    return b64urlBytes(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  }

  function unb64url(text) {
    const b64 = String(text).replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(b64 + "=".repeat((4 - b64.length % 4) % 4)), c => c.charCodeAt(0));
  }

  /** Seals a waiting message's body for the other side of the pair — a text,
      `{ text }`, or a file's description, `{ file: { name, type, size } }` —
      as { iv, ct }, both base64url. */
  async function sealMailBody(key, { box, from, to, id, at }, body) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: mailAad(box, from, to, id, at) },
      key, utf8.encode(JSON.stringify(body)));
    return { iv: b64urlBytes(iv), ct: b64urlBytes(new Uint8Array(ct)) };
  }

  /** Seals `text` for the other side of the pair: { iv, ct }, both base64url. */
  function sealMail(key, { box, from, to, id, at, text }) {
    return sealMailBody(key, { box, from, to, id, at }, { text });
  }

  /** A file's description, as one came: a name, a type and a size, nothing else. */
  function fileMetaValid(file) {
    return Boolean(file) && typeof file === "object" &&
           typeof file.name === "string" && file.name.length > 0 && file.name.length <= 255 &&
           typeof file.type === "string" && file.type.length <= 100 &&
           Number.isSafeInteger(file.size) && file.size >= 0;
  }

  /** The body of a waiting message — `{ text }` or `{ file }` — or null: not
      sealed with this key, not for here, from there, with this id and time,
      or neither a text nor a file's description. */
  async function openMailBody(key, { box, from, to, id, at, iv, ct }) {
    try {
      const plain = await subtle.decrypt({ name: "AES-GCM", iv: unb64url(iv), additionalData: mailAad(box, from, to, id, at) },
        key, unb64url(ct));
      const body = JSON.parse(new TextDecoder().decode(plain));
      if (body && typeof body.text === "string") return { text: body.text };
      if (body && fileMetaValid(body.file)) return { file: { name: body.file.name, type: body.file.type, size: body.file.size } };
      return null;
    } catch (_) { return null; }
  }

  /** The text of a waiting message, or null — see openMailBody. */
  async function openMail(key, m) {
    const body = await openMailBody(key, m);
    return body && typeof body.text === "string" ? body.text : null;
  }

  /* A waiting message's file — a photo, a document — goes on its own, after
     its description, as raw bytes: 12 of IV, then the sealed file. Bound to
     the same mailbox, sides and id as the message that describes it, so it
     opens only as that message's file. */
  function mailFileAad(box, from, to, id) {
    return sealData(["dc-mailfile-1", box, from, to, id]);
  }

  async function sealMailFile(key, { box, from, to, id }, bytes) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: mailFileAad(box, from, to, id) }, key, bytes));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv, 0);
    out.set(ct, 12);
    return out;
  }

  /** The file's bytes, or null: not this message's file, or changed. */
  async function openMailFile(key, { box, from, to, id }, sealed) {
    try {
      const all = new Uint8Array(sealed);
      if (all.length < 12 + 16) return null;
      const plain = await subtle.decrypt({ name: "AES-GCM", iv: all.subarray(0, 12), additionalData: mailFileAad(box, from, to, id) },
        key, all.subarray(12));
      return new Uint8Array(plain);
    } catch (_) { return null; }
  }

  /* ══════════════════════════════════════════
     The owner's inbox
     ──────────────────────────────────────────
     "Leave a message" used to email the app's owner through a mail company,
     which read every word. Now a visitor's note is sealed on their device to
     the owner's lock, kept on the Pi, and opened only on the owner's devices.

     The lock is two public keys — `box.sign`, each a raw P-256 point in
     base64url. Anyone seals a note to `box` (ECDH with a fresh key of their
     own, HKDF, AES-256-GCM: the sender cannot open it again either). `sign`
     lets the server tell the owner's device from anyone else's (proveOwner),
     so only the owner may collect notes or have them deleted.

     The two private keys never exist anywhere but the owner's devices: each
     works them out from the owner code, a 24-character code (120 bits) shown
     once when the inbox is set up. The lock is written here, in the app's
     own code, not handed out by the server — a server that was taken over
     could not slip in a lock of its own and read what visitors write next.
  ══════════════════════════════════════════ */

  /** The owner's lock, or null: no inbox yet, and no note can be left. Made
      on the owner's phone on 2 November 2026 ("Set up my inbox"). */
  const OWNER_LOCK = "BDRmy1TQYlYIUgo-54R6aoaHGYhnhV9vdXsDYpLKouOVbi8Nuw7doVwwA5qmGbyLLBA-XTrTqsQLD6VKW8SmoKs." +
                     "BM3jwvOzvxX9DGn4Vwv9baDKnfcsoO0-34WJ_MWqZgIUZ2dtp_2X2G3OT0qRdvHNYTE9meauONZo3AwhHQHpAM8";

  const OWNER_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";   // Crockford's: no I, L, O or U to misread
  const OWNER_CODE_CHARS    = 24;                                   // 5 bits each: 120
  const OWNER_LOCK_PATTERN  = /^[A-Za-z0-9_-]{87}\.[A-Za-z0-9_-]{87}$/;
  const NOTE_NAME_MAX = 200;
  const NOTE_TEXT_MAX = 5000;
  /* A sealed note or file carries the sender's one-time key (65 bytes), the
     IV (12) and the tag (16) besides what it seals. */
  const NOTE_SEAL_EXTRA = 65 + 12 + 16;

  /** A fresh owner code, grouped in fours: "K7QM-2X9D-…". 256 is a multiple
      of 32, so every character is equally likely. */
  function makeOwnerCode() {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(OWNER_CODE_CHARS));
    let code = "";
    for (const b of bytes) code += OWNER_CODE_ALPHABET[b % 32];
    return code.match(/.{4}/g).join("-");
  }

  /** An owner code as typed — any case, spaces or dashes, O for 0, I or L
      for 1 — as its 24 characters; null if it cannot be one. */
  function normalizeOwnerCode(input) {
    if (typeof input !== "string") return null;
    const code = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
    if (code.length !== OWNER_CODE_CHARS) return null;
    for (const c of code) if (!OWNER_CODE_ALPHABET.includes(c)) return null;
    return code;
  }

  function concatBytes(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  /** One of the owner's private keys, from the code: HKDF labelled for that
      key, 48 bytes read as a number, brought into range as FIPS 186-5 A.2.1
      does — so the bias is beyond measuring. */
  async function ownerScalar(code, label, order) {
    const ikm = await subtle.importKey("raw", utf8.encode(code), "HKDF", false, ["deriveBits"]);
    const bits = new Uint8Array(await subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8.encode(label) }, ikm, 384));
    let n = 0n;
    for (const b of bits) n = (n << 8n) | BigInt(b);
    const d = n % (order - 1n) + 1n;
    const out = new Uint8Array(32);
    for (let i = 31, v = d; i >= 0; i--, v >>= 8n) out[i] = Number(v & 0xffn);
    return out;
  }

  /**
   * The owner's keys, worked out from the code — null for something that is
   * not one. `p256` is the curve (vendor/noble.js in the page): Web Crypto
   * cannot find a public key from a private one, which importing needs.
   *
   * @returns {Promise<{box: {key: CryptoKey, pub: Uint8Array}, sign: {key: CryptoKey, pub: Uint8Array}, lock: string}|null>}
   */
  async function ownerKeys(codeInput, p256) {
    const code = normalizeOwnerCode(codeInput);
    if (!code) return null;
    const make = async (label, algorithm, usages) => {
      const d = await ownerScalar(code, label, p256.CURVE.n);
      const pub = p256.getPublicKey(d, false);
      const jwk = { kty: "EC", crv: "P-256", d: b64urlBytes(d), x: b64urlBytes(pub.subarray(1, 33)), y: b64urlBytes(pub.subarray(33)) };
      return { key: await subtle.importKey("jwk", jwk, algorithm, false, usages), pub: new Uint8Array(pub) };
    };
    const box  = await make("direct-connection/owner-box/v1", { name: "ECDH", namedCurve: "P-256" }, ["deriveBits"]);
    const sign = await make("direct-connection/owner-sign/v1", { name: "ECDSA", namedCurve: "P-256" }, ["sign"]);
    return { box, sign, lock: `${b64urlBytes(box.pub)}.${b64urlBytes(sign.pub)}` };
  }

  /** A lock's two public keys, if it has the shape of one. Whether they are
      points on the curve, importing them says. */
  function parseLock(lock) {
    if (typeof lock !== "string" || !OWNER_LOCK_PATTERN.test(lock)) return null;
    const [box, sign] = lock.split(".").map(unb64url);
    if (box.length !== 65 || sign.length !== 65 || box[0] !== 4 || sign[0] !== 4) return null;
    return { box, sign };
  }

  /** The owner's inbox on the server: a mailbox named from the lock, in the
      shape of a saved pair's, so the server keeps notes as it keeps messages. */
  async function inboxName(lock) {
    if (!parseLock(lock)) return null;
    const digest = await subtle.digest("SHA-256", utf8.encode(`direct-connection/owner-inbox/v1:${lock.split(".")[0]}`));
    return `~${b64urlBytes(new Uint8Array(digest))}`;
  }

  async function noteKey(shared, senderPub, ownerPub) {
    const ikm = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    return subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: concatBytes(senderPub, ownerPub), info: utf8.encode("direct-connection/owner-note/v1") },
      ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  /** Sealed to the owner: the sender's one-time public key, the IV, then the
      ciphertext — which only the owner's box key opens. */
  async function sealToOwner(lock, aad, bytes) {
    const owner = parseLock(lock);
    if (!owner) throw new Error("not a lock");
    const ownerKey = await subtle.importKey("raw", owner.box, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const once = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const oncePub = new Uint8Array(await subtle.exportKey("raw", once.publicKey));
    const shared = await subtle.deriveBits({ name: "ECDH", public: ownerKey }, once.privateKey, 256);
    const key = await noteKey(shared, oncePub, owner.box);
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, bytes));
    return concatBytes(oncePub, iv, ct);
  }

  async function openAsOwner(keys, aad, sealed) {
    try {
      const all = new Uint8Array(sealed);
      if (all.length < NOTE_SEAL_EXTRA) return null;
      const senderPub = all.subarray(0, 65);
      const sender = await subtle.importKey("raw", senderPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
      const shared = await subtle.deriveBits({ name: "ECDH", public: sender }, keys.box.key, 256);
      const key = await noteKey(shared, senderPub, keys.box.pub);
      return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: all.subarray(65, 77), additionalData: aad }, key, all.subarray(77)));
    } catch (_) { return null; }
  }

  function noteAad(box, id) {
    return sealData(["dc-note-1", box, id]);
  }

  function noteFileAad(box, id) {
    return sealData(["dc-notefile-1", box, id]);
  }

  /** What a note may hold: who it is from (as they wrote it, maybe nothing),
      the words, and a file's description. */
  function noteBodyValid(body) {
    return Boolean(body) && typeof body === "object" &&
           typeof body.name === "string" && body.name.length <= NOTE_NAME_MAX &&
           typeof body.text === "string" && body.text.length <= NOTE_TEXT_MAX &&
           (body.file === undefined || fileMetaValid(body.file)) &&
           (body.text.trim() !== "" || body.file !== undefined);
  }

  /** A note sealed to the owner, in a mailbox message's shape: the IV, and
      the sender's one-time key with the ciphertext. Bound to its inbox and id. */
  async function sealNote(lock, { box, id }, body) {
    const sealed = await sealToOwner(lock, noteAad(box, id), utf8.encode(JSON.stringify(body)));
    return { iv: b64urlBytes(sealed.subarray(65, 77)), ct: b64urlBytes(concatBytes(sealed.subarray(0, 65), sealed.subarray(77))) };
  }

  /** A note opened with the owner's keys — or null: not for this inbox, not
      this note, changed, or not a note's shape. */
  async function openNote(keys, { box, id, iv, ct }) {
    try {
      const ivBytes = unb64url(iv);
      const rest = unb64url(ct);
      if (ivBytes.length !== 12 || rest.length < 65 + 16) return null;
      const plain = await openAsOwner(keys, noteAad(box, id), concatBytes(rest.subarray(0, 65), ivBytes, rest.subarray(65)));
      if (!plain) return null;
      const body = JSON.parse(new TextDecoder().decode(plain));
      if (!noteBodyValid(body)) return null;
      return { name: body.name, text: body.text,
               ...(body.file ? { file: { name: body.file.name, type: body.file.type, size: body.file.size } } : {}) };
    } catch (_) { return null; }
  }

  /** A note's file, sealed to the owner whole. */
  function sealNoteFile(lock, { box, id }, bytes) {
    return sealToOwner(lock, noteFileAad(box, id), bytes);
  }

  function openNoteFile(keys, { box, id }, sealed) {
    return openAsOwner(keys, noteFileAad(box, id), sealed);
  }

  /** What the owner's device signs to show the server it is the owner's:
      the inbox, and the one-time word the server gave this connection. */
  function ownerProofData(box, nonce) {
    return sealData(["dc-owner-1", box, nonce]);
  }

  /** ECDSA P-256 over SHA-256 — Web Crypto's r‖s, 64 bytes, in base64url. */
  async function proveOwner(keys, box, nonce) {
    const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.sign.key, ownerProofData(box, nonce));
    return b64urlBytes(new Uint8Array(sig));
  }

  /** UUID v4 shape, used as the transfer id. */
  function makeTransferId() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = globalThis.crypto.getRandomValues(new Uint8Array(1))[0] % 16;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  return {
    TRANSFER_ID_LEN, E2E_BIN_IV_LEN, E2E_INFO_LABEL, ROOM_SECRET_BYTES,
    b64urlBytes, makeRoomSecret, savedRoomName,
    buildInviteHash, parseInviteHash, payloadLeaksSecret,
    deriveSharedKey,
    compareBytes, makeSharedVerificationCode, normalizeVerifyCode,
    packChunk, unpackChunk, splitChunkBody, makeTransferId,
    SEAL_ROLES, SEAL_WINDOW, messageAad, chunkAad, confirmAad, sealWindow, takeSeal,
    mailboxKey, mailAad, makeMailId, sealMail, openMail, sealMailBody, openMailBody, fileMetaValid,
    mailFileAad, sealMailFile, openMailFile,
    OWNER_LOCK, OWNER_CODE_CHARS, NOTE_NAME_MAX, NOTE_TEXT_MAX, NOTE_SEAL_EXTRA,
    makeOwnerCode, normalizeOwnerCode, ownerKeys, parseLock, inboxName,
    sealNote, openNote, sealNoteFile, openNoteFile, ownerProofData, proveOwner
  };
});
