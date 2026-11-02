/*
  ─────────────────────────────────────────────
  RelayLink — mailbox.js
  ─────────────────────────────────────────────

  Messages waiting for a saved person who is not there, until they open the
  app (see "Waiting messages" in the README) — texts, and photos and files.
  The two devices seal each one with a key from the secret only they share
  (protocol.js: sealMail, sealMailFile): this keeps them and hands them over,
  and cannot read them.

  A mailbox is a saved pair's room name and the side it is for ("a" or "b").
  Each message is kept as it came — its id, when it was written, and the
  sealed text — until it is taken and acknowledged, or for MAIL_TTL_MS. A
  photo or file is a message too — its sealed description — with the sealed
  file itself kept beside it on disk, one file each, never held in memory:
  sent first (fileStored), then taken up by the message that describes it
  (drop), and gone with that message. One never described is let go after
  ORPHAN_MS.

  Kept in a file when there is somewhere to keep it (on the Pi, the service's
  state directory), so a restart — every update is one — loses nothing; in
  memory only otherwise, and then no files at all. Bounded per mailbox and in
  all, so a stranger who learned a pair's room name could fill one mailbox,
  but not the disk or the memory.

  No messages are read here, and nothing about them is logged.
*/

"use strict";

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const MAIL_TTL_MS    = 7 * 24 * 60 * 60 * 1000;   // a week, then gone unread
const BOX_MAX_ITEMS  = 100;
const BOX_MAX_CHARS  = 2_000_000;                 // the sealed text's length, summed
const ALL_MAX_CHARS  = 50_000_000;
const CT_MAX_CHARS   = 65_536;                    // a 10 000-character message, sealed, fits
const SAVE_DELAY_MS  = 2000;
const FILE_MAX_BYTES     = 50 * 1024 * 1024 + 28; // a 50 MB file, sealed: 12 of IV, 16 of tag
const BOX_MAX_FILE_BYTES = 400 * 1024 * 1024;     // eight of the largest, waiting for one person
const ALL_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const ORPHAN_MS          = 10 * 60 * 1000;        // a file sent and never described

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

/** A mailbox and a message id, as an upload or a download names them. */
function fileAddressValid(box, side, id) {
  return typeof box === "string" && BOX.test(box) && SIDE(side) && typeof id === "string" && ID.test(id);
}

