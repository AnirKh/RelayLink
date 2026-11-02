/*
  ─────────────────────────────────────────────
  RelayLink — server.js
  Features:
  - Session create with 6-digit PIN, or open (no PIN, first guest in)
  - Session list broadcast
  - PIN verification on join
  - Offer / answer / ICE relay
  - Renegotiation offer/answer relay
  - (no call relay: call signalling travels end-to-end encrypted, peer to peer)
  - Peer disconnect notification
  - A code room outlives its guest: the seat is freed and the host told
  - A waiting room outlives its host's dropped link for HOST_AWAY_MS; the host
    takes it back with its host key (reclaim-session)
  - So does a chat, either side's link: the host takes its seat back with its
    host key, the guest with its guest key (rejoin-session); the other side
    hears peer-away / peer-back, and repair-request passes between them
  - Waiting files written straight to disk, at most MAIL_FILES_AT_ONCE coming at once
  - At most WS_PER_IP_MAX open WebSocket links per address
  - Session cleanup on disconnect
  - WebSocket heartbeat (30s ping/pong) drops clients that vanished silently
  - Stale session pruner (10 min)
  - PIN brute-force protection (3 attempts → 30s lockout per IP)
  - Per-room failed join throttling (mitigates distributed PIN guessing)
  - A correct invite token is not held to either lock (see joinVerdict)
  - One room per socket; every room message names its room
  - WebSocket Origin allowlist (same as CORS)
  - list-sessions / create-session rate limits per IP
  - Notes for the app's owner, sealed to the owner's lock on the sender's device,
    kept in the owner's inbox, collected only by the owner's devices (see OWNER INBOX)
  - Optional PUBLIC_SESSION_LIST=0 to hide active room names from the lobby
  ─────────────────────────────────────────────

  Environment — on the Pi, /etc/direct-connection.env (see deploy/pi).
  All optional:
    ALLOWED_ORIGINS       Comma-separated browser origins (must include your static site origin)
    PUBLIC_SESSION_LIST   Set to "0" to never expose other users' room names in the lobby
    HEARTBEAT_MS          Ping sweep interval, 1000–300000 (default 30000)
    HOST_AWAY_MS          How long a seat is kept for a side whose link dropped —
                          a waiting room's host, either side of a chat —
                          1000–3600000 (default 600000)
    KNOCK_PUBLIC_KEY      The key pair knocks are signed with (Web Push, VAPID).
    KNOCK_PRIVATE_KEY     Make them once with `node tools/knock-keys.js`.
                          Without both, the server sends no knocks and the page
                          offers none. See knock.js.
    KNOCK_SUBJECT         A mailto: or https: contact for the push services
                          (default: the site's address)
    HOST                  The one address to listen on — 127.0.0.1 behind a
                          proxy on the same machine (default: every address)
    BASE_PATH             A path the proxy in front passes on without taking it
                          off, e.g. /dc — taken off here (default: none)
    MAILBOX_DIR           Where waiting messages are kept (default: systemd's
                          STATE_DIRECTORY; without either, memory only)
    OWNER_LOCK            The owner's lock, where it is not the app's own
                          (DC.OWNER_LOCK in protocol.js) — tests, or this
                          server run for someone else
    See deploy/pi/SETUP.md for running it on a Raspberry Pi.
*/

"use strict";

const express    = require("express");
const http       = require("http");
const crypto     = require("crypto");
const path       = require("path");
const fs         = require("fs");
const { pipeline, Transform } = require("stream");
const WebSocket  = require("ws");

/* Policy lives in csp.js so the header here and the meta tag in index.html
   cannot drift apart unnoticed. See that file before editing either. */
const {
  buildCsp, DEFAULT_ALLOWED_ORIGINS, META_CSP, META_TAG_PATTERN
} = require("./csp");

/* Knocks — Web Push to a saved person's device. See knock.js. */
const { knockKeysFromEnv, isPushEndpoint, pushKeysValid, sendKnock } = require("./knock");
const KNOCK_KEYS = knockKeysFromEnv(process.env);
/* Tests only: a local server standing in for a push service. Never set on a
   real server — it lets knocks go to that one address besides the push
   services. */
const KNOCK_TEST_ORIGIN = process.env.KNOCK_TEST_ORIGIN || null;

/* Messages waiting for a saved person who is not there — sealed by the two
   devices, kept and handed over here, never read. See mailbox.js. Kept in a
   file in MAILBOX_DIR, or the directory systemd gives the service
   (STATE_DIRECTORY, on the Pi), so a restart loses none; in memory only
   without either. */
const { createMailboxes, fileAddressValid, FILE_MAX_BYTES: MAIL_FILE_MAX_BYTES } = require("./mailbox");
const MAILBOX_DIR = process.env.MAILBOX_DIR || (process.env.STATE_DIRECTORY || "").split(":")[0] || null;
/* Photos and files, too — sealed the same way, kept on disk beside it, one
   file each; none without a directory to keep them in. */
const mail = createMailboxes({ file: MAILBOX_DIR ? path.join(MAILBOX_DIR, "mailbox.json") : null,
                               filesDir: MAILBOX_DIR ? path.join(MAILBOX_DIR, "files") : null });
setInterval(() => mail.sweep(), 5 * 60 * 1000).unref();
/* ── OWNER INBOX ───────────────────────────
   "Leave a message" is a note for the app's owner. The sender's device seals
   it to the owner's lock (protocol.js — the lock is in the app's own code)
   and leaves it here like any waiting message, in the mailbox the lock names
   (OWNER_BOX, side "a"); a file goes first, as for messages. This server
   cannot open them. Only a link that proved it is the owner's — it signed
   this connection's one-time word with the lock's signing key (owner-hello)
   — may collect them or have them let go, and say where the owner's device
   is to be alerted (owner-alert, kept in owner.json beside the mailbox). */
const OWNER_LOCK = /^[A-Za-z0-9_-]{87}\.[A-Za-z0-9_-]{87}$/.test(process.env.OWNER_LOCK || "")
  ? process.env.OWNER_LOCK : require("./protocol.js").OWNER_LOCK;
const OWNER_BOX = OWNER_LOCK
  ? `~${crypto.createHash("sha256").update(`direct-connection/owner-inbox/v1:${OWNER_LOCK.split(".")[0]}`).digest("base64url")}`
  : null;
const OWNER_SIGN_KEY = (() => {
  if (!OWNER_LOCK) return null;
  const raw = Buffer.from(OWNER_LOCK.split(".")[1], "base64url");
  try {
    return crypto.createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256",
      x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") } });
  } catch (_) { console.error("OWNER_LOCK is not a lock: no inbox"); return null; }
})();
const OWNER_FILE = MAILBOX_DIR ? path.join(MAILBOX_DIR, "owner.json") : null;
let ownerAlert = null;                 // where the owner's device is alerted, or null
if (OWNER_FILE) {
  try {
    const kept = JSON.parse(fs.readFileSync(OWNER_FILE, "utf8"));
    if (kept && kept.v === 1 && kept.box === OWNER_BOX && kept.alert && typeof kept.alert === "object") ownerAlert = kept.alert;
  } catch (_) { /* none yet */ }
}

/** Did this signature come from the owner's device, for this connection? */
function ownerProofValid(nonce, sig) {
  if (!OWNER_SIGN_KEY || typeof nonce !== "string" || typeof sig !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(sig)) return false;
  try {
    return crypto.verify("sha256", Buffer.from(JSON.stringify(["dc-owner-1", OWNER_BOX, nonce])),
      { key: OWNER_SIGN_KEY, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
  } catch (_) { return false; }
}

/** Where to alert the owner — kept as the mailbox is: written aside, then moved into place. */
function keepOwnerAlert(alert) {
  ownerAlert = alert;
  if (!OWNER_FILE) return;
  try {
    fs.mkdirSync(path.dirname(OWNER_FILE), { recursive: true });
    fs.writeFileSync(`${OWNER_FILE}.tmp`, JSON.stringify({ v: 1, box: OWNER_BOX, alert }), { mode: 0o600 });
    fs.renameSync(`${OWNER_FILE}.tmp`, OWNER_FILE);
  } catch (err) {
    console.error(`Owner alert: could not be kept — ${err.code || err.message}`);
  }
}

/* Stopping — every update restarts the server — keeps what waits first. */
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { mail.flush(); process.exit(0); });

/* Every rate limit below keys on the client address, so it is only as strong
   as this is hard to forge. See clientip.js. */
const { getClientIp, isLoopbackIp, TRUSTED_PROXY_HOPS } = require("./clientip");

/* Sliding-window counters and log sanitising — small, pure, and tested
   directly rather than through a running server. See ratelimit.js. */
const { slidingAllow, pruneExpired, safeLabel, joinVerdict } = require("./ratelimit");

const app    = express();
const server = http.createServer(app);
/* A whole request may take this long to arrive. Node's own five minutes cut
   off a 50 MB photo or file sent over a slow phone connection (under about
   1.4 Mbit/s); the headers still have Node's minute, and uploads are few at
   once and limited per network. */
server.requestTimeout = 20 * 60 * 1000;

/* Mounted under a path by a proxy that passes the path on as it came — say
   Tailscale Funnel at /dc, should it not take it off itself (see deploy/pi).
   The path is taken off here before anything else sees the request; the
   WebSocket answers on any path anyway. Only a plain "/name" counts. */
const BASE_PATH = /^\/[A-Za-z0-9_-]+$/.test(process.env.BASE_PATH || "") ? process.env.BASE_PATH : "";
if (BASE_PATH) {
  app.use((req, res, next) => {
    if (req.url === BASE_PATH || req.url.startsWith(`${BASE_PATH}/`) || req.url.startsWith(`${BASE_PATH}?`)) {
      const rest = req.url.slice(BASE_PATH.length);
      req.url = rest.startsWith("/") ? rest : `/${rest}`;
    }
    next();
  });
}

const PUBLIC_SESSION_LIST = process.env.PUBLIC_SESSION_LIST !== "0";

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(","))
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

