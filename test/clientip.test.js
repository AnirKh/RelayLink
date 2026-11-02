/*
  Tests for clientip.js.

  Every rate limit in server.js keys on this value, so a forgeable one silently
  disables the PIN lockout, the room-creation cap and the email limit. The
  original implementation read the LEFTMOST X-Forwarded-For entry, which is
  whatever the client typed.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const { getClientIp, isLoopbackIp } = require("../clientip.js");

/** Minimal stand-in for an http request. */
function req(forwardedFor, remoteAddress = "10.9.9.9") {
  return {
    headers: forwardedFor === null ? {} : { "x-forwarded-for": forwardedFor },
    socket: { remoteAddress }
  };
}

/* ══════════════════════════════════════════
   Behind one proxy — the deployed setup
══════════════════════════════════════════ */

test("behind one proxy, the address the proxy observed is used", () => {
  /* The proxy in front (Tailscale Funnel on the Pi) appends the real client address, so it is the last entry. */
  assert.equal(getClientIp(req("203.0.113.7"), 1), "203.0.113.7");
});

test("a client cannot choose its address by sending the header itself", () => {
  /* The attack: send X-Forwarded-For, the proxy appends the real address, and
     a leftmost read returns the forged one. Every rate limit then keys on a
     value the attacker rotates at will. */
  const forged = getClientIp(req("1.2.3.4, 203.0.113.7"), 1);
  assert.equal(forged, "203.0.113.7", "must use the proxy-appended entry, not the client's");
  assert.notEqual(forged, "1.2.3.4");
});

test("a long forged chain still resolves to the real address", () => {
  assert.equal(
    getClientIp(req("9.9.9.9, 8.8.8.8, 7.7.7.7, 203.0.113.7"), 1),
    "203.0.113.7");
});

test("whitespace in the chain is tolerated", () => {
  assert.equal(getClientIp(req("  1.2.3.4 ,   203.0.113.7  "), 1), "203.0.113.7");
});

/* ══════════════════════════════════════════
   Other deployments
══════════════════════════════════════════ */

test("with no proxy the header is ignored entirely", () => {
  /* TRUSTED_PROXY_HOPS=0 is for a directly exposed process, where any
     X-Forwarded-For present was put there by the client. */
  assert.equal(getClientIp(req("1.2.3.4"), 0), "10.9.9.9");
  assert.equal(getClientIp(req("1.2.3.4, 5.6.7.8"), 0), "10.9.9.9");
});

test("behind two proxies, the count is taken from the right", () => {
  //            forged  , real client , proxy1
  const chain = "1.2.3.4, 203.0.113.7, 198.51.100.1";
  assert.equal(getClientIp(req(chain), 2), "203.0.113.7");
});

test("a chain shorter than the hop count falls back to the TCP peer", () => {
  /* The request did not arrive the way we were configured to expect, so
     nothing in the header is trustworthy. The socket address cannot be
     forged, so prefer it over guessing. */
  assert.equal(getClientIp(req("1.2.3.4"), 3), "10.9.9.9");
});

test("a missing or empty header falls back to the TCP peer", () => {
  assert.equal(getClientIp(req(null), 1), "10.9.9.9");
  assert.equal(getClientIp(req(""), 1), "10.9.9.9");
  assert.equal(getClientIp(req("   ,  , "), 1), "10.9.9.9");
});

test("a request with no socket still yields something usable", () => {
  assert.equal(getClientIp({ headers: {}, socket: {} }, 1), "unknown");
  assert.equal(getClientIp({ headers: {} }, 1), "unknown");
});

/* ══════════════════════════════════════════
   Loopback detection
══════════════════════════════════════════ */

test("loopback addresses are recognised in all three forms", () => {
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackIp(ip), true, ip);
  }
});

test("non-loopback addresses are not mistaken for loopback", () => {
  /* isLoopbackIp gates the no-Origin WebSocket path in development, so a false
     positive there would widen who may connect. */
  for (const ip of ["127.0.0.2", "10.0.0.1", "203.0.113.7", "", "unknown"]) {
    assert.equal(isLoopbackIp(ip), false, ip);
  }
});