function createMailboxes({ file = null, filesDir = null, now = () => Date.now(), saveDelayMs = SAVE_DELAY_MS } = {}) {
  const boxes = new Map();              // `${box}:${to}` → [{ id, at, iv, ct, keptAt, file? }]
  const pending = new Map();            // file name → { box, to, size, at }: sent, not yet described
  let total = 0;                        // all sealed text kept, in characters
  let fileTotal = 0;                    // all files kept with a message, in bytes
  let saveTimer = null;

  const keyOf = (box, side) => `${box}:${side}`;
  const sizeOf = item => item.iv.length + item.ct.length;
  /* A file's name on disk says nothing of whose it is. */
  const fileName = (box, to, id) => crypto.createHash("sha256").update(`${box}:${to}:${id}`).digest("hex");
  const filePath = (box, to, id) => path.join(filesDir, fileName(box, to, id));

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
            const withFile = filesDir && Number.isSafeInteger(it.file) && it.file > 0 && it.file <= FILE_MAX_BYTES;
            if (put(box, side, { id: it.id, at: it.at, iv: it.iv, ct: it.ct, keptAt: it.keptAt, ...(withFile ? { file: it.file } : {}) }) === "new" && withFile) {
              fileTotal += it.file;
            }
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

  /** A message gone — its file with it. */
  function letGo(box, side, m) {
    total -= sizeOf(m);
    if (!m.file) return;
    fileTotal -= m.file;
    fs.rm(filePath(box, side, m.id), { force: true }, () => {});
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

  const boxFileBytes = (box, to) =>
    (boxes.get(keyOf(box, to)) || []).reduce((n, m) => n + (m.file || 0), 0) +
    [...pending.values()].filter(p => p.box === box && p.to === to).reduce((n, p) => n + p.size, 0);
  const pendingBytes = () => [...pending.values()].reduce((n, p) => n + p.size, 0);

  return {
    /** Keeps one message: "new", "ok" (already kept — sent again), "full"
        (this mailbox), "server-full", or "invalid". `item.file` true: its
        file was sent first (fileStored), and is taken up with it — a file
        never sent makes the message "invalid". */
    drop(box, to, item) {
      if (!dropValid(box, to, item, now())) return "invalid";
      const kept = { id: item.id, at: item.at, iv: item.iv, ct: item.ct, keptAt: now() };
      let waiting = null;
      if (item.file === true) {
        if ((boxes.get(keyOf(box, to)) || []).some(m => m.id === item.id)) return "ok";
        waiting = filesDir ? pending.get(fileName(box, to, item.id)) : null;
        if (!waiting || waiting.box !== box || waiting.to !== to) return "invalid";
        kept.file = waiting.size;
      }
      const result = put(box, to, kept);
      if (result === "new") {
        if (waiting) { pending.delete(fileName(box, to, item.id)); fileTotal += waiting.size; }
        changed();
      }
      return result;
    },

    /** What waits in a mailbox, oldest first — with each file's size, the
        file itself to be fetched on its own. Taking removes nothing: it goes
        once the device says it has it (ack). */
    take(box, side) {
      if (typeof box !== "string" || !BOX.test(box) || !SIDE(side)) return [];
      return (boxes.get(keyOf(box, side)) || []).map(({ id, at, iv, ct, file }) => ({ id, at, iv, ct, ...(file ? { file } : {}) }));
    },

    /** The device has these: gone for good, files and all. */
    ack(box, side, ids) {
      const key = keyOf(box, side);
      const list = boxes.get(key);
      if (!list || !Array.isArray(ids)) return 0;
      const drop = new Set(ids.filter(id => typeof id === "string"));
      const keep = list.filter(m => !drop.has(m.id));
      const gone = list.length - keep.length;
      if (!gone) return 0;
      for (const m of list) if (drop.has(m.id)) letGo(box, side, m);
      if (keep.length) boxes.set(key, keep); else boxes.delete(key);
      changed();
      return gone;
    },

    /** Messages past their week, gone; files sent and never described, gone
        after ORPHAN_MS — and any on disk that no message names (a restart
        between the two). */
    sweep() {
      let gone = 0;
      for (const [key, list] of boxes) {
        const [box, side] = key.split(":");
        const keep = list.filter(m => now() - m.keptAt <= MAIL_TTL_MS);
        if (keep.length === list.length) continue;
        for (const m of list) if (now() - m.keptAt > MAIL_TTL_MS) letGo(box, side, m);
        gone += list.length - keep.length;
        if (keep.length) boxes.set(key, keep); else boxes.delete(key);
      }
      if (gone) changed();
      if (filesDir) {
        for (const [name, p] of pending) {
          if (now() - p.at > ORPHAN_MS) { pending.delete(name); fs.rm(path.join(filesDir, name), { force: true }, () => {}); }
        }
        const named = new Set(pending.keys());
        for (const [key, list] of boxes) {
          const [box, side] = key.split(":");
          for (const m of list) if (m.file) named.add(fileName(box, side, m.id));
        }
        let onDisk = [];
        try { onDisk = fs.readdirSync(filesDir); } catch (_) { /* none yet */ }
        for (const name of onDisk) {
          if (named.has(name)) continue;
          try {
            if (now() - fs.statSync(path.join(filesDir, name)).mtimeMs > ORPHAN_MS) fs.rmSync(path.join(filesDir, name), { force: true });
          } catch (_) { /* gone already */ }
        }
      }
      return gone;
    },

    /* ── Files ─────────────────────────────── */

    filesOn: Boolean(filesDir),

    /** May a file of `bytes` be sent to this mailbox? "ok", "off" (nowhere
        to keep it), "too-large", "full" (this mailbox), "server-full". */
    fileRoom(box, to, bytes) {
      if (!filesDir) return "off";
      if (!Number.isSafeInteger(bytes) || bytes < 28 || bytes > FILE_MAX_BYTES) return "too-large";
      if (boxFileBytes(box, to) + bytes > BOX_MAX_FILE_BYTES) return "full";
      if (fileTotal + pendingBytes() + bytes > ALL_MAX_FILE_BYTES) return "server-full";
      return "ok";
    },

    /** Where a file being sent is written — `part` while it comes, renamed to
        `path` when all of it has. */
    fileTarget(box, to, id) {
      fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 });
      const final = filePath(box, to, id);
      return { path: final, part: `${final}.part` };
    },

    /** All of a file has come: it waits for the message that describes it. */
    fileStored(box, to, id, size) {
      pending.set(fileName(box, to, id), { box, to, size, at: now() });
    },

    /** Already here: sent once, before an answer was lost. */
    fileHere(box, to, id) {
      const name = fileName(box, to, id);
      if (pending.has(name)) return pending.get(name).size;
      const m = (boxes.get(keyOf(box, to)) || []).find(x => x.id === id);
      return m && m.file ? m.file : 0;
    },

    /** The file of a message waiting in this mailbox, to hand over — or null. */
    fileFor(box, side, id) {
      if (!filesDir || !fileAddressValid(box, side, id)) return null;
      const m = (boxes.get(keyOf(box, side)) || []).find(x => x.id === id);
      return m && m.file ? { path: filePath(box, side, id), size: m.file } : null;
    },

    /** Kept now rather than in a moment — on the way out. */
    flush() { if (saveTimer) save(); },

    stats() {
      return { boxes: boxes.size, messages: [...boxes.values()].reduce((n, l) => n + l.length, 0), chars: total,
               fileBytes: fileTotal, pendingFiles: pending.size, file, filesDir };
    }
  };
}

module.exports = {
  createMailboxes, dropValid, fileAddressValid,
  MAIL_TTL_MS, BOX_MAX_ITEMS, BOX_MAX_CHARS, ALL_MAX_CHARS, CT_MAX_CHARS,
  FILE_MAX_BYTES, BOX_MAX_FILE_BYTES, ALL_MAX_FILE_BYTES, ORPHAN_MS
};