const API_CLIENT_HEADER = "x-dc-client";
/* Which waiting file, "box:side:id" — and ":size" when sending one. In a
   header, not the address: an address can be written down along the way. */
const MAIL_FILE_HEADER = "x-dc-mail";
const API_CLIENT_VALUE  = "1";

/* Which build of the client this server shipped with. Read out of app.js, which
   is where tools/sync-build.js writes it, so there is one copy and no way for
   the two to disagree. Every socket is told this on connecting; a page that
   finds it is older fetches the new one. Null if app.js has no well-formed id —
   then nothing is announced and nothing reloads. */
const CLIENT_BUILD = (() => {
  try {
    const src = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
    return (src.match(/^const APP_BUILD = "(\d{12}-[0-9a-f]{8})";/m) || [])[1] || null;
  } catch (_) {
    return null;
  }
})();

/* For pages older than the handshake above. They cannot update themselves and
   do not know to listen for a build id — but they do show the text of any
   "error" the server sends, so that is how they get told. Sent once per
   connection, to a socket that asks for the room list without having said
   hello first, which every such page does the moment it connects. Safe to
   delete once those pages are gone; none survives being closed. */
const RELOAD_NOTICE =
  "Шинэ хувилбар гарлаа — хуудсаа хааж дахин нээнэ үү. · A new version is out — please close and reopen this page.";

function nudgePageTooOldToUpdateItself(ws) {
  if (ws.saidHello || ws.nudged) return;
  ws.nudged = true;
  ws.send(JSON.stringify({ type: "error", message: RELOAD_NOTICE }));
}

/* Built once — ALLOWED_ORIGINS cannot change while the process is running. */
const CSP_HEADER = buildCsp(ALLOWED_ORIGINS, { asHeader: true });

/* index.html carries its own copy of the policy for the static (GitHub Pages)
   deployment, which cannot set headers. Nothing at runtime keeps the two in
   step, so say so loudly rather than letting the static build ship a stale one. */
function warnIfCspDrifted() {
  try {
    const html  = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    const match = html.match(META_TAG_PATTERN);
    if (!match) {
      console.warn("CSP: index.html has no Content-Security-Policy meta tag");
    } else if (match[2] !== META_CSP) {
      console.warn("CSP: index.html meta tag has drifted from csp.js — run `npm run sync-csp`");
    }
  } catch (err) {
    console.warn(`CSP: could not verify index.html — ${err.message}`);
  }
}


/** WebSocket upgrade: Origin must match allowlist (browsers always send Origin). */
function isAllowedWebSocketOrigin(req) {
  if (!ALLOWED_ORIGINS.length) return false;
  const origin = req.headers.origin;
  if (origin) return ALLOWED_ORIGINS.includes(origin);
  /* Non-browser clients have no Origin; allow loopback only in development. */
  const ip = getClientIp(req);
  if (process.env.NODE_ENV === "production") return false;
  return isLoopbackIp(ip);
}

/* At most this many open links from one address. Found in a security
   assessment: nothing bounded them, so one machine could open thousands and
   exhaust the process's memory. Generous on purpose — a mobile network can
   put many phones behind one address, and each open page holds one link —
   but far below what it takes to hurt. */
const WS_PER_IP_MAX = 50;
const wsOpenByIp = new Map();

const wss = new WebSocket.Server({
  server,
  maxPayload: 1024 * 1024,
  verifyClient: (info, cb) => {
    if (!isAllowedWebSocketOrigin(info.req)) return cb(false);
    if ((wsOpenByIp.get(getClientIp(info.req)) || 0) >= WS_PER_IP_MAX) return cb(false, 429, "Too many connections");
    cb(true);
  }
});

app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", CSP_HEADER);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", `Content-Type, ${API_CLIENT_HEADER}, ${MAIL_FILE_HEADER}`);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get(["/app.js", "/protocol.js", "/i18n.js", "/framebust.js", "/connstats.js", "/guards.js", "/pake.js", "/vendor/noble.js", "/style.css",
         "/manifest.webmanifest", "/icons/icon.svg", "/icons/apple-touch-icon.png", "/icons/author.jpg",
         "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png",
         "/icons/link-preview-relaylink.png", "/sw.js",
         "/vendor/tabler/tabler-icons.min.css", "/vendor/tabler/fonts/tabler-icons.woff2"], (req, res) => {
  res.sendFile(path.join(__dirname, req.path.slice(1)));
});

/* ── Ping endpoint — used by client to wake server ── */
app.get("/api/ping", (req, res) => res.json({
  ok: true,
  /* The public half of the knock keys, for a browser to subscribe with —
     null when this server sends no knocks. */
  knockKey: KNOCK_KEYS ? KNOCK_KEYS.publicKey : null,
  /* Whether a photo or file can wait here for someone away, and how big. */
  mailFileMaxBytes: mail.filesOn ? MAIL_FILE_MAX_BYTES : 0
}));

/** Non-simple header forces CORS preflight; simple cross-site forms cannot set it. */
function requireClientHeader(req, res, next) {
  if ((req.headers[API_CLIENT_HEADER] || "") !== API_CLIENT_VALUE) {
    return res.status(403).json({ error: "Forbidden", code: "forbidden" });
  }
  next();
}

/* ══════════════════════════════════════════════
   /api/mailbox/file — a photo or file that waits
══════════════════════════════════════════════

   A waiting message can be a photo or a file (see mailbox.js). The device
   seals it (protocol.js, sealMailFile), sends it here first, then the
   message that describes it over the link, as any other (mail-drop, with
   `file: true`). The other device fetches it when it takes that message, and
   it goes with the message once they say they have it.

   Named by the pair's mailbox, the side it is for and the message's id, in
   MAIL_FILE_HEADER — knowing the room name is the way in, as for meeting and
   for messages. The
   bytes are sealed: whoever holds the name could fill the mailbox, not read
   it. Written straight to disk as they come, never held in memory, and
   counted: one that is longer than it said is cut off. */
const MAIL_FILE_WINDOW_MS = 10 * 60 * 1000;
const MAIL_FILE_PUT_MAX   = 40;
const MAIL_FILE_GET_MAX   = 200;
const MAIL_FILES_AT_ONCE  = 3;
const mailFilePutHits = new Map();
const mailFileGetHits = new Map();
const mailFilesComing = new Set();   // `${box}:${to}:${id}` being written now
setInterval(() => {
  pruneExpired(mailFilePutHits, MAIL_FILE_WINDOW_MS);
  pruneExpired(mailFileGetHits, MAIL_FILE_WINDOW_MS);
}, 60_000).unref();

/** "box:side:id[:size]", as MAIL_FILE_HEADER says it. */
function mailFileNamed(req) {
  const [box, side, id, size] = String(req.headers[MAIL_FILE_HEADER] || "").split(":");
  return { box, side, id, size: size === undefined ? NaN : Number(size) };
}

app.post("/api/mailbox/file", requireClientHeader, (req, res) => {
  const { box, side: to, id, size } = mailFileNamed(req);
  const refuse = (status, code) => { if (!res.headersSent) res.status(status).json({ code }); };
  if (!fileAddressValid(box, to, id) || !Number.isSafeInteger(size)) return refuse(400, "invalid");
  if (req.headers["content-length"] !== undefined && Number(req.headers["content-length"]) !== size) return refuse(400, "invalid");
  const here = mail.fileHere(box, to, id);
  if (here) return here === size ? res.json({ ok: true }) : refuse(409, "invalid");   // sent before the answer was lost
  const room = mail.fileRoom(box, to, size);
  if (room !== "ok") return refuse({ "off": 503, "too-large": 413 }[room] || 507, room);
  if (!slidingAllow(mailFilePutHits, getClientIp(req), MAIL_FILE_PUT_MAX, MAIL_FILE_WINDOW_MS)) return refuse(429, "too-many");
  const coming = `${box}:${to}:${id}`;
  if (mailFilesComing.size >= MAIL_FILES_AT_ONCE || mailFilesComing.has(coming)) {
    res.setHeader("Retry-After", "10");
    return refuse(503, "busy");
  }
  mailFilesComing.add(coming);
  const target = mail.fileTarget(box, to, id);
  let got = 0;
  const count = new Transform({
    transform(chunk, _enc, done) {
      got += chunk.length;
      done(got > size ? Object.assign(new Error("longer than it said"), { code: "too-long" }) : null, chunk);
    }
  });
  pipeline(req, count, fs.createWriteStream(target.part, { mode: 0o600 }), err => {
    const fail = (status, code) => { mailFilesComing.delete(coming); fs.rm(target.part, { force: true }, () => {}); refuse(status, code); };
    if (err || got !== size) return fail(err && err.code === "too-long" ? 413 : 400, "upload-failed");
    fs.rename(target.part, target.path, renameErr => {
      if (renameErr) return fail(500, "upload-failed");
      mailFilesComing.delete(coming);
      mail.fileStored(box, to, id, size);
      res.json({ ok: true });
    });
  });
});

