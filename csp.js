/*
  ─────────────────────────────────────────────
  RelayLink — csp.js
  Single source of truth for the Content-Security-Policy.
  ─────────────────────────────────────────────

  The policy has to exist in two forms, and neither can be dropped:

    - as a response header from server.js — covers the Render deployment, and is
      the only form that can carry frame-ancestors (meta tags ignore it)
    - as a <meta> tag in index.html — GitHub Pages serves static files and
      cannot set headers, so the static deployment has no other option

  Keeping them in step by hand is how they drift: change one, forget the other,
  and the app breaks with a CORS or CSP error that points nowhere near the cause.

  So: edit the policy HERE, then run

      npm run sync-csp

  to rewrite the meta tag in index.html. server.js checks the two agree on
  startup and warns if they have drifted. `npm run check-csp` fails instead of
  rewriting, for use before a deploy.

  The header form follows ALLOWED_ORIGINS at runtime; the meta form is static
  and therefore built from DEFAULT_ALLOWED_ORIGINS. If you set ALLOWED_ORIGINS
  to something the defaults do not cover, update the defaults here too.
*/

"use strict";

/* Nothing is loaded from another site any more: the icon font, the one thing
   that was (from a CDN), is served from here — vendor/tabler/. So styles and
   fonts come from 'self' only. */

const DEFAULT_ALLOWED_ORIGINS = [
  "https://direct-connection.onrender.com",
  /* The Raspberry Pi at home, through Tailscale Funnel — see deploy/pi. */
  "https://raspberrypi.vulture-manta.ts.net",
  "https://anirkh.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
];

function wsOriginFor(origin) {
  return origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

/**
 * Builds the policy string.
 * @param {string[]} origins  browser origins allowed for fetch + WebSocket
 * @param {{ asHeader: boolean }} opts  header form also carries frame-ancestors
 */
function buildCsp(origins, { asHeader }) {
  const connect = new Set(["'self'", ...origins, ...origins.map(wsOriginFor)]);
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' blob: data:",
    "media-src 'self' blob: mediastream:",
    `connect-src ${Array.from(connect).join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    /* Browsers ignore frame-ancestors in a meta tag, so only emit it in the
       header form. Nothing header-based reaches the GitHub Pages build —
       X-Frame-Options is a header too, and Pages sets none — so the static
       deployment relies on framebust.js instead. Do not read this line as the
       static build being covered; it is not. */
    ...(asHeader ? ["frame-ancestors 'none'"] : []),
    "frame-src 'none'",
    "worker-src 'self' blob:"
  ].join("; ");
}

/** Exactly what index.html's meta tag should contain. */
const META_CSP = buildCsp(DEFAULT_ALLOWED_ORIGINS, { asHeader: false });

/** Matches the meta tag so the sync script and the startup check agree. */
const META_TAG_PATTERN = /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(">)/;

module.exports = {
  buildCsp,
  wsOriginFor,
  DEFAULT_ALLOWED_ORIGINS,
  META_CSP,
  META_TAG_PATTERN
};
