/*
  ─────────────────────────────────────────────
  RelayLink — clientip.js
  ─────────────────────────────────────────────

  Works out which address a request really came from. Every rate limit in
  server.js keys on this, so if it can be forged then none of them hold: the
  PIN lockout, the room-creation cap and — with no second line of defence —
  the email endpoint.

  X-Forwarded-For is a chain that grows left to right. Each proxy APPENDS the
  address it received the connection from, so the rightmost entries were
  written by the proxies nearest us and anything further left was supplied by
  the client and can say whatever it likes.

  Reading the leftmost entry therefore reads attacker-controlled input. We
  count in from the right instead, by however many proxies we actually sit
  behind.

    TRUSTED_PROXY_HOPS=1  (default)  one proxy in front — Tailscale Funnel on
                                     the Pi, nginx. Uses the last entry in the chain.
    TRUSTED_PROXY_HOPS=0             no proxy: ignore the header entirely and
                                     use the TCP peer. Set this if the process
                                     is exposed directly, or clients can forge
                                     their identity by sending the header.
    TRUSTED_PROXY_HOPS=n             n proxies you control, counted from us
                                     outwards.
*/

"use strict";

const TRUSTED_PROXY_HOPS = (() => {
  const parsed = parseInt(process.env.TRUSTED_PROXY_HOPS || "", 10);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 10) return parsed;
  return 1;
})();

/**
 * @param {{headers: object, socket: object}} req
 * @returns {string} an address the client could not have chosen
 */
function getClientIp(req, hops = TRUSTED_PROXY_HOPS) {
  const direct = (req.socket && req.socket.remoteAddress) || "unknown";
  if (hops <= 0) return direct;

  const chain = String((req.headers && req.headers["x-forwarded-for"]) || "")
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);

  if (!chain.length) return direct;

  /* Skip the entries our own proxies added to reach the address the outermost
     trusted one observed. */
  const index = chain.length - hops;

  /* Chain shorter than the hop count means the request did not arrive the way
     we were told to expect. Nothing in it is trustworthy, so fall back to the
     TCP peer, which cannot be forged. */
  if (index < 0) return direct;

  return chain[index] || direct;
}

function isLoopbackIp(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

module.exports = { getClientIp, isLoopbackIp, TRUSTED_PROXY_HOPS };