app.get("/api/mailbox/file", requireClientHeader, (req, res) => {
  if (!slidingAllow(mailFileGetHits, getClientIp(req), MAIL_FILE_GET_MAX, MAIL_FILE_WINDOW_MS)) {
    return res.status(429).json({ code: "too-many" });
  }
  const { box, side, id } = mailFileNamed(req);
  const found = mail.fileFor(box, side, id);
  if (!found) return res.status(404).json({ code: "gone" });
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", String(found.size));
  res.setHeader("Cache-Control", "no-store");
  pipeline(fs.createReadStream(found.path), res, () => {});
});

app.use((err, req, res, next) => {
  /* Anything reaching here is a bug in a handler. Answer generically rather
     than calling next(err): Express's default handler replies with the stack
     trace unless NODE_ENV is production, which is not guaranteed to be set. */
  console.error("Unhandled request error:", (err && err.stack) || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Server error", code: "server-error" });
});

/* ══════════════════════════════════════════════
   PIN BRUTE-FORCE PROTECTION
   ─────────────────────────────────────────────
   Per-IP tracking:
     - up to MAX_ATTEMPTS wrong PINs before lockout
     - lockout duration: LOCKOUT_MS
     - successful join clears the counter for that IP
     - entries pruned every minute to prevent memory growth
══════════════════════════════════════════════ */

const MAX_ATTEMPTS = 3;
const LOCKOUT_MS   = 30_000;  // 30 seconds

/** Per-IP failed join (wrong PIN/token). ip → { count, lockedUntil, lastFailAt } */
const joinAttempts = new Map();

const SESSION_JOIN_FAIL_WINDOW_MS = 10 * 60 * 1000; // 10 min
const SESSION_JOIN_FAIL_MAX       = 15;           // failures from any IP before room lock
const SESSION_JOIN_LOCK_MS        = 5 * 60 * 1000;  // 5 min room-level join lock

/**
 * Returns { allowed: true } or { allowed: false, remaining: seconds }.
 */
function rateLimitCheck(ip) {
  const now = Date.now();
  const entry = joinAttempts.get(ip);
  if (!entry) return { allowed: true };
  if (entry.lockedUntil && entry.lockedUntil > now) {
    return { allowed: false, remaining: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  return { allowed: true };
}

/**
 * Records a failed PIN attempt. Returns remaining attempts before lockout.
 * Returns 0 when just locked out.
 */
function rateLimitFail(ip) {
  const now = Date.now();
  const entry = joinAttempts.get(ip) || { count: 0, lockedUntil: 0, lastFailAt: now };
  entry.lastFailAt = now;
  entry.count++;
  const remaining = MAX_ATTEMPTS - entry.count;
  if (remaining <= 0) {
    entry.lockedUntil = now + LOCKOUT_MS;
    console.log(`Rate-limited IP ${ipLogId(ip)} for ${LOCKOUT_MS / 1000}s`);
  }
  joinAttempts.set(ip, entry);
  return Math.max(0, remaining);
}

/** Clears rate-limit state on successful join. */
function rateLimitClear(ip) {
  joinAttempts.delete(ip);
}

/* Prune stale per-IP join state (do not wipe in-progress counters). */
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of joinAttempts) {
    if (entry.lockedUntil && entry.lockedUntil > now) continue;
    if (entry.lockedUntil && entry.lockedUntil <= now) {
      joinAttempts.delete(ip);
      continue;
    }
    if (!entry.lockedUntil && entry.lastFailAt && now - entry.lastFailAt > 60 * 60 * 1000) {
      joinAttempts.delete(ip);
    }
  }
}, 60_000);

/* ══════════════════════════════════════════════
   WEBSOCKET — signaling
══════════════════════════════════════════════ */

const sessions = new Map();

/* ── A host whose link drops ─────────────────
   To send the link, the host switches to a messaging app; the phone pauses
   the page, and an iPhone cuts its link to the server almost at once. The room
   used to be deleted on the spot, so the link the friend received was dead by
   the time they tapped it. A room still waiting for its guest is now kept for
   HOST_AWAY_MS with no host, and the host takes it back on returning by
   presenting its host key — a secret only the host's page was given, never put
   in a link (reclaim-session). Leaving on purpose still closes it at once. */
const HOST_AWAY_MS = (() => {
  const parsed = parseInt(process.env.HOST_AWAY_MS || "", 10);
  if (Number.isFinite(parsed) && parsed >= 1000 && parsed <= 3_600_000) return parsed;
  return 10 * 60 * 1000;
})();

/** The host's link dropped and it has not come back in time. */
function hostAwayExpired(session, now = Date.now()) {
  return !session.host && now - session.hostAwaySince > HOST_AWAY_MS;
}

/* ── A seat kept for a page whose link dropped ──
   Reported, assessing why calls did not survive a phone changing networks:
   a room was deleted the moment either side's link to this server dropped
   mid-chat, and nothing could bring it back. Every repair of the chat's own
   link goes through the room, so after that blink nothing could be repaired.

   Now a dropped link — a network change, a locked screen, a blip — keeps the
   seat for the page to take back (rejoin-session for a guest, with the guest
   key it was given on joining; reclaim-session for a host, with its host key,
   as a waiting room's host already could). The other side is told
   (peer-away / peer-back), so it waits for the way to be repaired rather than
   giving up. Leaving on purpose (leave-session) still ends the room at once.
   A seat nobody comes back for goes after HOST_AWAY_MS, as before. */
function markAway(sessionId, session, side) {
  const now = Date.now();
  if (side === "host") { session.host = null;  session.hostAwaySince  = now; }
  else                 { session.guest = null; session.guestAwaySince = now; }
  const timer = `${side}AwayTimer`;
  clearTimeout(session[timer]);
  session[timer] = setTimeout(() => expireAway(sessionId, side), HOST_AWAY_MS + 100);
  if (session[timer].unref) session[timer].unref();
}

/** Nobody came back for the seat: the room goes — or, for a code room's
    guest, the seat opens to the next person, as when a guest leaves one. */
function expireAway(sessionId, side) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (side === "host" ? (session.host || !session.hostAwaySince) : (session.guest || !session.guestAwaySince)) return;   // came back
  if (side === "host") { dropSession(sessionId, session); broadcastSessionList(); return; }
  session.guestAwaySince = 0;
  session.guestKey = null;
  if (session.kind === "code" && session.host) { session.paired = false; freeGuestSeat(sessionId, session); return; }
  if (session.host && session.host.readyState === WebSocket.OPEN) {
    session.host.send(JSON.stringify({ type: "peer-disconnected", sessionId }));
  }
  clearTimeout(session.hostAwayTimer);
  removeSession(sessionId);
  console.log(`Session ${sessionLogId(sessionId)} removed — its guest did not come back`);
  broadcastSessionList();
}

/** Tells whoever is still there that the other side's link is back, or gone for now. */
function tellOther(session, from, type, sessionId) {
  const other = from === "host" ? session.guest : session.host;
  if (other && other.readyState === WebSocket.OPEN) other.send(JSON.stringify({ type, sessionId }));
}

/** Deletes a room, telling its guest if there is one. */
function dropSession(sessionId, session) {
  if (session.guest && session.guest.readyState === WebSocket.OPEN) {
    session.guest.send(JSON.stringify({ type: "peer-disconnected", sessionId }));
  }
  clearTimeout(session.hostAwayTimer);
  clearTimeout(session.guestAwayTimer);
  removeSession(sessionId);
  console.log(`Session ${sessionLogId(sessionId)} removed`);
}

/** Every room goes through here, so a saved person's open lobby always
    hears that nobody waits for it any more (tellSavedWaiting). */
function removeSession(sessionId) {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  if (session) tellSavedWaiting(sessionId, session, false);
}

/* ── Someone waiting for a saved person ─────
   Asked for: when someone taps a saved person's name and waits, that
   person's lobby should show it on their name. The knock's notification was
   easy to miss with the app open, and with alerts off there was none. Their
   page, while open, already asks after the pair's mailbox under the room's
   own name and the side it is (mail-fetch), so it is told there — nothing
   the server did not know: meet-waiting, true while someone waits in the
   room for them, false once nobody does. */
function tellSavedWaiting(sessionId, session, waiting) {
  if (!session || session.kind !== "saved") return;
  const forSide = session.hostSide === "a" ? "b" : "a";
  for (const l of mailListeners.get(`${sessionId}:${forSide}`) || []) {
    if (l.readyState === WebSocket.OPEN) l.send(JSON.stringify({ type: "meet-waiting", room: sessionId, waiting }));
  }
}

/** Someone is in it waiting for the other side — here or with its link
    dropped for a moment — and nobody has come. */
