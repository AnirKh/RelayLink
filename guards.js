/*
  ─────────────────────────────────────────────
  RelayLink — guards.js
  ─────────────────────────────────────────────

  The safety decisions, as pure functions.

  Every one of these had a real bug behind it, and every one was invisible to
  the test suite because it lived inside DOM-driven code in app.js:

    mayCaptureForCall     a peer could send call-offer, or later call-accept,
                          cold and open the camera with no prompt shown
    consentedVideo        answering a voice call with withVideo:true turned the
                          camera on
    mayRenderText         plaintext arriving on the data channel was displayed,
                          which undid failing closed on a key mismatch
    mayDeliverRecording   a voice note recorded in one room was delivered to the
                          next room's peer
    shouldRetryAutoJoin   an invite-link join whose answer never arrived left
                          the lobby disabled behind "Joining…" forever
    mayHandleFrame        only chat text was checked for encryption; a file
                          announcement or a call request arriving in the clear
                          was acted on, even after the channel had been declared
                          unsafe
    mayStartRecording     a double-click opened the microphone twice and the app
                          kept track of one — the other stayed on until the tab
                          closed
    mayKeepMicOpen        the room could go away while the microphone was still
                          opening, leaving it live in the lobby
    mayApplyRoomEvent     "the other side left" named no room, so one room
                          expiring tore down the chat in another

  One is here without a bug behind it, because it is the thing users are asked
  to trust:

    shieldState           what the shield in the chat header says — nothing
                          yet, encrypted but unchecked, or verified

  Extracting them is the point: a rule that can be called with plain values can
  be tested for every combination, including the ones nobody thinks to try.
  app.js keeps the effects — opening the camera, drawing bubbles — and asks
  here whether it is allowed to.

  No DOM, no module state, no side effects.
*/

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DCGuards = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /* ══════════════════════════════════════════
     Calls
  ══════════════════════════════════════════ */

  /**
   * May getUserMedia run?
   *
   * `inCall` is set by pressing a call button or Accept, and by nothing a peer
   * sends. Both call paths — placing a call and answering one — reach the same
   * capture, so both must ask. The guard was added to one of them first and the
   * other went unnoticed for a release.
   */
  function mayCaptureForCall(inCall) {
    return inCall === true;
  }

  /**
   * How much capture the user actually agreed to.
   *
   * The peer's flag rides in on every call message and cannot be trusted alone.
   * This is an AND, not an override: the peer may answer a video call with
   * audio only — no camera on their side is a fair reason — but can never add
   * video to a call the user asked to keep voice-only.
   */
  function consentedVideo(pendingCallVideo, peerWantsVideo) {
    return Boolean(pendingCallVideo) && Boolean(peerWantsVideo);
  }

  /** How long a call we place rings before it is given up as not answered. */
  const CALL_RING_MS = 45_000;

  /**
   * The call we placed has rung for CALL_RING_MS. Is it still only ringing —
   * not answered, and not over?
   *
   * Nothing used to end a call nobody picked up. The other person away from
   * the screen, or in another app, and the caller sat on "Calling…" for as
   * long as anyone watched, the call never placed and never ended.
   *
   * @param {{inCall: boolean, answered: boolean}} o
   */
  function callUnanswered(o) {
    return Boolean(o) && o.inCall === true && o.answered !== true;
  }

  /* ══════════════════════════════════════════
     Key exchange
  ══════════════════════════════════════════ */

  /**
   * May a peer public key be accepted?
   *
   * Exactly one exchange per data channel. A second key was accepted at any
   * time, including on a fully established channel, and re-derived the
   * verification code without changing the key actually in use — so the code on
   * screen stopped matching the key, the two sides displayed different codes,
   * and the UI still said "verified". On a PIN join that code is the only thing
   * standing between the user and a middleman, so a peer being able to set it
   * to anything empties it of meaning.
   *
   * Re-keying is not a feature here: a fresh channel runs a fresh exchange.
   *
   * `peerKeySeen` must be set the moment the first key arrives, not once its
   * derivation finishes — deriving is async, and a second key arriving during
   * that window is exactly the case worth refusing.
   */
  function mayAcceptPeerKey(o) {
    return Boolean(o) && !o.peerKeySeen;
  }

  /**
   * What the shield in the chat header should say.
   *
   *   "idle"  no key agreed yet — there is nothing to vouch for
   *   "warn"  encrypted, but nobody has checked for a middleman: a PIN join
   *           whose verification code has not been compared
   *   "ok"    authenticated — by the invite-link secret, or by the two people
   *           comparing the code
   *
   * The shield is the only standing sign of which of these a chat is in. It
   * replaced a full-width warning banner, so it carries that banner's whole
   * job: a PIN join is the path a middleman would force, and amber is how the
   * user finds out it happened.
   *
   * Green therefore has exactly two ways in, and both need a key to exist
   * first. Nothing merely truthy counts.
   *
   * @param {{ready: boolean, secure: boolean, verified: boolean}} o
   */
  function shieldState(o) {
    if (!o || o.ready !== true) return "idle";
    return (o.secure === true || o.verified === true) ? "ok" : "warn";
  }

  /* ══════════════════════════════════════════
     Incoming messages
  ══════════════════════════════════════════ */

  /**
   * May an incoming text message be displayed?
   *
   * Only when the agreed key opened it. The sender never transmits an
   * unencrypted body, so one arriving is never a real peer — and rendering it
   * would undo failing closed: that disables sending, but a middleman caught
   * swapping keys could still write into the chat window.
   */
  function mayRenderText(msg, e2eReady) {
    return Boolean(e2eReady) && Boolean(msg) && typeof msg.ct === "string" && msg.ct.length > 0;
  }

  /**
   * The only message types that may arrive outside the encrypted envelope.
   *
   * The handshake has to — there is no key yet. `e2e-dc` is the envelope
   * itself. `text` carries its own ciphertext and answers to mayRenderText.
   * `ack` and `typing` say nothing a watcher of the connection could not
   * already see from packet timing.
   *
   * Everything else — file announcements, call setup — is sent sealed, so it
   * is only believed sealed.
   */
  const CLEAR_TYPES = Object.freeze([
    "e2e-pubkey", "e2e-confirm", "e2e-fail", "e2e-dc",
    /* SPAKE2 handshake for a code room — runs before any key exists, and
       carries only public values (a curve point, a confirmation tag). See
       pake.js. The word itself never travels; it is proven, not sent. */
    "pake-msg", "pake-confirm",
    "text", "ack", "typing", "typing-stop"
  ]);

  /**
   * May a message from the data channel be acted on?
   *
   * `sealed` is true only for what came out of the envelope, which means the
   * agreed key opened it and the peer wrote it. Anything else on the channel
   * could have been written by whoever is carrying the packets.
   *
   * That party is not hypothetical: a signaling server that swaps the transport
   * fingerprints sits on the channel, and can pass the key exchange through
   * untouched so everything still reads as verified. It cannot open the
   * envelope — but it could write next to it. A clear `transfer-meta` drew a
   * file bubble with any name it liked; a clear `call-request` raised the
   * incoming-call prompt, and a clear `call-offer` after it was accepted as the
   * peer's — a call answered to whoever sent it.
   *
   * This is a list of what may be clear, not of what must be sealed, so a
   * message type added later is refused in the clear until someone decides
   * otherwise. The check that came before this one covered `text` alone, and
   * every other type was open by default.
   */
  function mayHandleFrame(type, sealed) {
    if (typeof type !== "string") return false;
    if (sealed === true) return true;
    return CLEAR_TYPES.includes(type);
  }

  /* ══════════════════════════════════════════
     Voice notes
  ══════════════════════════════════════════ */

  /**
   * May a finished recording be sent?
   *
   * A recording belongs to the room it started in. The recorder outlives the
   * room otherwise: leave while recording, join somewhere else, press the
   * button again — the press reads as "start" to the user but takes the stop
   * branch, and the file goes to whoever is connected now. That delivered
   * minutes of audio, including time spent in the lobby, to someone who was
   * never in the original room.
   *
   * @param {{recordedIn: string|null, currentRoom: string|null,
   *          discarded: boolean, channelOpen: boolean}} o
   */
  function mayDeliverRecording(o) {
    if (!o || o.discarded) return false;
    if (!o.channelOpen) return false;
    if (!o.recordedIn || !o.currentRoom) return false;
    return o.recordedIn === o.currentRoom;
  }

  /**
   * May a press on the record button open the microphone?
   *
   * Opening it is not instant, and `recording` only turns true once it has
   * opened. Two presses inside that gap — an ordinary double-click — each
   * opened a stream. The second replaced the first in the one variable that
   * remembers it, so the first could never be stopped: the microphone stayed
   * on, with nothing on screen saying so, until the tab was closed.
   *
   * @param {{recording: boolean, opening: boolean}} o
   */
  function mayStartRecording(o) {
    return Boolean(o) && !o.recording && !o.opening;
  }

  /**
   * The microphone has just finished opening. Is it still wanted?
   *
   * The permission prompt can sit on screen for as long as the user likes, and
   * the room can end underneath it. The clean-up that runs when a room ends
   * found nothing to stop — the stream did not exist yet — so the microphone
   * came on afterwards, in the lobby, with no button left to turn it off.
   *
   * @param {{askedIn: string|null, currentRoom: string|null, channelOpen: boolean}} o
   */
  function mayKeepMicOpen(o) {
    if (!o || !o.channelOpen) return false;
    if (!o.askedIn || !o.currentRoom) return false;
    return o.askedIn === o.currentRoom;
  }

  /**
   * The formats a voice note is recorded in, best first. MP4 with AAC plays
   * everywhere this app runs: it is the only thing an iPhone records, and
   * Chrome and Edge record it too. WebM and Ogg are for a browser that makes
   * nothing else (Firefox).
   */
  const VOICE_FORMATS = Object.freeze([
    "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"
  ]);

  /**
   * Which format to ask the recorder for: the first of VOICE_FORMATS it says
   * it can make, or "" — let it choose — if it can make none of them, or
   * cannot be asked.
   *
   * Notes used to be recorded in whatever the browser chose, which on a
   * computer is WebM, and an iPhone showed "Error" in place of them.
   *
   * @param {(type: string) => boolean} isTypeSupported
   */
  function pickVoiceFormat(isTypeSupported) {
    if (typeof isTypeSupported !== "function") return "";
    for (const type of VOICE_FORMATS) {
      try { if (isTypeSupported(type)) return type; } catch (_) { return ""; }
    }
    return "";
  }

  /**
   * What a finished recording really is: the recorder's own word for it, or
   * its data's. Every note used to be labelled WebM, whatever it was — and an
   * iPhone records MP4, and picks how to play a sound by its label, so it
   * showed "Error" in place of its own notes. A recorder that calls a sound
   * "video/…" (some do, for MP4) is taken at its container.
   */
  function voiceType(recorderType, dataType) {
    for (const said of [recorderType, dataType]) {
      const type = baseType(said).replace(/^video\//, "audio/");
      if (/^audio\/[a-z0-9.+-]+$/.test(type)) return type;
    }
    return "audio/webm";
  }

  /** The name a voice note goes by, to match what it is. */
  function voiceFileName(type) {
    const base = baseType(type);
    return base === "audio/mp4" ? "voice.m4a" : base === "audio/ogg" ? "voice.ogg" : "voice.webm";
  }

  /** The shortest voice note sent. A tap with a second tap straight after
      records next to nothing — about a hundred bytes, which no phone can
      play — and showed as an error on both sides. */
  const MIN_VOICE_MS = 1000;

  /** Is this recording worth sending — long enough, and with anything in it? */
  function voiceLongEnough(ms, bytes) {
    return Number.isFinite(ms) && ms >= MIN_VOICE_MS && Number.isFinite(bytes) && bytes > 0;
  }

  /* ══════════════════════════════════════════
     Invite-link join
  ══════════════════════════════════════════ */

  /**
   * The socket dropped. Should the pending join be sent again on reconnect?
   *
   * Only when one was outstanding and never answered. Without this the retry
   * was skipped and no answer ever came, leaving the lobby disabled with
   * nothing to click — and the invite already stripped from the URL, so
   * reloading did not help either.
   */
  function shouldRetryAutoJoin(o) {
    return Boolean(o) && Boolean(o.isAutoJoin) && Boolean(o.joinSent) && !o.joined;
  }

  /**
   * The server refused a join. Where does the reason go?
   *
   * There are three ways to ask to join, and each has its own place for a "no":
   *
   *   "dialog"  a PIN typed into the dialog — the dialog is on screen and has a
   *             line for errors
   *   "toast"   a tap on an open room in the list — nothing is on screen for
   *             it, so it has to be said some other way
   *   "lobby"   an invite link — the lobby is waiting on it
   *
   * Decided by which join is still waiting for an answer, never by how the page
   * was opened. That was a real bug: a page that arrived by invite link kept
   * routing every later refusal to the lobby, so a wrong PIN typed afterwards
   * was reported behind the dialog and left its button dead.
   *
   * @param {{pinJoin: boolean, listJoin: boolean, autoJoinPage: boolean}} o
   * @returns {"dialog"|"toast"|"lobby"}
   */
  function joinRefusalTarget(o) {
    if (!o) return "dialog";
    if (o.pinJoin)      return "dialog";
    if (o.listJoin)     return "toast";
    if (o.autoJoinPage) return "lobby";
    return "dialog";
  }

  /* ══════════════════════════════════════════
     Code rooms (SPAKE2)
  ══════════════════════════════════════════ */

  /** How many wrong-code attempts a host accepts before locking the room for a
      cooldown. SPAKE2 already limits an attacker to one guess per connection;
      this caps how fast those guesses can be made at all. */
  const CODE_MAX_ATTEMPTS = 10;

  /** How long the room stays locked once the limit is reached. */
  const CODE_LOCK_MS = 5 * 60 * 1000;

  /**
   * A guest just failed the SPAKE2 check on a code room, or a new one is
   * about to try. May the host accept the attempt, or is it locked?
   *
   * The word is proven between the two phones, so the server cannot rate-limit
   * it — the host does, here. A short word has few possibilities, so without
   * this a stranger could reconnect and guess, one try per connection, as fast
   * as the link allows. After CODE_MAX_ATTEMPTS the host turns new guests away
   * until `until`.
   *
   * `failures` in the answer is the count to carry on with. A lock that has
   * run its course starts it again from nothing. It used to be kept, so the
   * room locked again the moment its lock ended, for good: ten wrong words,
   * and the right one was turned away for ever — which let any stranger shut
   * any listed code room.
   *
   * @param {{failures: number, now: number, lockedUntil: number}} o
   * @returns {{locked: boolean, until: number, failures: number}}
   */
  function codeAttemptState(o) {
    const now = (o && o.now) || 0;
    const failures = (o && o.failures) || 0;
    if (o && o.lockedUntil) {
      if (o.lockedUntil > now) return { locked: true, until: o.lockedUntil, failures };
      return { locked: false, until: 0, failures: 0 };      // served: a fresh count
    }
    if (failures >= CODE_MAX_ATTEMPTS) return { locked: true, until: now + CODE_LOCK_MS, failures };
    return { locked: false, until: 0, failures };
  }

  /** Seconds a code room's lock has left at `now`: 0 for none, or one that is
      over. The host tells a guest it turns away this, so it knows to wait. */
  function codeLockSecondsLeft(until, now) {
    if (!Number.isFinite(until) || !Number.isFinite(now) || until <= now) return 0;
    return Math.min(3600, Math.ceil((until - now) / 1000));
  }

  /** Whole minutes to tell a guest turned away from a locked room: at least
      one — "0 minutes" would mean now — and the lock's own length when the
      host did not say (an older page). */
  function lockMinutes(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return Math.round(CODE_LOCK_MS / 60000);
    return Math.max(1, Math.ceil(seconds / 60));
  }

  /* ══════════════════════════════════════════
     Received files
  ══════════════════════════════════════════ */

  /** Picture types a received "image" may be drawn and opened as. Raster only:
      an SVG is a document that can carry script. Anything else sent as a
      picture is offered as a download instead. */
  const SHOWABLE_IMAGE_TYPES = Object.freeze([
    "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/avif",
    "image/bmp", "image/heic", "image/heif"
  ]);

  /** How many transfers may be arriving at once. */
  const INCOMING_MAX_AT_ONCE = 16;

  /** The transfer id's shape: protocol.js makeTransferId, a v4 UUID. */
  const TRANSFER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  /** "Image/PNG; q=1" → "image/png". Empty for anything that is not a string. */
  function baseType(mimeType) {
    if (typeof mimeType !== "string") return "";
    return mimeType.split(";")[0].trim().toLowerCase();
  }

  /**
   * How a received file is shown, and the type its assembled blob is given.
   *
   * The blob's type is what the browser treats it as when it is opened, and
   * the sender chooses the type. A "picture" typed text/html, opened from the
   * chat — or a file link long-pressed into a new tab — would load as a page
   * from this site. So the sender's type is kept only when it can do nothing
   * but show: a raster picture, or sound. Everything else becomes a plain
   * download, typed application/octet-stream, which no browser renders.
   *
   * The sending side asks the same question, so a picture the receiver would
   * not draw is sent as a file in the first place, and both sides agree.
   *
   * @returns {{kind: "file"|"image"|"voice", blobType: string}}
   */
  /** What a pasted or dropped file is sent as: a picture if it says it is
      one — presentAs still decides whether it is drawn as one — else a file. */
  function droppedKind(type) {
    return /^image\//.test(baseType(type)) ? "image" : "file";
  }

  function presentAs(kind, mimeType) {
    const type = baseType(mimeType);
    if (kind === "image" && SHOWABLE_IMAGE_TYPES.includes(type)) return { kind: "image", blobType: type };
    if (kind === "voice" && /^audio\/[a-z0-9.+-]+$/.test(type))  return { kind: "voice", blobType: type };
    return { kind: "file", blobType: "application/octet-stream" };
  }

  /**
   * A transfer-meta has arrived: take the file, or turn it away?
   *
   * The sending app refuses anything over the limit before it sends — but the
   * other side can run a changed app, and nothing on this side checked. A
   * stranger in a room with no PIN could stream data until the phone filled up.
   *
   *   "malformed"  not a transfer this app could have sent
   *   "too-big"    over the per-file limit
   *   "busy"       too many arriving at once, or too many bytes between them
   *
   * The declared size is a promise, not a fact; app.js holds the sender to it
   * byte by byte as the file arrives (withinDeclaredSize).
   *
   * @param {{meta: object, maxBytes: number, budgetBytes: number,
   *          activeBytes: number, activeCount: number}} o
   * @returns {{ok: true, kind: string, blobType: string} | {ok: false, reason: string}}
   */
  function incomingTransfer(o) {
    const meta = o && o.meta;
    const refuse = reason => ({ ok: false, reason });
    if (!meta || typeof meta !== "object") return refuse("malformed");
    if (typeof meta.id !== "string" || !TRANSFER_ID.test(meta.id)) return refuse("malformed");
    if (meta.kind !== "file" && meta.kind !== "image" && meta.kind !== "voice") return refuse("malformed");
    if (!Number.isSafeInteger(meta.size) || meta.size < 0) return refuse("malformed");
    if (meta.totalChunks !== undefined &&
        (!Number.isSafeInteger(meta.totalChunks) || meta.totalChunks < 0)) return refuse("malformed");
    if (!(meta.size <= o.maxBytes)) return refuse("too-big");
    if ((o.activeCount || 0) >= INCOMING_MAX_AT_ONCE) return refuse("busy");
    if (!((o.activeBytes || 0) + meta.size <= o.budgetBytes)) return refuse("busy");
    return { ok: true, ...presentAs(meta.kind, meta.mimeType) };
  }

  /** Has a transfer still sent no more than it said it would? */
  function withinDeclaredSize(receivedBytes, declaredBytes) {
    return Number.isSafeInteger(receivedBytes) && Number.isSafeInteger(declaredBytes) &&
           receivedBytes >= 0 && receivedBytes <= declaredBytes;
  }

  /* ══════════════════════════════════════════
     Chat messages
  ══════════════════════════════════════════ */

  /**
   * The longest chat message, in characters.
   *
   * A message goes as one data-channel message, and an oversized one is not
   * delivered late or in pieces — send() throws, or the channel closes. That
   * used to happen silently: a long paste did nothing, and the text sat in the
   * box with no word as to why. 64 KB is the size every browser's channel
   * carries in one message; at the worst case of 3 UTF-8 bytes per character,
   * 10 000 characters sealed and base64-encoded is about 40 KB.
   */
  const MAX_MESSAGE_CHARS = 10000;

  /**
   * Does this Enter in the message box send the message, or start a new line?
   *
   * It always sent. On a phone — whose keyboard has no Shift to hold — a
   * message could not have a second line, and the keyboard's own ↵ key did
   * the opposite of what it shows. On a phone (`touch`: the pointer is a
   * finger) Enter now starts a new line and the send button sends; on a
   * computer Enter sends and Shift+Enter starts a line, as before. An Enter
   * that finishes a word still being composed — Chinese, Japanese or Korean
   * input — never sends: it used to send the half-written word.
   *
   * @param {{touch: boolean, shift: boolean, composing: boolean}} o
   */
  function enterSends(o) {
    if (!o || o.composing === true || o.shift === true) return false;
    return o.touch !== true;
  }

  /** May this message be sent — or, arriving, be shown? */
  function messageFits(text) {
    return typeof text === "string" && text.length <= MAX_MESSAGE_CHARS;
  }

  /** How many messages may wait for the link at once. */
  const OUTBOX_MAX = 100;

  /**
   * The link is down for a moment — a phone between networks, the other side
   * reopening the page. May a message written now wait for it, rather than
   * not go? Only in a chat on screen that has not ended, and that has been
   * connected once — so it is known who it is for — and not past OUTBOX_MAX.
   *
   * @param {{chatOpen: boolean, chatEnded: boolean, hadKey: boolean, waiting: number}} o
   */
  function mayQueueText(o) {
    return Boolean(o) && o.chatOpen === true && o.chatEnded !== true && o.hadKey === true &&
           Number.isInteger(o.waiting) && o.waiting < OUTBOX_MAX;
  }

  /**
   * May what waited go now? Only over a key agreed again, and checked at
   * least as well as the one it was written under: a chat that was green does
   * not send what waited into one that is amber.
   *
   * @param {{ready: boolean, wasGreen: boolean, green: boolean}} o
   */
  function mayFlushOutbox(o) {
    return Boolean(o) && o.ready === true && (o.wasGreen !== true || o.green === true);
  }

  /**
   * What the message box shows for a draft of `length` characters: a counter
   * once the draft is near the limit, marked over once it is past it.
   *
   * @returns {{counter: boolean, over: boolean}}
   */
  function draftState(length) {
    const n = Number.isFinite(length) ? length : 0;
    return { counter: n >= MAX_MESSAGE_CHARS * 0.9, over: n > MAX_MESSAGE_CHARS };
  }

  /* ══════════════════════════════════════════
     When the other side's link to the server drops
  ══════════════════════════════════════════ */

  /** ICE states in which the direct link is up, or may still come back. */
  const LINK_ALIVE = Object.freeze(["checking", "connected", "completed", "disconnected"]);

  /**
   * The server says the other side's connection to it dropped. Does that end
   * the chat?
   *
   * Once the two phones are connected the chat runs directly between them; the
   * server only introduced them. But a phone whose screen locks has its page
   * paused, and an iPhone cuts the page's link to the server almost at once.
   * The server saw that link drop and said "peer left", and the chat ended —
   * while the link between the phones was still up, or would have been as soon
   * as the screen came back on.
   *
   * So the server's word ends the chat only when the direct link is not up:
   * the channel never opened, or the link has already failed or closed.
   * Otherwise the chat carries on and the direct link decides — it closes when
   * the other side really leaves, and see linkLostForGood for when it fails.
   *
   * @param {{channelOpen: boolean, iceState: string}} o
   */
  function serverLeaveEndsChat(o) {
    if (!o || o.channelOpen !== true) return true;
    return !LINK_ALIVE.includes(o.iceState);
  }

  /**
   * The direct link has failed. Is it gone for good?
   *
   * A failed link is repaired by a fresh exchange through the server (an ICE
   * restart). Once the server has dropped the room there is nobody to carry
   * one, so a failure then is final — and the chat must say so, rather than
   * sit on "retrying" for ever.
   *
   * @param {{iceState: string, serverRoomGone: boolean}} o
   */
  function linkLostForGood(o) {
    return Boolean(o) && o.iceState === "failed" && o.serverRoomGone === true;
  }

  /* ══════════════════════════════════════════
     Reactions
  ══════════════════════════════════════════ */

  /** The reactions on offer, in the order the bar shows them. */
  const REACTIONS = Object.freeze(["👍", "❤️", "😂", "😮", "😢", "🙏"]);

  /** A message both sides can name: a text by its sender's number for it, a
      file, picture or voice note by its transfer id. */
  const REACTION_KEY = /^(?:t:\d{1,15}|f:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

  /**
   * The name both sides use for a message, or null for one that cannot be
   * named — then it cannot be reacted to. A text's number comes from its
   * sender, the other side's app included, so it is checked like anything
   * else that arrives.
   *
   * @param {"text"|"file"} kind
   */
  function reactionKey(kind, id) {
    const key = kind === "text" && Number.isSafeInteger(id) ? `t:${id}`
              : kind === "file" && typeof id === "string" ? `f:${id}` : null;
    return key && REACTION_KEY.test(key) ? key : null;
  }

  /**
   * May a reaction from the other side be shown? Only on a message both of
   * you can name, saying whose message it is (`mine`: the reactor's own), and
   * only one of the six — or none, taking one back. Anything else is not
   * drawn: a reaction is an emoji, never a way to put other words on screen.
   */
  function reactionValid(o) {
    return Boolean(o) && typeof o.key === "string" && REACTION_KEY.test(o.key) &&
           typeof o.mine === "boolean" && (o.emoji === "" || REACTIONS.includes(o.emoji));
  }

  /** Picking the reaction you already gave takes it back; any other replaces it. */
  function nextReaction(current, picked) {
    return current === picked ? "" : picked;
  }

  /** What a message's badge shows: each emoji given, theirs first, and "2"
      when you both gave the same one. */
  function reactionBadge(mine, theirs) {
    const shown = [];
    for (const emoji of [theirs, mine]) {
      if (!emoji) continue;
      const same = shown.find(s => s.emoji === emoji);
      if (same) same.count++;
      else shown.push({ emoji, count: 1 });
    }
    return shown;
  }

  /* ══════════════════════════════════════════
     Links in a message
  ══════════════════════════════════════════ */

  /** Where a link may start: a web address, or one beginning "www.". */
  const LINK_START = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;

  /** A sentence's punctuation after an address is the sentence's: "see x.com."
      A closing bracket stays when the address opened one, as Wikipedia's do. */
  function trimLinkEnd(raw) {
    const count = (s, ch) => s.split(ch).length - 1;
    let out = raw;
    for (;;) {
      const last = out.slice(-1);
      if (/[.,!?;:'"’”»…]/.test(last)) { out = out.slice(0, -1); continue; }
      const open = { ")": "(", "]": "[", "}": "{" }[last];
      if (open && count(out, open) < count(out, last)) { out = out.slice(0, -1); continue; }
      return out;
    }
  }

  /** Where an address really goes — or null for anything that is not plainly
      a web page: another scheme, no host, or a host hidden behind "name@",
      which reads as one site and opens another. */
  function linkHref(raw) {
    let url;
    try { url = new URL(/^www\./i.test(raw) ? `https://${raw}` : raw); } catch (_) { return null; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || url.username || url.password) return null;
    return url.href;
  }

  /**
   * A message cut into its words and its links, so a web address can be
   * tapped rather than copied. Only http and https become links — never
   * javascript:, data: or anything else a message could hold — and each is
   * shown as it was written, opening where it really goes (`href`).
   *
   * @returns {{text: string, href?: string}[]}
   */
  function splitLinks(text) {
    const s = typeof text === "string" ? text : "";
    const parts = [];
    let done = 0;
    for (const m of s.matchAll(LINK_START)) {
      const raw = trimLinkEnd(m[0]);
      const href = raw && linkHref(raw);
      if (!href) continue;
      if (m.index > done) parts.push({ text: s.slice(done, m.index) });
      parts.push({ text: raw, href });
      done = m.index + raw.length;
    }
    if (done < s.length) parts.push({ text: s.slice(done) });
    return parts;
  }

  /* ══════════════════════════════════════════
     The phone's Back button during a chat
  ══════════════════════════════════════════ */

  /** A chat is on screen and has not ended — the Back-to-lobby button is what
      an ended chat shows. */
  function chatIsLive(o) {
    return Boolean(o) && o.chatOpen === true && o.chatEnded !== true;
  }

  /**
   * The phone's Back button (or the swipe that means the same) was pressed.
   * What does it do?
   *
   *   "ignore"  no chat on screen: it was ordinary navigation
   *   "close"   a picture is open over the chat: Back closes it, as it closes
   *             a picture in any app — the chat, ended or not, stays
   *   "mini"    a call fills the screen: Back makes it small and shows the
   *             chat, as the call's own chat button does — the call goes on.
   *             Reported: Back in a call asked "Leave the chat?" over it,
   *             one tap from ending the call and the chat together
   *   "lobby"   the chat has ended already: just go back to the lobby
   *   "stay"    the "Leave the chat?" question is up: Back answers it — stay
   *   "ask"     a chat that is on: ask before ending it
   *
   * To a phone, Back means "leave this page", so it used to close the page and
   * the chat with it — for both people, in the middle of a sentence.
   *
   * @param {{chatOpen: boolean, chatEnded: boolean, asking: boolean, viewing: boolean, callFull: boolean}} o
   */
  function backPress(o) {
    if (!o || o.chatOpen !== true) return "ignore";
    if (o.viewing === true) return "close";
    if (o.callFull === true) return "mini";
    if (o.chatEnded === true) return "lobby";
    if (o.asking === true) return "stay";
    return "ask";
  }

  /**
   * The chat's channel has closed — the other side has left — during a call.
   * What becomes of the call?
   *
   *   "none"    no call: nothing to end
   *   "missed"  theirs was still ringing here: a missed call, as a hang-up
   *             while ringing is
   *   "ended"   a call was on: it ends now, and says so
   *
   * Reported: when one side left during a call — the X, then Leave — the
   * other's call froze on "Reconnecting…" for half a minute, then said the
   * connection had dropped. Leaving ended the call only on the side that
   * left; the other waited for its own recovery to give up. The call cannot
   * go on without the channel that carries its signalling, and the person
   * has gone, so it ends with the chat, as a hang-up would.
   *
   * @param {{inCall: boolean, ringingHere: boolean}} o
   */
  function callWhenChatCloses(o) {
    if (!o) return "none";
    if (o.ringingHere === true) return "missed";
    if (o.inCall === true) return "ended";
    return "none";
  }

  /**
   * The X at the top of the chat was pressed. Ask before leaving?
   *
   * Reported: the arrow that was there read as "back", not as "end the chat
   * for both of us", and it left at once. Now it is an X and, pressed by
   * hand in a chat that is on, asks first — the same question Back asks.
   * The app's own clicks on it (the question's Leave, an ended chat's way
   * back) are not hands: they leave, as before.
   *
   * @param {{byHand: boolean, chatLive: boolean}} o
   */
  function leaveAsks(o) {
    return Boolean(o) && o.byHand === true && o.chatLive === true;
  }

  /* ══════════════════════════════════════════
     A connection that never comes up
  ══════════════════════════════════════════ */

  /**
   * The give-up time has passed since the chat screen opened. Is the
   * connection stuck — and worth telling the user about?
   *
   * Only while the chat screen is showing, and only if the channel between the
   * two devices never opened. A channel that opened and then failed its key
   * check has said so already (e2eFailClosed), and a chat that works needs
   * nothing said.
   *
   * @param {{chatOpen: boolean, channelOpen: boolean, keyAgreed: boolean}} o
   */
  function connectStalled(o) {
    return Boolean(o) && o.chatOpen === true && o.channelOpen !== true && o.keyAgreed !== true;
  }

  /* ══════════════════════════════════════════
     The host's own room
  ══════════════════════════════════════════ */

  /**
   * The link to the server has dropped. Was it holding a room — one this
   * browser made and is still waiting in for its guest?
   *
   * The server keeps such a room for a while and the host takes it back on
   * reconnecting (reclaim-session), so the PIN and the link already sent
   * still work. It used to be deleted with the socket, and the host kept
   * showing a PIN and a link for a room that no longer existed. Once the chat
   * has started the room is no longer needed — the chat runs directly — so
   * only a waiting room counts.
   *
   * @param {{isHost: boolean, hasSession: boolean, chatStarted: boolean}} o
   */
  function waitingRoomLost(o) {
    return Boolean(o) && o.isHost === true && o.hasSession === true && o.chatStarted !== true;
  }

  /** How long a page keeps the room it hosts, for taking back after a reload.
      A little past the server's own wait, so the server is the one to say no. */
  const HOST_ROOM_MAX_AGE_MS = 15 * 60 * 1000;

  /**
   * A waiting room this tab was hosting, as it was saved to sessionStorage —
   * usable to take the room back after a reload? The phone may close a page
   * in the background while its owner is off sending the link; opened again,
   * the page finds its room here. Only a well-formed, recent record counts;
   * anything else is thrown away rather than half-believed.
   *
   * @returns {object|null} the room, or null
   */
  function restorableHostRoom(stored, now) {
    if (!stored || typeof stored !== "object" || stored.v !== 1) return null;
    const { sessionId, hostKey, token, pin, kind, roomSecret, word, savedAt } = stored;
    for (const s of [sessionId, hostKey, token]) if (typeof s !== "string" || !s) return null;
    if (kind !== "pin" && kind !== "open" && kind !== "code") return null;
    if (kind === "pin" ? !(typeof pin === "string" && /^\d{6}$/.test(pin)) : pin !== null) return null;
    if (roomSecret !== null && (typeof roomSecret !== "string" || !roomSecret)) return null;
    if (kind === "code" ? !(typeof word === "string" && word) : word !== null) return null;
    if (!Number.isFinite(savedAt) || savedAt > now || now - savedAt > HOST_ROOM_MAX_AGE_MS) return null;
    return { sessionId, hostKey, token, pin, kind, roomSecret, word, savedAt };
  }

  /**
   * Is this room in the list the one this browser is hosting? It used to be
   * shown like any other, with a Join button that could only fail.
   *
   * @param {{sessionId: string, isHost: boolean, currentSessionId: string}} o
   */
  function isOwnRoom(o) {
    return Boolean(o) && o.isHost === true && typeof o.sessionId === "string" &&
           o.sessionId.length > 0 && o.sessionId === o.currentSessionId;
  }

  /* ══════════════════════════════════════════
     A call across a locked screen
  ══════════════════════════════════════════ */

  /**
   * May the call's camera be flipped to the other side now?
   *
   * Flipping opens a camera, so only in an agreed call (mayCaptureForCall).
   * Only when the call already has a camera in it: a flip swaps one camera for
   * the other, and must never be how video gets into a voice call. And not
   * while another change to the call's camera is under way — a second press,
   * or a restart after the screen was locked — since both swap tracks into the
   * same sender and the loser's camera would be left running.
   *
   * @param {{inCall: boolean, hasVideo: boolean, busy: boolean}} o
   */
  function mayFlipCamera(o) {
    return Boolean(o) && mayCaptureForCall(o.inCall) && o.hasVideo === true && !o.busy && !o.sharing;
  }

  /**
   * May this side start sharing its screen now?
   *
   * The browser asks which screen, window or tab, every time — that picker is
   * the consent, and nothing is shared without it. This only decides whether
   * the call is one to share into: an agreed call (mayCaptureForCall) that
   * already sends video, since the screen takes the camera's place in the same
   * sender. A voice call has no video to replace. Not while another change to
   * the call's devices is under way, and not where the browser cannot share
   * (no iPhone or iPad browser can).
   *
   * @param {{inCall: boolean, hasVideo: boolean, busy: boolean, supported: boolean}} o
   */
  function mayShareScreen(o) {
    return Boolean(o) && mayCaptureForCall(o.inCall) && o.hasVideo === true && !o.busy && o.supported === true;
  }

  /**
   * May the call's controls — its status, its figures, its buttons — fade
   * away for now?
   *
   * Reported: during a call they stayed on screen for good, over the other
   * person and over a shared screen. They step aside once there is something
   * behind them to see and nobody is using them: a video call, connected, with
   * no pointer resting on them and no keyboard moving through them. Before the
   * call connects they say what is happening; in a voice call there is
   * nothing behind them.
   *
   * @param {{inCall: boolean, connected: boolean, video: boolean,
   *          pointerOnControls: boolean, keyboardInControls: boolean}} o
   */
  function callChromeMayHide(o) {
    return Boolean(o) && o.inCall === true && o.connected === true && o.video === true &&
      !o.pointerOnControls && !o.keyboardInControls;
  }

  /**
   * Should the share button show? In a video call, where the browser can share.
   *
   * @param {{inCall: boolean, hasVideo: boolean, supported: boolean}} o
   */
  function shareOffered(o) {
    return Boolean(o) && o.inCall === true && o.hasVideo === true && o.supported === true;
  }

  /**
   * May the call's microphone be opened again because the phone's microphones
   * changed — headphones connected or taken off mid-call?
   *
   * On an iPhone a call's sound goes wherever its microphone is. Opened before
   * the headphones arrived, the microphone was the phone's own, and the other
   * person kept coming out of the speaker. Opening it again picks what the
   * phone now prefers, and the sound follows. Only in an agreed call
   * (mayCaptureForCall), only one that already has a microphone, and not while
   * another change to the call's devices is under way.
   *
   * @param {{inCall: boolean, hasAudio: boolean, busy: boolean}} o
   */
  function mayMoveMic(o) {
    return Boolean(o) && mayCaptureForCall(o.inCall) && o.hasAudio === true && !o.busy;
  }

  /**
   * What a change in the phone's microphones, mid-call, should do.
   *
   *   "mic"             open the microphone again, alone — headphones arriving:
   *                     the phone prefers theirs and the sound goes with it
   *   "mic-and-camera"  open both again, as a call starts — headphones taken
   *                     off in a video call. Reported: with the microphone
   *                     alone, the sound landed on the iPhone's quiet earpiece,
   *                     as for a voice call; a video call starts on the
   *                     loudspeaker, and opening both as it did brings that back.
   *   "none"            nothing that matters to the sound changed
   *
   * @param {{before: number, after: number, hasVideo: boolean}} o
   *        how many microphones the phone listed before and after
   */
  function micChangeAction(o) {
    if (!o || !Number.isFinite(o.before) || !Number.isFinite(o.after)) return "none";
    if (o.after < o.before && o.hasVideo === true) return "mic-and-camera";
    return "mic";
  }

  /**
   * The other person's voice, evened out as it arrives: a compressor brings
   * the quiet and the loud parts closer and lifts them both — by its own
   * make-up gain, which the Web Audio standard defines from these numbers
   * (about 17 dB here) — and a limiter keeps the loudest from distorting.
   * Measured in Edge's own Web Audio, with a voice-like sound: arriving
   * anywhere from -40 to -6 dB (34 dB apart) it comes out between -24 and -13
   * (11 dB apart), its peaks far from distorting; ordinary speech, -24 in,
   * comes out 6 dB louder, a far voice, -35 in, 13 dB louder. The hiss
   * between words is lifted by the make-up gain too, which is why the
   * threshold is no lower.
   */
  const VOICE_LEVELLER = Object.freeze({ threshold: -40, knee: 12, ratio: 4, attack: 0.01, release: 0.3,
                                         limit: -3, limitRatio: 20, limitAttack: 0.002, limitRelease: 0.1 });

  /**
   * Is the other person's voice evened out here? Wherever Web Audio is, and
   * there is a voice — but not on an iPhone or iPad, where a page's sound while
   * its microphone is open is the phone's own business, and a call has gone
   * silent there before for less: the plain way stays.
   *
   * @param {{webAudio: boolean, hasAudio: boolean, os: string}} o
   */
  function mayLevelVoice(o) {
    return Boolean(o) && o.webAudio === true && o.hasAudio === true && o.os !== "iphone" && o.os !== "ipad";
  }

  /**
   * Should the call show the loudspeaker button?
   *
   * On an iPhone or iPad a page has no way to choose the loudspeaker over the
   * earpiece; what it can do is open the microphone and camera again as a
   * video call starts, which is when the phone picks the loudspeaker. So only
   * there, and only in a video call — a voice call has no camera to open, and
   * opening one would be capture nobody agreed to.
   *
   * @param {{inCall: boolean, hasVideo: boolean, os: string}} o
   */
  function speakerOffered(o) {
    return Boolean(o) && o.inCall === true && o.hasVideo === true && (o.os === "iphone" || o.os === "ipad");
  }

  /**
   * Is there another side to flip to — should the flip button show?
   *
   * A phone or a tablet: more than one camera, and the one in use says which
   * way it faces. A computer's webcam says nothing about facing, and a second
   * webcam plugged into one is not "the other side"; there the button would
   * only fail.
   *
   * @param {{inCall: boolean, hasVideo: boolean, facing: string|undefined, cameras: number}} o
   */
  function flipCameraOffered(o) {
    return Boolean(o) && o.inCall === true && o.hasVideo === true &&
      (o.facing === "user" || o.facing === "environment") && o.cameras > 1;
  }

  /**
   * Which of our call's microphone and camera need starting again?
   *
   * A phone that locks mid-call may stop them for good — the track ends — and
   * nothing started them again: back on the screen, the call was still up,
   * but the other side heard and saw nothing until someone hung up and rang
   * again. Only "ended" counts. "Muted" is the phone pausing a track, and the
   * phone resumes it itself.
   *
   * Starting them again is opening the microphone and camera, so it happens
   * only in an agreed call (mayCaptureForCall), and only for what the call
   * already had: a voice call never gains a camera here.
   *
   * @param {{inCall: boolean, tracks: {kind: string, readyState: string}[]}} o
   * @returns {string[]} "audio", "video", both or neither
   */
  function tracksToRestart(o) {
    if (!o || !mayCaptureForCall(o.inCall) || !Array.isArray(o.tracks)) return [];
    const kinds = [];
    for (const t of o.tracks) {
      if (!t || t.readyState !== "ended") continue;
      if ((t.kind === "audio" || t.kind === "video") && !kinds.includes(t.kind)) kinds.push(t.kind);
    }
    return kinds;
  }

  /**
   * What the call screen says about the other side, if anything.
   *
   *   "away"          their page is hidden — screen locked, or another app —
   *                   as their app told ours
   *   "reconnecting"  the call's own link is down for now, and may come back
   *   null            nothing to say
   *
   * Without this a locked screen on the other side was a frozen picture, or
   * silence, with nothing to say why. Their own word comes first: it says why,
   * where the link can only say that something is wrong.
   *
   * @param {{inCall: boolean, peerAway: boolean, linkState: string}} o
   */
  function callPauseNote(o) {
    if (!o || o.inCall !== true) return null;
    if (o.peerAway === true) return "away";
    /* "failed" too: a failed call link is now worked on (callRecovery), not
       simply ended, so it is reconnecting as much as a disconnected one. */
    if (o.linkState === "disconnected" || o.linkState === "failed") return "reconnecting";
    /* Their phone paused their microphone and could not wake it (micCheck):
       said here, so silence is not taken for a fault at this end. */
    if (o.peerMicSilent === true) return "mic";
    return null;
  }

  /**
   * Is this side's microphone really sending sound in the call — and if not,
   * what now?
   *
   * Reported: an Android phone heard nothing at all from an iPhone, from the
   * start of the call, voice or video, now and then — while the iPhone heard
   * the Android phone. A phone can pause a page's microphone without ending
   * it: the track says it is muted (by the phone, not by the person), or it
   * stays live and sends nothing but zeros. Only a microphone that ended was
   * ever started again. Now one paused for a moment is opened again, and one
   * that will not come back is said on both sides.
   *
   *   "ok"      sending, or nothing to check: no call, no microphone, muted by
   *             the person themselves (silence they chose)
   *   "wait"    paused, but not for long yet — or the page is hidden, where a
   *             phone pauses capture for its own reasons
   *   "reopen"  open the microphone again (at most MIC_CHECK.reopens times)
   *   "tell"    still paused after that: say so, here and to the other side
   *
   * `pausedBy`: "phone" (the track's muted flag) or "zeros" (its level read
   * exactly 0 in the call's stats — a real microphone in a quiet room still
   * reads above 0 — and only until the microphone has sent any sound at all:
   * the fault was silence from the start, and once heard, quiet is someone
   * being quiet). Each has its own wait: the flag is the phone saying so,
   * zeros need longer to be sure.
   *
   * @param {{inCall: boolean, hasMic: boolean, userMuted: boolean, visible: boolean,
   *          pausedBy: "phone"|"zeros"|null, pausedFor: number, reopens: number}} o
   */
  const MIC_CHECK = Object.freeze({ phoneMs: 1500, zerosMs: 4000, reopens: 2 });
  function micCheck(o) {
    if (!o || o.inCall !== true || o.hasMic !== true || o.userMuted === true) return "ok";
    if (o.pausedBy !== "phone" && o.pausedBy !== "zeros") return "ok";
    if (o.visible !== true || !(o.pausedFor >= 0)) return "wait";
    if (o.pausedFor < (o.pausedBy === "phone" ? MIC_CHECK.phoneMs : MIC_CHECK.zerosMs)) return "wait";
    return o.reopens < MIC_CHECK.reopens ? "reopen" : "tell";
  }

  /**
   * What a call whose own link is down should do now.
   *
   * Reported, asking how to make connections steadier: a call whose link
   * failed — Wi-Fi to mobile data mid-call, a moment without signal — simply
   * ended, while the chat beside it tried again. Now the call tries too: the
   * side that placed it asks for a fresh route (an ICE restart) over the
   * chat's channel — one side only, so two offers never cross — after a few
   * seconds down, and again now and then; both sides give up once it has been
   * down long enough to be gone.
   *
   *   "none"     the link is up, or this is not a link that is down
   *   "wait"     down, and nothing to do yet
   *   "restart"  ask for a fresh route now (the side that placed the call)
   *   "give-up"  down too long: end the call, and say why
   *
   * @param {{state: string, offerer: boolean, downFor: number,
   *          sinceRestart: number, restarts: number}} o  times in ms
   */
  /**
   * What the chat's own link, when it is down, should do now.
   *
   * Found assessing why calls did not survive a phone changing networks: the
   * chat's repair waited for the link to be declared failed — tens of seconds
   * — and only the host could start it; on "disconnected" the code called
   * restartIce(), which nothing then acted on. Now, a couple of seconds down,
   * the host makes a fresh offer through the server and the guest asks the
   * host to (repair-request) — the host alone offers, so two never cross —
   * again every few seconds, but only while the way through the server is
   * open: our seat there, theirs too. There is no giving up here: the room's
   * own wait for a side that does not come back ends the chat (peer-
   * disconnected), and so does the channel closing.
   *
   *   "none" | "wait" | "restart" (the host) | "ask" (the guest)
   *
   * @param {{state: string, host: boolean, downFor: number, sinceRepair: number,
   *          repairs: number, pathOpen: boolean}} o  times in ms
   */
  const CHAT_REPAIR = Object.freeze({ firstTryMs: 2000, retryMs: 6000 });
  function chatRepair(o) {
    if (!o || (o.state !== "disconnected" && o.state !== "failed")) return "none";
    if (!(o.downFor >= 0) || o.pathOpen !== true) return "wait";
    if (o.downFor < CHAT_REPAIR.firstTryMs) return "wait";
    if (o.repairs > 0 && !(o.sinceRepair >= CHAT_REPAIR.retryMs)) return "wait";
    return o.host === true ? "restart" : "ask";
  }

  const CALL_RECOVER = Object.freeze({ firstTryMs: 3000, retryMs: 8000, giveUpMs: 30000 });
  function callRecovery(o) {
    if (!o || (o.state !== "disconnected" && o.state !== "failed")) return "none";
    if (!(o.downFor >= 0)) return "wait";
    if (o.downFor >= CALL_RECOVER.giveUpMs) return "give-up";
    if (o.offerer === true && o.downFor >= CALL_RECOVER.firstTryMs &&
        (o.restarts === 0 || o.sinceRestart >= CALL_RECOVER.retryMs)) return "restart";
    return "wait";
  }

  /* ══════════════════════════════════════════
     Telling you something arrived
  ══════════════════════════════════════════ */

  /**
   * Is nobody looking at this page — another tab, another app, or another
   * window in front of it? Then a message arriving needs a sound and a count
   * in the title to be noticed at all.
   *
   * @param {{visibility: string, focused: boolean}} o
   */
  function unattended(o) {
    return Boolean(o) && (o.visibility === "hidden" || o.focused === false);
  }

  /**
   * The tab's title: "(2) Өртөө" for two unread, with a phone in front
   * while a call rings. Past 99 it says "99+", as a badge would.
   *
   * @param {{base: string, unread: number, ringing: boolean}} o
   */
  function tabTitle(o) {
    const base = String((o && o.base) || "");
    const n = o && Number.isSafeInteger(o.unread) && o.unread > 0 ? o.unread : 0;
    const count = n ? `(${n > 99 ? "99+" : n}) ` : "";
    return `${o && o.ringing === true ? "📞 " : ""}${count}${base}`;
  }

  /* ══════════════════════════════════════════
     Opened inside another app's browser
  ══════════════════════════════════════════ */

  /* What each app writes into its built-in browser's user agent. Messenger
     before Facebook: Messenger's says FBAN too. */
  const IN_APP_TOKENS = Object.freeze([
    [/FBAN\/Messenger|MessengerForiOS|MessengerLite|Orca-Android/, "Messenger"],
    [/FBAN|FBAV|FB_IAB|FBIOS|FB4A/, "Facebook"],
    [/Instagram/, "Instagram"],
    [/Barcelona/, "Threads"],
    [/musical_ly|BytedanceWebview|TikTok/, "TikTok"],
    [/\bLine\/\d/, "LINE"],
    [/Snapchat/, "Snapchat"],
    [/MicroMessenger/, "WeChat"],
    [/KAKAOTALK/i, "KakaoTalk"],
    [/LinkedInApp/, "LinkedIn"],
    [/Twitter/, "X"]
  ]);

  /**
   * Is this page open inside another app's built-in browser — Facebook's,
   * Instagram's, Messenger's — rather than Safari or Chrome?
   *
   * Such a browser is run by the app, which can add its own code to the pages
   * it shows; it often may not use the camera or microphone; and it closes,
   * taking the chat with it, when the app is left. A link sent through one of
   * these apps opens in it by default.
   *
   * Known apps by name; otherwise an Android WebView (its user agent says
   * "wv"), or an iPhone browser that does not call itself Safari — which an
   * iPhone home-screen app does not either, so running installed is never
   * taken for this.
   *
   * @param {{userAgent: string, maxTouchPoints: number, standalone: boolean}} o
   * @returns {{app: string|null, os: "ios"|"android"|"other"}|null}
   */
  function inAppBrowser(o) {
    const ua = String((o && o.userAgent) || "");
    if (!ua || o.standalone === true) return null;
    const ios = isAppleTouchDevice(ua, o.maxTouchPoints);
    const os = ios ? "ios" : /Android/.test(ua) ? "android" : "other";
    for (const [token, app] of IN_APP_TOKENS) if (token.test(ua)) return { app, os };
    if (os === "android" && /; wv\)/.test(ua)) return { app: null, os };
    if (ios && !/Safari\//.test(ua)) return { app: null, os };
    return null;
  }

  /**
   * Which ways out to offer. On an iPhone, a button that hands the whole
   * address — the invite included — to Safari (safariUrl). On Android, a
   * button for the default browser only when there is no invite in the
   * address: Android's way of doing it cannot carry the address's #fragment,
   * which is where an invite keeps its secret. Everywhere: the app's own
   * "Open in browser", and copying the link.
   *
   * @param {{inApp: object|null, hasInvite: boolean}} o
   */
  function inAppAdvice(o) {
    const os = o && o.inApp && o.inApp.os;
    return { safari: os === "ios", openDefault: os === "android" && o.hasInvite !== true };
  }

  /** The address that opens this page in Safari from inside an app on an
      iPhone, the whole of it — fragment and all. Null for anything not web. */
  function safariUrl(href) {
    return typeof href === "string" && /^https?:\/\//.test(href) ? `x-safari-${href}` : null;
  }

  /** The address that opens this page in Android's default browser from inside
      an app. Never for an address with a fragment: it could not carry it, and
      an invite's secret is in it. */
  function androidIntentUrl(href) {
    let u;
    try { u = new URL(href); } catch (_) { return null; }
    if (u.protocol !== "https:" || u.hash) return null;
    return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;end`;
  }

  /* ══════════════════════════════════════════
     Installing as an app
  ══════════════════════════════════════════ */

  /** An iPhone or iPad. iPadOS describes itself as a Mac, so a Mac with a
      touch screen counts too — no Mac has one. */
  function isAppleTouchDevice(userAgent, maxTouchPoints) {
    const ua = String(userAgent || "");
    if (/iPhone|iPad|iPod/.test(ua)) return true;
    return /Macintosh/.test(ua) && Number(maxTouchPoints) > 1;
  }

  /**
   * What the Install button does here, if anything.
   *
   *   "prompt"    the browser has offered to install this site (Chrome, Edge,
   *               Samsung Internet — beforeinstallprompt): the button asks it to
   *   "ios-help"  an iPhone or iPad, where no page can install itself: the
   *               button shows the taps that do it by hand
   *   "none"      already running as the installed app, or a browser that
   *               cannot install a site at all (Firefox): no button
   *
   * Running installed wins over everything: a button offering to install the
   * app you are already in would be nonsense. So does being inside another
   * app's browser (Facebook's, Instagram's): nothing can be installed from
   * there, and the iPhone steps — Share, Add to Home Screen — are not on offer.
   *
   * @param {{standalone: boolean, canPrompt: boolean, userAgent: string, maxTouchPoints: number, inApp: boolean}} o
   * @returns {"prompt"|"ios-help"|"none"}
   */
  function installOffer(o) {
    if (!o || o.standalone === true || o.inApp === true) return "none";
    if (o.canPrompt === true) return "prompt";
    if (isAppleTouchDevice(o.userAgent, o.maxTouchPoints)) return "ios-help";
    return "none";
  }

  /* ══════════════════════════════════════════
     Saved people
  ══════════════════════════════════════════ */

  /** A saved person's secret: 32 random bytes in base64url (makeRoomSecret). */
  const SAVED_SECRET = /^[A-Za-z0-9_-]{43}$/;
  /** The room two saved people meet in: "~" and a SHA-256 in base64url
      (savedRoomName in protocol.js). */
  const SAVED_ROOM = /^~[A-Za-z0-9_-]{43}$/;
  const PERSON_NAME_MAX = 40;
  const SAVED_PEOPLE_MAX = 50;

  /**
   * A name for a saved person, as typed: control characters and the marks
   * that turn text round taken out, runs of spaces made one, the ends trimmed,
   * and no more than PERSON_NAME_MAX characters — counted as characters, so
   * an emoji is never cut in half. Nothing left is no name. The name is this
   * device's alone; nothing the other side sends goes into it.
   */
  function personName(raw) {
    if (typeof raw !== "string") return null;
    const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, "")
                     .replace(/\s+/g, " ").trim();
    return Array.from(clean).slice(0, PERSON_NAME_MAX).join("").trim() || null;
  }

  /**
   * The people saved on this device, read back from storage. Each is a key to
   * a room, so they are checked like anything else that arrives: only
   * well-formed entries, each secret and room once, at most SAVED_PEOPLE_MAX.
   * Anything else is left out rather than half-believed.
   *
   * @returns {{name: string, secret: string, room: string, side: "a"|"b", savedAt: number}[]}
   */
  function savedPeople(stored) {
    const list = stored && typeof stored === "object" && stored.v === 1 && Array.isArray(stored.people)
      ? stored.people : [];
    const out = [];
    const seen = new Set();
    for (const p of list) {
      if (!p || typeof p !== "object") continue;
      const name = personName(p.name);
      if (!name) continue;
      if (typeof p.secret !== "string" || !SAVED_SECRET.test(p.secret)) continue;
      if (typeof p.room !== "string" || !SAVED_ROOM.test(p.room)) continue;
      if (p.side !== "a" && p.side !== "b") continue;
      if (seen.has(p.secret) || seen.has(p.room)) continue;
      seen.add(p.secret);
      seen.add(p.room);
      out.push({ name, secret: p.secret, room: p.room, side: p.side, savedAt: Number.isFinite(p.savedAt) ? p.savedAt : 0,
                 /* Where to knock for them, if they have alerts on — a bad
                    one is dropped, not the person. */
                 ...(knockAddressValid(p.knock) ? { knock: { endpoint: p.knock.endpoint, p256dh: p.knock.p256dh, auth: p.knock.auth } } : {}) });
      if (out.length === SAVED_PEOPLE_MAX) break;
    }
    return out;
  }

  /**
   * May this chat offer to save the person in it? Only once nobody can be in
   * the middle — the shield green, by an invite link, a shared word or the
   * code compared. The secret that saves them goes over this chat to whoever
   * is at the other end of it: a middleman in an amber chat would be handed the
   * key to every chat after. Not in a saved person's own room: they are saved.
   *
   * @param {{ready: boolean, secure: boolean, verified: boolean, savedRoom: boolean}} o
   */
  function mayOfferSave(o) {
    return shieldState(o) === "ok" && o.savedRoom !== true;
  }

  /** An offer to save each other, as it arrived: believed only with a secret
      of the shape this app makes. The other side chose it, and nothing else
      of the offer is used. */
  function saveOfferValid(data) {
    return Boolean(data) && typeof data.secret === "string" && SAVED_SECRET.test(data.secret);
  }

  /**
   * Both pressed Save at once, and the two offers crossed. Both sides keep the
   * one with the greater secret, so both save the same one: true when theirs
   * is it, and this side answers it with the name it already gave them.
   */
  function keepTheirOffer(mine, theirs) {
    return typeof mine === "string" && typeof theirs === "string" && theirs > mine;
  }

  /**
   * May the host take a key agreed with no secret? In every other room the
   * host works out two keys, with the invite link's secret and without, since
   * a guest may have come in by PIN or from the list. A saved person's room
   * has neither: the secret is the only way in, and a key without it is
   * someone else — the server, or whoever it told the room's name.
   */
  function mayUsePlainKey(roomKind) {
    return roomKind !== "saved";
  }

  /* ══════════════════════════════════════════
     Waiting messages
  ══════════════════════════════════════════ */

  const MAIL_THREAD_MAX = 200;    // messages kept per person on this device
  const MAIL_SEEN_MAX   = 500;    // ids remembered per person, so none is shown twice
  const MAIL_ID = /^[A-Za-z0-9_-]{22}$/;
  const MAIL_STATES = ["sending", "kept", "refused"];
  const MAIL_FILE_MAX = 50 * 1024 * 1024;   // a photo or file that waits: the Pi keeps this much, sealed

  /** A waiting photo or file, as described in its message: a name to show, a
      type (only ever believed as presentAs allows), its size in bytes. */
  function mailFileValid(file) {
    return Boolean(file) && typeof file === "object" &&
           typeof file.name === "string" && file.name.length >= 1 && file.name.length <= 255 &&
           typeof file.type === "string" && file.type.length <= 100 &&
           Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= MAIL_FILE_MAX;
  }

  /** The other side of a saved pair. */
  function otherSide(side) {
    return side === "a" ? "b" : side === "b" ? "a" : null;
  }

  /** A note in the owner's inbox says who left it — as they wrote it, maybe
      nothing — and only a note may hold words and a file together. */
  function noteFromValid(m) {
    return (m.from === undefined || (m.mine === false && typeof m.from === "string" && m.from.length <= 200)) &&
           (m.got === undefined || Number.isSafeInteger(m.got));
  }

  /**
   * The conversations kept on this device, read back from storage — each
   * person's messages (theirs and ours) and when they were last read, and the
   * ids already taken, so a message delivered again is not shown again. Only
   * well-formed entries are believed, at most MAIL_THREAD_MAX a person.
   *
   * @returns {{v: 1, threads: object, seen: object}}
   */
  function mailStore(stored) {
    const out = { v: 1, threads: {}, seen: {} };
    if (!stored || typeof stored !== "object" || stored.v !== 1) return out;
    for (const [room, thread] of Object.entries(stored.threads || {})) {
      if (!SAVED_ROOM.test(room) || !thread || !Array.isArray(thread.items)) continue;
      const items = thread.items.filter(m => m && typeof m === "object" && MAIL_ID.test(m.id) && Number.isSafeInteger(m.at) &&
        typeof m.mine === "boolean" && noteFromValid(m) &&
        (m.file === undefined ? typeof m.text === "string" && messageFits(m.text)
                              : mailFileValid(m.file) && (m.text === undefined || (m.from !== undefined && messageFits(m.text)))) &&
        (m.mine ? MAIL_STATES.includes(m.state) : m.state === undefined));
      out.threads[room] = { read: Number.isSafeInteger(thread.read) ? thread.read : 0,
                            items: items.sort((x, y) => x.at - y.at).slice(-MAIL_THREAD_MAX) };
    }
    for (const [room, ids] of Object.entries(stored.seen || {})) {
      if (SAVED_ROOM.test(room) && Array.isArray(ids)) out.seen[room] = ids.filter(id => typeof id === "string" && MAIL_ID.test(id)).slice(-MAIL_SEEN_MAX);
    }
    return out;
  }

  /** Their messages not yet read. */
  function mailUnread(thread) {
    if (!thread || !Array.isArray(thread.items)) return 0;
    return thread.items.filter(m => !m.mine && arrivedAt(m) > (thread.read || 0)).length;
  }

  /** When a message reached this device: `got`, where it was noted — a note's
      `at` is the sender's clock, which may be off — or else its `at`. */
  function arrivedAt(m) {
    return Number.isSafeInteger(m.got) ? m.got : m.at;
  }

  const MAIL_REFUSALS = Object.freeze({ "full": "mailBoxFull", "server-full": "mailServerFull", "too-many": "mailTooMany",
                                       "off": "mailFilesOff", "too-large": "mailFileTooBig", "busy": "mailTryLater" });

  /** Why the server would not keep a message, in our words: the key for it.
      A code this page does not know is just "not sent". */
  function mailRefusalKey(code) {
    return typeof code === "string" && Object.prototype.hasOwnProperty.call(MAIL_REFUSALS, code) ? MAIL_REFUSALS[code] : "mailNotSent";
  }

  /* ══════════════════════════════════════════
     Knocks
  ══════════════════════════════════════════ */

  /**
   * Where to knock for someone, as their device sent it: the push subscription
   * that wakes it. Believed only in the shape a browser makes — a web address,
   * the browser's P-256 public key, its 16-byte secret — since it is kept,
   * and handed to the server with each knock. Which push services the server
   * will actually send to is the server's own list (knock.js).
   */
  function knockAddressValid(a) {
    if (!a || typeof a !== "object") return false;
    const { endpoint, p256dh, auth } = a;
    return typeof endpoint === "string" && endpoint.length <= 1024 && /^https?:\/\/[^\s/?#@]+\/\S*$/.test(endpoint) &&
           typeof p256dh === "string" && /^B[A-Za-z0-9_-]{86}$/.test(p256dh) &&
           typeof auth === "string" && /^[A-Za-z0-9_-]{22}$/.test(auth);
  }

  /**
   * What the alerts switch shows, if anything.
   *
   *   "hidden"   the server sends no knocks, or this browser cannot get them
   *   "install"  an iPhone or iPad in Safari: only an app on the Home Screen
   *              can get them there, so the switch says how
   *   "blocked"  notifications refused in the browser's settings
   *   "on"       subscribed, and allowed to show them
   *   "off"      anything else: a tap asks
   *
   * @param {{serverKey: boolean, supported: boolean, appleTouch: boolean, standalone: boolean,
   *          permission: string, subscribed: boolean}} o
   */
  function knockState(o) {
    if (!o || o.serverKey !== true) return "hidden";
    if (o.supported !== true) return o.appleTouch === true && o.standalone !== true ? "install" : "hidden";
    if (o.permission === "denied") return "blocked";
    return o.permission === "granted" && o.subscribed === true ? "on" : "off";
  }

  /* ══════════════════════════════════════════
     The server's refusals, in the user's language
  ══════════════════════════════════════════ */

  /** Why the server would not make a room, as it says it, to the words for it. */
  const SERVER_ERROR_KEYS = Object.freeze({
    "invalid-name": "roomNameInvalid",
    "name-taken": "roomNameTaken",
    "too-many-rooms": "tooManyRooms"
  });

  /**
   * The words for a refusal the server named with a code. Its message is
   * English, and used to be shown as it came — to Mongolian readers too. A
   * code this page does not know (a newer server) has none: the caller falls
   * back to that message.
   */
  function serverErrorKey(code) {
    return typeof code === "string" && Object.prototype.hasOwnProperty.call(SERVER_ERROR_KEYS, code)
      ? SERVER_ERROR_KEYS[code] : null;
  }

  /* ══════════════════════════════════════════
     Room events from the server
  ══════════════════════════════════════════ */

  /**
   * The server says something happened to a room. Is it the one on screen?
   *
   * These messages used to name no room, and the client assumed they meant the
   * current one. A browser that had opened a room and then moved to another
   * still heard about the first: ten minutes on, when it expired, "the other
   * side left" arrived and closed the live chat in the second.
   *
   * A message with no room at all is believed, for an older server that does
   * not name one yet. One that names a different room never is.
   *
   * @param {{eventRoom: string|null|undefined, currentRoom: string|null}} o
   */
  function mayApplyRoomEvent(o) {
    if (!o || !o.currentRoom) return false;
    if (o.eventRoom === undefined || o.eventRoom === null) return true;
    return o.eventRoom === o.currentRoom;
  }

  /* ══════════════════════════════════════════
     Updates
  ══════════════════════════════════════════ */

  /** `202610131742-3fa9c1d2` — when it was built, then a hash of what was
      built. Written by tools/sync-build.js. */
  const BUILD_ID = /^\d{12}-[0-9a-f]{8}$/;

  /**
   * Is build `a` later than build `b`?
   *
   * True only for two well-formed ids. One of them arrives from the server, and
   * something malformed must never talk a page into reloading itself.
   */
  function isNewerBuild(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (!BUILD_ID.test(a) || !BUILD_ID.test(b)) return false;
    return a.slice(0, 12) > b.slice(0, 12);
  }

  /**
   * The server has said which build it is. What should this page do about it?
   *
   *   "none"    the same build — or the server is the older one, which happens
   *             for a few minutes while it is still restarting after an update
   *   "reload"  this page is out of date and nothing is going on: fetch the new one
   *   "later"   out of date, but someone is mid-chat, mid-join or mid-sentence —
   *             remember it and fetch the new page once they are done
   *   "notify"  out of date, and a fresh page was already fetched without
   *             getting a newer one — the update has not finished arriving, and
   *             fetching again would only loop
   *
   * This is what makes a page that was left open notice an update. Without it
   * a tab from before the update kept running the old code for as long as it
   * stayed open: its owner saw a room that needs no PIN drawn as one that does,
   * was asked for a PIN that did not exist, and could not get in.
   *
   * @param {{serverBuild: string, pageBuild: string, retriedFor: string|null,
   *          recentlyReloaded: boolean, busy: boolean}} o
   */
  function updateAction(o) {
    if (!o || !isNewerBuild(o.serverBuild, o.pageBuild)) return "none";
    if (o.recentlyReloaded) return "notify";
    if (typeof o.retriedFor === "string" && o.retriedFor.indexOf(o.serverBuild) === 0) return "notify";
    return o.busy ? "later" : "reload";
  }

  return {
    isNewerBuild, updateAction,
    mayCaptureForCall, consentedVideo, CALL_RING_MS, callUnanswered,
    mayAcceptPeerKey, shieldState,
    CODE_MAX_ATTEMPTS, CODE_LOCK_MS, codeAttemptState, codeLockSecondsLeft, lockMinutes,
    SHOWABLE_IMAGE_TYPES, INCOMING_MAX_AT_ONCE, presentAs, droppedKind, incomingTransfer, withinDeclaredSize,
    MAX_MESSAGE_CHARS, messageFits, draftState, enterSends, OUTBOX_MAX, mayQueueText, mayFlushOutbox,
    isAppleTouchDevice, installOffer,
    LINK_ALIVE, serverLeaveEndsChat, linkLostForGood,
    tracksToRestart, mayFlipCamera, flipCameraOffered, mayMoveMic, micChangeAction, speakerOffered, VOICE_LEVELLER, mayLevelVoice,
    mayShareScreen, shareOffered, callChromeMayHide, callPauseNote, MIC_CHECK, micCheck, CALL_RECOVER, callRecovery,
    CHAT_REPAIR, chatRepair, unattended, tabTitle,
    waitingRoomLost, isOwnRoom, connectStalled, chatIsLive, backPress, leaveAsks, callWhenChatCloses, splitLinks,
    REACTIONS, reactionKey, reactionValid, nextReaction, reactionBadge,
    HOST_ROOM_MAX_AGE_MS, restorableHostRoom,
    SAVED_SECRET, SAVED_ROOM, PERSON_NAME_MAX, SAVED_PEOPLE_MAX,
    personName, savedPeople, mayOfferSave, saveOfferValid, keepTheirOffer, mayUsePlainKey,
    knockAddressValid, knockState,
    MAIL_THREAD_MAX, MAIL_SEEN_MAX, MAIL_FILE_MAX, mailFileValid, otherSide, mailStore, mailUnread, arrivedAt, mailRefusalKey,
    inAppBrowser, inAppAdvice, safariUrl, androidIntentUrl,
    CLEAR_TYPES, mayRenderText, mayHandleFrame,
    mayDeliverRecording, mayStartRecording, mayKeepMicOpen,
    VOICE_FORMATS, pickVoiceFormat, voiceType, voiceFileName, MIN_VOICE_MS, voiceLongEnough,
    shouldRetryAutoJoin, joinRefusalTarget,
    mayApplyRoomEvent, SERVER_ERROR_KEYS, serverErrorKey
  };
});
