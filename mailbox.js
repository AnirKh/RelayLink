/*
  ─────────────────────────────────────────────
  RelayLink — mailbox.js
  ─────────────────────────────────────────────

  Messages waiting for a saved person who is not there, until they open the
  app (see "Waiting messages" in the README). The two devices seal each one
  with a key from the secret only they share (protocol.js, sealMail): this
  keeps them and hands them over, and cannot read them.

  A mailbox is a saved pair's room name and the side it is for ("a" or "b").
  Each message is kept as it came — its id, when it was written, and the
  sealed text — until it is taken and acknowledged, or for MAIL_TTL_MS. Kept
  in a file when there is somewhere to keep it (on the Pi, the service's state
  directory), so a restart — every update is one — loses nothing; in memory
  only otherwise (the Render standby). Bounded per mailbox and in all, so a
  stranger who learned a pair's room name could fill one mailbox, but not the
  disk or the memory.

  No messages are read here, and nothing about them is logged.
*/

"use strict";

const fs   = require("fs");
const path = require("path");

const MAIL_TTL_MS    = 7 * 24 * 60 * 60 * 1000;   // a week, then gone unread
const BOX_MAX_ITEMS  = 100;
const BOX_MAX_CHARS  = 2_000_000;                 // the sealed text's length, summed
const ALL_MAX_CHARS  = 50_000_000;
const CT_MAX_CHARS   = 65_536;                    // a 10 000-character message, sealed, fits
const SAVE_DELAY_MS  = 2000;

const BOX  = /^~[A-Za-z0-9_-]{43}$/;
const ID   = /^[A-Za-z0-9_-]{22}$/;
const IV   = /^[A-Za-z0-9_-]{16}$/;
const CT   = /^[A-Za-z0-9_-]+$/;
const SIDE = side => side === "a" || side === "b";

/** A mailbox's address and one message for it, as a device sent them — or
    not believed. `at` is the writer's clock: sealed in, so not changeable,
    but only within reason (2020 to a day ahead). */
function dropValid(box, to, item, now) {
  if (typeof box !== "string" || !BOX.test(box) || !SIDE(to) || !item || typeof item !== "object") return false;
  const { id, at, iv, ct } = item;
  return typeof id === "string" && ID.test(id) &&
         Number.isSafeInteger(at) && at > 1_577_836_800_000 && at < now + 24 * 60 * 60 * 1000 &&
         typeof iv === "string" && IV.test(iv) &&
         typeof ct === "string" && ct.length <= CT_MAX_CHARS && CT.test(ct);
}

function createMailboxes({ file = null, now = () => Date.now(), saveDelayMs = SAVE_DELAY_MS } = {}) {
  const boxes = new Map();              // `${box}:${to}` → [{ id, at, iv, ct, keptAt }]
  let total = 0;                        // all sealed text kept, in characters
  let saveTimer = null;

  const keyOf = (box, side) => `${box}:${side}`;
  const sizeOf = item => item.iv.length + item.ct.length;

  /* Whatever the file holds, each message is believed only as a new one
     would be — and one past its week is not taken back up. */
  if (file) {
    try {
      const kept = JSON.parse(fs.readFileSync(file, "utf8"));
      if (kept && kept.v === 1 && kept.boxes && typeof kept.boxes === "object") {
        for (const [key, items] of Object.entries(kept.boxes)) {
          const [box, side] = key.split(":");
          if (!Array.isArray(items)) continue;
          for (const it of items) {
            if (!it || !Number.isFinite(it.keptAt) || now() - it.keptAt > MAIL_TTL_MS) continue;
            if (!dropValid(box, side, it, Math.max(now(), it.keptAt))) continue;
            put(box, side, { id: it.id, at: it.at, iv: it.iv, ct: it.ct, keptAt: it.keptAt });
          }
        }
      }
    } catch (_) { /* no file yet, or not ours: start empty */ }
  }

  function put(box, side, item) {
    const key = keyOf(box, side);
    const list = boxes.get(key) || [];
    if (list.some(m => m.id === item.id)) return "ok";                  // sent again: kept once
    if (list.length >= BOX_MAX_ITEMS) return "full";
    if (list.reduce((n, m) => n + sizeOf(m), 0) + sizeOf(item) > BOX_MAX_CHARS) return "full";
    if (total + sizeOf(item) > ALL_MAX_CHARS) return "server-full";
    list.push(item);
    boxes.set(key, list);
    total += sizeOf(item);
    return "new";
  }

  function save() {
    if (!file) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    const out = { v: 1, boxes: Object.fromEntries(boxes) };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
      fs.renameSync(tmp, file);                 // all or nothing: never half a file
    } catch (err) {
      console.error(`Mailbox: could not be kept — ${err.code || err.message}`);
    }
  }

  function changed() {
    if (!file || saveTimer) return;
    saveTimer = setTimeout(save, saveDelayMs);
    if (saveTimer.unref) saveTimer.unref();
  }

  return {
    /** Keeps one message: "new", "ok" (already kept — sent again), "full"
        (this mailbox), "server-full", or "invalid". */
    drop(box, to, item) {
      if (!dropValid(box, to, item, now())) return "invalid";
      const result = put(box, to, { id: item.id, at: item.at, iv: item.iv, ct: item.ct, keptAt: now() });
      if (result === "new") changed();
      return result;
    },

    /** What waits in a mailbox, oldest first. Taking it removes nothing:
        it goes once the device says it has it (ack). */
    take(box, side) {
      if (typeof box !== "string" || !BOX.test(box) || !SIDE(side)) return [];
      return (boxes.get(keyOf(box, side)) || []).map(({ id, at, iv, ct }) => ({ id, at, iv, ct }));
    },

    /** The device has these: gone for good. */
    ack(box, side, ids) {
      const key = keyOf(box, side);
      const list = boxes.get(key);
      if (!list || !Array.isArray(ids)) return 0;
      const drop = new Set(ids.filter(id => typeof id === "string"));
      const keep = list.filter(m => !drop.has(m.id));
      const gone = list.length - keep.length;
      if (!gone) return 0;
      for (const m of list) if (drop.has(m.id)) total -= sizeOf(m);
      if (keep.length) boxes.set(key, keep); else boxes.delete(key);
      changed();
      return gone;
    },

    /** Messages past their week, gone. */
    sweep() {
      let gone = 0;
      for (const [key, list] of boxes) {
        const keep = list.filter(m => now() - m.keptAt <= MAIL_TTL_MS);
        if (keep.length === list.length) continue;
        for (const m of list) if (now() - m.keptAt > MAIL_TTL_MS) total -= sizeOf(m);
        gone += list.length - keep.length;
        if (keep.length) boxes.set(key, keep); else boxes.delete(key);
      }
      if (gone) changed();
      return gone;
    },

    /** Kept now rather than in a moment — on the way out. */
    flush() { if (saveTimer) save(); },

    stats() { return { boxes: boxes.size, messages: [...boxes.values()].reduce((n, l) => n + l.length, 0), chars: total, file }; }
  };
}

module.exports = { createMailboxes, dropValid, MAIL_TTL_MS, BOX_MAX_ITEMS, BOX_MAX_CHARS, ALL_MAX_CHARS, CT_MAX_CHARS };