function savedRoomWaiting(session) {
  return Boolean(session) && session.kind === "saved" && !session.guest && !session.guestAwaySince &&
    Boolean(session.host || session.hostAwaySince);
}
/** Unknown message types logged per socket before going quiet. */
const UNKNOWN_TYPE_LOG_MAX = 5;
const SESSION_ID_MAX = 80;
const SESSION_ID_PATTERN = /^[\p{L}\p{N} _.:~-]+$/u;

function isValidSessionId(sessionId) {
  return typeof sessionId === "string" &&
    sessionId.trim() === sessionId &&
    sessionId.length > 0 &&
    sessionId.length <= SESSION_ID_MAX &&
    SESSION_ID_PATTERN.test(sessionId);
}

/** The room two people who saved each other meet in: "~" and a SHA-256 of
    the secret only their two devices hold (savedRoomName in protocol.js).
    No room made by name may take one — see create-session. */
const SAVED_ROOM_PATTERN = /^~[A-Za-z0-9_-]{43}$/;

function isSavedRoomId(sessionId) {
  return typeof sessionId === "string" && SAVED_ROOM_PATTERN.test(sessionId);
}

function sessionLogId(sessionId) {
  return crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 10);
}

function ipLogId(ip) {
  return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 10);
}


function publicSessions() {
  if (!PUBLIC_SESSION_LIST) return [];
  return Array.from(sessions)
    .filter(([, s]) => !s.guest && !s.guestAwaySince && !hostAwayExpired(s))   // a seat kept for a guest is not free
    .filter(([, s]) => s.kind !== "saved")       // two saved people's room is theirs: never listed
    /* `open` lets the lobby show which rooms can be entered without a PIN, and
       skip the PIN dialog for them. It gives nothing away: the server answers
       the same question for anyone who tries the door. */
    .map(([sessionId, s]) => ({ sessionId, createdAt: s.createdAt, open: s.open === true, kind: s.kind || "pin" }));
}

const listSessionsHits   = new Map();
const createSessionHits  = new Map();
const LIST_SESSIONS_WINDOW_MS  = 60_000;
const LIST_SESSIONS_MAX        = 40;
const CREATE_SESSION_WINDOW_MS = 10 * 60 * 1000;
const CREATE_SESSION_MAX       = 10;
const knockHits          = new Map();
const KNOCK_WINDOW_MS    = 10 * 60 * 1000;
const KNOCK_MAX          = 30;
const KNOCK_ROOM_GAP_MS  = 20_000;     // one knock per room in this long
const mailDropHits       = new Map();
const MAIL_DROP_WINDOW_MS = 10 * 60 * 1000;
const MAIL_DROP_MAX      = 60;
const mailFetchHits      = new Map();
/* Notes for the owner, from one network: fewer than messages between two
   people who saved each other — anyone can leave one. */
const noteHits           = new Map();
const NOTE_WINDOW_MS     = 10 * 60 * 1000;
const NOTE_MAX           = 10;
const MAIL_FETCH_WINDOW_MS = 60_000;
const MAIL_FETCH_MAX     = 30;
const MAIL_KNOCK_GAP_MS  = 60_000;     // "a message waits" once a minute per mailbox
const mailKnockedAt      = new Map();
/* A page told a message waits asks for it at once. One that has not within
   this long is not really there — a locked phone, a page gone whose link has
   not yet been noticed closed — and its device is alerted instead. */
const MAIL_ANSWER_MS     = 4000;
const mailFetchedAt      = new Map();  // `${box}:${side}` → when last asked after
/* The links that asked after a mailbox, told the moment a message arrives
   for it: `${box}:${side}` → links. */
const mailListeners      = new Map();

/* joinAttempts has a sweep above; these were
   missed, and without one they keep an entry per address seen since startup.
   See ratelimit.js — pruneExpired explains why slidingAllow cannot do it. */
setInterval(() => {
  pruneExpired(listSessionsHits, LIST_SESSIONS_WINDOW_MS);
  pruneExpired(createSessionHits, CREATE_SESSION_WINDOW_MS);
  pruneExpired(knockHits, KNOCK_WINDOW_MS);
  pruneExpired(mailDropHits, MAIL_DROP_WINDOW_MS);
  pruneExpired(mailFetchHits, MAIL_FETCH_WINDOW_MS);
  pruneExpired(noteHits, NOTE_WINDOW_MS);
  for (const [box, at] of mailKnockedAt) if (Date.now() - at > MAIL_KNOCK_GAP_MS) mailKnockedAt.delete(box);
  for (const [key, at] of mailFetchedAt) if (Date.now() - at > 60_000) mailFetchedAt.delete(key);
}, 60_000);

function recordSessionJoinFailure(sessionId, session) {
  const now = Date.now();
  if (!session.failedJoinWindowStart || now - session.failedJoinWindowStart > SESSION_JOIN_FAIL_WINDOW_MS) {
    session.failedJoinWindowStart = now;
    session.failedJoinCount = 0;
  }
  session.failedJoinCount++;
  if (session.failedJoinCount >= SESSION_JOIN_FAIL_MAX) {
    session.joinLockedUntil = now + SESSION_JOIN_LOCK_MS;
    console.log(`Session ${sessionLogId(sessionId)} join-locked ${SESSION_JOIN_LOCK_MS / 1000}s`);
  }
}

function generatePin() {
  return String(crypto.randomInt(100000, 1000000));
}

function generateToken() {
  return crypto.randomBytes(24).toString("base64url");
}

/** Compares a PIN or token in constant time. A correct token is admitted even
    while the join locks are on (see joinVerdict), so nothing limits how often
    one may be tried — which makes this a comparison that must not leak how
    close a wrong value came. */
