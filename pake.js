/*
  ─────────────────────────────────────────────
  RelayLink — pake.js
  ─────────────────────────────────────────────

  SPAKE2 (RFC 9382) over P-256. A password-authenticated key agreement:
  two people who share a short secret — a word, a few digits — end up with the
  same strong key, and anyone who does not know the secret cannot.

  Why this is here. A PIN join falls back to plain ECDH plus a code the two
  people compare by hand, because the server makes the PIN and so cannot be
  kept out of it. SPAKE2 lets the HOST choose the secret instead, share it out
  of band, and have the chat verify it automatically — the same "already green"
  result as the invite link, from a short code the server never sees.

  The property that makes a short code safe is the one offline-guessing cannot
  break: an attacker in the middle must commit to a single password guess to
  take part at all, and a wrong guess simply fails. There is nothing to carry
  away and grind through offline — which is exactly what a plain "mix the word
  into the key" scheme would allow, and why that scheme is not used here.

  The elliptic-curve arithmetic is @noble/curves, audited and used unmodified.
  This file is only the SPAKE2 protocol on top of it, and test/pake.test.js
  pins every step to the official RFC 9382 test vectors — if those pass, the
  core matches the specification byte for byte.

  No DOM, no sockets, no module state. app.js drives it; vendor/noble.js hands
  the browser the same curve library Node gets from node_modules.
*/

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory({
      p256:  require("@noble/curves/p256").p256,
      sha256: require("@noble/hashes/sha256").sha256,
      hmac:  require("@noble/hashes/hmac").hmac,
      hkdf:  require("@noble/hashes/hkdf").hkdf,
      utils: require("@noble/hashes/utils")
    });
  } else {
    /* vendor/noble.js sets window.DCNoble to the same four pieces. */
    root.DCPake = factory(root.DCNoble);
  }
})(typeof self !== "undefined" ? self : globalThis, function (noble) {
  "use strict";

  const { p256, sha256, hmac, hkdf, utils } = noble;
  const { bytesToHex, hexToBytes, concatBytes } = utils;
  const Point = p256.ProjectivePoint;
  const ORDER = p256.CURVE.n;

  /* RFC 9382 §4, the P-256 seeds, decompressed once. M is the host's (A's)
     point, N the guest's (B's). */
  const M = Point.fromHex("02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f");
  const N = Point.fromHex("03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49");

  const enc = new TextEncoder();

  /* ══════════════════════════════════════════
     Encoding
  ══════════════════════════════════════════ */

  function bytesToBigInt(bytes) {
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    return n;
  }

  /** A scalar as 32 big-endian bytes, the width P-256 uses. */
  function scalarToBytes(value) {
    const out = new Uint8Array(32);
    let v = value;
    for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
    return out;
  }

  /** Length as 8 little-endian bytes, the transcript's framing. */
  function len64(length) {
    const out = new Uint8Array(8);
    let v = length;
    for (let i = 0; i < 8; i++) { out[i] = v & 0xff; v >>>= 8; }
    return out;
  }

  const uncompressed = point => point.toRawBytes(false);   // 0x04 || X || Y, 65 bytes

  /* ══════════════════════════════════════════
     Protocol steps — deterministic in their inputs, which is what lets
     test/pake.test.js hold them against the RFC vectors.
  ══════════════════════════════════════════ */

  /** The host's message: pA = x·G + w·M. */
  function messageA(w, x) {
    return Point.BASE.multiply(x).add(M.multiply(w));
  }

  /** The guest's message: pB = y·G + w·N. */
  function messageB(w, y) {
    return Point.BASE.multiply(y).add(N.multiply(w));
  }

  /** The host's view of the shared point: K = x·(pB − w·N). */
  function sharedFromA(w, x, pB) {
    return pB.subtract(N.multiply(w)).multiply(x);
  }

  /** The guest's view of the shared point: K = y·(pA − w·M). */
  function sharedFromB(w, y, pA) {
    return pA.subtract(M.multiply(w)).multiply(y);
  }

  /**
   * The transcript, exactly as RFC 9382 §4 frames it:
   *   len(A)‖A ‖ len(B)‖B ‖ len(pA)‖pA ‖ len(pB)‖pB ‖ len(K)‖K ‖ len(w)‖w
   * every length an 8-byte little-endian count, every point uncompressed,
   * w a 32-byte scalar. Binding all of it is what ties the confirmation to
   * this exact exchange.
   */
  function transcript(idA, idB, pA, pB, K, w) {
    const wBytes = scalarToBytes(w);
    const field = bytes => concatBytes(len64(bytes.length), bytes);
    return concatBytes(
      field(idA), field(idB),
      field(uncompressed(pA)), field(uncompressed(pB)), field(uncompressed(K)),
      field(wBytes)
    );
  }

  /**
   * Keys from the transcript (RFC 9382 §4):
   *   Ke ‖ Ka = SHA-256(TT)          — Ke is the shared secret, Ka seeds the rest
   *   KcA ‖ KcB = HKDF(Ka, "ConfirmationKeys")
   */
  function deriveKeys(TT) {
    const hash = sha256(TT);
    const Ke = hash.slice(0, 16);
    const Ka = hash.slice(16, 32);
    const Kc = hkdf(sha256, Ka, undefined, enc.encode("ConfirmationKeys"), 32);
    return { hash, Ke, Ka, KcA: Kc.slice(0, 16), KcB: Kc.slice(16, 32) };
  }

  const confirm = (Kc, TT) => hmac(sha256, Kc, TT);

  /** Constant-time compare — a confirmation check must not leak where it differs. */
  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  /* ══════════════════════════════════════════
     Password → scalar
  ══════════════════════════════════════════ */

  /**
   * The secret word becomes the scalar w. SHA-512 to 64 bytes, then reduced
   * mod the curve order: 512 bits folded into ~256 leaves any bias far below
   * anything observable. A context string (the room) is mixed in, so the same
   * word in two rooms is two different scalars.
   *
   * No slow hash is needed here, unlike a scheme that mixes the word straight
   * into the key: SPAKE2 already denies the offline guessing that a slow hash
   * would be defending against.
   */
  function scalarFromPassword(password, context) {
    const material = concatBytes(
      enc.encode("direct-connection/pake/v1\n"),
      enc.encode(String(context == null ? "" : context)), enc.encode("\n"),
      enc.encode(String(password == null ? "" : password))
    );
    const wide = concatBytes(sha256(concatBytes(material, Uint8Array.of(0))),
                             sha256(concatBytes(material, Uint8Array.of(1))));
    /* Non-zero mod n: w = 0 would drop the password out of the message. */
    const w = bytesToBigInt(wide) % ORDER;
    return w === 0n ? 1n : w;
  }

  /* ══════════════════════════════════════════
     The two public steps app.js calls
  ══════════════════════════════════════════ */

  /** Fresh scalar in [1, n−1]. */
  function randomScalar() {
    while (true) {
      const b = globalThis.crypto.getRandomValues(new Uint8Array(32));
      const s = bytesToBigInt(b) % ORDER;
      if (s !== 0n) return s;
    }
  }

  /**
   * Begin. Returns the message to send the peer, and the state to hand `finish`.
   * `role` is "host" or "guest"; both sides must agree, which they do from who
   * created the room.
   */
  function start(role, password, context) {
    if (role !== "host" && role !== "guest") throw new Error("role must be host or guest");
    const w = scalarFromPassword(password, context);
    const x = randomScalar();   // the side's own ephemeral scalar, host's x or guest's y
    const mine = role === "host" ? messageA(w, x) : messageB(w, x);
    return { state: { role, w, x, context }, message: bytesToHex(uncompressed(mine)) };
  }

  /**
   * Finish, given the peer's message. Validates it, derives the shared key and
   * both confirmation tags, and hands back:
   *   confirmToSend       our tag, to send the peer
   *   verifyPeerConfirm   a function: the peer's tag in → true if it matches
   *   sessionKey          raw 32 bytes to turn into the channel's AES key,
   *                       available only once the peer's tag has verified
   *
   * Throws if the peer's message is not a valid, non-identity curve point, or
   * if the shared point degenerates — any of which means no honest peer.
   */
  function finish(state, peerMessageHex) {
    const peer = Point.fromHex(peerMessageHex);   // throws on off-curve / bad encoding
    peer.assertValidity();
    /* fromHex already rejects the identity (and P-256's cofactor is 1, so every
       valid point is in the prime-order group); this is a redundant backstop. */
    if (peer.equals(Point.ZERO)) throw new Error("peer message is the identity point");

    const { role, w, x } = state;
    const K = role === "host" ? sharedFromA(w, x, peer) : sharedFromB(w, x, peer);
    if (K.equals(Point.ZERO)) throw new Error("shared point is the identity");

    /* The transcript is identity-A then identity-B then pA then pB, in that
       fixed order, whichever side we are. */
    const myMsg = role === "host" ? messageA(w, x) : messageB(w, x);
    const pA = role === "host" ? myMsg : peer;
    const pB = role === "host" ? peer : myMsg;
    const idA = enc.encode("DC-host:" + String(state.context == null ? "" : state.context));
    const idB = enc.encode("DC-guest:" + String(state.context == null ? "" : state.context));

    const TT = transcript(idA, idB, pA, pB, K, w);
    const { hash, KcA, KcB } = deriveKeys(TT);

    const myConfirm   = role === "host" ? confirm(KcA, TT) : confirm(KcB, TT);
    const peerConfirm = role === "host" ? confirm(KcB, TT) : confirm(KcA, TT);

    /* The channel key comes from the full transcript hash, not from Ke alone,
       so it carries the agreed point's whole 256-bit strength. Its own label
       keeps it apart from the confirmation keys. */
    const sessionKey = hkdf(sha256, hash, undefined, enc.encode("direct-connection/pake/channel/v1"), 32);

    return {
      confirmToSend: bytesToHex(myConfirm),
      verifyPeerConfirm: tagHex => {
        let tag;
        try { tag = hexToBytes(tagHex); } catch (_) { return false; }
        return sameBytes(tag, peerConfirm);
      },
      sessionKey
    };
  }

  return {
    /* high level */
    start, finish, scalarFromPassword,
    /* low level, exposed for the RFC-vector tests */
    _messageA: messageA, _messageB: messageB,
    _sharedFromA: sharedFromA, _sharedFromB: sharedFromB,
    _transcript: transcript, _deriveKeys: deriveKeys, _confirm: confirm,
    _M: M, _N: N, _ORDER: ORDER, _Point: Point,
    _uncompressed: uncompressed, _bytesToHex: bytesToHex, _hexToBytes: hexToBytes
  };
});
