/*
  ─────────────────────────────────────────────
  RelayLink — ratelimit.js
  ─────────────────────────────────────────────

  The sliding-window counters behind the `list-sessions` and `create-session`
  limits, kept here for the same reason clientip.js is separate: they are small,
  pure, and the thing several limits rest on, so they are worth testing directly
  rather than through a running server.

  Shape of the state: Map<clientIp, number[]> — a list of request timestamps.

  joinVerdict is here as well: which of the join limits apply to which kind of
  credential is a decision about rate limiting, and it was wrong for a while in
  a way only a table of cases shows.
*/

"use strict";

/**
 * Records a hit and reports whether it is allowed.
 *
 * Trims expired timestamps for this caller on the way through, which keeps an
 * active entry bounded but does nothing for callers who never return — see
 * pruneExpired.
 *
 * @returns {boolean} false when the caller is over `max` within `windowMs`
 */
function slidingAllow(map, key, max, windowMs, now = Date.now()) {
  const times = (map.get(key) || []).filter(t => now - t < windowMs);
  if (times.length >= max) {
    /* Store the trimmed list even when refusing, so a caller hammering the
       endpoint cannot pin an ever-growing array in memory. */
    map.set(key, times);
    return false;
  }
  times.push(now);
  map.set(key, times);
  return true;
}

/**
 * Drops entries whose timestamps have all aged out.
 *
 * Without this the map keeps one entry per address seen since the process
 * started: slidingAllow only ever trims the entry belonging to whoever is
 * asking right now, so an address that never comes back is never touched
 * again. The lobby calls list-sessions on every page load, which makes that
 * one entry per unique visitor, permanently.
 *
 * @returns {number} how many entries were removed
 */
function pruneExpired(map, windowMs, now = Date.now()) {
  let removed = 0;
  for (const [key, times] of map) {
    if (!times.some(t => now - t < windowMs)) {
      map.delete(key);
      removed++;
    }
  }
  return removed;
}

/**
 * Makes a client-supplied value safe to put in a log line.
 *
 * A WebSocket `data.type` is whatever the client sent, up to maxPayload and
 * newlines included. Printed raw it lets anyone forge log entries: a type
 * containing "\n" writes as many lines as it likes and can imitate the real
 * ones ("Rate-limited IP ...", "Session ... join-locked"). Real message types
 * are short ASCII identifiers, so anything else is an attack or a bug.
 */
function safeLabel(value, max = 32) {
  const text = typeof value === "string" ? value : String(value);
  const clean = text.replace(/[^\x20-\x7E]/g, "·");
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

/**
 * Decides what a join attempt gets, given what is already known about it.
 *
 * The two locks exist to slow down guessing a 6-digit PIN. The invite token is
 * 192 random bits; nobody guesses it, so nobody presenting the right one is
 * guessing. Holding them to the PIN's locks protected nothing and cost a lot:
 * room names are public, so fifteen wrong PINs from anyone locked the invited
 * guest out of a room they held a valid link to — and could be repeated for as
 * long as the room existed.
 *
 * So a correct token goes straight through, and everything else meets the
 * locks first. A PIN counts for nothing while a lock is on, right or wrong: if
 * a correct one were admitted during the lock, the lock would stop nothing —
 * the guesser would just keep going until one landed.
 *
 * Wrong PINs can still lock a room against other PIN joiners. That is what a
 * guess limit on a short code costs, and the invite link is the way round it.
 *
 * An open room — one created without a PIN — asks for nothing, so there is
 * nothing to guess and neither lock has anything to protect. It admits whoever
 * arrives first and is full after that, like every other room.
 *
 * Arriving at a PIN room with no PIN and no token is not a guess either: it is
 * a browser whose list was out of date, or someone who has not typed anything
 * yet. That gets "pin-required" and is not counted against anyone, where a
 * wrong PIN is.
 *
 * A seat held through the invite link is not "full" to that same link. The
 * link is one person's, and a second copy of it is that person in another
 * browser — most often the app the link was sent through (Messenger,
 * Instagram), which opened it first and took the seat, left for Safari or
 * Chrome. Turned away as "full", the guest could not get in at all, and once
 * the abandoned copy dropped the room went with it. So the newer copy takes
 * the seat ("replace"). Only from the link: a guest let in by a PIN, or by
 * tapping an open room, came another way, and the link does not move them.
 *
 * And only a copy someone is looking at (`visible`). The first version let any
 * copy take the seat, and one nobody was looking at — a second Safari tab
 * opened behind the first, an app's browser loading again in the background —
 * took it from the copy in use: the guest watched Safari say the chat had moved
 * elsewhere, and the host tried to connect to a page nobody had open. A copy
 * in the background is told the link is open elsewhere ("held-elsewhere") and
 * offers to continue there, which a tap — on screen by definition — can do.
 *
 * @param {{open: boolean, tokenOk: boolean, pinOk: boolean, noCredential: boolean,
 *          full: boolean, seatByLink: boolean, visible: boolean,
 *          roomLocked: boolean, ipLimited: boolean}} o
 * @returns {"admit"|"replace"|"held-elsewhere"|"full"|"room-locked"|"ip-limited"|"pin-required"|"wrong"}
 */
function joinVerdict(o) {
  if (o.tokenOk && o.full && o.seatByLink === true) return o.visible === true ? "replace" : "held-elsewhere";
  if (o.open || o.tokenOk) return o.full ? "full" : "admit";
  if (o.roomLocked) return "room-locked";
  if (o.full)       return "full";
  if (o.ipLimited)  return "ip-limited";
  if (o.pinOk)      return "admit";
  return o.noCredential ? "pin-required" : "wrong";
}

module.exports = { slidingAllow, pruneExpired, safeLabel, joinVerdict };