function secretMatches(expected, supplied) {
  /* An open room has no PIN at all — `expected` is null there, and null must
     match nothing rather than throw. */
  if (typeof expected !== "string" || typeof supplied !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** A page's key for one create: random, its own, and only ever sent with
    that create (see create-session). Anything else is taken as none. */
function isCreateKey(key) {
  return typeof key === "string" && /^[A-Za-z0-9_-]{22,64}$/.test(key);
}

/** A create sent again for a room this server already made for it: the same
    room, answered as the first create would have been — and a guest who
    arrived while the host was away introduced now, as when a host takes its
    room back (reclaim-session). `restart`: the guest was in a chat with an
    earlier copy of this host, which is over; it starts again with this one. */
function adoptRoom(ws, sessionId, session, { restart = false } = {}) {
  if (session.host !== ws) cleanupClient(ws);    // one room per socket
  session.host = ws;
  session.hostAwaySince = 0;
  clearTimeout(session.hostAwayTimer);
  session.waitingSince = Date.now();
  const { pin, token, hostKey, open, kind } = session;
  ws.send(JSON.stringify({ type: "session-created", sessionId, pin, token, hostKey, open, kind }));
  if (session.guest?.readyState === WebSocket.OPEN) {
    session.guest.send(JSON.stringify({ type: "host-back", sessionId, ...(restart ? { restart: true } : {}) }));
    ws.send(JSON.stringify({ type: "guest-joined", sessionId }));
    session.paired = true;
  }
  broadcastSessionList();
  console.log(`Session ${sessionLogId(sessionId)} create sent again: the same room`);
}

function broadcastSessionList() {
  const list = publicSessions();

  const msg = JSON.stringify({ type: "session-list", sessions: list });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

/* Every message about a room says which room. A client that could not tell had
   to assume its current one, and was wrong whenever it had moved on. */

/** Removes every room this socket is part of and tells whoever is left in it.
    Also what enforces one room per socket: creating or joining calls it first. */
function cleanupClient(ws, { dropped = false } = {}) {
  for (const [sessionId, session] of sessions) {
    /* The host's link dropped — not a leave: keep the room, for the host to
       take back (see HOST_AWAY_MS). A room still waiting for its guest always
       was kept; one with a chat in it now is too, and the guest is told. */
    if (dropped && session.host === ws) {
      markAway(sessionId, session, "host");
      if (session.paired) tellOther(session, "host", "peer-away", sessionId);
      console.log(`Session ${sessionLogId(sessionId)} host away`);
      continue;
    }
    /* A guest in a chat whose link dropped: its seat is kept for it to take
       back with its guest key, and the host is told. */
    if (dropped && session.guest === ws && session.paired) {
      markAway(sessionId, session, "guest");
      tellOther(session, "guest", "peer-away", sessionId);
      console.log(`Session ${sessionLogId(sessionId)} guest away`);
      continue;
    }
    /* A guest leaving a room whose host is away: nobody to tell, and the room
       is still the host's — free the seat. */
    if (session.guest === ws && !session.host) {
      session.guest = null;
      session.paired = false;
      session.guestKey = null;
      session.waitingSince = Date.now();
      if (savedRoomWaiting(session)) tellSavedWaiting(sessionId, session, true);
      broadcastSessionList();
      continue;
    }
    /* A code room outlives its guest. Admission to one is first-come — the
       word is proven afterwards, between the two browsers — so anyone can take
       the seat, and leaving used to delete the room: one wrong guess, or one
       stranger joining and leaving, and the room was gone, the right word with
       it. Now the seat is freed and the host told; the host knows whether a
       chat just ended or an attempt failed, and says which (guest-left). */
    if (session.kind === "code" && session.guest === ws) {
      freeGuestSeat(sessionId, session);
      continue;
    }
    if (session.host === ws || session.guest === ws) {
      const other = session.host === ws ? session.guest : session.host;
      if (other && other.readyState === WebSocket.OPEN) {
        other.send(JSON.stringify({ type: "peer-disconnected", sessionId }));
      }
      removeSession(sessionId);
      console.log(`Session ${sessionLogId(sessionId)} removed`);
      broadcastSessionList();
    }
  }
}

/** Empties a code room's seat and opens it to the next guest. The host is
    told; the guest, if still connected, already knows — it left, or was
    turned away (release-guest). */
function freeGuestSeat(sessionId, session) {
  session.guest = null;
  session.paired = false;
  session.guestKey = null;
  session.guestAwaySince = 0;
  clearTimeout(session.guestAwayTimer);
  session.waitingSince = Date.now();     // the ten minutes to find a guest start again
  if (session.host && session.host.readyState === WebSocket.OPEN) {
    session.host.send(JSON.stringify({ type: "guest-left", sessionId }));
  }
  broadcastSessionList();
}

function relayToOther(ws, sessionId, payload) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (ws !== session.host && ws !== session.guest) return;
  const other = ws === session.host ? session.guest : session.host;
  if (other && other.readyState === WebSocket.OPEN) {
    other.send(JSON.stringify(payload));
  }
}

wss.on("connection", (ws, req) => {
  const clientIp = getClientIp(req);

  ws.clientIp = clientIp;
  wsOpenByIp.set(clientIp, (wsOpenByIp.get(clientIp) || 0) + 1);
  ws.once("close", () => {
    const left = (wsOpenByIp.get(clientIp) || 1) - 1;
    if (left > 0) wsOpenByIp.set(clientIp, left);
    else wsOpenByIp.delete(clientIp);
  });
  /* Heartbeat state — reset by every pong; see the sweep below. Browsers answer
     protocol-level pings automatically, so no client-side change is needed. */
  ws.isAlive  = true;
  ws.on("pong", () => { ws.isAlive = true; });
  console.log(`Client connected ${ipLogId(clientIp)} | sessions: ${sessions.size}`);

  /* Said first, on every connection — including the reconnect every open page
     makes a few seconds after this process restarts for an update. That is the
     moment a page left open finds out it is old. */
  /* With it, a word for this connection alone: the owner's device signs it
     to show it is the owner's (owner-hello). */
  ws.ownerNonce = crypto.randomBytes(16).toString("base64url");
  ws.send(JSON.stringify({ type: "hello", ...(CLIENT_BUILD ? { build: CLIENT_BUILD } : {}), nonce: ws.ownerNonce }));

  ws.on("close", () => {
    console.log(`Client disconnected ${ipLogId(clientIp)}`);
    cleanupClient(ws, { dropped: true });
    for (const key of ws.mailKeys || []) {
      const set = mailListeners.get(key);
      if (set) { set.delete(ws); if (!set.size) mailListeners.delete(key); }
    }
  });
  ws.on("error", (e) => { console.error("WS error:", e); cleanupClient(ws, { dropped: true }); });

  /* Nothing catches what a "message" listener throws: it becomes an uncaught
     exception and Node ends the process, taking every room and every call with
     it. The four characters `null` did exactly that — see handleMessage. This
     is the backstop for whichever input nobody has thought of yet, the same job
     the error handler does for the HTTP side. */
  ws.on("message", (raw) => {
    try {
      handleMessage(raw);
    } catch (err) {
      console.error(`Message handler error for ${ipLogId(clientIp)}:`, (err && err.stack) || err);
    }
  });

  function handleMessage(raw) {
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    /* Parsing succeeding does not make it a message. `null`, `7`, `"x"` and
       `[]` are all valid JSON, and reading `.type` off null throws. */
    if (data === null || typeof data !== "object" || Array.isArray(data)) return;
    console.log(`MSG ${ipLogId(clientIp)}: ${safeLabel(data.type)}`);

    switch (data.type) {

      /* ── List sessions ──────────────────────── */
      case "list-sessions": {
        if (!slidingAllow(listSessionsHits, clientIp, LIST_SESSIONS_MAX, LIST_SESSIONS_WINDOW_MS)) {
          ws.send(JSON.stringify({ type: "session-list", sessions: [], throttled: true }));
          break;
        }
        ws.send(JSON.stringify({ type: "session-list", sessions: publicSessions() }));
        nudgePageTooOldToUpdateItself(ws);
        break;
      }

      /* A current page introducing itself. The build it names is not used for
         anything — saying hello at all is the signal. */
      case "hello":
        ws.saidHello = true;
        break;

      /* ── Create session ─────────────────────── */
      case "create-session": {
        /* A saved person's room's name is not one to make a room under: that
           room is made only by meeting (meet-session), never listed, never
           with a PIN. */
        if (!isValidSessionId(data.sessionId) || isSavedRoomId(data.sessionId)) {
          ws.send(JSON.stringify({ type: "error", code: "invalid-name", message: "Invalid session name" }));
          break;
        }
        /* The same create again — sent once more because the link dropped
           before the answer came back, after this server had made the room.
           That used to be refused as "name taken": the page's own room, kept
           for a host whose link dropped (HOST_AWAY_MS), blocked its name, and
           the page had no host key to take it back with. A create carries a
           key of its own (createKey); the same key gets the same room, and
           its answer, again. Not counted as a new room. */
        {
          const found = sessions.get(data.sessionId);
          if (found && hostAwayExpired(found)) dropSession(data.sessionId, found);
        }
        const existing = sessions.get(data.sessionId);
        if (existing) {
          if (isCreateKey(data.createKey) && existing.paired !== true && secretMatches(existing.createKey, data.createKey)) {
            adoptRoom(ws, data.sessionId, existing);
            break;
          }
          ws.send(JSON.stringify({ type: "error", code: "name-taken", message: "Session name is already in use" }));
          break;
        }
        if (!slidingAllow(createSessionHits, clientIp, CREATE_SESSION_MAX, CREATE_SESSION_WINDOW_MS)) {
          ws.send(JSON.stringify({ type: "error", code: "too-many-rooms", message: "Too many rooms created from this network. Try again later." }));
          break;
        }
        /* One room per socket. A browser that opened a room and then opened
           another used to keep hosting both: the first stayed listed with
           nobody behind it, a guest who joined it waited on a host that was
           elsewhere, and when it expired the notice ended the chat in the
           second. Opening a room now lets go of the previous one. */
        cleanupClient(ws);
        /* Three kinds of room. "pin" is the default and stays the default for
           anything not spelled out — a room must never change kind by accident.
           "open" admits the first person with no secret at all. "code" admits
           the first person too, but the two of them then prove a secret word to
           each other with SPAKE2 (see pake.js); the server never sees that word,
           so for admission a code room behaves exactly like an open one.
           Both open and code get a token, for the invite link. */
        const kind = data.code === true ? "code" : (data.open === true ? "open" : "pin");
        const open = kind === "open" || kind === "code";   // admission: first come
        const pin  = kind === "pin" ? generatePin() : null;
        const token = generateToken();
        const hostKey = generateToken();     // the host's alone: never in a link
        sessions.set(data.sessionId, {
          host: ws, guest: null, offer: null,
          kind, open, pin, token, hostKey, createdAt: Date.now(), hostAwaySince: 0,
          createKey: isCreateKey(data.createKey) ? data.createKey : null,   // the same create, if sent again
          joinLockedUntil: 0,
          failedJoinWindowStart: 0,
          failedJoinCount: 0
        });
        ws.send(JSON.stringify({ type: "session-created", sessionId: data.sessionId, pin, token, hostKey, open, kind }));
        broadcastSessionList();
        console.log(`Session ${sessionLogId(data.sessionId)} created`);
        break;
      }

      /* ── Join session ───────────────────────── */
      case "join-session": {
        const ip = ws.clientIp;

        /* 1. Session lookup — unknown rooms do not affect per-IP join counters */
        {
          const away = sessions.get(data.sessionId);
          if (away && hostAwayExpired(away)) dropSession(data.sessionId, away);
        }
        const session = sessions.get(data.sessionId);
        /* A saved person's room is entered only by meeting there, and only
           the two who saved each other can name it: to a join, it is not here. */
        if (!session || session.kind === "saved") {
          console.log(`Session lookup failed from ${ipLogId(ip)}`);
          ws.send(JSON.stringify({
            type: "pin-error",
            code: "not-found",
            message: "Session not found — it may have expired."
          }));
          break;
        }

        /* 2. Your own room. Its name is in the lobby list like any other, and
           the PIN is on your screen, so this is one click away. It used to be
           admitted, which left one browser negotiating with itself. */
        if (session.host === ws) {
          ws.send(JSON.stringify({
            type: "pin-error",
            code: "own-room",
            message: "This is the room you created."
          }));
          break;
        }

        /* 3. A room-level lock that has run its course */
        if (session.joinLockedUntil && session.joinLockedUntil <= Date.now()) {
          session.joinLockedUntil = 0;
          session.failedJoinCount = 0;
          session.failedJoinWindowStart = 0;
        }

        /* 4. Decide. Which lock applies to which credential is joinVerdict's
           job — see ratelimit.js. The short of it: the locks are there to slow
           PIN guessing, so a correct invite token is not held to them. */
        const rl = rateLimitCheck(ip);
        const tokenOk = secretMatches(session.token, data.token);
        const verdict = joinVerdict({
          open:         session.open === true,
          tokenOk,
          pinOk:        typeof data.pin === "string" && /^\d{6}$/.test(data.pin) && secretMatches(session.pin, data.pin),
          noCredential: typeof data.pin !== "string" && typeof data.token !== "string",
          /* A seat kept for a guest whose link dropped is still taken. */
          full:         Boolean(session.guest) || session.guestAwaySince > 0,
          /* Taken through the link — by another socket. The same socket asking
             twice is not a second copy of anything, and "replacing" it would
             run cleanupClient on the room's own guest and delete the room. */
          seatByLink:   session.guestByLink === true && session.guest !== ws,
          /* Whether anyone is looking at the page asking. Only such a copy may
             take a seat from another — see joinVerdict. */
          visible:      data.visible === true,
          roomLocked:   session.joinLockedUntil > Date.now(),
          ipLimited:    !rl.allowed
        });

        /* Arrived with nothing to show, at a room that wants a PIN. Not a guess,
           so nothing is counted — the client just asks for the PIN. */
        if (verdict === "pin-required") {
          ws.send(JSON.stringify({
            type: "pin-error",
            code: "pin-required",
            sessionId: data.sessionId,
            message: "This room needs a PIN."
          }));
          break;
        }

        if (verdict === "room-locked") {
          const rem = Math.ceil((session.joinLockedUntil - Date.now()) / 1000);
          ws.send(JSON.stringify({
            type: "pin-error",
            code: "session-join-locked",
            remaining: rem,
            message: `Too many failed join attempts for this room. Try again in ${rem}s.`
          }));
          break;
        }

        if (verdict === "full") {
          ws.send(JSON.stringify({
            type: "pin-error",
            code: "full",
            message: "Session is full"
          }));
          break;
        }

        if (verdict === "held-elsewhere") {
          ws.send(JSON.stringify({
            type: "pin-error",
            code: "held-elsewhere",
            sessionId: data.sessionId,
            message: "This link is open in another browser."
          }));
          break;
        }

        if (verdict === "ip-limited") {
          ws.send(JSON.stringify({
            type: "pin-error",
            code: "rate-limited",
            remaining: rl.remaining,
            message: `Too many attempts. Try again in ${rl.remaining}s.`
          }));
          break;
        }

        if (verdict === "wrong") {
          recordSessionJoinFailure(data.sessionId, session);
          const left = rateLimitFail(ip);
          if (left === 0) {
            ws.send(JSON.stringify({
              type: "pin-error",
              code: "rate-limited",
              remaining: Math.ceil(LOCKOUT_MS / 1000),
              message: `Too many attempts. Try again in ${Math.ceil(LOCKOUT_MS / 1000)}s.`
            }));
          } else {
            ws.send(JSON.stringify({
              type: "pin-error",
              code: "wrong-pin",
              attemptsLeft: left,
              message: `Wrong PIN. ${left} attempt(s) remaining.`
            }));
          }
          break;
        }

        /* 5. Admitted — clear the limits and let go of any room this socket was
           already in. One room per socket; see create-session. */
        rateLimitClear(ip);
        cleanupClient(ws);
        session.joinLockedUntil = 0;
        session.failedJoinCount = 0;
        session.failedJoinWindowStart = 0;
        /* The same link, opened again in another browser: the seat moves to
           the newer copy. The room is kept — the guest has not left, only
           changed browsers — and the copy left behind is told, so it stops
           rather than joining again and taking the seat back. Once it is no
           longer the guest, its socket closing ends nothing. */
        const replaced = verdict === "replace" ? session.guest : null;
        session.guest = ws;
        session.guestByLink = tokenOk;
        /* A seat kept for a copy whose link had dropped is taken over too:
           that copy's key no longer brings it back. */
        session.guestAwaySince = 0;
        clearTimeout(session.guestAwayTimer);
        /* This guest's alone, to take the seat back with if its link drops —
           never in a link, never shown. */
        session.guestKey = generateToken();
        if (replaced && replaced.readyState === WebSocket.OPEN) {
          replaced.send(JSON.stringify({ type: "seat-taken", sessionId: data.sessionId }));
        }
        /* A host who is away hears of the guest when it takes the room back;
           the guest is told to wait meanwhile. */
        const hostHere = session.host?.readyState === WebSocket.OPEN;
        session.paired = hostHere;          // the host knows this guest: a chat, not a wait
        ws.send(JSON.stringify({ type: "session-joined", sessionId: data.sessionId, hostAway: !hostHere, guestKey: session.guestKey }));
        if (hostHere) {
          session.host.send(JSON.stringify({ type: "guest-joined", sessionId: data.sessionId, replaced: verdict === "replace" }));
        }
        broadcastSessionList();
        console.log(`Session ${sessionLogId(data.sessionId)} guest joined from ${ipLogId(ip)}`);
        break;
      }

      /* ── Meeting a saved person ─────────────────
         Two people who saved each other meet in a room named by a hash of a
         secret only their two devices hold (see "Saved people" in the
         README). Either may come first, so one message does both: the first
         makes the room and waits in it, the second joins — two taps at once
         cannot both make it. Never listed, no PIN, no token, no link: the
         name is the way in, and only those two devices can work it out. The
         secret itself is then proven between them, so even a server that took
         the seat could not read or join the chat.

         Each device says which side of the pair it is ("a" or "b"). The same
         side again — another tab, a reload, a page the phone closed — is a
         newer copy, and takes that side's seat, as a link opened again does;
         the copy left behind is told (seat-taken). */
      case "meet-session": {
        const sessionId = data.sessionId;
        const side = data.side;
        if (!isSavedRoomId(sessionId) || (side !== "a" && side !== "b")) {
          ws.send(JSON.stringify({ type: "error", code: "invalid-name", message: "Invalid session name" }));
          break;
        }
        {
          const found = sessions.get(sessionId);
          if (found && hostAwayExpired(found)) dropSession(sessionId, found);
        }
        const room = sessions.get(sessionId);

        /* First here: make the room and wait in it. */
        if (!room) {
          if (!slidingAllow(createSessionHits, clientIp, CREATE_SESSION_MAX, CREATE_SESSION_WINDOW_MS)) {
            ws.send(JSON.stringify({ type: "error", code: "too-many-rooms", message: "Too many rooms created from this network. Try again later." }));
            break;
          }
          cleanupClient(ws);                   // one room per socket
          const hostKey = generateToken();     // to take the room back if this link drops
          sessions.set(sessionId, {
            host: ws, guest: null, offer: null,
            kind: "saved", open: false, pin: null, token: null, hostKey, hostSide: side,
            createdAt: Date.now(), hostAwaySince: 0, createKey: null,
            joinLockedUntil: 0, failedJoinWindowStart: 0, failedJoinCount: 0
          });
          ws.send(JSON.stringify({ type: "session-created", sessionId, pin: null, token: null, hostKey, open: false, kind: "saved" }));
          tellSavedWaiting(sessionId, sessions.get(sessionId), true);   // their lobby, if open, shows it on our name
          console.log(`Session ${sessionLogId(sessionId)} made for a saved person`);
          break;
        }
        if (room.kind !== "saved") {
          ws.send(JSON.stringify({ type: "error", code: "name-taken", message: "Session name is already in use" }));
          break;
        }
        /* A link already seated here does not change sides. */
        if (room.guest === ws || (room.host === ws && side !== room.hostSide)) break;

        /* The waiting side, again. Its newest copy hosts; one still open is
           told it no longer does. If the chat the old copy was in is over —
           the other side starts again with this one; if that side's own link
           is down too, its seat goes, since the chat it would take back is
           gone. */
        if (side === room.hostSide) {
          if (room.host && room.host !== ws && room.host.readyState === WebSocket.OPEN) {
            room.host.send(JSON.stringify({ type: "seat-taken", sessionId }));
          }
          const restart = room.paired === true && room.host !== ws;
          if (restart && room.guest?.readyState !== WebSocket.OPEN) {
            room.guest = null;
            room.guestAwaySince = 0;
            room.guestKey = null;
            clearTimeout(room.guestAwayTimer);
            room.paired = false;
          }
          adoptRoom(ws, sessionId, room, { restart });
          if (savedRoomWaiting(room)) tellSavedWaiting(sessionId, room, true);
          break;
        }

        /* The other side: into the seat. A copy of it there before — another
           tab, or one whose link dropped — gives the seat up to this one, and
           the host starts again. */
        const replaced = room.guest;
        const hadGuest = Boolean(replaced) || room.guestAwaySince > 0;
        cleanupClient(ws);                     // one room per socket
        room.guest = ws;
        room.guestAwaySince = 0;
        clearTimeout(room.guestAwayTimer);
        room.guestKey = generateToken();       // to take the seat back if this link drops
        if (replaced && replaced.readyState === WebSocket.OPEN) {
          replaced.send(JSON.stringify({ type: "seat-taken", sessionId }));
        }
        tellSavedWaiting(sessionId, room, false);  // come: nobody waits now, on any of its devices
        const hostHere = room.host?.readyState === WebSocket.OPEN;
        room.paired = hostHere;
        ws.send(JSON.stringify({ type: "session-joined", sessionId, hostAway: !hostHere, guestKey: room.guestKey }));
        if (hostHere) room.host.send(JSON.stringify({ type: "guest-joined", sessionId, replaced: hadGuest }));
        console.log(`Session ${sessionLogId(sessionId)} saved person met`);
        break;
      }

      /* ── A knock ────────────────────────────────
         First to a saved person's room, the page asks for them to be told —
         a notification on their device, the app open or not (see knock.js).
         The address comes with the knock, from the device that holds it; the
         server keeps none. Only the host of a saved person's room, while
         nobody else is in it; only to a push service's own address; once per
         room in KNOCK_ROOM_GAP_MS and KNOCK_MAX per network in ten minutes.
         The answer says whether it went, and whether the address is gone for
         good — the page then forgets it. */
      case "knock": {
        const sessionId = data.sessionId;
        const room = sessions.get(sessionId);
        if (!KNOCK_KEYS || !room || room.kind !== "saved" || room.host !== ws || room.guest) break;
        const to = data.to && typeof data.to === "object" ? data.to : {};
        const refuse = () => ws.send(JSON.stringify({ type: "knock-result", sessionId, ok: false, gone: false }));
        if (!isPushEndpoint(to.endpoint, KNOCK_TEST_ORIGIN) || !pushKeysValid(to.p256dh, to.auth)) { refuse(); break; }
        const now = Date.now();
        if (now - (room.knockedAt || 0) < KNOCK_ROOM_GAP_MS ||
            !slidingAllow(knockHits, clientIp, KNOCK_MAX, KNOCK_WINDOW_MS)) { refuse(); break; }
        room.knockedAt = now;
        sendKnock({ to: { endpoint: to.endpoint, p256dh: to.p256dh, auth: to.auth }, room: sessionId, keys: KNOCK_KEYS, now })
          .then(result => {
            console.log(`Session ${sessionLogId(sessionId)} knocked: ${result.status || "no answer"}`);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "knock-result", sessionId, ok: result.ok, gone: result.gone }));
            }
          });
        break;
      }

      /* ── Waiting messages ───────────────────────
         A message for a saved person who is not there, sealed by the device
         that wrote it (see mailbox.js and protocol.js, sealMail): kept here
         until theirs asks, never read. A mailbox is the pair's room name and
         the side it is for; knowing the name is the way in, as for meeting.
         Kept once by its id, whoever sends it again. Then whoever is asking
         after that mailbox right now is told at once (mail-waiting). If
         nobody is — or nobody asks for it within MAIL_ANSWER_MS, so was not
         really there — and the sender gave their knock address, their device
         is told "a message waits", at most once a minute. */
      case "mail-drop": {
        const { box, to, id, at, iv, ct } = data;
        const refuse = code => ws.send(JSON.stringify({ type: "mail-refused", id: typeof id === "string" ? id.slice(0, 32) : null, code }));
        const note = OWNER_BOX !== null && box === OWNER_BOX;       // for the owner, from anyone
        if (note && to !== "a") { refuse("invalid"); break; }
        if (note && !slidingAllow(noteHits, clientIp, NOTE_MAX, NOTE_WINDOW_MS)) { refuse("too-many"); break; }
        if (!slidingAllow(mailDropHits, clientIp, MAIL_DROP_MAX, MAIL_DROP_WINDOW_MS)) { refuse("too-many"); break; }
        const result = mail.drop(box, to, { id, at, iv, ct, file: data.file === true });   // a photo or file: sent first, see /api/mailbox/file
        if (result === "invalid" || result === "full" || result === "server-full") { refuse(result); break; }
        ws.send(JSON.stringify({ type: "mail-dropped", id }));
        if (result !== "new") break;                       // sent again: told already
        const key = `${box}:${to}`;
        const listening = [...(mailListeners.get(key) || [])].filter(l => l.readyState === WebSocket.OPEN && l !== ws);
        for (const l of listening) l.send(JSON.stringify({ type: "mail-waiting", box }));
        /* A note alerts the owner where the owner said; a message, where its writer said. */
        const knock = note ? ownerAlert : (data.knock && typeof data.knock === "object" ? data.knock : null);
        const alert = () => {
          if (!knock || !KNOCK_KEYS || !isPushEndpoint(knock.endpoint, KNOCK_TEST_ORIGIN) || !pushKeysValid(knock.p256dh, knock.auth)) return;
          if (Date.now() - (mailKnockedAt.get(key) || 0) < MAIL_KNOCK_GAP_MS || !slidingAllow(knockHits, clientIp, KNOCK_MAX, KNOCK_WINDOW_MS)) return;
          mailKnockedAt.set(key, Date.now());
          sendKnock({ to: { endpoint: knock.endpoint, p256dh: knock.p256dh, auth: knock.auth }, room: box, keys: KNOCK_KEYS, kind: "mail" })
            .then(r => {
              console.log(`Mail knock: ${r.status || "no answer"}`);
              if (note && r.gone && ownerAlert === knock) keepOwnerAlert(null);   // that device no longer takes alerts
            });
        };
        if (!listening.length) { alert(); break; }
        const toldAt = Date.now();
        const check = setTimeout(() => { if ((mailFetchedAt.get(key) || 0) < toldAt) alert(); }, MAIL_ANSWER_MS);
        if (check.unref) check.unref();
        break;
      }

      /* What waits for this device, in each of its mailboxes — and from now
         on, word the moment more arrives, while this link is open. */
      case "mail-fetch": {
        if (!slidingAllow(mailFetchHits, clientIp, MAIL_FETCH_MAX, MAIL_FETCH_WINDOW_MS)) break;
        const asked = Array.isArray(data.boxes) ? data.boxes.slice(0, 50) : [];
        ws.mailKeys = ws.mailKeys || new Set();
        for (const b of asked) {
          if (!b || typeof b.box !== "string" || !SAVED_ROOM_PATTERN.test(b.box) || (b.side !== "a" && b.side !== "b")) continue;
          if (b.box === OWNER_BOX && !ws.isOwner) continue;           // the owner's notes, to the owner alone
          const key = `${b.box}:${b.side}`;
          if (!ws.mailKeys.has(key) && ws.mailKeys.size >= 50) continue;
          ws.mailKeys.add(key);
          if (!mailListeners.has(key)) mailListeners.set(key, new Set());
          mailListeners.get(key).add(ws);
          mailFetchedAt.set(key, Date.now());
          /* A photo or file only to a page that says it can take one. An app
             from before them opened its message as no text, took it for
             garbled — and said it had it, so it was gone for good. */
          const items = mail.take(b.box, b.side).filter(m => !m.file || data.files === true);
          if (items.length) ws.send(JSON.stringify({ type: "mail", box: b.box, side: b.side, items }));
          /* Someone already waiting in the room for this side: said now, not
             only when the next one starts (see tellSavedWaiting). */
          const waitingRoom = sessions.get(b.box);
          if (savedRoomWaiting(waitingRoom) && waitingRoom.hostSide !== b.side) {
            ws.send(JSON.stringify({ type: "meet-waiting", room: b.box, waiting: true }));
          }
        }
        break;
      }

      /* The owner's device, showing it is: this connection's word, signed with
         the lock's signing key. From then on it may collect the owner's notes. */
      case "owner-hello": {
        if (ownerProofValid(ws.ownerNonce, data.proof)) {
          ws.isOwner = true;
          ws.send(JSON.stringify({ type: "owner-ok" }));
        } else {
          ws.send(JSON.stringify({ type: "owner-refused" }));
        }
        break;
      }

      /* Where the owner's device is alerted when a note arrives — or nowhere (null). */
      case "owner-alert": {
        if (!ws.isOwner) break;
        const to = data.knock && typeof data.knock === "object" ? data.knock : null;
        if (to && (!isPushEndpoint(to.endpoint, KNOCK_TEST_ORIGIN) || !pushKeysValid(to.p256dh, to.auth))) break;
        keepOwnerAlert(to ? { endpoint: to.endpoint, p256dh: to.p256dh, auth: to.auth } : null);
        break;
      }

      /* The device has them: gone from here for good. */
      case "mail-ack": {
        if (typeof data.box !== "string" || !SAVED_ROOM_PATTERN.test(data.box) || (data.side !== "a" && data.side !== "b")) break;
        if (data.box === OWNER_BOX && !ws.isOwner) break;            // and let go by the owner alone
        mail.ack(data.box, data.side, Array.isArray(data.ids) ? data.ids.slice(0, 200) : []);
        break;
      }

      /* ── WebRTC signaling ───────────────────── */
      case "offer": {
        const session = sessions.get(data.sessionId);
        if (!session) break;
        if (ws !== session.host) break;
        session.offer = data.offer;
        if (session.guest?.readyState === WebSocket.OPEN) {
          session.guest.send(JSON.stringify({ type: "offer", offer: data.offer }));
        }
        break;
      }

      case "answer":             relayToOther(ws, data.sessionId, { type: "answer",             answer:    data.answer });    break;
      case "ice-candidate":      relayToOther(ws, data.sessionId, { type: "ice-candidate",      candidate: data.candidate }); break;
      case "renegotiate-offer":  relayToOther(ws, data.sessionId, { type: "renegotiate-offer",  offer:     data.offer });    break;
      case "renegotiate-answer": relayToOther(ws, data.sessionId, { type: "renegotiate-answer", answer:    data.answer });   break;

      /* Call signaling deliberately has no relay here: offers, answers and
         candidates travel inside the end-to-end encrypted data channel, so the
         server cannot read or inject them. Do not add one back. */

      case "leave-session": cleanupClient(ws); break;

      /* The host, back after its link dropped, taking its room again. The host
         key proves it: a secret this server gave only the host's page, never in
         a link, so a guest who has the link cannot take the room. A key that
         does not match, or a room no longer kept, is refused alike. */
      case "reclaim-session": {
        const found = sessions.get(data.sessionId);
        if (found && hostAwayExpired(found)) dropSession(data.sessionId, found);
        const session = sessions.get(data.sessionId);
        if (!session || !secretMatches(session.hostKey, data.hostKey)) {
          ws.send(JSON.stringify({ type: "reclaim-failed", sessionId: data.sessionId }));
          break;
        }
        if (session.host !== ws) cleanupClient(ws);    // one room per socket
        /* Back to a chat it was in (the guest was known before the link
           dropped): the chat goes on — nothing is started again, and the guest
           is told the way to repair it is open. Back to a waiting room: as
           before, with any guest who arrived meanwhile introduced now. */
        const resumed = session.paired === true;
        session.host = ws;
        session.hostAwaySince = 0;
        clearTimeout(session.hostAwayTimer);
        if (!resumed) session.waitingSince = Date.now();   // a fresh ten minutes to find a guest
        ws.send(JSON.stringify({
          type: "session-reclaimed", sessionId: data.sessionId,
          pin: session.pin, token: session.token, kind: session.kind, open: session.open,
          guestWaiting: Boolean(session.guest), resumed
        }));
        if (resumed) {
          tellOther(session, "host", "peer-back", data.sessionId);
        } else if (session.guest?.readyState === WebSocket.OPEN) {
          session.guest.send(JSON.stringify({ type: "host-back", sessionId: data.sessionId }));
          ws.send(JSON.stringify({ type: "guest-joined", sessionId: data.sessionId }));
          session.paired = true;
        }
        broadcastSessionList();
        break;
      }

      /* A guest whose link dropped mid-chat, back on a new one, taking its seat
         again with the guest key it was given on joining — which never left
         its page, so nobody else can present it. Its old link may not have
         been noticed as gone yet; the seat is the new one's either way. */
      case "rejoin-session": {
        const session = sessions.get(data.sessionId);
        if (!session || !session.guestKey || !secretMatches(session.guestKey, data.guestKey)) {
          ws.send(JSON.stringify({ type: "rejoin-failed", sessionId: data.sessionId }));
          break;
        }
        if (session.guest !== ws) cleanupClient(ws);   // one room per socket
        session.guest = ws;
        session.guestAwaySince = 0;
        clearTimeout(session.guestAwayTimer);
        const hostHere = session.host?.readyState === WebSocket.OPEN;
        ws.send(JSON.stringify({ type: "session-rejoined", sessionId: data.sessionId, hostAway: !hostHere }));
        if (hostHere) tellOther(session, "guest", "peer-back", data.sessionId);
        break;
      }

      /* The guest asking the host to start a fresh route for their chat — only
         the host makes the offer, so two never cross. Passed on like the
         rest of the repair. */
      case "repair-request": relayToOther(ws, data.sessionId, { type: "repair-request", sessionId: data.sessionId }); break;

      /* The host of a code room turning away a guest whose word did not match,
         so the seat is free for the next attempt — or the right one. Only the
         host, only a code room, and only a seat that is taken. The guest is
         told the way any guest is told its host has gone — and, when the host
         says the room is locked after too many wrong words, told that, and
         for how long. It used to hear only "the other side left", and the
         right word arriving during the lock had no way to know to wait. */
      case "release-guest": {
        const session = sessions.get(data.sessionId);
        if (!session || session.host !== ws || session.kind !== "code" || !session.guest) break;
        const guest = session.guest;
        if (guest.readyState === WebSocket.OPEN) {
          const told = { type: "peer-disconnected", sessionId: data.sessionId };
          if (data.reason === "locked") {
            told.reason = "code-locked";
            if (Number.isInteger(data.retryIn) && data.retryIn >= 0 && data.retryIn <= 3600) told.retryIn = data.retryIn;
          }
          guest.send(JSON.stringify(told));
        }
        session.guest = null;
        session.paired = false;
        session.guestKey = null;          // turned away: its key takes nothing back
        session.waitingSince = Date.now();
        broadcastSessionList();
        break;
      }

      case "ping": /* keep-alive, no-op */ break;

      default:
        /* An unknown type is either an old client or someone probing. Either
           way one socket must not be able to fill the log with novel types. */
        ws.unknownTypeLogs = (ws.unknownTypeLogs || 0) + 1;
        if (ws.unknownTypeLogs <= UNKNOWN_TYPE_LOG_MAX) {
          console.log(`Unknown msg type from ${ipLogId(clientIp)}: ${safeLabel(data.type)}` +
            (ws.unknownTypeLogs === UNKNOWN_TYPE_LOG_MAX ? " (further ones from this client not logged)" : ""));
        }
    }
  }
});

/* ══════════════════════════════════════════════
   HEARTBEAT
   ─────────────────────────────────────────────
   A phone that sleeps or drops off the network never sends a close frame, so
   without this the socket looks connected forever: the room stays occupied,
   its name stays taken, and the surviving peer is never told the other side
   is gone. Ping every client each sweep; a client that did not answer the
   previous sweep is terminated, which fires "close" → cleanupClient().
   Detection takes between one and two sweeps.
══════════════════════════════════════════════ */

const HEARTBEAT_MS = (() => {
  const parsed = parseInt(process.env.HEARTBEAT_MS || "", 10);
  if (Number.isFinite(parsed) && parsed >= 1000 && parsed <= 300_000) return parsed;
  return 30_000;
})();

const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      console.log(`Terminating unresponsive client ${ipLogId(ws.clientIp || "unknown")}`);
      ws.terminate();          // fires "close" → cleanupClient frees the session
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) { ws.terminate(); }
  });
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(heartbeat));

/* ── Stale session pruner (10 min, host-only) ── */
setInterval(() => {
  const TEN_MIN = 10 * 60 * 1000;
  const now = Date.now();
  let pruned = 0;
  for (const [id, s] of sessions) {
    /* A host whose link dropped, kept waiting for: gone once its time is up. */
    if (!s.host) {
      if (hostAwayExpired(s, now)) { dropSession(id, s); pruned++; }
      continue;
    }
    /* A socket already gone but "close" never fired — a backstop. Treated as
       the drop it is: the seat is kept, for its page to take back. */
    if (s.host.readyState !== WebSocket.OPEN) {
      markAway(id, s, "host");
      if (s.paired) tellOther(s, "host", "peer-away", id);
      continue;
    }
    if (s.guest && s.guest.readyState !== WebSocket.OPEN && s.paired) {
      markAway(id, s, "guest");
      tellOther(s, "guest", "peer-away", id);
    }
    if (!s.guest && now - (s.waitingSince || s.createdAt) > TEN_MIN) {
      /* Its own message, not peer-disconnected: there never was a peer. The
         host is in the lobby looking at a PIN and a link, and needs telling
         that both have stopped working — the old message said "peer left" into
         a chat screen that was not showing. */
      if (s.host?.readyState === WebSocket.OPEN) {
        s.host.send(JSON.stringify({ type: "session-expired", sessionId: id }));
      }
      removeSession(id);
      pruned++;
    }
  }
  if (pruned) { console.log(`Pruned ${pruned} stale session(s)`); broadcastSessionList(); }
}, 60_000);

/* ── Start ─────────────────────────────────── */
const PORT = process.env.PORT || 3000;
/* Every address unless HOST names one. Behind a proxy on the same machine —
   Tailscale Funnel on the Pi — 127.0.0.1: nothing reaches it except through
   the proxy, which is what TRUSTED_PROXY_HOPS counts on. */
const HOST = process.env.HOST || undefined;
server.listen(PORT, HOST, () => {
  warnIfCspDrifted();
  console.log(`Trusting ${TRUSTED_PROXY_HOPS} proxy hop(s) for client addresses`);
  if (TRUSTED_PROXY_HOPS > 0 && process.env.TRUSTED_PROXY_HOPS === undefined) {
    console.log("  (default: correct behind one proxy — Tailscale Funnel on the Pi, nginx.");
    console.log("   Set TRUSTED_PROXY_HOPS=0 if this process is exposed directly,");
    console.log("   otherwise clients can forge their address and evade rate limits.)");
  }
  console.log(`Server running on ${HOST || "every address"}, port ${PORT}${BASE_PATH ? `, under ${BASE_PATH}` : ""}`);
  const kept = mail.stats();
  console.log(kept.file ? `Mailbox: kept in ${kept.file} (${kept.messages} waiting)` : "Mailbox: in memory only — lost on restart");
});
