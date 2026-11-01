/*
  RelayLink — app.js  v20260518
  ─────────────────────────────────────────────
  Dual-language support: Mongolian (default) / English
  All user-visible strings routed through t() / I18N
  ─────────────────────────────────────────────
*/

"use strict";

/* ══════════════════════════════════════════════
   IS THIS SCRIPT RUNNING IN THE PAGE THAT WAS BUILT WITH IT?
   ─────────────────────────────────────────────
   A browser keeps the page and each script on separate clocks, so after an
   update it can hold one from before and one from after. Old page plus this
   script was reproduced: the script looked for a button the old page does not
   have, threw while loading, and nothing on the page worked — not even the
   parts that had not changed.

   index.html loads this file as app.js?v=<build>. That stamp is the page saying
   which build it belongs to; APP_BUILD is this script saying which build it is.
   If they differ the page is the stale half, so fetch a fresh one and run
   nothing — before the invite is read, before a socket opens.

   This has to stand entirely on its own. It cannot use guards.js or i18n.js:
   in a mixed page those are exactly the files that cannot be trusted to match.

   APP_BUILD is written by tools/sync-build.js and by nothing else.
══════════════════════════════════════════════ */
const APP_BUILD = "202611010818-d4ccd1e7";

function refuseToRunInAStalePage() {
  let builtFor = null;
  try { builtFor = new URL(document.currentScript.src).searchParams.get("v"); }
  catch (_) { /* no script address to read — nothing to compare */ }
  if (!builtFor || builtFor === APP_BUILD) return;

  /* `?r=` marks a page we already went to fetch. The address is new to every
     cache between here and the server, so it comes back current — unless the
     update has not finished arriving, in which case asking again would only
     loop. Say so instead. The invite, if there is one, rides along in the
     fragment and is still never sent anywhere. */
  const alreadyFetched = String(new URLSearchParams(location.search).get("r") || "").startsWith(APP_BUILD);
  if (alreadyFetched) showStalePageNotice();
  else location.replace(`${location.pathname}?r=${encodeURIComponent(APP_BUILD)}${location.hash}`);

  throw new Error(`Stale page: built for ${builtFor}, but this script is ${APP_BUILD}. Not starting.`);
}

/** Shown only when fetching a fresh page did not produce one. Plain DOM and
    both languages spelled out: nothing else can be assumed to have loaded. */
function showStalePageNotice() {
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;background:#15151a;color:#e8e5de;" +
    "min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;" +
    "gap:14px;text-align:center;padding:24px;box-sizing:border-box";
  const mn = document.createElement("p");
  mn.textContent = "Шинэчлэл татагдаж байна. Түр хүлээгээд дахин ачаална уу.";
  mn.style.cssText = "margin:0;font-size:16px;font-weight:600";
  const en = document.createElement("p");
  en.textContent = "An update is still arriving. Wait a moment, then reload.";
  en.style.cssText = "margin:0;font-size:14px;color:#9b98a4";
  const again = document.createElement("a");
  /* A new address each time, so a retry is never answered from a cache that
     stored the stale page under the last one. */
  again.href = `${location.pathname}?r=${encodeURIComponent(APP_BUILD)}.${Date.now()}${location.hash}`;
  again.textContent = "Дахин ачаалах / Reload";
  again.style.cssText = "margin-top:6px;padding:10px 18px;border-radius:8px;background:#7fa8d4;color:#12121a;text-decoration:none;font-size:14px";
  wrap.append(mn, en, again);
  document.body.replaceChildren(wrap);
}

refuseToRunInAStalePage();

/* Wire-protocol primitives — invite links, key derivation, chunk framing.
   See protocol.js; it is loaded before this file and covered by test/. */
const DC = window.DCProtocol;

/* Derived connection facts and the safety decisions. Both are pure and tested
   directly — see connstats.js and guards.js, and test/ for what they promise. */
const DCS = window.DCStats;
const G   = window.DCGuards;

/* ── Read hash immediately ───────────────────── */
const _invite        = DC.parseInviteHash(location.hash);
const _autoSessionId = _invite.sessionId;
const _autoToken     = _invite.token;
const _autoSecret    = _invite.secret;
const _isAutoJoin    = _invite.isInvite;

/* Opened inside another app's own browser — Facebook's, Instagram's — where a
   link sent through that app lands by default. Until the person says where to
   go on, the invite stays in the address, so the app's "Open in browser"
   carries it across, and nothing joins: the seat is theirs, and it belongs to
   the browser they are about to open. See "Opened inside another app's
   browser" below. */
const _inApp = G.inAppBrowser({
  userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints, standalone: runningInstalled()
});
let inAppHold = Boolean(_inApp) && !inAppChosenHere();

function inAppChosenHere() {
  try { return sessionStorage.getItem("dc-inapp-continue") === "1"; } catch (_) { return false; }
}

if (_isAutoJoin && !inAppHold) history.replaceState({}, "", location.pathname);


/** Get a plain string from the current language */
function t(key) {
  return I18N[LANG][key] ?? I18N.en[key] ?? key;
}

/** Update all static DOM elements tagged with data-i18n / data-i18n-ph */
function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.dataset.i18n;
    const val = I18N[LANG][key];
    if (typeof val === "string") el.textContent = val;
    if (key === "leaveHint" && typeof val === "function") el.textContent = val(leaveAttachMaxMbRounded());
    else if (typeof val === "function" && "i18nArg" in el.dataset) el.textContent = val(el.dataset.i18nArg);
  });
  document.querySelectorAll("[data-i18n-ph]").forEach(el => {
    const key = el.dataset.i18nPh;
    const val = I18N[LANG][key];
    if (typeof val === "string") el.placeholder = val;
  });
  document.querySelectorAll("[data-i18n-aria]").forEach(el => {
    const val = I18N[LANG][el.dataset.i18nAria];
    if (typeof val === "string") el.setAttribute("aria-label", val);
  });
  // lang toggle active state
  document.querySelectorAll(".lang-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.lang === LANG);
  });
  // update document lang attribute
  document.documentElement.lang = LANG === "mn" ? "mn" : "en";
  // the tab's title names the app in this language: Өртөө or RelayLink
  drawTitle();
  // re-render session list so timeAgo labels update
  renderSessionList(_lastSessionList);
  drawPeople();
  // update voice record button title
  if (voiceRecordBtn) voiceRecordBtn.title = t("recordVoice");
  // update typing indicator if visible
  if (typingIndicator && !typingIndicator.classList.contains("hidden")) {
    typingIndicator.textContent = t("peerTyping");
  }
  // the path badge carries a translated label and tooltip — redraw both
  renderConnectionPath(_lastPath);
}

/* ── Language switcher ───────────────────────── */
document.querySelectorAll(".lang-btn").forEach(btn => {
  btn.onclick = () => {
    LANG = btn.dataset.lang;
    /* Storage blocked: the choice still holds, until the page is closed. */
    try { localStorage.setItem("lang", LANG); } catch (_) {}
    applyI18n();
  };
});

/* ── DOM refs ────────────────────────────────── */
const aboutDropdown    = document.getElementById("aboutDropdown");
const lobbyScreen      = document.getElementById("lobbyScreen");
const chatScreen       = document.getElementById("chatScreen");
const sessionIdInput   = document.getElementById("sessionId");
const createBtn        = document.getElementById("createBtn");
const createOpenBtn    = document.getElementById("createOpenBtn");
const createCodeBtn    = document.getElementById("createCodeBtn");
const codeOverlay      = document.getElementById("codeOverlay");
const codeTitle        = document.getElementById("codeTitle");
const codeHint         = document.getElementById("codeHint");
const codeInput        = document.getElementById("codeInput");
const codeConfirmBtn   = document.getElementById("codeConfirmBtn");
const codeCancelBtn    = document.getElementById("codeCancelBtn");
const createInfo       = document.getElementById("createInfo");    // the Create tab's own news: creating, the PIN, the room expiring
const lobbyStatus      = document.getElementById("lobbyStatus");   // news for every tab: the server waking, joining, a join failing
const roomsCount       = document.getElementById("roomsCount");
const sessionsList     = document.getElementById("sessionsList");
const refreshBtn       = document.getElementById("refreshBtn");
const pinOverlay       = document.getElementById("pinOverlay");
const pinSessionLabel  = document.getElementById("pinSessionLabel");
const pinInput         = document.getElementById("pinInput");
const pinJoinBtn       = document.getElementById("pinJoinBtn");
const pinCancelBtn     = document.getElementById("pinCancelBtn");
const pinError         = document.getElementById("pinError");
const chatSessionLabel = document.getElementById("chatSessionLabel");
const connectionQuality= document.getElementById("connectionQuality");
const connectionState  = document.getElementById("connectionState");
const connectionPath   = document.getElementById("connectionPath");
const statsBar         = document.getElementById("statsBar");
const leaveBtn         = document.getElementById("leaveBtn");
const chatMessages     = document.getElementById("chatMessages");
const newMessagesBtn   = document.getElementById("newMessagesBtn");   // see scrollBottom
const typingIndicator  = document.getElementById("typingIndicator");
const messageInput     = document.getElementById("messageInput");
const messageCounter   = document.getElementById("messageCounter");
const srAnnouncer      = document.getElementById("srAnnouncer");
const sendBtn          = document.getElementById("sendBtn");
const attachBtn        = document.getElementById("attachBtn");
const attachMenu       = document.getElementById("attachMenu");
const sendImageBtn     = document.getElementById("sendImageBtn");
const sendFileBtn      = document.getElementById("sendFileBtn");
const imageInput       = document.getElementById("imageInput");
const fileInput        = document.getElementById("fileInput");
const voiceRecordBtn   = document.getElementById("voiceRecordBtn");
const voiceCallBtn     = document.getElementById("voiceCallBtn");
const videoCallBtn     = document.getElementById("videoCallBtn");
const callOverlay      = document.getElementById("callOverlay");
const callStatusLabel  = document.getElementById("callStatusLabel");
const remoteVideo      = document.getElementById("remoteVideo");
const localVideo       = document.getElementById("localVideo");
const toggleMuteBtn    = document.getElementById("toggleMuteBtn");
const toggleCamBtn     = document.getElementById("toggleCamBtn");
const flipCamBtn       = document.getElementById("flipCamBtn");
const speakerBtn       = document.getElementById("speakerBtn");
const shareBtn         = document.getElementById("shareBtn");
const callStats        = document.getElementById("callStats");
const callMicNote      = document.getElementById("callMicNote");      // see "A microphone the phone has paused"
const callTapToHear    = document.getElementById("callTapToHear");    // see playRemoteCallMedia
const endCallBtn       = document.getElementById("endCallBtn");
const senderName       = document.getElementById("senderName");
const leaveMessage     = document.getElementById("leaveMessage");
const leaveFileBtn     = document.getElementById("leaveFileBtn");
const leaveFile        = document.getElementById("leaveFile");
const leaveFileName    = document.getElementById("leaveFileName");
const leaveSendBtn     = document.getElementById("leaveSendBtn");
const leaveStatus      = document.getElementById("leaveStatus");
const callRequestModal = document.getElementById("callRequestModal");
const callRequestTitle = document.getElementById("callRequestTitle");
const callRequestIcon  = document.getElementById("callRequestIcon");
const callAcceptBtn    = document.getElementById("callAcceptBtn");
const callDeclineBtn   = document.getElementById("callDeclineBtn");
const keyVerifyDropdown = document.getElementById("keyVerifyDropdown");
const keyVerifyBtn   = document.getElementById("keyVerifyBtn");
const keyVerifyIcon  = document.getElementById("keyVerifyIcon");
const factWhoCanRead      = document.getElementById("factWhoCanRead");
const factCipherValue     = document.getElementById("factCipherValue");
const factCallsValue      = document.getElementById("factCallsValue");
const factPathValue       = document.getElementById("factPathValue");
const factYourIpValue     = document.getElementById("factYourIpValue");
const factPeerIpValue     = document.getElementById("factPeerIpValue");
const factYourDeviceValue = document.getElementById("factYourDeviceValue");
const factPeerDeviceValue = document.getElementById("factPeerDeviceValue");
const keyVerifyCode  = document.getElementById("keyVerifyCode");
const keyVerifyHint  = document.getElementById("keyVerifyHint");
const keyVerifyInput = document.getElementById("keyVerifyInput");
const keyVerifyStatus= document.getElementById("keyVerifyStatus");
const peopleSection  = document.getElementById("peopleSection");   // see "SAVED PEOPLE"
const peopleList     = document.getElementById("peopleList");
const saveOverlay    = document.getElementById("saveOverlay");
const saveTitle      = document.getElementById("saveTitle");
const saveHint       = document.getElementById("saveHint");
const saveNameInput  = document.getElementById("saveNameInput");
const saveCancelBtn  = document.getElementById("saveCancelBtn");
const saveConfirmBtn = document.getElementById("saveConfirmBtn");
const knockBtn       = document.getElementById("knockBtn");          // see "KNOCKS"
const knockIcon      = document.getElementById("knockIcon");
const knockLabel     = document.getElementById("knockLabel");
const mailOverlay    = document.getElementById("mailOverlay");       // see "WAITING MESSAGES"
const mailTitle      = document.getElementById("mailTitle");
const mailHint       = document.getElementById("mailHint");
const mailList       = document.getElementById("mailList");
const mailInput      = document.getElementById("mailInput");
const mailSendBtn    = document.getElementById("mailSendBtn");
const mailCloseBtn   = document.getElementById("mailCloseBtn");
const mailClearBtn   = document.getElementById("mailClearBtn");

/* ── State ───────────────────────────────────── */
let ws              = null;
let pc              = null;
let callPc          = null;
let dataChannel     = null;
let inCall          = false;
let pendingCallVideo = false;
let currentSession  = null;
let isConnecting    = false;
let isHost          = false;
let iceQueue        = [];
let callIceQueue    = [];

let localStream     = null;
let remoteCallStream = null;
let isMuted         = false;
let isCamOff        = false;
let mediaRecorder   = null;
let voiceChunks     = [];
let voiceStream     = null;   // the live mic stream, so any path can release it
let voiceSession    = null;   // the room a recording belongs to
let voiceDiscard    = false;  // set when the result must be dropped, not sent
let voiceOpening    = false;  // the mic is being opened — a second press must wait

let statsInterval   = null;
let msgIdCounter    = 0;
const pendingAcks   = {};
let typingTimeout   = null;
let peerTyping      = false;

let _lastSessionList = [];  // cache for re-render on language change

/* Saved people — see "SAVED PEOPLE" below. Declared up here because
   applyI18n() draws the list while this file is still being read.

   people      everyone saved on this device, as G.savedPeople read them
   meeting     the one being met: from the tap on their name until leaving
   pendingMeet that tap's message, until the server answers it — sent again
               each time the link comes up, as a create is
   saveOffer   our offer to save each other, until they answer: { secret, name }
   saveAsked   their offer, while we are asked about it: { secret }
   saveDialog  the name dialog, while open: { mode, onConfirm, onCancel }
   forgetting  the room of the person whose row asks "Forget?"
   waitingForUs the rooms of those who tapped our name and wait for us now
   personMenuFor the room whose row shows Rename and Forget (personMenu)
   heldOpen    a long press opened that menu: the click its release may send
               is not a tap on the name
   quickCall   a call asked for from the row — { room, video } — placed once
               the chat with them is up (placeQuickCall) */
let people      = [];
let waitingForUs = new Set();
let personMenuFor = null;
let heldOpen    = false;
let quickCall   = null;
let meeting     = null;
let pendingMeet = null;
let saveOffer   = null;
let saveAsked   = null;
let saveDialog  = null;
let forgetting  = null;

/* Knocks — see "KNOCKS" below, declared up here for the same reason.

   knockSupported  this browser can be woken by a push at all
   knockKey        the server's public key to subscribe with; none, no knocks
   knockSub        this browser's push subscription, while alerts are on
   knockSent       the person being waited for was knocked on
   knockShared     this channel has told the other side where to knock
   savedInChat     the person saved in this chat, if one was           */
const knockSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
let knockKey    = null;
let knockSub    = null;
let knockSent   = false;
let knockShared = false;
let savedInChat = null;
let knockEarly  = null;   // their address, come before our side finished saving them

/* Waiting messages — see "WAITING MESSAGES" below; declared up here because
   each person's row shows how many are new.

   mailStore    each person's conversation kept on this device, and the ids
                already taken (G.mailStore)
   mailOpenFor  the room whose conversation is open, if one is            */
let mailStore   = { v: 1, threads: {}, seen: {} };
let mailOpenFor = null;

/* Last known connection path, so the header badge can be redrawn in the new
   language. Declared here rather than beside renderConnectionPath(): applyI18n()
   runs while this file is still parsing and reads it, which a `let` further down
   would refuse — the badge is translated, so it has to be reachable that early. */
let _lastPath = null;

/* What the shield's panel says about the two devices.

   _lastAddresses  from this browser's own connection statistics — nothing the
                   peer said goes into it
   peerDevice      what the other side said it is: two short codes. It can say
                   anything, so it is only ever shown through DCS.deviceLabel,
                   which turns known codes into words and everything else into
                   nothing
   peerInfoSent    this side has described itself on the current channel */
let _lastAddresses = null;
let peerDevice     = null;
let peerInfoSent   = false;

/* This device, described once. System and browser only — see describeDevice. */
const MY_DEVICE = DCS.describeDevice({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints });

const recvBuffers = {};

/* The server has dropped this chat's room — the other side's link to it went,
   or ours did. The chat carries on directly between the phones, but nothing
   can be repaired through the server any more. See G.serverLeaveEndsChat. */
let serverRoomGone = false;

/* ── Turned-away transfers ──────────────────
   A refused or abandoned transfer's chunks keep coming until the sender hears.
   They are dropped on arrival, not parked as orphans, and its transfer-done or
   transfer-abort says nothing more — the bubble already shows it failed.
   Ids only, and only the most recent few hundred.                          */
const refusedTransfers = new Set();
const REFUSED_REMEMBERED = 256;

function rememberRefused(id) {
  refusedTransfers.add(id);
  if (refusedTransfers.size > REFUSED_REMEMBERED) {
    refusedTransfers.delete(refusedTransfers.values().next().value);
  }
}

/* Our own transfers still sending, by id. A transfer-abort naming one of them
   means the other side turned it away: the send loop stops at the next chunk. */
const outgoingTransfers = new Map();

/* ── Early-chunk parking ────────────────────
   transfer-meta travels inside the encrypted e2e-dc envelope, so it is decrypted
   asynchronously, while binary chunks are handled synchronously. A chunk can
   therefore land before its metadata is registered. Park those here instead of
   dropping them; transfer-meta adopts them the moment it lands.               */
const orphanChunks     = {};
let   orphanChunkCount = 0;
const ORPHAN_CHUNK_MAX = 64;   // ~4 MB ceiling — the race window is a few chunks at most

/** Removes and returns chunks parked for `id` (empty array if none). */
function takeOrphanChunks(id) {
  const early = orphanChunks[id];
  if (!early) return [];
  delete orphanChunks[id];
  orphanChunkCount -= early.length;
  return early;
}

/* ── Blob URL memory management ─────────────
   Every createObjectURL() is tracked here.
   revokeTrackedBlobUrls() is called on leave
   so memory is freed when the chat closes.     */
const _trackedBlobUrls = [];
function trackBlobUrl(url) { _trackedBlobUrls.push(url); return url; }
function revokeTrackedBlobUrls() {
  while (_trackedBlobUrls.length) URL.revokeObjectURL(_trackedBlobUrls.pop());
}

/* ── In-app toast (replaces alert()) ────────
   type: "info" | "warn" | "error" | "ok"      */
function showToast(msg, type = "info") {
  const container = document.getElementById("dcToastContainer");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `dc-toast dc-toast-${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => { toast.remove(); }, 4000);
}

/* ── Screen-reader announcements ────────────
   Bubbles are drawn silently: a screen reader found a new message only by
   going to look for one. What arrives from the other side, and every system
   note, is also written into a visually hidden live region, which reads it
   out. Only the last few lines are kept — it is a voice, not a history.    */
function announce(text) {
  if (!srAnnouncer || !text) return;
  const line = document.createElement("p");
  line.textContent = text;
  srAnnouncer.appendChild(line);
  while (srAnnouncer.childElementCount > 3) srAnnouncer.firstElementChild.remove();
}

/* ── Telling you something arrived ──────────
   A message, a file or a call that came while nobody was looking at this
   page — another tab or another app in front — arrived in silence: no sound,
   nothing in the tab's title, and an incoming call rang nobody.

     a message or file   while the page is not looked at: a short chime, a
                         buzz where the phone can, and "(2) Өртөө" in
                         the title — and on the installed app's icon — until
                         it is looked at again (noticeArrival)
     an incoming call    rings and buzzes for as long as it is asked, looked
                         at or not: a phone left on the table with its screen
                         kept on is the usual case (startIncomingRing)

   A browser lets a page make no sound until it has been touched, so the sound
   is readied at the first tap. A phone that has put the page to sleep — an
   iPhone with its screen off, or with Safari in the background — runs none of
   this until it wakes: only a notification sent through a server could reach
   it there, and this app has none.                                         */
const CHIME_GAP_MS = 1500;          // a burst of messages chimes once
const RING_EVERY_S = 3;             // a ring, quiet, the next ring
/* The caller gives up after CALL_RING_MS. A little longer here, so a hang-up
   that never arrived still ends the ringing (incomingRingTimedOut). */
const INCOMING_RING_MS = G.CALL_RING_MS + 5000;
const RING_BUZZ = Array.from({ length: 2 * Math.ceil(INCOMING_RING_MS / (RING_EVERY_S * 1000)) },
                             (_, i) => (i % 2 ? RING_EVERY_S * 1000 - 600 : 600));

let soundCtx    = null;     // made at the first tap: no page may make a sound before one
let unread      = 0;        // arrived while nobody was looking
let lastChimeAt = 0;
let ringing     = false;    // an incoming call is being asked
let ringOut     = null;     // the ring's own output — cut to silence it
let ringTimer   = null;

function readySound() {
  if (soundCtx) {
    if (soundCtx.state === "suspended") soundCtx.resume().catch(() => {});
    return;
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try { soundCtx = new Ctx(); } catch (_) { soundCtx = null; }
}
document.addEventListener("pointerdown", readySound, true);
document.addEventListener("keydown", readySound, true);

/** Plays once sound can be heard — never before the first tap. */
function withSound(play) {
  if (!soundCtx) return;
  if (soundCtx.state === "running") { play(); return; }
  soundCtx.resume().then(() => { if (soundCtx.state === "running") play(); }).catch(() => {});
}

/** One soft tone, `at` seconds from now on the sound's own clock, which keeps
    time in a background tab where timers are slowed. */
function tone(out, freq, at, len, peak) {
  const start = soundCtx.currentTime + at;
  const osc = soundCtx.createOscillator();
  const env = soundCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(peak, start + 0.02);
  env.gain.exponentialRampToValueAtTime(0.0001, start + len);
  osc.connect(env);
  env.connect(out);
  osc.start(start);
  osc.stop(start + len + 0.05);
}

/** A buzz, on the phones that have one (Android). A hidden page gets none. */
function buzz(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) {}
}

function lookedAt() {
  return !G.unattended({ visibility: document.visibilityState, focused: document.hasFocus() });
}

function drawTitle() {
  document.title = G.tabTitle({ base: t("appName"), unread, ringing });
  try {
    if (navigator.setAppBadge) (unread ? navigator.setAppBadge(unread) : navigator.clearAppBadge()).catch(() => {});
  } catch (_) {}
}

/** A message, a file or a missed call has arrived from the other side. */
function noticeArrival() {
  noteCallChat();                     // the call may be covering the chat
  if (lookedAt()) return;
  unread++;
  drawTitle();
  const now = Date.now();
  if (now - lastChimeAt < CHIME_GAP_MS) return;
  lastChimeAt = now;
  withSound(() => {
    tone(soundCtx.destination, 880, 0, 0.18, 0.12);
    tone(soundCtx.destination, 1320, 0.12, 0.3, 0.1);
  });
  buzz(120);
}

/** Looked at again: what came is seen. */
function markSeen() {
  if (!unread || !lookedAt()) return;
  unread = 0;
  drawTitle();
}
document.addEventListener("visibilitychange", markSeen);
window.addEventListener("focus", markSeen);

/** An incoming call is being asked. */
function startIncomingRing() {
  stopIncomingRing();
  ringing = true;
  drawTitle();
  withSound(() => {
    if (!ringing || ringOut) return;           // answered while the sound was waking
    ringOut = soundCtx.createGain();
    ringOut.connect(soundCtx.destination);
    for (let s = 0; s * 1000 < INCOMING_RING_MS; s += RING_EVERY_S) {
      tone(ringOut, 660, s, 0.4, 0.15);
      tone(ringOut, 880, s + 0.45, 0.4, 0.15);
    }
  });
  buzz(RING_BUZZ);
  ringTimer = setTimeout(incomingRingTimedOut, INCOMING_RING_MS);
}

/** Answered, turned down, or over: the ringing stops, all of it. */
function stopIncomingRing() {
  clearTimeout(ringTimer);
  ringTimer = null;
  if (ringOut) { try { ringOut.disconnect(); } catch (_) {} ringOut = null; }
  if (!ringing) return;
  ringing = false;
  buzz(0);
  drawTitle();
}

/** Still asked after the caller has surely given up: their hang-up was lost
    on the way. It is the missed call it would have been. */
function incomingRingTimedOut() {
  ringTimer = null;
  if (callRequestModal.classList.contains("hidden")) { stopIncomingRing(); return; }
  endCall(false);
  appendSys(t("sysMissedCall"));
  noticeArrival();
}

/* ── Reconnect / back-to-lobby button ───────
   Shown in chat when the peer disconnects.    */
function showReconnectButton() {
  /* Shown whenever a chat has ended, however it ended: nothing left to keep
     the screen on for. */
  keepScreenOn(false);
  /* The channel closing and the server's notice can both arrive for one
     ending; one button is enough. */
  if (chatMessages.querySelector(".reconnect-sys-wrap")) return;
  const wrap = document.createElement("div");
  wrap.className = "reconnect-sys-wrap";
  const btn = document.createElement("button");
  btn.className = "reconnect-sys-btn";
  btn.textContent = t("reconnectBtn");
  btn.onclick = () => leaveBtn.click();
  wrap.appendChild(btn);
  chatMessages.appendChild(wrap);
  scrollBottom();
}

/* ══════════════════════════════════════════════
   E2E ENCRYPTION  (ECDH P-256 → HKDF → AES-GCM 256)
   ─────────────────────────────────────────────
   App-layer key for text, photos, files, voice notes and call signaling on the
   data channel. Voice/video media rides WebRTC's own DTLS-SRTP.

   Plain ECDH alone cannot detect a man-in-the-middle: the signaling server sees
   both public keys and could swap in its own. Two defences:

     Link joins  — the host's browser mints a random room secret, carries it in
                   the invite-link fragment (never sent to the server) and mixes
                   it into HKDF. An attacker without the secret derives a
                   different key, so the confirmation below fails and the chat
                   never opens. No user action required.
     PIN joins   — no shared secret exists, so we fall back to plain ECDH and the
                   manual verification code. The UI says plainly which one you
                   got, so a forced downgrade is visible rather than silent.

   The host cannot know in advance how the guest will join, so it derives BOTH
   candidate keys and lets the guest's confirmation packet select one.

   Flow:
     1. dataChannel.onopen → e2eInit() → e2e-pubkey exchange
     2. both sides derive; guest sends e2e-confirm sealed with its key
     3. host tries each candidate, adopts the one that opens it, confirms back
     4. neither opens → e2e-fail, channel stays shut
══════════════════════════════════════════════ */

let e2eKey      = null;   // CryptoKey AES-GCM 256 (derived, after confirmation)
let e2eKeyPair  = null;   // ECDH ephemeral key pair
let e2eReady    = false;
let e2eVerifyCode = "";
let e2eVerified = false;
let e2eLocalPubRaw = null;

let roomSecret       = null;   // host: minted locally; guest: read from invite link
let pendingRoomSecret = null;  // secret for the join currently in flight
let e2eCandidates    = null;   // host only: { secure, plain } awaiting selection
let e2eKeyPending    = null;   // guest only: key awaiting the host's confirmation
let e2eSecureMode    = false;  // true = room secret authenticated this exchange
let e2ePendingConfirm = null;  // confirm that landed before derivation finished
let e2ePeerKeySeen   = false;  // a peer public key has arrived on this channel
let e2eConfirmTimer  = null;
let e2eSendSeq       = 0;                 // the number our last sealed message carried
let e2eRecvSeen      = DC.sealWindow();   // the other side's numbers already taken (DC.takeSeal)

/** Who seals what: this side and the other, bound into every seal so a
    message cannot be handed back to the side that sent it (DC.messageAad). */
function myRole() {
  return isHost ? "h" : "g";
}

function peerRole() {
  return isHost ? "g" : "h";
}

/* ── Code rooms (SPAKE2) ──────────────────────
   A code room agrees its key from a secret word with SPAKE2 (see pake.js)
   instead of plain ECDH. Both sides must run the same path, so the kind is
   remembered for the life of the room. */
const PAKE = window.DCPake;
let roomKind       = "pin";   // "pin" | "open" | "code" — set on create and on join
let pakeCode       = null;    // the secret word for this room (never sent to the server)
let pakeStarted    = null;    // our SPAKE2 start(): { state, message }
let pakeSession    = null;    // our SPAKE2 finish(): awaiting the peer's confirmation
let keyAgreement   = "ECDH";  // how the live key was agreed — for the shield panel
/* Host-side guard on wrong-code guesses; the server cannot see the word, so it
   cannot rate-limit it. See guards.js codeAttemptState. */
let wordMatched    = false;   // this channel's SPAKE2 succeeded: a real chat, not an attempt
let roomReadyInfo  = null;    // what session-created said, to draw the ready panel again
let hostKey        = null;    // the server's proof that this page is the room's host — never in a link
let reclaimPending = false;   // our link dropped while hosting a waiting room: take it back on reconnecting
let reclaimRedraw  = false;   // and the panel is not on screen — this page was opened fresh
let guestKey       = null;    // the server's proof that this page is the room's guest — never in a link
let seatPending    = false;   // our link dropped mid-chat: the server keeps our seat; take it back on reconnecting
let peerServerAway = false;   // the other side's link to the server dropped: repairs through it wait for its return
let codeFailures   = 0;
let codeLockedUntil = 0;

const E2E_CONFIRM_TIMEOUT_MS = 15_000;

const makeRoomSecret = DC.makeRoomSecret;

async function e2eInit() {
  e2eVerifyCode = "";
  e2eVerified = false;
  e2eSecureMode = false;
  e2eLocalPubRaw = null;
  e2eCandidates = null;
  e2eKeyPending = null;
  e2ePendingConfirm = null;
  e2ePeerKeySeen = false;
  /* A new channel is a new introduction. */
  peerDevice   = null;
  peerInfoSent = false;
  updateKeyVerifyUi();
  e2eKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey", "deriveBits"]
  );
  const pubJwk = await crypto.subtle.exportKey("jwk", e2eKeyPair.publicKey);
  e2eLocalPubRaw = await crypto.subtle.exportKey("raw", e2eKeyPair.publicKey);
  // Send over already-open data channel (raw, not through dcSend so we bypass e2eReady guard)
  if (dataChannel && dataChannel.readyState === "open") {
    dataChannel.send(JSON.stringify({ type: "e2e-pubkey", key: pubJwk }));
  }
}

/** ECDH → HKDF → AES-GCM. `secret` (or its absence) changes the resulting key. */
function deriveKeyWith(peerPub, secret) {
  return DC.deriveSharedKey(e2eKeyPair.privateKey, peerPub, secret);
}

/* The confirmation carries the verification code, binding it to both public
   keys — a relayed copy from a different exchange will not match. */
async function sealConfirm(key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify({ v: "confirm-1", code: e2eVerifyCode }));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: DC.confirmAad(myRole()) }, key, pt);
  return {
    type: "e2e-confirm",
    ct: btoa(String.fromCharCode(...new Uint8Array(ct))),
    iv: btoa(String.fromCharCode(...iv))
  };
}

async function opensConfirm(key, ctB64, ivB64) {
  try {
    const from64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: from64(ivB64), additionalData: DC.confirmAad(peerRole()) }, key, from64(ctB64));
    const obj = JSON.parse(new TextDecoder().decode(pt));
    return Boolean(obj) && obj.v === "confirm-1" && obj.code === e2eVerifyCode;
  } catch (_) { return false; }
}

function armConfirmTimeout() {
  clearTimeout(e2eConfirmTimer);
  e2eConfirmTimer = setTimeout(() => { if (!e2eReady) e2eFailClosed(); }, E2E_CONFIRM_TIMEOUT_MS);
}

/** Adopt the agreed key and open the chat. `secure` = room secret authenticated it. */
function e2eActivate(key, secure) {
  clearTimeout(e2eConfirmTimer);
  clearConnectWatch();
  keepScreenOn(true);    // a late connection after the give-up note let the screen go
  e2eKey        = key;
  e2eSendSeq    = 0;                 // a new key counts its messages afresh
  e2eRecvSeen   = DC.sealWindow();
  e2eReady      = true;
  e2eSecureMode = secure;
  e2eVerified   = secure;   // the link secret already proves there is no middleman
  sendBtn.disabled      = false;
  voiceCallBtn.disabled = false;
  videoCallBtn.disabled = false;
  updateKeyVerifyUi();
  /* The one thing the chat says about connecting, and it says it here — once
     the key is agreed — rather than when the channel opens. "Connected" then
     always means the chat can be used, and a channel that fails the key check
     never gets to claim it.

     Three lines used to be written on every join: the transport, "setting up
     encryption…", and the verification code. That was more than anyone read.
     How the chat was verified is the shield's job now; the code is in its
     panel. */
  appendSys(t("sysConnected"));
  maybeOfferSave();
  placeQuickCall();                // a call asked for from a saved person's row

  /* The guest introduces itself; the host answers when that arrives (see the
     peer-info case). Not both at once: the host reaches this line before it
     has sent the confirmation that makes the guest ready, and an envelope that
     overtook the confirmation would be dropped on arrival — the guest would
     never learn what it is talking to. The guest only gets here because the
     host is already listening. Where to knock for us goes the same way. */
  if (!isHost) { sendPeerInfo(); shareKnockAddress(); }
}

/** Tells the other side which system and browser this is — once per channel,
    and only inside the encrypted envelope. */
function sendPeerInfo() {
  if (peerInfoSent) return;
  peerInfoSent = true;
  dcSendE2e({ type: "peer-info", os: MY_DEVICE.os, browser: MY_DEVICE.browser }).catch(() => {});
}

/* ══════════════════════════════════════════════
   CODE ROOMS — SPAKE2 over the data channel
   ─────────────────────────────────────────────
   Symmetric: each side sends its message, answers the peer's message with a
   confirmation tag, and verifies the peer's tag. Matching words → the same key,
   authenticated, so the shield goes green with nothing to compare by hand. A
   wrong word → the tags do not verify and the channel never opens. The word
   itself never travels; only public values do (see pake.js, guards.js).
══════════════════════════════════════════════ */

/** Clears everything a code handshake holds. Called whenever a channel resets. */
function pakeReset() {
  pakeStarted = null;
  pakeSession = null;
}

/** Start the exchange when the channel opens. Both sides call this. */
async function pakeBegin() {
  pakeReset();
  wordMatched = false;
  updateKeyVerifyUi();
  appendSys(t("e2eWaiting"));

  /* Host holds the gate: a stranger cannot be let on for an endless stream of
     guesses. If locked from earlier wrong attempts, do not even start. */
  if (isHost) {
    const lock = G.codeAttemptState({ failures: codeFailures, lockedUntil: codeLockedUntil, now: Date.now() });
    /* A lock that has run out starts the count afresh — see codeAttemptState. */
    codeFailures = lock.failures;
    codeLockedUntil = lock.until;
    if (lock.locked) { pakeFailClosed(true); return; }
  }
  if (!PAKE || !pakeCode || !currentSession) { pakeFailClosed(false); return; }

  try {
    pakeStarted = PAKE.start(isHost ? "host" : "guest", pakeCode, currentSession.sessionId);
    /* Raw send: the handshake runs before any key exists. */
    dataChannel.send(JSON.stringify({ type: "pake-msg", msg: pakeStarted.message }));
  } catch (err) {
    console.error("SPAKE2 start failed:", err);
    pakeFailClosed(false);
  }
}

/** The peer's SPAKE2 message arrived. Derive, and answer with our tag. */
async function handlePakeMessage(data) {
  if (!pakeStarted || pakeSession) return;   // not started, or already answered
  try {
    pakeSession = PAKE.finish(pakeStarted.state, data.msg);
    dataChannel.send(JSON.stringify({ type: "pake-confirm", tag: pakeSession.confirmToSend }));
  } catch (err) {
    /* An invalid point, or a degenerate shared value — never an honest peer. */
    console.warn("SPAKE2 message rejected:", err && err.message);
    pakeFailClosed(false);
  }
}

/** The peer's confirmation tag arrived. If it verifies, the word matched. */
async function handlePakeConfirm(data) {
  if (!pakeSession) return;
  if (!pakeSession.verifyPeerConfirm(String(data.tag || ""))) {
    pakeFailClosed(false);
    return;
  }
  try {
    const key = await crypto.subtle.importKey(
      "raw", pakeSession.sessionKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    codeFailures = 0;             // a success clears the host's wrong-guess count
    wordMatched = true;
    keyAgreement = "SPAKE2";
    pakeReset();
    /* Authenticated by the shared word, exactly like the invite-link secret. */
    e2eActivate(key, true);
  } catch (err) {
    console.error("SPAKE2 key import failed:", err);
    pakeFailClosed(false);
  }
}

/**
 * The code handshake failed — a wrong word, a tampered message, or the lockout.
 * The channel never opens. The guest returns to the lobby so they can try again;
 * the host counts the miss and, past the limit, locks the room for a cooldown.
 */
function pakeFailClosed(locked) {
  pakeReset();
  keyAgreement = "ECDH";
  e2eReady = false; e2eVerified = false; e2eSecureMode = false;
  sendBtn.disabled = true; voiceCallBtn.disabled = true; videoCallBtn.disabled = true;
  updateKeyVerifyUi();

  if (isHost && !locked) {
    codeFailures++;
    const lock = G.codeAttemptState({ failures: codeFailures, lockedUntil: codeLockedUntil, now: Date.now() });
    if (lock.locked) codeLockedUntil = lock.until;
  }

  if (isHost) {
    /* Turn this guest away — the server frees the seat and keeps the room —
       and go back to waiting, for the next attempt or the right one. This
       used to stay on a dead chat screen while the guest's leaving deleted
       the room, so "try again" could only ever find "not found". */
    /* Locked: the guest is told so, and for how long — it used to hear only
       that we had gone, and the right word arriving now could not know to wait. */
    const lockedFor = G.codeLockSecondsLeft(codeLockedUntil, Date.now());
    if (currentSession) wsSend({ type: "release-guest", sessionId: currentSession.sessionId,
                                 ...(lockedFor ? { reason: "locked", retryIn: lockedFor } : {}) });
    returnToWaitingRoom(lockedFor ? "codeLocked" : "codeWrongHost");
  } else {
    /* Guest: back to the lobby, where the room is listed again — unless the
       host's "locked" already took us there (turnedAwayLocked). */
    showToast(t("codeWrong"), "error");
    appendSys(t("codeWrong"));
    setTimeout(() => { if (!e2eReady && currentSession) leaveBtn.click(); }, 1200);
  }
}

/**
 * A code room's host turned us away because the room is locked, after too
 * many wrong words. Said — with how long to wait — instead of "the other side
 * left", then back to the lobby, where it is said again: the right word,
 * arriving during the lock, used to have no way to know it should wait.
 */
function turnedAwayLocked(retryIn) {
  const text = I18N[LANG].codeLockedGuest(G.lockMinutes(retryIn));
  if (dataChannel) dataChannel.onclose = null;     // its closing is not news now
  showToast(text, "error");
  appendSys(text);
  setTimeout(() => {
    if (e2eReady) return;
    if (currentSession) leaveBtn.click();
    const note = document.createElement("span");
    note.style.color = "var(--orange)";
    note.textContent = `🔒 ${text}`;
    lobbyStatus.replaceChildren(note);
  }, 1200);
}

/**
 * A code room's host, back to waiting after an attempt that did not become a
 * chat — a wrong word, or a guest who left first. The room is still on the
 * server (see release-guest, guest-left); the ready panel is drawn again with
 * a note to say what happened. Called twice for one attempt — the host's own
 * failure, then the server's guest-left — the second changes nothing.
 */
function returnToWaitingRoom(noteKey) {
  const alreadyWaiting = chatScreen.classList.contains("hidden");
  wordMatched = false;
  clearConnectWatch();
  /* Our own closing must not run the channel's close handler: it would write
     "connection closed" into a chat nobody is in, and let the screen sleep. */
  if (dataChannel) dataChannel.onclose = null;
  endCall(false);
  closePeerConnection();
  if (alreadyWaiting && !noteKey) { disarmBackGuard(); return; }
  chatScreen.classList.add("hidden");
  lobbyScreen.classList.remove("hidden");
  disarmBackGuard();               // with the chat off screen — see leaveBtn
  document.getElementById("langSwitcher").style.display = "";
  showLobbyTab("create");
  if (roomReadyInfo) showRoomReady(roomReadyInfo);
  if (noteKey) {
    const note = document.createElement("div");
    note.style.cssText = "text-align:center;color:var(--orange);margin-bottom:12px";
    note.textContent = `⚠️ ${t(noteKey)}`;
    createInfo.prepend(note);
  }
  keepScreenOn(true);              // still hosting: a lock now would take the room
  saveHostRoom();
}

/** Refuse to open the channel. Better a dead chat than a silently readable one. */
function e2eFailClosed() {
  clearTimeout(e2eConfirmTimer);
  e2eKey = null; e2eKeyPending = null; e2eCandidates = null; e2ePendingConfirm = null;
  e2eReady = false; e2eVerified = false; e2eSecureMode = false;
  e2ePeerKeySeen = false;
  sendBtn.disabled      = true;
  voiceCallBtn.disabled = true;
  videoCallBtn.disabled = true;
  updateKeyVerifyUi();
  appendSys(t("e2eMismatch"));
  showToast(t("e2eMismatch"), "error");
}

async function e2eDeriveKey(peerPubJwk) {
  try {
    const peerPub = await crypto.subtle.importKey(
      "jwk", peerPubJwk,
      { name: "ECDH", namedCurve: "P-256" },
      true,   // extractable only to compute fingerprint
      []
    );
    const peerRaw = await crypto.subtle.exportKey("raw", peerPub);
    e2eVerifyCode = await makeSharedVerificationCode(e2eLocalPubRaw, peerRaw);
    updateKeyVerifyUi();

    if (isHost) {
      /* Guest may hold the room secret (invite link) or not (PIN). Prepare both
         — except in a saved person's room, where the secret is the only way in
         and a key without it is someone else (G.mayUsePlainKey). */
      e2eCandidates = {
        secure: roomSecret ? await deriveKeyWith(peerPub, roomSecret) : null,
        plain:  G.mayUsePlainKey(roomKind) ? await deriveKeyWith(peerPub, null) : null
      };
    } else {
      e2eKeyPending = await deriveKeyWith(peerPub, roomSecret);
      e2eSecureMode = Boolean(roomSecret);
      dataChannel.send(JSON.stringify(await sealConfirm(e2eKeyPending)));
    }
    armConfirmTimeout();

    /* A confirm can arrive while the derivation above is still running. */
    if (e2ePendingConfirm) {
      const queued = e2ePendingConfirm;
      e2ePendingConfirm = null;
      await handleE2eConfirm(queued);
    }
  } catch (err) {
    console.error("E2E key derivation failed:", err);
    e2eReady = false;
    sendBtn.disabled = true;
    appendSys(t("e2eFailed"));
  }
}

async function handleE2eConfirm(data) {
  if (e2eReady) return;

  if (isHost) {
    if (!e2eCandidates) { e2ePendingConfirm = data; return; }
    const { secure, plain } = e2eCandidates;
    if (secure && await opensConfirm(secure, data.ct, data.iv)) {
      e2eCandidates = null;
      e2eActivate(secure, true);
    } else if (plain && await opensConfirm(plain, data.ct, data.iv)) {
      e2eCandidates = null;
      e2eActivate(plain, false);
    } else {
      /* Neither key opens it: a middleman swapped keys, or the peer is running
         an incompatible build. Either way, do not open the channel. */
      e2eCandidates = null;
      dcSend({ type: "e2e-fail" });
      e2eFailClosed();
      return;
    }
    dataChannel.send(JSON.stringify(await sealConfirm(e2eKey)));
  } else {
    if (!e2eKeyPending) { e2ePendingConfirm = data; return; }
    const key = e2eKeyPending;
    e2eKeyPending = null;
    if (await opensConfirm(key, data.ct, data.iv)) e2eActivate(key, e2eSecureMode);
    else e2eFailClosed();
  }
}

/* `aad`: who sealed it and its place (DC.messageAad, DC.chunkAad) — checked
   on opening, never sent. */
async function e2eEncrypt(plaintext, aad) {
  const iv      = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ct      = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, e2eKey, encoded);
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  return { ct: b64(ct), iv: b64(iv) };
}

async function e2eDecrypt(ctB64, ivB64, aad) {
  const from64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const plain  = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: from64(ivB64), additionalData: aad },
    e2eKey,
    from64(ctB64)
  );
  return new TextDecoder().decode(plain);
}

async function e2eEncryptBytes(data, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const input = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, e2eKey, input);
  return { iv, ct: new Uint8Array(ct) };
}

async function e2eDecryptBytes(ct, iv, aad) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, e2eKey, ct);
  return new Uint8Array(plain);
}

const E2E_BIN_IV_LEN = DC.E2E_BIN_IV_LEN;

/** Send JSON over the data channel inside the same E2E envelope as text —
    numbered, and sealed as ours (DC.messageAad). */
async function dcSendE2e(obj) {
  if (!dcReady() || !e2eReady) return false;
  const n = ++e2eSendSeq;
  const { ct, iv } = await e2eEncrypt(JSON.stringify(obj), DC.messageAad(myRole(), n, "e2e-dc"));
  dataChannel.send(JSON.stringify({ type: "e2e-dc", ct, iv, n }));
  return true;
}

/** Call signaling rides inside the E2E data-channel envelope. */
function dcSendCallSignal(obj) {
  return dcSendE2e(obj);
}

/* The Raspberry Pi at home, through Tailscale Funnel (see deploy/pi): it never
   sleeps, so nobody waits for it to wake. Render still runs the same server
   and is the way back — https://direct-connection.onrender.com — should the
   Pi be gone for long. */
const DEFAULT_SERVER_URL = "https://raspberrypi.vulture-manta.ts.net/dc";
const SERVER_URL = window.DIRECT_CONNECTION_SERVER_URL ||
  (["localhost", "127.0.0.1"].includes(location.hostname)
    ? `${location.protocol}//${location.hostname}:3000`
    : DEFAULT_SERVER_URL);
const WS_URL = SERVER_URL.replace(/^http/, "ws");
const CHUNK_SIZE    = 65536;
const MAX_P2P_FILE_BYTES = 150 * 1024 * 1024; // 150 MB hard cap for P2P transfers
/* What may be arriving at once: two maximum-size files side by side. */
const INCOMING_BUDGET_BYTES = 2 * MAX_P2P_FILE_BYTES;
/* The largest chunk body an honest sender makes: IV, then CHUNK_SIZE of
   plaintext sealed with AES-GCM's 16-byte tag. */
const MAX_CHUNK_BODY = DC.E2E_BIN_IV_LEN + CHUNK_SIZE + 16;

/** Max size for “leave a message” file; server may raise via /api/ping (Resend email ~40MB cap). */
let maxLeaveAttachBytes = 28 * 1024 * 1024;

function leaveAttachMaxMbRounded() {
  return Math.max(1, Math.round(maxLeaveAttachBytes / 1024 / 1024));
}

/* ══════════════════════════════════════════════
   SERVER WAKE-UP
   ─────────────────────────────────────────────
   Render free tier sleeps after ~15 min idle.
   On page load we hit /api/ping immediately so
   the server is warm by the time the user acts.
   If it takes >2s we surface a notice so the
   user knows to wait rather than retry-spam.
══════════════════════════════════════════════ */

let _serverWoke = false;

function wakeServer() {
  if (_serverWoke) return;
  const wakeNoticeTimer = setTimeout(() => {
    const msg = document.createElement("span");
    msg.className = "server-wake-status";
    msg.style.color = "var(--orange)";
    msg.textContent = `⏳ ${t("serverWaking")}`;
    lobbyStatus.replaceChildren(msg);
  }, 2000);

  // Abort if server doesn't respond within 60s (Render cold start max)
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 60_000);

  fetch(`${SERVER_URL}/api/ping`, { signal: controller.signal })
    .then(r => (r.ok ? r.json() : null))
    .then(j => {
      if (j && typeof j.maxLeaveAttachBytes === "number" && j.maxLeaveAttachBytes >= 1048576) {
        maxLeaveAttachBytes = j.maxLeaveAttachBytes;
        applyI18n();
      }
      /* The server sends knocks: the alerts switch can show. */
      if (j && typeof j.knockKey === "string" && /^B[A-Za-z0-9_-]{86}$/.test(j.knockKey)) knockKeyArrived(j.knockKey);
    })
    .catch(() => {})
    .finally(() => {
      clearTimeout(wakeNoticeTimer);
      clearTimeout(timeout);
    });
}

const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302"  },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
  ],
  iceTransportPolicy: "all"
};

/* ── Apply i18n on load ─────────────────────── */
applyI18n();

/* ══════════════════════════════════════════════
   VISIBLE AREA
   ─────────────────────────────────────────────
   A phone keyboard covers the bottom of the screen, and on iOS and in most
   in-app browsers nothing in CSS finds out: the page stays full height. The
   message box is the bottom-most thing on the page, so it sat underneath the
   keyboard while the user typed into it.

   The visual viewport is the one measurement that does get shorter, so the
   page's height follows it. Every screen is sized from --app-height — see
   :root in style.css.
══════════════════════════════════════════════ */

/* Was the newest message in view before the visible area changed? Noted on
   scroll rather than read at resize time: by then the list has already been
   cut short from the bottom and can no longer say where it was. */
let _stickToBottom = true;
chatMessages.addEventListener("scroll", () => {
  _stickToBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 48;
  /* Down at the newest by hand: nothing is waiting below any more. */
  if (_stickToBottom) newMessagesBtn.classList.add("hidden");
});

function fitToVisibleArea() {
  const vv = window.visualViewport;

  /* Pinch-zoom shrinks the visual viewport as well, and is not a keyboard.
     Resizing the page to a zoomed-in view would fight the zoom. */
  if (vv && Math.abs(vv.scale - 1) > 0.01) return;

  const height = vv ? vv.height : window.innerHeight;
  if (!(height > 0)) return;   // a hidden or not-yet-laid-out page reports 0

  document.documentElement.style.setProperty("--app-height", `${height}px`);

  /* iOS scrolls the whole page to lift a focused field above the keyboard. The
     page now fits in what is visible, so there is nothing to scroll to — and
     leaving it scrolled pushes the header off the top. */
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);

  /* The message list just got shorter from the bottom up. Keep the newest
     message in view, unless the user had scrolled back to read older ones. */
  if (_stickToBottom) scrollBottom();
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", fitToVisibleArea);
  window.visualViewport.addEventListener("scroll", fitToVisibleArea);
}
window.addEventListener("resize", fitToVisibleArea);
fitToVisibleArea();

/* ══════════════════════════════════════════════
   ABOUT THIS PAGE
   ─────────────────────────────────────────────
   Opened by its own button. A tap anywhere else closes it, as a dropdown is
   expected to; a tap inside — selecting the text — leaves it open.
══════════════════════════════════════════════ */

/* The author's panel, at the top left, opens and closes the same way — and
   opening one closes the other, since the tap that opens it is elsewhere.
   Escape closes either. */
const authorDropdown = document.getElementById("authorDropdown");
const DROPDOWNS = [aboutDropdown, authorDropdown];

document.addEventListener("click", (e) => {
  for (const d of DROPDOWNS) if (d.open && !d.contains(e.target)) d.open = false;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") for (const d of DROPDOWNS) d.open = false;
});

/** Both create buttons, always together — a second create while one is in
    flight is the same mistake whichever button it comes from. */
function setCreateButtons(disabled) {
  createBtn.disabled     = disabled;
  createOpenBtn.disabled = disabled;
  createCodeBtn.disabled = disabled;
}

/* ── The shared-word dialog ───────────────────
   Used both ways: the host choosing a word, the guest entering it. One
   callback, set per use. */
let _codeOnConfirm = null;
function askForCode({ title, hint, confirmLabel, onConfirm }) {
  _codeOnConfirm = onConfirm;
  codeTitle.textContent = title;
  codeHint.textContent = hint;
  codeConfirmBtn.textContent = confirmLabel;
  codeInput.value = "";
  codeOverlay.classList.remove("hidden");
  setTimeout(() => codeInput.focus(), 100);
}
function closeCodeDialog() { codeOverlay.classList.add("hidden"); _codeOnConfirm = null; }
function submitCode() {
  const word = codeInput.value.trim();
  if (!word) { codeInput.focus(); return; }
  const cb = _codeOnConfirm;
  closeCodeDialog();
  if (cb) cb(word);
}
codeConfirmBtn.onclick = submitCode;
codeCancelBtn.onclick = closeCodeDialog;
codeInput.addEventListener("keydown", e => { if (e.key === "Enter") submitCode(); });

function setLobbyButtons(disabled) {
  setCreateButtons(disabled);
  sessionIdInput.disabled = disabled;
  refreshBtn.disabled     = disabled;
}

let _autoJoinSent  = false;
/* The invite was opened again in another browser and the seat went there
   (seat-taken). This copy never joins with it again — not on a reconnect, not
   ever: the two would take the seat back and forth for as long as both were
   open. */
let inviteMovedAway = false;
let _autoJoinTimer = null;
const AUTO_JOIN_TIMEOUT_MS = 20_000;

function checkAutoJoin() {
  if (!_isAutoJoin || _autoJoinSent || inAppHold || inviteMovedAway) return;
  _autoJoinSent = true;
  isConnecting = true;
  roomKind = "pin"; pakeCode = null;   // an invite link is the ECDH path, not a code room
  pendingRoomSecret = _autoSecret;   // link join — carries the room secret
  setLobbyButtons(true);
  const msg = document.createElement("span");
  msg.style.color = "var(--accent-text)";
  msg.textContent = I18N[LANG].joiningSession(_autoSessionId);
  lobbyStatus.replaceChildren(msg);
  /* `visible`: whether anyone is looking at this page. Only then may it take a
     seat another copy of the link holds — a copy in the background is told the
     link is open elsewhere instead (held-elsewhere). */
  wsSend({ type: "join-session", sessionId: _autoSessionId, token: _autoToken, visible: document.visibilityState === "visible" });

  /* The server always answers a join — unless the socket dies first. Without a
     deadline the lobby stays disabled behind "Joining…" with nothing to click
     and nothing coming. */
  clearTimeout(_autoJoinTimer);
  _autoJoinTimer = setTimeout(autoJoinTimedOut, AUTO_JOIN_TIMEOUT_MS);
}

/** "Continue here", on a copy of the link whose seat went to another copy, or
    that was turned away because another copy holds it. The person, looking at
    this one, makes it the one in use — by a tap, never by itself: the copies
    would otherwise take the seat back and forth. From the chat screen it goes
    back to the lobby first, where the join's answer is shown. */
function continueWithInviteHere() {
  if (!chatScreen.classList.contains("hidden")) leaveBtn.click();
  inviteMovedAway = false;
  _autoJoinSent = false;
  if (ws && ws.readyState === WebSocket.OPEN) checkAutoJoin();   // otherwise the socket opening sends it
}

/** The "Continue here" button, under whatever said the link is open elsewhere. */
function continueHereButton() {
  const wrap = document.createElement("div");
  wrap.className = "reconnect-sys-wrap continue-here";
  const btn = document.createElement("button");
  btn.className = "reconnect-sys-btn";
  btn.textContent = t("inAppContinue");
  btn.onclick = continueWithInviteHere;
  wrap.appendChild(btn);
  return wrap;
}

/** A definitive answer arrived (joined, refused, or errored) — stop the clock. */
function autoJoinSettled() {
  clearTimeout(_autoJoinTimer);
  _autoJoinTimer = null;
}

function autoJoinTimedOut() {
  autoJoinSettled();
  if (currentSession) return;          // it landed after all
  isConnecting = false;
  setLobbyButtons(false);
  const msg = document.createElement("span");
  msg.style.color = "var(--danger-text)";
  msg.textContent = t("joinTimedOut");
  lobbyStatus.replaceChildren(msg);
}

/* ══════════════════════════════════════════════
   WEBSOCKET
══════════════════════════════════════════════ */

function connectWebSocket() {
  ws = new WebSocket(WS_URL);
  ws.onopen    = () => {
    _serverWoke = true;
    // Clear the "waking up" notice — WS open is the true ready signal
    if (lobbyStatus.querySelector(".server-wake-status")) {
      const msg = document.createElement("span");
      msg.className = "server-ready-status";
      msg.style.color = "var(--green)";
      msg.textContent = `✓ ${t("serverReady")}`;
      lobbyStatus.replaceChildren(msg);
      setTimeout(() => {
        if (lobbyStatus.querySelector(".server-ready-status")) lobbyStatus.replaceChildren();
      }, 2000);
    }
    /* First thing said on every connection, ahead of the list request: it is
       how the server tells a current page from one that predates this
       handshake and so cannot update itself. */
    wsSend({ type: "hello", build: APP_BUILD });
    requestSessionList();
    checkAutoJoin();
    sendPendingCreate();
    sendPendingMeet();
    mailAtConnect();
    restoreHostRoom();
    sendReclaim();
    resumeSeat();
    if (!_keepAliveInterval) {
      _keepAliveInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 10 * 60 * 1000);
    }
  };
  ws.onclose   = () => {
    // Clear keep-alive so it doesn't stack when we reconnect
    if (_keepAliveInterval) { clearInterval(_keepAliveInterval); _keepAliveInterval = null; }
    /* Mid-chat, the server now keeps our seat for a while (the other side is
       told peer-away) and we take it back on reconnecting (resumeSeat), so the
       chat can still be repaired through it. Only without a key to do that —
       an older server — is the room taken as gone, as it used to be. */
    if (pc && currentSession) {
      if (isHost ? hostKey : guestKey) seatPending = true;
      else serverRoomGone = true;
    }
    /* A room still waiting for its guest is simply gone: say so. */
    if (G.waitingRoomLost({ isHost, hasSession: Boolean(currentSession), chatStarted: Boolean(pc) })) {
      /* The server keeps it for us. An older server, which gave no host key,
         does not: say so, as before. */
      if (hostKey) awaitReclaim();
      else loseWaitingRoom();
    }
    /* If the socket died between sending the join and hearing back, the answer
       is never coming. Let the reconnect send it again rather than leaving the
       lobby disabled behind "Joining…" forever. */
    if (G.shouldRetryAutoJoin({ isAutoJoin: _isAutoJoin, joinSent: _autoJoinSent, joined: Boolean(currentSession) })) {
      autoJoinSettled();
      _autoJoinSent = false;
    }
    /* Same for a tap on an open room: its answer died with the socket, and
       while this stays set no other open room can be joined. */
    listJoinId = null;
    setTimeout(connectWebSocket, 3000);
  };
  ws.onerror   = (e) => console.error("WS error", e);
  let _signalQueue = Promise.resolve();
  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      _signalQueue = _signalQueue.then(() => handleSignaling(data).catch(e => console.error("WS signal error", e)));
    } catch (e) { console.error("WS parse error", e); }
  };
}

let _keepAliveInterval = null;

// Connect on page load — don't wait for approve click
// (no data is sent until user approves; WS just warms up)
connectWebSocket();
wakeServer();

/* Every place a room secret can be held. The join is sent while the secret is
   still in pendingRoomSecret — roomSecret is only assigned once the server
   confirms — so checking roomSecret alone would leave the guard inert during
   exactly the message most likely to leak it. */
function roomSecretsInPlay() {
  return [roomSecret, pendingRoomSecret, _autoSecret,
          meeting && meeting.secret, saveOffer && saveOffer.secret, saveAsked && saveAsked.secret,
          ...people.map(p => p.secret)];
}

function wsSend(obj) {
  /* The room secret must never reach the server — see README, "Invite links".
     Refuse rather than send: dropping one signaling message is recoverable,
     whereas leaking the secret silently removes the man-in-the-middle
     protection with nothing appearing to be wrong. */
  for (const secret of roomSecretsInPlay()) {
    if (DC.payloadLeaksSecret(obj, secret)) {
      console.error(`Refusing to send "${obj && obj.type}": payload contains the room secret`);
      return;
    }
  }
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

/* ══════════════════════════════════════════════
   LOBBY
══════════════════════════════════════════════ */

function requestSessionList() { wsSend({ type: "list-sessions" }); }
refreshBtn.onclick = requestSessionList;

/* A create the server has not answered yet. wsSend drops a message while the
   link is down, so a Create pressed then — while Render woke up, or just after
   a drop — sent nothing, and the page sat on "Creating…" with every create
   button disabled for good. It is kept until answered, and sent (again) each
   time the link comes up.

   Sent again, it may find the room already made: the first one arrived, and
   only its answer was lost with the link. The server keeps such a room for
   its host, and refused the second create as "name taken" — this page's own
   room blocking its name. So each create carries a key of its own, the same
   every time it is sent (makeCreateKey), and the server answers the same key
   with the same room. The key is random, this page's, and only ever sent
   with its create: it is not the room secret, and is never in a link. */
let pendingCreate = null;

function makeCreateKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sendPendingCreate() {
  if (pendingCreate && ws && ws.readyState === WebSocket.OPEN) wsSend(pendingCreate);
}

/* ── Install as an app ──────────────────────
   The button at the bottom left. Chrome, Edge and Samsung Internet offer to
   install a site that has a manifest; the offer arrives as beforeinstallprompt,
   is held here, and is spent when the button is pressed — the browser shows
   its own install window, one tap more puts the icon on the home screen or
   desktop. No page can install itself on an iPhone: there the button shows
   the taps that do it. Already installed, or a browser that cannot install a
   site (Firefox): no button. The decision is G.installOffer.              */
const installBtn     = document.getElementById("installBtn");
const installOverlay = document.getElementById("installOverlay");
let installPrompt = null;   // the browser's offer; good for one use

function runningInstalled() {
  return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

function updateInstallButton() {
  const offer = G.installOffer({
    standalone: runningInstalled(), canPrompt: Boolean(installPrompt),
    userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints, inApp: Boolean(_inApp)
  });
  installBtn.dataset.offer = offer;
  installBtn.classList.toggle("hidden", offer === "none");
}

async function installApp() {
  if (installBtn.dataset.offer === "ios-help") { installOverlay.classList.remove("hidden"); return; }
  const offer = installPrompt;
  if (!offer) return;
  installPrompt = null;            // a browser's offer can be shown once
  offer.prompt();
  await offer.userChoice.catch(() => null);
  updateInstallButton();
}

window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();              // no banner of the browser's own: the button is the offer
  installPrompt = e;
  updateInstallButton();
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  updateInstallButton();
  showToast(t("appInstalled"), "info");
});
installBtn.onclick = installApp;
document.getElementById("installCloseBtn").onclick = () => installOverlay.classList.add("hidden");
installOverlay.onclick = e => { if (e.target === installOverlay) installOverlay.classList.add("hidden"); };
updateInstallButton();

/* ── Opened inside another app's browser ───
   A link sent through Facebook, Instagram, Messenger and the like opens in
   that app's own browser. It is run by the app, which can add its own code to
   the pages it shows; it often may not use the camera or microphone, so calls
   fail; and it closes, chat and all, when the app is left. So the page says
   so first, and offers the ways out:

     iPhone   "Open in Safari" — hands the whole address, invite and all, to
              Safari (G.safariUrl). Some apps block it; then the note says to
              use their ⋯ menu.
     Android  "Open in browser", for the default browser — only with no invite
              in the address, since Android's way cannot carry its fragment
              (G.androidIntentUrl).
     both     the app's own "Open in browser", which takes the address as it is;
              "Copy link", to paste into Safari or Chrome; "Continue here".

   While the notice is up the invite stays in the address and nothing joins
   (inAppHold, above). "Continue here" lets go: the address is tidied and the
   invite joins, as it would have in any browser.                         */
const inAppOverlay = document.getElementById("inAppOverlay");
const inAppText    = document.getElementById("inAppText");
const inAppNote    = document.getElementById("inAppNote");

function showInAppNotice() {
  const advice = G.inAppAdvice({ inApp: _inApp, hasInvite: _isAutoJoin });
  inAppText.dataset.i18n = _inApp.app ? "inAppText" : "inAppTextUnknown";
  inAppText.dataset.i18nArg = _inApp.app || "";
  inAppText.textContent = _inApp.app ? I18N[LANG].inAppText(_inApp.app) : t("inAppTextUnknown");
  document.getElementById("inAppSafariBtn").classList.toggle("hidden", !advice.safari);
  document.getElementById("inAppDefaultBtn").classList.toggle("hidden", !advice.openDefault);
  inAppOverlay.classList.remove("hidden");
}

function leaveForBrowser(url) {
  if (!url) return;
  location.href = url;
  /* An app that blocks the hand-off simply does nothing. */
  setTimeout(() => { inAppNote.textContent = t("inAppIfNothing"); }, 1500);
}

function continueInApp() {
  try { sessionStorage.setItem("dc-inapp-continue", "1"); } catch (_) {}
  inAppHold = false;
  inAppOverlay.classList.add("hidden");
  if (_isAutoJoin) {
    history.replaceState({}, "", location.pathname);
    /* The socket opening joins, if it has not opened yet. */
    if (ws && ws.readyState === WebSocket.OPEN) checkAutoJoin();
  }
}

document.getElementById("inAppSafariBtn").onclick  = () => leaveForBrowser(G.safariUrl(location.href));
document.getElementById("inAppDefaultBtn").onclick = () => leaveForBrowser(G.androidIntentUrl(location.href));
document.getElementById("inAppCopyBtn").onclick = () => {
  const link = location.href;          // the invite included: it is still in the address
  const done = () => showToast(t("inAppCopied"), "info");
  navigator.clipboard.writeText(link).then(done).catch(() => {
    const field = document.createElement("input");
    field.value = link;
    document.body.appendChild(field);
    field.select();
    document.execCommand("copy");
    field.remove();
    done();
  });
};
document.getElementById("inAppContinueBtn").onclick = continueInApp;
if (inAppHold) showInAppNotice();

/* ── Tabs: Rooms | Create room | Email ──────
   One section at a time, so the lobby is one screen instead of three cards
   stacked. Rooms is where every visit opens — most people arriving are
   joining someone — and where the lobby returns after a chat.          */
const lobbyTabs = [...document.querySelectorAll(".lobby-tab")];
let activeLobbyTab = "rooms";

function showLobbyTab(name) {
  if (!lobbyTabs.some(tab => tab.dataset.tab === name)) return;
  const arriving = name !== activeLobbyTab;
  activeLobbyTab = name;
  for (const tab of lobbyTabs) {
    const on = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;    // one tab stop for the row; arrows move along it
    document.getElementById(tab.getAttribute("aria-controls")).classList.toggle("hidden", !on);
  }
  /* The list may be minutes old; looking at it is the moment to refresh it. */
  if (name === "rooms" && arriving) requestSessionList();
}

/** Which tab an arrow, Home or End key moves to from tab `index` of `count`
    (wrapping round), or -1 for any other key. */
function lobbyTabKeyTarget(key, index, count) {
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft")  return (index - 1 + count) % count;
  if (key === "Home")       return 0;
  if (key === "End")        return count - 1;
  return -1;
}

lobbyTabs.forEach((tab, index) => {
  tab.onclick = () => showLobbyTab(tab.dataset.tab);
  tab.onkeydown = e => {
    const to = lobbyTabKeyTarget(e.key, index, lobbyTabs.length);
    if (to < 0) return;
    e.preventDefault();
    showLobbyTab(lobbyTabs[to].dataset.tab);
    lobbyTabs[to].focus();
  };
});

function renderSessionList(sessions) {
  _lastSessionList = sessions || [];
  roomsCount.textContent = String(_lastSessionList.length);
  roomsCount.classList.toggle("hidden", !_lastSessionList.length);
  if (!_lastSessionList.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("noRooms");
    sessionsList.replaceChildren(empty);
    return;
  }
  sessionsList.replaceChildren();
  _lastSessionList.forEach(({ sessionId, createdAt, open, kind }) => {
    /* Three kinds. Anything an older server did not label is a PIN room; only
       an explicit flag makes it anything else, so a room never changes kind by
       accident. */
    const roomIs = kind === "code" ? "code" : (open === true || kind === "open") ? "open" : "pin";
    const glyph  = { pin: "🔒", open: "🔓", code: "🔑" }[roomIs];
    const label  = { pin: "roomKindPin", open: "roomKindOpen", code: "roomKindCode" }[roomIs];
    const item = document.createElement("div");
    item.className = "session-item";
    const info = document.createElement("div");
    info.className = "session-item-info";
    const name = document.createElement("div");
    name.className = "session-item-name";
    name.textContent = `${glyph} ${sessionId}`;
    const meta = document.createElement("div");
    meta.className = "session-item-meta";
    const kindTag = document.createElement("span");
    kindTag.className = roomIs === "pin" ? "room-kind" : `room-kind ${roomIs}`;
    kindTag.textContent = t(label);
    meta.append(document.createTextNode(I18N[LANG].sessionMeta(timeAgo(createdAt))), kindTag);
    info.append(name, meta);
    /* The room this browser is hosting: said as such, with nothing to press —
       a Join button here could only fail. */
    if (G.isOwnRoom({ sessionId, isHost, currentSessionId: currentSession?.sessionId })) {
      const yours = document.createElement("span");
      yours.className = "own-room-tag";
      yours.textContent = t("roomYours");
      item.append(info, yours);
      sessionsList.appendChild(item);
      return;
    }
    const joinBtn = document.createElement("button");
    joinBtn.className = "join-btn";
    joinBtn.dataset.id = sessionId;
    joinBtn.textContent = t("joinBtn");
    /* An open room has nothing to type. A code room asks for the shared word. A
       PIN room asks for the PIN. If the list is wrong about a room, the server
       says so and the right dialog opens then — see the pin-required case. */
    joinBtn.onclick = () =>
      roomIs === "open" ? joinOpenRoom(sessionId) :
      roomIs === "code" ? openCodeJoin(sessionId) :
                          openPinModal(sessionId);
    item.append(info, joinBtn);
    sessionsList.appendChild(item);
  });
}

function timeAgo(ts) {
  const { unit, value } = DCS.timeAgo(ts);
  return { s: I18N[LANG].timeS, m: I18N[LANG].timeM, h: I18N[LANG].timeH }[unit](value);
}

/* Three kinds of room, one per button.

     PIN room   the guest types the 6-digit PIN, or uses the invite link
     open room  no secret: anyone who can see the list taps Join and is in
     code room  the host invents a word, shares it, and the guest types it;
                SPAKE2 proves the word and turns the chat green with nothing to
                compare by hand (see pake.js)

   All three hold the host and one guest. */
function createRoom(kind) {
  const sessionId = sessionIdInput.value.trim();
  if (!sessionId) { showToast(t("enterSessionName"), "warn"); return; }
  if (isConnecting) return;
  if (kind === "code" && !pakeCode) { openChooseCode(sessionId); return; }
  isConnecting = true;
  setCreateButtons(true);
  createInfo.textContent = t("creating");
  roomKind = kind;   // so the host takes the code path when the channel opens
  pendingCreate = { type: "create-session", sessionId, open: kind === "open", code: kind === "code",
                    createKey: makeCreateKey() };
  sendPendingCreate();
}

/* ── A waiting room lost with the server link ─
   The server drops a socket's room when the socket goes, and cannot tell the
   host — the host's socket is the one that went. The PIN and link stayed on
   screen for a room that no longer existed, and whoever used them was told
   "not found". Now the host is told, and can make it again in one tap: same
   name, same kind, and for a code room the same word, which the guest already
   has. A PIN room gets a new PIN; there is no keeping the old one.        */
function loseWaitingRoom() {
  /* Waiting for a saved person: nothing to make again by hand — a tap on
     their name does it. */
  if (roomKind === "saved") { endMeeting(); showToast(`⚠️ ${t("savedLost")}`, "warn"); return; }
  const lost = { sessionId: currentSession.sessionId, kind: roomKind };
  forgetHostRoom();
  hostKey = null;
  reclaimPending = false;
  keepScreenOn(false);
  currentSession = null;
  roomSecret = null;
  isHost = false;
  isConnecting = false;
  const msg = document.createElement("div");
  msg.style.color = "var(--orange)";
  msg.textContent = `⚠️ ${t("roomLost")}`;
  const again = document.createElement("button");
  again.className = "recreate-btn";
  again.textContent = t("recreateRoom");
  again.onclick = () => recreateRoom(lost);
  createInfo.style.textAlign = "center";
  createInfo.replaceChildren(msg, again);
  setCreateButtons(false);
  if (activeLobbyTab !== "create") showToast(`⚠️ ${t("roomLost")}`, "warn");
  renderSessionList(_lastSessionList);
}

/* ── Taking a waiting room back ─────────────
   To send the link, the host switches to a messaging app; the phone pauses
   the page, and an iPhone cuts its link to the server at once. The server
   used to delete the room with the link, so the link the friend received was
   dead by the time they tapped it. Now the server keeps a waiting room for a
   while, and this page takes it back on reconnecting by presenting its host
   key (reclaim-session) — the same room, the same PIN, the same link.

   The phone may also close the page in the background. The room is therefore
   kept in sessionStorage too, for this tab only, and a page opened fresh takes
   it back from there (G.restorableHostRoom). It holds the room's secret and,
   for a code room, its word, so it lives no longer than the room: forgotten
   when the chat starts, the room ends, or the host leaves.             */
const HOST_ROOM_KEY = "dc-host-room";
let hostRoomRestoreTried = false;

function saveHostRoom() {
  /* Not a saved person's room: a page opened fresh meets them by a tap on
     their name again, and the server gives that page the seat. */
  if (!isHost || !currentSession || !hostKey || !roomReadyInfo || roomKind === "saved") return;
  try {
    sessionStorage.setItem(HOST_ROOM_KEY, JSON.stringify({
      v: 1, sessionId: currentSession.sessionId, hostKey, token: currentSession.token,
      pin: roomKind === "pin" ? roomReadyInfo.pin : null, kind: roomKind,
      roomSecret: roomSecret || null, word: roomKind === "code" ? pakeCode : null,
      savedAt: Date.now()
    }));
  } catch (_) { /* storage off: a reconnect can still take the room back, a reload cannot */ }
}

function forgetHostRoom() {
  try { sessionStorage.removeItem(HOST_ROOM_KEY); } catch (_) {}
}

/** Our link dropped while hosting a waiting room: the PIN and link stay on
    screen — they still work — and the room is taken back on reconnecting. */
function awaitReclaim() {
  reclaimPending = true;
  const note = document.createElement("span");
  note.style.color = "var(--orange)";
  note.textContent = `⏳ ${t("reconnectingRoom")}`;
  lobbyStatus.replaceChildren(note);
}

/** Our link dropped mid-chat: take our seat back on the new one — the host
    with its host key, the guest with its guest key. */
function resumeSeat() {
  if (!seatPending || !currentSession) return;
  if (isHost && hostKey)        wsSend({ type: "reclaim-session", sessionId: currentSession.sessionId, hostKey });
  else if (!isHost && guestKey) wsSend({ type: "rejoin-session",  sessionId: currentSession.sessionId, guestKey });
}

function sendReclaim() {
  if (!reclaimPending || !hostKey || !currentSession) return;
  wsSend({ type: "reclaim-session", sessionId: currentSession.sessionId, hostKey });
}

/** Opened fresh — a reload, or a page the phone had closed — while this tab
    was hosting a waiting room: take it up again. Once, at the first connection. */
function restoreHostRoom() {
  if (hostRoomRestoreTried) return;
  hostRoomRestoreTried = true;
  if (_isAutoJoin || currentSession || meeting) return;    // meeting: opened from a knock
  let stored = null;
  try { stored = JSON.parse(sessionStorage.getItem(HOST_ROOM_KEY) || "null"); } catch (_) {}
  const room = G.restorableHostRoom(stored, Date.now());
  if (!room) { forgetHostRoom(); return; }
  isHost = true;
  currentSession = { sessionId: room.sessionId, token: room.token };
  roomKind = room.kind;
  hostKey = room.hostKey;
  roomSecret = room.roomSecret;
  pakeCode = room.word;
  roomReadyInfo = { sessionId: room.sessionId, pin: room.pin, token: room.token, kind: room.kind, open: room.kind === "open" };
  reclaimRedraw = true;
  showLobbyTab("create");
  awaitReclaim();
}

function recreateRoom(lost) {
  sessionIdInput.value = lost.sessionId;
  createRoom(lost.kind);      // a code room still holds its word in pakeCode
}

createBtn.onclick     = () => createRoom("pin");
createOpenBtn.onclick = () => createRoom("open");
createCodeBtn.onclick = () => createRoom("code");

/** Host: ask for the word, remember it, then create the room. The word stays
    in this browser — it is never put in the create message. */
function openChooseCode(sessionId) {
  askForCode({
    title: t("chooseCodeTitle"), hint: t("chooseCodeHint"), confirmLabel: t("createBtnLabelCode"),
    onConfirm: word => { pakeCode = word; createRoom("code"); }
  });
}

/** Guest: ask for the word, then join. Admission is first-come like an open
    room; the word is proven peer to peer once connected, not sent to join. */
function openCodeJoin(sessionId) {
  if (isConnecting || listJoinId || pinJoinInFlight) return;
  askForCode({
    title: I18N[LANG].codeJoinTitle(sessionId), hint: t("codeJoinHint"), confirmLabel: t("joinBtn"),
    onConfirm: word => {
      pakeCode = word;
      roomKind = "code";
      listJoinId = sessionId;
      pendingRoomSecret = null;
      wsSend({ type: "join-session", sessionId });
    }
  });
}

/* ── Joining an open room ────────────────────── */
let listJoinId = null;   // a join sent straight from the list, not yet answered

function joinOpenRoom(sessionId) {
  /* One join at a time: a second tap, or a tap while an invite link is still
     being answered, would leave two answers and no way to tell them apart. */
  if (isConnecting || listJoinId || pinJoinInFlight) return;
  listJoinId = sessionId;
  roomKind = "open"; pakeCode = null;   // ECDH path, no shared word
  pendingRoomSecret = null;   // no link, so no shared secret — the shield starts amber
  wsSend({ type: "join-session", sessionId });
}

/* ── PIN modal ───────────────────────────────── */
let pendingJoinId = null;
let pinJoinInFlight = false;   // a join sent from this dialog, not yet answered

/** The dialog's join has been answered, or no longer matters. Join was only
    ever re-enabled after a refusal, so one successful join left it disabled
    for every room after — the dialog opened with a button that did nothing. */
function settlePinJoin() {
  pinJoinInFlight = false;
  pinJoinBtn.disabled = false;
}

function openPinModal(sessionId) {
  pendingJoinId = sessionId;
  pinSessionLabel.textContent = I18N[LANG].sessionLabel(sessionId);
  pinInput.value = "";
  pinError.textContent = "";
  settlePinJoin();   // a freshly opened dialog always has a working button
  pinOverlay.classList.remove("hidden");
  setTimeout(() => pinInput.focus(), 100);
}

pinCancelBtn.onclick = () => { pinOverlay.classList.add("hidden"); pendingJoinId = null; };
pinJoinBtn.onclick = attemptJoin;
pinInput.addEventListener("keydown", e => { if (e.key === "Enter") attemptJoin(); });

function attemptJoin() {
  const pin = pinInput.value.trim();
  if (pin.length !== 6) { pinError.textContent = t("pinMustBe6"); return; }
  pinError.textContent = "";
  pinJoinBtn.disabled = true;
  pinJoinInFlight = true;
  roomKind = "pin"; pakeCode = null;   // a PIN join is the ECDH path, not a code room
  pendingRoomSecret = null;   // PIN join — no shared secret, manual verification applies
  wsSend({ type: "join-session", sessionId: pendingJoinId, pin });
}

/* ══════════════════════════════════════════════
   SAVED PEOPLE
   ─────────────────────────────────────────────
   Talking to the same person again took a room made from nothing each time:
   a name typed, a kind picked, a link copied and sent through another app,
   and that link tapped. Once two people have saved each other, each just
   taps the other's name in the lobby: whoever is first waits, and the second
   tap connects them — green, with nothing to type, send or compare.

   Saving: in a chat already checked (green — G.mayOfferSave), one side
   offers and names the other; the other is asked, and names them back. The
   offer carries a fresh secret, sealed, over the chat itself — never through
   the server. Each device keeps the secret, the name it chose, and which
   side of the pair it is ("a" offered, "b" answered).

   Meeting: the room's name is a hash of the secret (DC.savedRoomName), so
   both devices work it out alone, and the server learns nothing it could
   join with. One message, meet-session, makes the room or joins it — see
   server.js. The secret is then mixed into the key exactly as an invite
   link's is, and the host takes no key made without it (G.mayUsePlainKey):
   a seat taken by anyone else — the server included — never opens.

   The waiting side waits here in the lobby, on the person's row, with the
   screen kept on, until they come, it is cancelled, or ten minutes pass.  */
const PEOPLE_KEY = "dc-people";

function loadPeople() {
  try { return G.savedPeople(JSON.parse(localStorage.getItem(PEOPLE_KEY) || "null")); }
  catch (_) { return []; }
}

/** Stored, or false: storage switched off, full, or a window that keeps nothing. */
function storePeople(list) {
  try { localStorage.setItem(PEOPLE_KEY, JSON.stringify({ v: 1, people: list })); return true; }
  catch (_) { return false; }
}

/** Asked before offering or accepting, so neither side is left saved alone. */
function peopleStorable() {
  try { localStorage.setItem(`${PEOPLE_KEY}-probe`, "1"); localStorage.removeItem(`${PEOPLE_KEY}-probe`); return true; }
  catch (_) { return false; }
}

/** What to call a room on screen: a saved person's room by their name, not
    the hash it is named by. */
function roomTitle(sessionId) {
  return meeting && meeting.room === sessionId ? meeting.name : sessionId;
}

function drawPeople() {
  peopleSection.classList.toggle("hidden", !people.length);
  peopleList.replaceChildren(...people.map(personRow));
  drawKnockSwitch();
  mirrorForKnocks();
}

function personRow(p) {
  const item = document.createElement("div");
  item.className = "person-item";

  if (forgetting === p.room) {
    item.classList.add("asking");
    const ask = document.createElement("span");
    ask.className = "person-ask";
    ask.textContent = I18N[LANG].forgetAsk(p.name);
    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "person-small-btn btn-quiet";
    keep.textContent = t("forgetNo");
    keep.onclick = () => { forgetting = null; drawPeople(); };
    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "person-small-btn btn-danger";
    forget.textContent = t("forgetYes");
    forget.onclick = () => forgetPerson(p);
    item.append(ask, keep, forget);
    return item;
  }

  const here = Boolean(meeting) && meeting.room === p.room;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "person-open";
  open.disabled = Boolean(meeting);
  const avatar = document.createElement("span");
  avatar.className = "person-avatar";
  avatar.appendChild(tablerIcon("user"));
  const text = document.createElement("span");
  text.className = "person-text";
  const name = document.createElement("span");
  name.className = "person-name";
  name.textContent = p.name;
  /* They turned alerts on: a tap knocks if they are not there. */
  if (p.knock) {
    const bell = tablerIcon("bell");
    bell.classList.add("person-knock");
    bell.setAttribute("aria-hidden", "false");
    bell.setAttribute("role", "img");
    bell.setAttribute("aria-label", t("personAlerted"));
    bell.title = t("personAlerted");
    name.appendChild(bell);
  }
  const sub = document.createElement("span");
  sub.className = "person-sub";
  /* Tapped: the room is being made, or made and waited in — and knocked on.
     Or they tapped ours and wait for us: the row stands out (theyWait). */
  const theyAreWaiting = !here && waitingForUs.has(p.room);
  const callingThem = here && Boolean(quickCall) && quickCall.room === p.room;
  sub.textContent = t(theyAreWaiting ? "personWantsToTalk" : !here ? "personTap" : !currentSession ? "personConnecting"
                    : callingThem ? "personCallWaiting" : knockSent ? "personKnocked" : "personWaiting");
  if (theyAreWaiting) {
    item.classList.add("knocking");
    avatar.replaceChildren(tablerIcon("bell-ringing"));
  }
  text.append(name, sub);
  open.append(avatar, text);
  open.onclick = () => {
    if (heldOpen) return;                // the release of a long press, not a tap (the page's click handler clears it)
    meetPerson(p);
  };
  open.title = t("personMenuHint");
  item.appendChild(open);

  /* A call straight from the row: their chat, and the call as soon as it is
     up (quickCallPerson). Not while someone is being met. */
  if (!here) {
    for (const [icon, label, video] of [["phone", "voiceCall", false], ["video", "videoCall", true]]) {
      const tool = document.createElement("button");
      tool.type = "button";
      tool.className = "person-tool call";
      tool.disabled = Boolean(meeting);
      tool.setAttribute("aria-label", `${t(label)}: ${p.name}`);
      tool.title = t(label);
      tool.appendChild(tablerIcon(icon));
      tool.onclick = () => quickCallPerson(p, video);
      item.appendChild(tool);
    }
  }
  /* Messages for them, or from them — also while waiting for them: a word
     left instead. */
  item.appendChild(mailTool(p));
  if (here) {
    item.classList.add("waiting");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "person-small-btn btn-quiet";
    cancel.textContent = t("personCancel");
    cancel.onclick = () => leaveBtn.click();
    item.appendChild(cancel);
    return item;
  }
  /* Rename and forget are kept out of sight: a right click, a long press on
     a phone, or the keyboard's menu key opens them on the row (personMenu).
     Asked for: the pencil and the bin on every row were more than needed. */
  item.oncontextmenu = e => { e.preventDefault(); openPersonMenu(p); };
  holdForMenu(item, p);
  if (personMenuFor === p.room) item.appendChild(personMenu(p));
  return item;
}

/* ── A call straight from the row ───────────
   Asked for: a voice or video call from a saved person's row, beside the
   envelope. It meets them as a tap on the name does — their room, a knock
   if they turned alerts on — and once the chat with them is up, places the
   call as the chat's own button would (requestCall): they are asked, as for
   any call. If they are not there yet, the row says the call will start when
   they connect; cancelling, or leaving, drops it.

   Both may press call at once. Two requests crossing would each turn the
   other away, so the host calls first and the guest a moment later — and
   not at all if the host's call is already ringing there: one tap answers
   it.

   The host calls once the guest has introduced itself (peer-info), not the
   moment its own key is agreed. Found trying it: the host is ready first,
   and a call sent then overtook the confirmation that makes the guest ready
   — dropped on arrival, so the host rang and the guest never heard it. The
   guest introduces itself only once it is ready. */
const QUICK_CALL_GUEST_WAIT_MS = 1500;
let quickCallArmed = null;          // the host's call asked for, waiting for the guest to be ready

function quickCallPerson(p, video) {
  meetPerson(p);
  if (!meeting || meeting.room !== p.room) return;     // busy: nothing was started
  quickCall = { room: p.room, video };
  drawPeople();
}

/** The chat with them is up (e2eActivate): place the call asked for — the
    guest a moment later, the host once the guest is ready (quickCallPeerReady). */
function placeQuickCall() {
  const asked = quickCall;
  quickCall = null;
  if (!asked || roomKind !== "saved" || !meeting || meeting.room !== asked.room) return;
  if (isHost) { quickCallArmed = asked; return; }
  setTimeout(() => ringQuickCall(asked), QUICK_CALL_GUEST_WAIT_MS);
}

/** The guest has introduced itself (peer-info): it is ready, and the host's call can ring there. */
function quickCallPeerReady() {
  const asked = quickCallArmed;
  quickCallArmed = null;
  if (asked && meeting && meeting.room === asked.room) ringQuickCall(asked);
}

function ringQuickCall(asked) {
  if (inCall || !e2eReady || !callRequestModal.classList.contains("hidden")) return;   // theirs rings here: answer that
  requestCall(asked.video);
}

/* ── Rename and forget, on request ──────────
   A right click opens them, and the keyboard's menu key — both are the
   browser's "contextmenu". Android sends that on a long press as well; an
   iPhone does not, so a press held for half a second opens them too (a
   finger that moves is scrolling, and lets go of it). The click a long
   press's release can send is not taken for a tap on the name. A tap
   anywhere else, or Escape, closes them; nothing opens while someone is
   being met. */
const HOLD_MS = 500;

function openPersonMenu(p) {
  if (meeting || forgetting) return;
  personMenuFor = p.room;
  drawPeople();
  const first = peopleList.querySelector(".person-menu-item");
  if (first) first.focus();                // for the keyboard: straight to Rename
}

function closePersonMenu() {
  if (personMenuFor === null) return;
  personMenuFor = null;
  drawPeople();
}

function holdForMenu(item, p) {
  let timer = null, from = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  item.addEventListener("pointerdown", e => {
    if (e.pointerType !== "touch") return;
    from = { x: e.clientX, y: e.clientY };
    cancel();
    timer = setTimeout(() => { timer = null; heldOpen = true; openPersonMenu(p); }, HOLD_MS);
  });
  item.addEventListener("pointermove", e => {
    if (timer && from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 10) cancel();
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) item.addEventListener(type, cancel);
}

function personMenu(p) {
  const menu = document.createElement("div");
  menu.className = "person-menu";
  menu.setAttribute("role", "menu");
  for (const [icon, label, act, kind] of [["pencil", "personRename", renamePerson, ""], ["trash", "personForget", askForget, " danger"]]) {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = `person-menu-item${kind}`;
    choice.setAttribute("role", "menuitem");
    choice.setAttribute("aria-label", `${t(label)}: ${p.name}`);
    const words = document.createElement("span");
    words.textContent = t(label);
    choice.append(tablerIcon(icon), words);
    choice.onclick = () => { personMenuFor = null; act(p); };
    menu.appendChild(choice);
  }
  return menu;
}

/* A long press whose release sent no click (Android's does not) leaves
   nothing behind: the next touch starts afresh. */
document.addEventListener("pointerdown", () => { heldOpen = false; });
document.addEventListener("click", e => {
  /* The long press's own release: it neither meets (the name's click lets it
     pass) nor closes what it just opened. Cleared here, after the name's
     click, which runs first. Found trying it: cleared there, this closed the
     menu as its own release came up. */
  if (heldOpen) { heldOpen = false; return; }
  if (personMenuFor !== null && !(e.target && e.target.closest && e.target.closest(".person-menu"))) closePersonMenu();
});
document.addEventListener("keydown", e => { if (e.key === "Escape") closePersonMenu(); });

/** A tap on their name: make our room, or join theirs if they are waiting. */
function meetPerson(p) {
  if (meeting || listJoinId || pinJoinInFlight || (isConnecting && !currentSession)) return;
  /* A room of our own still waiting for its guest is given up for this. */
  if (currentSession) leaveBtn.click();
  meeting = p;
  waitingForUs.delete(p.room);        // tapped: coming, so no longer shown as waiting
  knockSent = false;
  isConnecting = true;
  roomKind = "saved"; pakeCode = null;
  pendingRoomSecret = p.secret;       // mixed into the key; never sent
  pendingMeet = { type: "meet-session", sessionId: p.room, side: p.side };
  sendPendingMeet();
  drawPeople();
}

function sendPendingMeet() {
  if (pendingMeet && ws && ws.readyState === WebSocket.OPEN) wsSend(pendingMeet);
}

/** First there: the room is made, and we wait in it — on their row, here in
    the lobby. A tap cancelled before this answer came has nothing to take up:
    the cancel's leave-session went after the meet, so the server has already
    let the room go. Another leave now could only take a room made since. */
function meetWaiting(data) {
  pendingMeet = null;
  if (!meeting || meeting.room !== data.sessionId) return;
  isHost = true;
  hostKey = typeof data.hostKey === "string" ? data.hostKey : null;
  reclaimPending = false;
  roomKind = "saved";
  currentSession = { sessionId: data.sessionId, token: null };
  roomSecret = meeting.secret;
  pendingRoomSecret = null;
  isConnecting = false;
  keepScreenOn(true);                 // a lock now would take the room with it
  drawPeople();
  knockFor(meeting);                  // they get alerts: tell them we are here
}

/** The wait for them is over without a chat — expired, lost, or refused. */
function endMeeting() {
  keepScreenOn(false);
  hostKey = null;
  reclaimPending = false;
  if (isHost) currentSession = null;
  roomSecret = null;
  pendingRoomSecret = null;
  isHost = false;
  isConnecting = false;
  roomKind = "pin";
  meeting = null;
  pendingMeet = null;
  knockSent = false;
  quickCall = null;                // a call asked for goes with the meeting
  quickCallArmed = null;
  lobbyStatus.replaceChildren();
  drawPeople();
}

/** This chat was opened again elsewhere — another tab, or this page opened
    afresh — and the seat went there. This copy stops, and nothing joins
    again by itself, so the two never take the seat back and forth. */
function savedSeatTaken() {
  const inChat = !chatScreen.classList.contains("hidden");
  clearConnectWatch();
  if (dataChannel) dataChannel.onclose = null;
  endCall(false);
  closePeerConnection();
  guestKey = null;
  seatPending = false;
  endMeeting();
  currentSession = null;
  if (!inChat) { showToast(t("savedElsewhere"), "info"); return; }
  voiceCallBtn.disabled = true;
  videoCallBtn.disabled = true;
  statsBar.textContent = "";
  setQuality(`⬤ ${t("seatTakenShort")}`, "failed");
  appendSys(t("savedElsewhere"));
  showReconnectButton();
}

/* ── Saving each other, in a chat ───────────── */

/** Once a chat is checked, it offers — once, as a line in the chat. */
function maybeOfferSave() {
  if (chatMessages.querySelector(".save-sys")) return;
  if (!G.mayOfferSave({ ready: e2eReady, secure: e2eSecureMode, verified: e2eVerified, savedRoom: roomKind === "saved" })) return;
  const line = document.createElement("div");
  line.className = "save-sys";
  chatMessages.appendChild(line);
  drawSaveLine("offer");
  scrollBottom();
}

/** The line: the offer, waiting for their answer, or saved. */
function drawSaveLine(state, name) {
  const line = chatMessages.querySelector(".save-sys");
  if (!line) return;
  const text = document.createElement("span");
  if (state !== "offer") {
    text.textContent = state === "waiting" ? t("saveLineWaiting") : I18N[LANG].saveLineDone(name);
    line.replaceChildren(text);
    return;
  }
  text.textContent = t("saveLineText");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "reconnect-sys-btn";
  btn.append(tablerIcon("user-plus"), document.createTextNode(t("saveLineBtn")));
  btn.onclick = startSaveOffer;
  line.replaceChildren(text, btn);
}

function chatChecked() {
  return G.mayOfferSave({ ready: e2eReady, secure: e2eSecureMode, verified: e2eVerified, savedRoom: roomKind === "saved" });
}

/** Ours: name them, then ask them. Saved once they say yes. */
function startSaveOffer() {
  if (saveOffer || saveAsked) return;
  if (!chatChecked()) { showToast(t("savedVerifyFirst"), "warn"); return; }
  if (!peopleStorable()) { showToast(t("savedNoStorage"), "error"); return; }
  if (people.length >= G.SAVED_PEOPLE_MAX) { showToast(t("savedFull"), "warn"); return; }
  openSaveDialog("offer", {
    onConfirm: async name => {
      if (saveOffer || saveAsked || !chatChecked()) return;
      saveOffer = { secret: DC.makeRoomSecret(), name };
      if (!await dcSendE2e({ type: "save-offer", secret: saveOffer.secret })) {
        saveOffer = null;
        showToast(t("messageNotSent"), "error");
        return;
      }
      drawSaveLine("waiting");
    }
  });
}

/** Theirs: we are asked, and name them back — or say not now. */
async function receiveSaveOffer(data) {
  if (!G.saveOfferValid(data) || saveAsked) return;
  const decline = reason => dcSendE2e({ type: "save-decline", ...(reason ? { reason } : {}) }).catch(() => {});
  if (roomKind === "saved") { decline(); return; }       // already saved: nothing to ask
  /* Both pressed Save, and the offers crossed: both sides keep the same one,
     answered with the name already given. */
  if (saveOffer) {
    if (!G.keepTheirOffer(saveOffer.secret, data.secret)) return;    // they answer ours
    const { name } = saveOffer;
    saveOffer = null;
    await acceptSaveOffer(data.secret, name);
    return;
  }
  if (!chatChecked()) { decline("unverified"); showToast(t("savedVerifyFirst"), "warn"); return; }
  if (!peopleStorable()) { decline("storage"); showToast(t("savedNoStorage"), "error"); return; }
  if (people.length >= G.SAVED_PEOPLE_MAX) { decline(); showToast(t("savedFull"), "warn"); return; }
  saveAsked = { secret: data.secret };
  openSaveDialog("ask", {
    onConfirm: name => { if (saveAsked) acceptSaveOffer(saveAsked.secret, name); },
    onCancel:  () => { if (saveAsked) { saveAsked = null; decline(); } }
  });
}

async function acceptSaveOffer(secret, name) {
  saveAsked = null;
  const person = await addPerson(name, secret, "b");
  if (!person) { dcSendE2e({ type: "save-decline", reason: "storage" }).catch(() => {}); return; }
  dcSendE2e({ type: "save-accept" }).catch(() => {});
  drawSaveLine("done", person.name);
  showToast(I18N[LANG].savedDone(person.name), "info");
  savedInChatNow(person);
}

/** They said yes to ours: saved here too. */
async function receiveSaveAccept() {
  if (!saveOffer) return;
  const { secret, name } = saveOffer;
  saveOffer = null;
  const person = await addPerson(name, secret, "a");
  if (!person) return;
  drawSaveLine("done", person.name);
  showToast(I18N[LANG].savedDone(person.name), "info");
  savedInChatNow(person);
}

/** They said no, or could not. Their reason picks one of our sentences. */
function receiveSaveDecline(data) {
  if (!saveOffer) return;
  saveOffer = null;
  const reason = data && data.reason;
  showToast(t(reason === "unverified" ? "savedPeerVerifyFirst" : reason === "storage" ? "savedPeerNoStorage" : "savedDeclined"), "info");
  drawSaveLine("offer");
}

/** Keeps one more person, or says why not. Returns them as kept, or null. */
async function addPerson(rawName, secret, side) {
  const name = G.personName(rawName);
  if (!name || !G.SAVED_SECRET.test(secret)) return null;
  if (people.length >= G.SAVED_PEOPLE_MAX) { showToast(t("savedFull"), "warn"); return null; }
  const room = await DC.savedRoomName(secret);
  const next = G.savedPeople({ v: 1, people: [...people, { name, secret, room, side, savedAt: Date.now() }] });
  if (!storePeople(next)) { showToast(t("savedNoStorage"), "error"); return null; }
  people = next;
  drawPeople();
  fetchMail();                        // their mailbox, asked after from now on
  return people.find(p => p.secret === secret) || null;
}

function renamePerson(p) {
  openSaveDialog("rename", {
    value: p.name,
    onConfirm: name => {
      const next = people.map(q => q.room === p.room ? { ...q, name } : q);
      if (!storePeople(next)) { showToast(t("savedNoStorage"), "error"); return; }
      people = next;
      drawPeople();
    }
  });
}

function askForget(p) {
  forgetting = p.room;
  drawPeople();
}

function forgetPerson(p) {
  forgetting = null;
  const next = people.filter(q => q.room !== p.room);
  if (!storePeople(next)) { showToast(t("savedNoStorage"), "error"); drawPeople(); return; }
  people = next;
  /* Their conversation goes with them. */
  delete mailStore.threads[p.room];
  delete mailStore.seen[p.room];
  storeMail();
  if (mailOpenFor === p.room) closeThread();
  drawPeople();
  renewKnockAddress(p);
}

/* Found in a security assessment: forgetting someone took them off this
   device and nothing more. They still held where to knock for it, and could
   go on making it say "Someone you saved wants to talk". A browser gives a
   device one address for all of them, so the only way to take it back from
   one is to give it up: with alerts on, the address is made afresh and the
   old one ended — the push service then calls it gone, and a knock to it
   goes nowhere. Everyone still saved gets the new one the next time they
   connect, as after alerts are turned on (shareKnockAddress); until then a
   knock from them finds the old one gone, so the toast says so. */
async function renewKnockAddress(forgotten) {
  if (!knockSub || knockStateNow() !== "on") return;
  const old = knockSub;
  knockSub = null;                         // one renewal at a time; a second forget is covered by it
  try {
    await old.unsubscribe();
    const reg = await navigator.serviceWorker.ready;
    knockSub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: knockKeyBytes() });
    showToast(I18N[LANG].forgetRenewed(forgotten.name), "info");
  } catch (err) {
    console.warn("Alerts could not be made afresh:", err);
    knockSub = null;
    showToast(t("knockFailed"), "error");
  }
  knocksChanged();
}

/* ── The name dialog ─────────────────────────
   One dialog, three uses: naming someone we offer to save, naming them back
   when they offered, and renaming. */
function openSaveDialog(mode, { value = "", onConfirm, onCancel = null }) {
  const words = {
    offer:  ["saveTitle",    "saveHint",    "saveCancel"],
    ask:    ["saveAskTitle", "saveAskHint", "saveNotNow"],
    rename: ["renameTitle",  "renameHint",  "saveCancel"]
  }[mode];
  saveDialog = { mode, onConfirm, onCancel };
  saveTitle.textContent = t(words[0]);
  saveHint.textContent = t(words[1]);
  saveCancelBtn.textContent = t(words[2]);
  saveConfirmBtn.textContent = t("saveConfirm");
  saveNameInput.value = value;
  saveOverlay.classList.remove("hidden");
  setTimeout(() => saveNameInput.focus(), 100);
}

function closeSaveDialog() {
  saveOverlay.classList.add("hidden");
  saveDialog = null;
}

function confirmSaveDialog() {
  const name = G.personName(saveNameInput.value);
  if (!name) { saveNameInput.focus(); return; }
  const done = saveDialog && saveDialog.onConfirm;
  closeSaveDialog();
  if (done) done(name);
}

function cancelSaveDialog() {
  const cancel = saveDialog && saveDialog.onCancel;
  closeSaveDialog();
  if (cancel) cancel();
}

saveConfirmBtn.onclick = confirmSaveDialog;
saveCancelBtn.onclick = cancelSaveDialog;
saveNameInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); confirmSaveDialog(); }
});

/* Saved or forgotten in another tab: the same list here. */
window.addEventListener("storage", e => {
  if (e.key !== PEOPLE_KEY) return;
  people = loadPeople();
  drawPeople();
});

people = loadPeople();
drawPeople();

/* ══════════════════════════════════════════════
   KNOCKS
   ─────────────────────────────────────────────
   Saving someone made meeting them one tap — if they opened the app too. Now
   the first to tap knocks: the other's device shows "Anu wants to talk", even
   with the app closed, and a tap on that opens the app and meets them.

   A device that wants knocks turns alerts on, with the switch by "Saved
   people": the browser asks, the worker (sw.js) is registered, and the
   browser's push service gives an address for this server's key. That
   address goes to each saved person sealed, over the chat — when they are
   saved, and each time they connect — and to the server only with a knock,
   from whoever is first in the room (see knock.js). An address the push
   service says is gone is forgotten.

   What it costs, said plainly: the push service (Google's, Apple's,
   Microsoft's or Mozilla's — whichever the browser uses) carries each knock.
   It cannot read it, but it sees that one came, and when. Nobody is knocked
   on who has not turned alerts on.                                         */

function knockStateNow() {
  return G.knockState({
    serverKey: Boolean(knockKey), supported: knockSupported,
    appleTouch: G.isAppleTouchDevice(navigator.userAgent, navigator.maxTouchPoints), standalone: runningInstalled(),
    permission: knockSupported ? Notification.permission : "default", subscribed: Boolean(knockSub)
  });
}

function drawKnockSwitch() {
  const state = knockStateNow();
  knockBtn.classList.toggle("hidden", state === "hidden");
  knockBtn.dataset.state = state;
  if (state === "hidden") return;
  const [icon, label] = {
    off: ["bell", "knockOff"], on: ["bell-ringing", "knockOn"],
    blocked: ["bell-off", "knockBlocked"], install: ["bell", "knockInstall"]
  }[state];
  knockIcon.className = `ti ti-${icon}`;
  knockLabel.textContent = t(label);
  knockBtn.title = t("knockHint");
  knockBtn.setAttribute("aria-pressed", String(state === "on"));
}

function knockKeyBytes() {
  return Uint8Array.from(atob(knockKey.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
}

/** The subscription is for the key this server signs with now. */
function subscribedToKey(sub) {
  const key = sub.options && sub.options.applicationServerKey;
  if (!key) return true;                 // a browser that does not say: believed
  return btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === knockKey;
}

/** The worker, at this build's address — registering it again updates it. */
function knockWorker() {
  return navigator.serviceWorker.register(`sw.js?v=${APP_BUILD}`, { updateViaCache: "none" })
    .then(() => navigator.serviceWorker.ready);
}

/** The server sends knocks. Where alerts were on, they are taken up again:
    the worker brought to this build, and the subscription made afresh if the
    server's key has changed since. */
async function knockKeyArrived(key) {
  knockKey = key;
  if (knockSupported) {
    try {
      if (await navigator.serviceWorker.getRegistration()) {
        const reg = await knockWorker();
        let sub = await reg.pushManager.getSubscription();
        if (sub && !subscribedToKey(sub)) {
          await sub.unsubscribe();
          sub = Notification.permission === "granted"
            ? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: knockKeyBytes() })
            : null;
        }
        knockSub = Notification.permission === "granted" ? sub : null;
      }
    } catch (err) {
      console.warn("Alerts could not be taken up:", err);
    }
  }
  drawPeople();
}

async function knocksOn() {
  /* Asked first, inside the tap: only then does a browser show its question. */
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    drawKnockSwitch();
    if (permission === "denied") showToast(t("knockBlockedHint"), "warn");
    return;
  }
  try {
    const reg = await knockWorker();
    knockSub = await reg.pushManager.getSubscription() ||
               await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: knockKeyBytes() });
    showToast(t("knockOnDone"), "info");
  } catch (err) {
    console.warn("Alerts could not be turned on:", err);
    knockSub = null;
    showToast(t("knockFailed"), "error");
  }
  knocksChanged();
}

async function knocksOff() {
  const sub = knockSub;
  knockSub = null;
  try { if (sub) await sub.unsubscribe(); } catch (_) { /* gone already */ }
  showToast(t("knockOffDone"), "info");
  knocksChanged();
}

/** On or off: the switch, and the person in this chat told at once. */
function knocksChanged() {
  drawPeople();
  if (knockPeer()) sendKnockAddress();
}

knockBtn.onclick = () => {
  const state = knockStateNow();
  if (state === "install") installOverlay.classList.remove("hidden");    // the Home Screen steps
  else if (state === "blocked") showToast(t("knockBlockedHint"), "warn");
  else if (state === "on") knocksOff();
  else knocksOn();
};

/** Where to knock for this device, while alerts are on. */
function knockAddress() {
  if (!knockSub || knockStateNow() !== "on") return null;
  const { endpoint, keys } = knockSub.toJSON();
  const address = { endpoint, p256dh: keys && keys.p256dh, auth: keys && keys.auth };
  return G.knockAddressValid(address) ? address : null;
}

/** Who this chat is with among the saved: the person met, or the one just
    saved here. */
function knockPeer() {
  return roomKind === "saved" ? meeting : savedInChat;
}

/** Tells them where to knock for us — or that alerts are off. */
function sendKnockAddress() {
  const address = knockAddress();
  dcSendE2e({ type: "knock-address", ...(address || { off: true }) }).catch(() => {});
}

/** Once a channel, in a saved person's room: the address may have changed
    since — alerts turned on or off, a new subscription. */
function shareKnockAddress() {
  if (knockShared || roomKind !== "saved") return;
  knockShared = true;
  sendKnockAddress();
}

/** Saved in this chat: their address, if it came first, is theirs now — and
    they get ours. */
function savedInChatNow(person) {
  savedInChat = person;
  if (knockEarly) { const early = knockEarly; knockEarly = null; receiveKnockAddress(early); }
  sendKnockAddress();
}

/** Where to knock for them, as they sent it — or that they turned alerts off. */
function receiveKnockAddress(data) {
  const peer = knockPeer();
  if (!peer) { knockEarly = data; return; }          // still saving them here
  const address = data.off === true ? null : { endpoint: data.endpoint, p256dh: data.p256dh, auth: data.auth };
  if (address && !G.knockAddressValid(address)) return;
  setKnockAddress(peer.room, address);
}

function setKnockAddress(room, address) {
  const next = people.map(q => {
    if (q.room !== room) return q;
    const kept = { ...q };
    delete kept.knock;
    return address ? { ...kept, knock: address } : kept;
  });
  if (!storePeople(next)) return;
  people = next;
  const now = people.find(q => q.room === room);
  if (now && meeting && meeting.room === room) meeting = now;
  if (now && savedInChat && savedInChat.room === room) savedInChat = now;
  drawPeople();
}

/** First in their room, and they get alerts: knock. */
function knockFor(p) {
  if (p && p.knock) wsSend({ type: "knock", sessionId: p.room, to: p.knock });
}

/** The server's answer: knocked, or not — and an address gone for good is
    forgotten, so it is not tried again. */
function knockAnswered(data) {
  if (!meeting || data.sessionId !== meeting.room) return;
  if (data.gone === true) setKnockAddress(meeting.room, null);
  knockSent = data.ok === true;
  drawPeople();
}

/** The worker's copy, for naming who knocked: each person's room and name,
    and the page's language — nothing else. Only while alerts are on. */
function mirrorForKnocks() {
  if (!knockSub || !window.indexedDB) return;
  const value = { lang: LANG, names: people.map(p => [p.room, p.name]) };
  try {
    const open = indexedDB.open("dc-knock", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onsuccess = () => {
      const db = open.result;
      try {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(value, "people");
        tx.oncomplete = tx.onerror = tx.onabort = () => db.close();
      } catch (_) { db.close(); }
    };
  } catch (_) { /* storage off: a knock still comes, without the name */ }
}

/* ── Someone waiting for us, shown on their name ──
   Asked for: when a saved person taps our name and waits, this lobby should
   show it — the knock's notification was easy to miss with the app open, and
   with alerts off there was none. While this page asks after the pair's
   mailboxes, the server says who waits for us and when they stop
   (meet-waiting): their row stands out — "wants to talk, tap to join" — and
   it is said once, with the chime if nobody is looking. Every link that comes
   up asks afresh (mailAtConnect), so nothing stays shown that has ended. */
function theyWait(room, waiting) {
  const p = people.find(q => q.room === room);
  if (!p || waitingForUs.has(room) === waiting) return;
  if (waiting) waitingForUs.add(room); else waitingForUs.delete(room);
  if (waiting && !(meeting && meeting.room === room)) {
    showToast(I18N[LANG].knockTitle(p.name), "info");
    noticeArrival();
  }
  drawPeople();
}

/** Their knock was tapped: meet them — if this page is free; if it is busy,
    say who. */
function answerKnock(room) {
  const p = people.find(q => q.room === room);
  if (!p || (meeting && meeting.room === room)) return;
  const free = chatScreen.classList.contains("hidden") && !meeting && !currentSession &&
               !isConnecting && !listJoinId && !pinJoinInFlight;
  if (!free) { showToast(I18N[LANG].knockTitle(p.name), "info"); return; }
  showLobbyTab("rooms");
  meetPerson(p);
}

/* Opened by tapping a knock: the worker names the room in the address. */
const _knockedRoom = (location.hash.match(/^#knock=(~[A-Za-z0-9_-]{43})$/) || [])[1] || null;
if (_knockedRoom) {
  history.replaceState({}, "", `${location.pathname}${location.search}`);
  answerKnock(_knockedRoom);
}
/* Tapped with this page already open: the worker says so. */
if (knockSupported) {
  navigator.serviceWorker.addEventListener("message", e => {
    const d = e.data;
    if (!d || typeof d.room !== "string" || !G.SAVED_ROOM.test(d.room)) return;
    if (d.type === "knock") answerKnock(d.room);
    else if (d.type === "mail") answerMail(d.room);
  });
}

/* ══════════════════════════════════════════════
   WAITING MESSAGES
   ─────────────────────────────────────────────
   A chat needs both people there at once. Now a saved person who is away
   can be written to: the message waits on the server — the Pi at home —
   until they open the app, and is theirs then. They can write back the same
   way. Each person's envelope, by their name, opens the conversation, and
   says how many are new.

   Sealed here, before it goes (DC.sealMail): with a key worked out from the
   secret only the two devices share, and bound to where it belongs — the
   pair's mailbox, who wrote it, to whom, its id and its time. The server
   keeps it and hands it over (mailbox.js); it cannot read it, change it, or
   pass one off as from the other. One opened as anything else does not
   open, and one delivered twice is shown once (the ids taken, kept here).

   A message goes again, by itself, until the server says it has kept it —
   so one written while the link is down is not lost. Whoever has the app
   open hears of a new one at once; whoever has alerts on and is away is
   told "Anu sent you a message". Each conversation is kept on this device
   only, up to G.MAIL_THREAD_MAX messages, and goes when the person is
   forgotten or it is cleared.                                              */
const MAIL_KEY = "dc-mail";
const mailKeys = new Map();              // room → the pair's key, worked out once

function loadMail() {
  try { return G.mailStore(JSON.parse(localStorage.getItem(MAIL_KEY) || "null")); }
  catch (_) { return G.mailStore(null); }
}

/** Kept, or false: storage off or full. What is on screen stays either way. */
function storeMail() {
  try { localStorage.setItem(MAIL_KEY, JSON.stringify(mailStore)); return true; }
  catch (_) { return false; }
}

function threadFor(room) {
  if (!mailStore.threads[room]) mailStore.threads[room] = { read: 0, items: [] };
  return mailStore.threads[room];
}

/** One more message in a conversation: in time order, the oldest let go past the limit. */
function addToThread(room, item) {
  const thread = threadFor(room);
  thread.items.push(item);
  thread.items.sort((x, y) => x.at - y.at);
  if (thread.items.length > G.MAIL_THREAD_MAX) thread.items.splice(0, thread.items.length - G.MAIL_THREAD_MAX);
}

function mailKeyFor(p) {
  if (!mailKeys.has(p.room)) mailKeys.set(p.room, DC.mailboxKey(p.secret));
  return mailKeys.get(p.room);
}

/** The envelope by their name, with how many of theirs are new. */
function mailTool(p) {
  const unread = G.mailUnread(mailStore.threads[p.room]);
  const tool = document.createElement("button");
  tool.type = "button";
  tool.className = unread ? "person-tool mail has-new" : "person-tool mail";
  tool.setAttribute("aria-label", `${t("personMail")}: ${p.name}${unread ? ` — ${I18N[LANG].mailUnreadCount(unread)}` : ""}`);
  tool.title = t("personMail");
  tool.appendChild(tablerIcon("mail"));
  if (unread) {
    const count = document.createElement("span");
    count.className = "mail-count";
    count.textContent = unread > 9 ? "9+" : String(unread);
    tool.appendChild(count);
  }
  tool.onclick = () => openThread(p);
  return tool;
}

/** Ours, sealed here and handed to the server; shown at once as on its way. */
async function sendMail(p, text) {
  const id = DC.makeMailId();
  const at = Date.now();
  const sealed = await DC.sealMail(await mailKeyFor(p), { box: p.room, from: p.side, to: G.otherSide(p.side), id, at, text });
  const item = { id, at, mine: true, text, state: "sending", iv: sealed.iv, ct: sealed.ct };
  addToThread(p.room, item);
  storeMail();
  dropMail(p, item);
  drawThread();
}

/** To the server — and where to knock for them, if they get alerts, so it
    can tell them a message waits. */
function dropMail(p, item) {
  wsSend({ type: "mail-drop", box: p.room, to: G.otherSide(p.side), id: item.id, at: item.at, iv: item.iv, ct: item.ct,
           ...(p.knock ? { knock: p.knock } : {}) });
}

/** Each time the link comes up: ours the server has not said it kept, again
    (it keeps each once), and what waits for us, asked after. */
function mailAtConnect() {
  /* Who waits for us is asked afresh with the mailboxes: a wait that ended
     while the link was down is not left showing. */
  if (waitingForUs.size) { waitingForUs.clear(); drawPeople(); }
  for (const p of people) {
    for (const item of (mailStore.threads[p.room] || { items: [] }).items) {
      if (item.mine && item.state === "sending" && item.iv && item.ct) dropMail(p, item);
    }
  }
  fetchMail();
}

function fetchMail() {
  if (people.length) wsSend({ type: "mail-fetch", boxes: people.map(p => ({ box: p.room, side: p.side })) });
}

/** The server kept ours — or would not, and why. */
function mailAnswered(data, kept) {
  for (const [room, thread] of Object.entries(mailStore.threads)) {
    const item = thread.items.find(m => m.mine && m.id === data.id);
    if (!item || item.state !== "sending") continue;
    item.state = kept ? "kept" : "refused";
    delete item.iv;                       // sealed for sending; not needed now
    delete item.ct;
    storeMail();
    if (!kept) showToast(t(G.mailRefusalKey(data.code)), "error");
    if (mailOpenFor === room) drawThread();
    return;
  }
}

/** Theirs, from the server — one delivery at a time, so two that cross are
    not both taken for new. */
let mailQueue = Promise.resolve();
function receiveMail(data) {
  mailQueue = mailQueue.then(() => takeMail(data)).catch(err => console.error("Messages could not be taken:", err));
  return mailQueue;
}

/** Opened here — or not at all — kept, and the server told it can let them go. */
async function takeMail(data) {
  const p = people.find(q => q.room === data.box && q.side === data.side);
  const items = Array.isArray(data.items) ? data.items.filter(m => m && typeof m.id === "string") : [];
  if (!p || !items.length) return;
  const key = await mailKeyFor(p);
  const seen = new Set(mailStore.seen[p.room] || []);
  let fresh = 0;
  for (const m of items) {
    if (seen.has(m.id)) continue;                        // delivered before: shown once
    const text = await DC.openMail(key, { box: p.room, from: G.otherSide(p.side), to: p.side, id: m.id, at: m.at, iv: m.iv, ct: m.ct });
    seen.add(m.id);                                      // opened or not, never tried again
    if (text === null || !G.messageFits(text) || !Number.isSafeInteger(m.at)) continue;
    addToThread(p.room, { id: m.id, at: m.at, mine: false, text });
    fresh++;
  }
  mailStore.seen[p.room] = [...seen].slice(-G.MAIL_SEEN_MAX);
  if (mailOpenFor === p.room) threadFor(p.room).read = Date.now();
  storeMail();
  wsSend({ type: "mail-ack", box: p.room, side: p.side, ids: items.map(m => m.id) });
  if (!fresh) return;
  drawPeople();
  if (mailOpenFor === p.room) { drawThread(); return; }
  showToast(I18N[LANG].mailArrived(p.name), "info");
  noticeArrival();
}

/* ── The conversation ────────────────────── */

function openThread(p) {
  mailOpenFor = p.room;
  mailTitle.textContent = p.name;
  mailHint.textContent = t("mailHint");
  mailClearBtn.classList.remove("asking");
  mailClearBtn.textContent = t("mailClear");
  threadFor(p.room).read = Date.now();
  storeMail();
  mailOverlay.classList.remove("hidden");
  drawThread();
  drawPeople();
  fetchMail();                                           // anything newer
  setTimeout(() => mailInput.focus(), 100);
}

function closeThread() {
  mailOverlay.classList.add("hidden");
  mailOpenFor = null;
  drawPeople();
}

function drawThread() {
  if (!mailOpenFor) return;
  const items = (mailStore.threads[mailOpenFor] || { items: [] }).items;
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "mail-empty";
    empty.textContent = t("mailEmpty");
    mailList.replaceChildren(empty);
    return;
  }
  mailList.replaceChildren(...items.map(mailBubble));
  mailList.scrollTop = mailList.scrollHeight;
}

function mailBubble(m) {
  const row = document.createElement("div");
  row.className = `mail-item ${m.mine ? "me" : "peer"}`;
  const bubble = document.createElement("div");
  bubble.className = "mail-bubble";
  fillMessage(bubble, m.text);                           // links tappable, nothing else made of it
  const meta = document.createElement("div");
  meta.className = m.state === "refused" ? "mail-meta refused" : "mail-meta";
  const when = new Date(m.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  meta.textContent = m.mine ? `${when} · ${t({ sending: "mailSending", kept: "mailKept", refused: "mailNotSent" }[m.state])}` : when;
  row.append(bubble, meta);
  return row;
}

function sendFromThread() {
  const p = people.find(q => q.room === mailOpenFor);
  const text = mailInput.value;
  if (!p || !text.trim()) return;
  if (!G.messageFits(text)) { showToast(I18N[LANG].messageTooLong(G.MAX_MESSAGE_CHARS), "warn"); return; }
  mailInput.value = "";
  sendMail(p, text).catch(err => { console.error("Message could not be sealed:", err); showToast(t("mailNotSent"), "error"); });
}

mailSendBtn.onclick = sendFromThread;
mailInput.addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  if (!G.enterSends({ touch: typingWithFinger(), shift: e.shiftKey, composing: e.isComposing || e.keyCode === 229 })) return;
  e.preventDefault();
  sendFromThread();
});
mailCloseBtn.onclick = closeThread;
mailOverlay.onclick = e => { if (e.target === mailOverlay) closeThread(); };

/* Clear: a second tap, so one is not enough to lose a conversation. The ids
   taken are kept, so nothing cleared comes back. */
mailClearBtn.onclick = () => {
  if (!mailOpenFor) return;
  if (!mailClearBtn.classList.contains("asking")) {
    mailClearBtn.classList.add("asking");
    mailClearBtn.textContent = t("mailClearSure");
    return;
  }
  mailClearBtn.classList.remove("asking");
  mailClearBtn.textContent = t("mailClear");
  threadFor(mailOpenFor).items = [];
  storeMail();
  drawThread();
  drawPeople();
};

/** "A message waits" tapped: their conversation, and anything newer. */
function answerMail(room) {
  const p = people.find(q => q.room === room);
  if (p) openThread(p);
}

mailStore = loadMail();
drawPeople();

/* Opened by tapping "a message waits": the worker names the room in the address. */
const _mailRoom = (location.hash.match(/^#mail=(~[A-Za-z0-9_-]{43})$/) || [])[1] || null;
if (_mailRoom) {
  history.replaceState({}, "", `${location.pathname}${location.search}`);
  answerMail(_mailRoom);
}

/* ══════════════════════════════════════════════
   WEBRTC — DATA CHANNEL PC
══════════════════════════════════════════════ */

function closePeerConnection() {
  /* A voice note belongs to the room it was recorded in. Leaving, or the peer
     leaving, ends both — and releases the microphone, which otherwise stayed
     live all the way back to the lobby. */
  abandonVoiceRecording();
  iceQueue = [];
  callIceQueue = [];
  e2eKey = null;
  e2eKeyPair = null;
  e2eReady = false;
  if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
  renderConnectionPath(null);   // no connection, no path — the badge must not linger
  /* Nor may the last chat's addresses or device: the panel would be describing
     someone who is no longer there. */
  _lastAddresses = null;
  peerDevice     = null;
  peerInfoSent   = false;
  /* The code handshake belongs to the channel that just closed. The word and
     the room kind are kept — a dropped connection to the same room reconnects
     and runs the handshake again. */
  pakeReset();
  keyAgreement = "ECDH";
  /* An offer to save each other belongs to the channel it was made on. */
  saveOffer = null;
  saveAsked = null;
  if (saveDialog && saveDialog.mode !== "rename") closeSaveDialog();
  knockShared = false;                     // a new channel is told again
  knockEarly = null;
  e2eVerifyCode = "";
  e2eVerified = false;
  e2eLocalPubRaw = null;
  e2eSecureMode = false;
  e2eCandidates = null;
  e2eKeyPending = null;
  e2ePendingConfirm = null;
  clearTimeout(e2eConfirmTimer);
  updateKeyVerifyUi();
  if (pc) {
    pc.onicecandidate = pc.oniceconnectionstatechange =
    pc.ondatachannel  = pc.ontrack = null;
    pc.close(); pc = null;
  }
  closeCallPeerConnection();
  dataChannel = null;
  sendBtn.disabled = true;
  stopChatRepair();                      // nothing left to repair
}

function createPeerConnection() {
  closePeerConnection();
  serverRoomGone = false;
  pc = new RTCPeerConnection(ICE_CONFIG);

  pc.onicecandidate = ({ candidate }) => {
    // Null candidate = gathering finished. currentSession can already be gone if
    // the user left mid-gathering — candidates now outlive the old blocking wait.
    if (!candidate || !currentSession) return;
    wsSend({ type: "ice-candidate", candidate, sessionId: currentSession.sessionId });
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    if (s === "checking")                        setQuality(`⬤ ${t("connecting")}`, "");
    if (s === "connected" || s === "completed")  { setQuality(`⬤ ${t("connected")}`, "connected"); startStatsPolling(); stopChatRepair(); }
    if (s === "failed" && G.linkLostForGood({ iceState: s, serverRoomGone })) { endChatLinkLost(); return; }
    /* Down — disconnected or failed outright — is repaired, from either side:
       see watchChatLink. (A bare restartIce() used to stand here; nothing
       acted on it.) */
    if (s === "disconnected" || s === "failed")  { setQuality(`⬤ ${t("reconnecting")}`, "poor"); watchChatLink(); }
    if (s === "closed")                          setQuality(`⬤ ${t("connClosed")}`, "failed");
  };

  pc.ondatachannel = ({ channel }) => { dataChannel = channel; setupDataChannel(); };

  pc.ontrack = null;
}

function createCallPeerConnection() {
  closeCallPeerConnection();
  /* Collects what the other side sends. Not given to the picture yet: it is
     empty, and Safari would keep that empty stream — see showRemoteTracks. */
  remoteCallStream = new MediaStream();
  remoteVideo.srcObject = null;
  peerAway = false;
  callPc = new RTCPeerConnection(ICE_CONFIG);

  callPc.onicecandidate = ({ candidate }) => {
    if (!candidate || !currentSession) return;
    dcSendCallSignal({ type: "call-ice", candidate });
  };

  callPc.onconnectionstatechange = () => {
    if (!callPc) return;
    updateCallPauseNote();
    const state = callPc.connectionState;
    if (state === "connected") {
      callStatusLabel.textContent = t("callConnected");
    }
    /* Down — disconnected, or failed outright — is worked on, not ended: see
       watchCallLink. Closed is the call being put down. */
    watchCallLink();
    if (state === "closed") {
      if (inCall) endCall(false);
    }
  };

  callPc.ontrack = ({ track }) => {
    // Always store the stream even if inCall hasn't been set yet —
    // the callee's ontrack fires during setRemoteDescription(offer),
    // which happens before inCall = true on their side.
    if (!remoteCallStream) remoteCallStream = new MediaStream();
    if (!remoteCallStream.getTracks().includes(track)) remoteCallStream.addTrack(track);
    showRemoteTracks();
    track.onunmute = () => {
      /* Frames have started to arrive. A picture that is still blank by now is
         the Safari case below in some other order of events: hand it over again. */
      if (track.kind === "video" && !remoteVideo.videoWidth) showRemoteTracks();
      playRemoteCallMedia();
    };

    // Play and update status only when the call is actually active
    if (inCall) {
      playRemoteCallMedia();
      callStatusLabel.textContent = t("callConnected");
    } else {
      // Store for later — play() is called again when inCall becomes true
      remoteVideo._pendingPlay = true;
    }
  };
}

/* Safari — every browser on an iPhone — keeps playing the sound of a stream
   while never drawing a video track that was added to it after it was given to
   the <video>: the other person's picture stays black and their voice comes
   through. It happened only sometimes, by timing. So the picture is never given
   a stream to grow; each time a track arrives it gets a fresh one holding
   every track so far, and so sees the video from its first moment. */
function showRemoteTracks() {
  if (!remoteCallStream || !remoteCallStream.getTracks().length) return;
  remoteVideo.srcObject = new MediaStream(remoteCallStream.getTracks());
}

/* A phone may refuse to start the other person's sound without a tap of its
   own. That used to be swallowed: a call that connected in silence, with
   nothing to press. Now "Tap to hear" appears — the tap is the phone's
   permission — and goes once the sound plays. A play interrupted by a fresh
   stream (AbortError) is not that, and the next play() follows anyway. */
function playRemoteCallMedia() {
  if (!remoteVideo.srcObject) showRemoteTracks();
  remoteVideo.play()
    .then(() => callTapToHear.classList.add("hidden"))
    .catch(err => { if (err && err.name === "NotAllowedError") callTapToHear.classList.remove("hidden"); });
}

function closeCallPeerConnection() {
  if (callPc) {
    callPc.onicecandidate = callPc.onconnectionstatechange = callPc.ontrack = null;
    callPc.close();
    callPc = null;
  }
  remoteCallStream = null;
  stopCallRecovery();                   // nothing left to reconnect
}

function isChatLinkUp() {
  if (!pc) return false;
  const ice = pc.iceConnectionState;
  return ice === "connected" || ice === "completed";
}

/** The direct link failed with no server left to repair it through. Said
    plainly, instead of "retrying" for ever. */
function endChatLinkLost() {
  setQuality(`⬤ ${t("connClosed")}`, "failed");
  appendSys(t("sysLinkLost"));
  endCall(false);
  closePeerConnection();
  showReconnectButton();
}

/* ── The chat's link, repaired ──────────────
   Found assessing why calls did not survive a phone changing networks. The
   chat's link was repaired only once declared failed — tens of seconds — only
   by the host, and only through a room that had already been deleted the
   moment either side's link to the server dropped. The server now keeps the
   seat (see rejoin-session / reclaim-session there) and this side takes it
   back on reconnecting (resumeSeat). Then, a couple of seconds after the link
   goes down (G.chatRepair), the host makes a fresh offer through the server
   and the guest asks the host to (repair-request); again every few seconds,
   while the way through the server is open. The call's own recovery rides on
   the chat's channel, so it follows once this is repaired.                  */
let chatDownSince   = 0;
let chatRepairAt    = 0;
let chatRepairs     = 0;
let chatRepairTimer = null;

function watchChatLink() {
  const s = pc?.iceConnectionState;
  if (s === "connected" || s === "completed") { stopChatRepair(); return; }
  if ((s !== "disconnected" && s !== "failed") || chatOver()) return;
  if (!chatDownSince) chatDownSince = Date.now();
  if (!chatRepairTimer) chatRepairTimer = setInterval(stepChatRepair, 1000);
}

/** Our seat on the server is ours, and so is theirs: a repair can get through. */
function serverPathOpen() {
  return Boolean(ws && ws.readyState === WebSocket.OPEN && currentSession && !seatPending && !peerServerAway && !serverRoomGone);
}

/** Nothing left to repair: no chat, or its channel closed — the other side
    gone for good, which no fresh route brings back. */
function chatOver() {
  return !pc || !currentSession || dataChannel?.readyState === "closed";
}

function stepChatRepair() {
  if (chatOver()) { stopChatRepair(); return; }
  const now = Date.now();
  const action = G.chatRepair({
    state: pc.iceConnectionState, host: isHost, pathOpen: serverPathOpen(),
    downFor: now - chatDownSince, sinceRepair: now - chatRepairAt, repairs: chatRepairs
  });
  if (action === "none") { stopChatRepair(); return; }
  if (action === "wait") return;
  chatRepairAt = now;
  chatRepairs++;
  if (action === "restart") handleFullRenegotiation();
  else wsSend({ type: "repair-request", sessionId: currentSession.sessionId });
}

function stopChatRepair() {
  clearInterval(chatRepairTimer);
  chatRepairTimer = null;
  chatDownSince = chatRepairAt = chatRepairs = 0;
}

/** The way through the server has just opened — our seat back, or theirs —
    or the other side asked (the host only): repair now rather than at the
    next step. Asked, the host restarts even if its own side still looks up:
    the guest sees what the host does not. */
function repairChatNow(asked = false) {
  if (chatOver()) return;
  if (asked) {
    if (isHost && serverPathOpen() && Date.now() - chatRepairAt >= 3000) {
      chatRepairAt = Date.now();
      chatRepairs++;
      handleFullRenegotiation();
    }
    return;
  }
  watchChatLink();
  if (chatRepairTimer) stepChatRepair();
}

/** The server no longer has our room — it restarted, or kept the seat too
    long. The chat goes on while its own link is up, and ends if it is not. */
function roomGoneForGood() {
  seatPending = false;
  serverRoomGone = true;
  if (isHost) hostKey = null;          // a key to a room that is no more:
  else guestKey = null;                //   nothing to take back next time
  if (pc && G.linkLostForGood({ iceState: pc.iceConnectionState, serverRoomGone })) endChatLinkLost();
}

async function handleFullRenegotiation() {
  if (!pc || !currentSession || !isHost) return;
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    // Send immediately — restarted ICE candidates trickle in behind it
    wsSend({ type: "renegotiate-offer", offer: pc.localDescription, sessionId: currentSession.sessionId });
  } catch (e) { console.error("Renegotiation error:", e); }
}

function setupDataChannel() {
  dataChannel.binaryType = "arraybuffer";

  dataChannel.onopen = async () => {
    // sendBtn stays disabled until the key exchange completes (usually <100ms)
    voiceCallBtn.disabled = true;
    videoCallBtn.disabled = true;
    /* Nothing is announced yet. The channel being open is not the chat being
       usable — e2eActivate() says "connected" once the key is agreed. */
    e2eReady = false;
    /* A code room proves a shared word with SPAKE2; every other room does the
       plain ECDH exchange. The kind was fixed when the room was created or
       joined, so both sides take the same branch. */
    if (roomKind === "code") await pakeBegin();
    else                     await e2eInit();
    // sendBtn enabled in e2eActivate() once the shared key is confirmed
  };

  dataChannel.onclose = () => {
    sendBtn.disabled = true;
    voiceCallBtn.disabled = true;
    videoCallBtn.disabled = true;
    /* A call goes with the chat, at once — it used to freeze on
       "Reconnecting…" for half a minute (G.callWhenChatCloses). Said first:
       the call ended, then they left. */
    const call = G.callWhenChatCloses({ inCall, ringingHere: !callRequestModal.classList.contains("hidden") });
    if (call !== "none") {
      endCall(false);
      appendSys(t(call === "missed" ? "sysMissedCall" : "sysCallEnded"));
    }
    /* The server already said they had gone and the chat went on; now the
       channel has closed too, which is them leaving. */
    appendSys(t(serverRoomGone ? "sysPeerLeft" : "sysClosed"));
    // Clean up unacknowledged messages and incomplete transfers to free memory.
    /* Mark them failed in the UI first: clearing the state alone left every
       in-flight bubble showing "Receiving…" with nothing ever to finish it. */
    for (const k of Object.keys(recvBuffers)) failTransfer(k);
    for (const k of Object.keys(pendingAcks)) delete pendingAcks[k];
    for (const k of Object.keys(recvBuffers)) delete recvBuffers[k];
    for (const k of Object.keys(orphanChunks)) delete orphanChunks[k];
    orphanChunkCount = 0;
    refusedTransfers.clear();
    stopChatRepair();
    showReconnectButton();
  };

  dataChannel.onerror = e => console.error("DC error", e);

  dataChannel.onmessage = ({ data }) => {
    if (typeof data === "string") {
      try { handleTextMessage(JSON.parse(data)); }
      catch (err) { console.error("DC parse error", err); }
    } else {
      handleBinaryChunk(data);
    }
  };
}

/** The host's "room is ready" panel: the PIN, the open-room notice, or the
    code room's word, and the invite link where there is one. Drawn when the
    room is made, and again when a code room's host is back waiting after an
    attempt that failed. */
function showRoomReady(data) {
  const shareUrl = `${location.origin}${location.pathname}#${DC.buildInviteHash(data.sessionId, data.token, roomSecret)}`;
  createInfo.style.textAlign = "left";
  const ready = document.createElement("div");
  ready.style.cssText = "text-align:center;margin-bottom:14px";
  ready.textContent = t("roomReady");

  const isOpen = roomKind === "open";
  const isCode = roomKind === "code";

  const pinBox = document.createElement("div");
  pinBox.style.cssText = "background:var(--sunken);border-radius:10px;padding:14px;margin-bottom:12px;text-align:center";
  const pinLabel = document.createElement("div");
  pinLabel.style.cssText = "font-size:11px;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:1px";
  /* Each kind fills the same box: a PIN to read out, an open-room notice, or
     — for a code room — the word the host chose, to share the same way. */
  pinLabel.textContent = isCode ? t("codeRoomTitle") : isOpen ? t("openRoomTitle") : t("pinCode");
  const pinValue = document.createElement("div");
  pinValue.style.cssText = isCode
    ? "font-size:24px;font-weight:700;color:var(--accent-text);word-break:break-word"
    : isOpen
      ? "font-size:28px;line-height:1.2;color:var(--orange)"
      : "font-size:28px;font-weight:700;letter-spacing:10px;color:var(--text)";
  if (isCode)     pinValue.textContent = pakeCode || "";
  else if (isOpen) pinValue.appendChild(tablerIcon("lock-open"));
  else            pinValue.textContent = data.pin;
  const pinHint = document.createElement("div");
  pinHint.style.cssText = "font-size:11px;color:var(--muted);margin-top:4px";
  pinHint.textContent = isCode ? t("codeRoomHint") : isOpen ? t("openRoomHint") : t("pinCodeHint");
  pinBox.append(pinLabel, pinValue, pinHint);

  const linkHint = document.createElement("div");
  linkHint.style.cssText = "font-size:12px;color:var(--muted);margin-bottom:6px";
  linkHint.textContent = t("linkHint");
  const linkRow = document.createElement("div");
  linkRow.style.cssText = "display:flex;gap:6px;align-items:center";
  const shareUrlInput = document.createElement("input");
  shareUrlInput.id = "shareUrlInput";
  shareUrlInput.type = "text";
  shareUrlInput.value = shareUrl;
  shareUrlInput.readOnly = true;
  shareUrlInput.style.cssText = "font-size:11px;padding:8px 10px;border-radius:8px;flex:1;min-width:0;background:var(--sunken);color:var(--accent-text);border:1px solid var(--border)";
  const copyLinkBtn = document.createElement("button");
  copyLinkBtn.id = "copyLinkBtn";
  copyLinkBtn.style.cssText = "width:auto;margin:0;padding:8px 14px;font-size:13px;min-height:36px;border-radius:8px;flex-shrink:0";
  copyLinkBtn.textContent = t("copyBtn");
  linkRow.append(shareUrlInput, copyLinkBtn);
  /* No invite link for a code room: the link carries the room secret for
     the ECDH path, which a code room does not use. The word is the only way
     in, and a link would just fail to connect. */
  if (isCode) createInfo.replaceChildren(ready, pinBox);
  else        createInfo.replaceChildren(ready, pinBox, linkHint, linkRow);

  copyLinkBtn.onclick = () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      copyLinkBtn.textContent = t("copiedBtn");
      setTimeout(() => { const b = document.getElementById("copyLinkBtn"); if (b) b.textContent = t("copyBtn"); }, 2000);
    }).catch(() => {
      shareUrlInput.select();
      document.execCommand("copy");
      copyLinkBtn.textContent = t("copiedBtn");
    });
  };
}

/* ══════════════════════════════════════════════
   SIGNALING HANDLER
══════════════════════════════════════════════ */

/* ── Noticing an update ──────────────────────
   The server names its build on every connection, and every page reconnects
   within seconds of the server restarting for an update. So a page that was
   left open finds out it is old almost as soon as it becomes old — and fetches
   the new one, provided nobody is in the middle of anything. */

let updatePending     = null;    // a newer build to fetch once this page is idle
let updateNoticeShown = false;

/** In a room, joining one, or part-way through typing something — any of which
    a reload would throw away. */
function pageIsBusy() {
  return Boolean(currentSession) || isConnecting || pinJoinInFlight || Boolean(listJoinId) ||
         sessionIdInput.value.trim() !== "" || leaveMessage.value.trim() !== "" || senderName.value.trim() !== "";
}

/** Loads the page again under an address no cache has seen, so what comes back
    is current. The same trick as refuseToRunInAStalePage(). */
function fetchNewPage(build) {
  try { sessionStorage.setItem("dc-self-reload", String(Date.now())); } catch (_) { /* storage off — the ?r= marker still stops a loop */ }
  location.replace(`${location.pathname}?r=${encodeURIComponent(build)}${location.hash}`);
}

function handleServerBuild(serverBuild) {
  let recentlyReloaded = false;
  try { recentlyReloaded = Date.now() - Number(sessionStorage.getItem("dc-self-reload") || 0) < 60_000; } catch (_) {}

  const action = G.updateAction({
    serverBuild, pageBuild: APP_BUILD,
    retriedFor: new URLSearchParams(location.search).get("r"),
    recentlyReloaded, busy: pageIsBusy()
  });

  if (action === "reload") fetchNewPage(serverBuild);
  else if (action === "later") updatePending = serverBuild;
  else if (action === "notify" && !updateNoticeShown) {
    updateNoticeShown = true;
    showToast(t("updateOnItsWay"), "info");
  }
}

/** Is this server message about the room on screen? See mayApplyRoomEvent. */
function roomEventIsOurs(data) {
  return G.mayApplyRoomEvent({
    eventRoom: data.sessionId,
    currentRoom: currentSession && currentSession.sessionId
  });
}

async function handleSignaling(data) {
  switch (data.type) {

    case "hello":
      handleServerBuild(data.build);
      break;

    case "session-list":
      renderSessionList(data.sessions);
      break;

    case "session-created": {
      /* First to a saved person's room: we wait in it for them. */
      if (data.kind === "saved") { meetWaiting(data); break; }
      /* A room of our own instead — waiting for a saved person is given up. */
      if (meeting) { meeting = null; pendingMeet = null; drawPeople(); }
      pendingCreate = null;
      isHost = true;
      hostKey = typeof data.hostKey === "string" ? data.hostKey : null;
      reclaimPending = false;
      roomKind = data.kind === "code" ? "code" : (data.open === true ? "open" : "pin");
      currentSession = { sessionId: data.sessionId, token: data.token };
      /* Minted here, in the browser — the server never learns it. */
      roomSecret = makeRoomSecret();

      /* The PIN and link go in the Create tab. A host who wandered to another
         tab while the server was waking up is brought back to them. */
      showLobbyTab("create");
      /* A screen that locks while the host waits takes the room with it. */
      keepScreenOn(true);
      /* The list may already show this room, with a Join button. */
      renderSessionList(_lastSessionList);
      roomReadyInfo = data;
      showRoomReady(data);
      saveHostRoom();

      setCreateButtons(false);
      isConnecting = false;
      requestSessionList();
      break;
    }

    case "session-joined":
      autoJoinSettled();
      settlePinJoin();
      listJoinId = null;
      isHost = false;
      currentSession = { sessionId: data.sessionId };
      /* Ours alone, to take the seat back with if our link drops mid-chat.
         Kept in memory only: a reload is a new page, and a new join. */
      guestKey = typeof data.guestKey === "string" ? data.guestKey : null;
      seatPending = false;
      peerServerAway = false;
      /* Present only when this join came from an invite link — or a tap on a
         saved person, whose secret it is. */
      roomSecret = pendingRoomSecret;
      pendingRoomSecret = null;
      pendingMeet = null;
      /* Some other room joined — waiting for a saved person is given up. */
      if (roomKind !== "saved" && meeting) { meeting = null; drawPeople(); }
      pinOverlay.classList.add("hidden");
      switchToChat(data.sessionId);
      createPeerConnection();
      /* The host stepped away — off sending this very link, most likely. Wait
         for them rather than count down to "could not connect". */
      if (data.hostAway === true) {
        clearConnectWatch();
        appendSys(roomKind === "saved" && meeting ? I18N[LANG].savedWaitingFor(meeting.name) : t("waitingForHost"));
      }
      break;

    case "host-back":
      if (!roomEventIsOurs(data) || isHost) break;
      /* A saved person's side opened it again — a reload, another tab — and
         the chat with the copy it left is over. Start again with the new one,
         keeping what was said. */
      if (data.restart === true) {
        if (dataChannel) dataChannel.onclose = null;
        endCall(false);
        createPeerConnection();
        appendSys(I18N[LANG].savedReopened(roomTitle(currentSession.sessionId)));
      } else {
        appendSys(t("hostBack"));
      }
      watchConnecting();
      break;

    case "session-reclaimed":
      /* Our room, taken back: the same PIN, the same link. */
      if (!roomEventIsOurs(data) || !isHost) break;
      /* Back to a chat in progress: the seat is ours again and the chat's link
         can be repaired through it. Nothing about the waiting room. */
      if (data.resumed === true) {
        seatPending = false;
        serverRoomGone = false;
        repairChatNow();
        break;
      }
      reclaimPending = false;
      lobbyStatus.replaceChildren();
      currentSession.token = data.token;
      roomReadyInfo = { ...roomReadyInfo, sessionId: data.sessionId, pin: data.pin, token: data.token, kind: data.kind, open: data.open };
      if (reclaimRedraw) { reclaimRedraw = false; showRoomReady(roomReadyInfo); }
      keepScreenOn(true);
      saveHostRoom();
      renderSessionList(_lastSessionList);
      break;

    case "reclaim-failed":
      /* Gone after all — kept too long, or the server restarted. */
      if (!roomEventIsOurs(data)) break;
      /* Mid-chat: the chat goes on while its own link is up — it just can no
         longer be repaired through the server. Not the waiting room's loss. */
      if (seatPending) { roomGoneForGood(); break; }
      reclaimPending = false;
      reclaimRedraw = false;
      lobbyStatus.replaceChildren();
      forgetHostRoom();
      if (isHost && currentSession) loseWaitingRoom();
      break;

    case "guest-joined":
      if (!roomEventIsOurs(data)) break;
      forgetHostRoom();
      peerServerAway = false;            // a guest just arrived: its link is up
      /* The guest opened the same link again in another browser — out of the
         app it was sent through, into Safari or Chrome — and the seat moved
         with them. What was set up with the copy they left is let go of
         quietly (its channel closing would say "connection closed" and offer a
         way out), the chat on screen stays, and the connection starts again
         with the new copy. The line says so, since the person at the other end
         has, as far as this page can tell, changed. */
      if (data.replaced === true) {
        if (dataChannel) dataChannel.onclose = null;
        endCall(false);
      }
      switchToChat(currentSession.sessionId, { keepMessages: data.replaced === true });
      if (data.replaced === true) {
        appendSys(roomKind === "saved" ? I18N[LANG].savedReopened(roomTitle(currentSession.sessionId)) : t("guestReopened"));
      }
      createPeerConnection();
      dataChannel = pc.createDataChannel("chat");
      dataChannel.binaryType = "arraybuffer";
      setupDataChannel();
      {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        // Send immediately — trickle ICE candidates follow via ice-candidate messages
        wsSend({ type: "offer", offer: pc.localDescription, sessionId: currentSession.sessionId });
      }
      break;

    case "offer":
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      while (iceQueue.length) {
        try { await pc.addIceCandidate(iceQueue.shift()); } catch (e) { console.error(e); }
      }
      {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        // Send immediately — trickle ICE candidates follow via ice-candidate messages
        wsSend({ type: "answer", answer: pc.localDescription, sessionId: currentSession.sessionId });
      }
      break;

    case "answer":
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      while (iceQueue.length) {
        try { await pc.addIceCandidate(iceQueue.shift()); } catch (e) { console.error(e); }
      }
      break;

    case "ice-candidate":
      if (!pc) break;
      if (pc.remoteDescription && pc.remoteDescription.type) {
        /* During a repair a candidate for the fresh route can arrive before
           the description it belongs to: kept, and tried again with it. */
        try { await pc.addIceCandidate(data.candidate); } catch (_) { iceQueue.push(data.candidate); }
      } else {
        iceQueue.push(data.candidate);
      }
      break;

    case "renegotiate-offer":
      if (!pc || !currentSession) break;
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      /* Candidates for this fresh route that came in ahead of it. */
      while (iceQueue.length) {
        try { await pc.addIceCandidate(iceQueue.shift()); } catch (_) { /* one for the old route */ }
      }
      {
        const ra = await pc.createAnswer();
        await pc.setLocalDescription(ra);
        // Send immediately — trickle ICE candidates follow via ice-candidate messages
        wsSend({ type: "renegotiate-answer", answer: pc.localDescription, sessionId: currentSession.sessionId });
      }
      break;

    case "renegotiate-answer":
      if (!pc || pc.signalingState !== "have-local-offer") break;   // an answer to nothing we asked
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      while (iceQueue.length) {
        try { await pc.addIceCandidate(iceQueue.shift()); } catch (_) { /* one for the old route */ }
      }
      break;

    /* ── Our seat kept through a dropped link (see rejoin-session in server.js) ── */

    case "session-rejoined":
      /* Our seat taken back: the chat can be repaired through it again. */
      if (!roomEventIsOurs(data) || isHost) break;
      seatPending = false;
      serverRoomGone = false;
      peerServerAway = data.hostAway === true;
      repairChatNow();
      break;

    case "rejoin-failed":
      /* Kept too long, or the server restarted: the room is gone. */
      if (!roomEventIsOurs(data)) break;
      roomGoneForGood();
      break;

    case "peer-away":
      /* The other side's link to the server dropped; its seat is kept. The
         chat may well go on directly — only a repair has to wait. */
      if (!roomEventIsOurs(data)) break;
      peerServerAway = true;
      break;

    case "peer-back":
      /* Back: if our link is down, repair it now. */
      if (!roomEventIsOurs(data)) break;
      peerServerAway = false;
      repairChatNow();
      break;

    case "repair-request":
      /* The guest sees our link down — perhaps before we do. */
      if (!roomEventIsOurs(data) || !isHost) break;
      repairChatNow(true);
      break;

    /* No call-offer / call-answer / call-ice cases here on purpose. Call
       signaling arrives only through the encrypted data channel (see
       handleTextMessage). Accepting it from the WebSocket would let the
       signaling server inject a call offer and start getUserMedia without the
       peer ever asking, bypassing the end-to-end channel entirely. */

    case "peer-disconnected":
      /* Named by room since the server learned to say which. It used not to,
         and a room this browser had moved on from could still end the chat in
         the room it was actually in. */
      if (!roomEventIsOurs(data)) break;
      /* A code room locked after too many wrong words, turning us away: said
         so, with how long to wait. Only before any chat — a host cannot use it
         to end one. */
      if (data.reason === "code-locked" && !isHost && roomKind === "code" && !e2eReady) {
        turnedAwayLocked(data.retryIn);
        break;
      }
      /* What a locked screen looks like from here: the other side's page is
         paused and its link to the server cut. If the link between the two
         phones is still up, the chat goes on — see G.serverLeaveEndsChat. */
      if (!G.serverLeaveEndsChat({ channelOpen: dataChannel?.readyState === "open", iceState: pc?.iceConnectionState })) {
        serverRoomGone = true;
        break;
      }
      appendSys(t("sysPeerLeft"));
      endCall(false);
      closePeerConnection();
      showReconnectButton();
      break;

    case "knock-result":
      knockAnswered(data);
      break;

    /* Waiting messages — see "WAITING MESSAGES". */
    case "mail":
      receiveMail(data);
      break;

    case "mail-waiting":
      fetchMail();
      break;

    case "meet-waiting":
      /* A saved person waits for us in their room, or no longer (theyWait). */
      if (typeof data.room === "string") theyWait(data.room, data.waiting === true);
      break;

    case "mail-dropped":
      mailAnswered(data, true);
      break;

    case "mail-refused":
      mailAnswered(data, false);
      break;

    case "seat-taken":
      /* This invite link was opened again in another browser, and the seat
         went there — to Safari or Chrome, most often, from the app the link was
         sent through. The chat goes on there; this copy stops, says so, and
         never joins again (inviteMovedAway). Nothing to offer here: the way
         back to the lobby is the X, which leaves at once here (chatEndedHere). */
      if (!roomEventIsOurs(data)) break;
      if (roomKind === "saved") { savedSeatTaken(); break; }
      if (isHost) break;
      inviteMovedAway = true;
      guestKey = null;                   // the seat is the other copy's now
      seatPending = false;
      autoJoinSettled();
      clearConnectWatch();
      if (dataChannel) dataChannel.onclose = null;
      endCall(false);
      closePeerConnection();
      currentSession = null;
      roomSecret = null;
      isConnecting = false;
      keepScreenOn(false);
      /* What the channel's close would have tidied, had it been let run: no
         calls from a chat that has moved, and no figures for a link that has gone. */
      voiceCallBtn.disabled = true;
      videoCallBtn.disabled = true;
      statsBar.textContent = "";
      chatMessages.querySelectorAll(".reconnect-sys-wrap").forEach(el => el.remove());
      setQuality(`⬤ ${t("seatTakenShort")}`, "failed");
      appendSys(t("seatTaken"));
      /* Wrong copy? The one the person is looking at may be this one. */
      chatMessages.appendChild(continueHereButton());
      scrollBottom();
      break;

    case "guest-left":
      /* A code room's guest has gone and the server kept the room. */
      if (!roomEventIsOurs(data) || !isHost) break;
      if (!wordMatched) {
        /* Never became a chat — a stranger, or a word that did not match. */
        returnToWaitingRoom();
        break;
      }
      /* A real chat: theirs is the same news as peer-disconnected. The room
         goes, as every room does once its chat has been — offering the seat
         to someone else mid-chat would be wrong. */
      wsSend({ type: "leave-session", sessionId: currentSession?.sessionId });
      if (!G.serverLeaveEndsChat({ channelOpen: dataChannel?.readyState === "open", iceState: pc?.iceConnectionState })) {
        serverRoomGone = true;
        break;
      }
      appendSys(t("sysPeerLeft"));
      endCall(false);
      closePeerConnection();
      showReconnectButton();
      break;

    case "session-expired": {
      /* Nobody joined in time and the server has dropped the room. This used to
         arrive as peer-disconnected, which wrote "peer left" into the hidden
         chat screen and left the lobby showing a PIN and a link for a room that
         no longer existed — the host waited on it with nothing to say so. */
      if (!roomEventIsOurs(data)) break;
      if (roomKind === "saved") {
        const name = meeting ? meeting.name : "";
        endMeeting();
        showToast(`⌛ ${I18N[LANG].savedExpired(name)}`, "warn");
        break;
      }
      keepScreenOn(false);
      forgetHostRoom();
      hostKey = null;
      currentSession = null;
      roomSecret = null;
      isHost = false;
      isConnecting = false;
      const msg = document.createElement("span");
      msg.style.color = "var(--orange)";
      msg.textContent = `⌛ ${t("roomExpired")}`;
      createInfo.style.textAlign = "";
      createInfo.replaceChildren(msg);
      /* Said in the Create tab, where the PIN was. A host looking at another
         tab would not see it there, so it is also said where they are. */
      if (activeLobbyTab !== "create") showToast(`⌛ ${t("roomExpired")}`, "warn");
      setCreateButtons(false);
      break;
    }

    case "error": {
      autoJoinSettled();
      console.error("[Server error]", data.message);
      /* Said in the user's language where the server named why — its own
         message is English, and was shown as it came. */
      const key = G.serverErrorKey(data.code);
      const said = key ? t(key) : data.message;
      /* A tap on a saved person, refused — too many rooms from this network. */
      if (pendingMeet) {
        endMeeting();
        showToast(said, "error");
        break;
      }
      if (_isAutoJoin && isConnecting) {
        const msg = document.createElement("span");
        msg.style.color = "var(--danger-text)";
        msg.textContent = `❌ ${said}`;
        lobbyStatus.replaceChildren(msg);
        setLobbyButtons(false);
        isConnecting = false;
      } else {
        pendingCreate = null;
        showToast(said, "error");
        createInfo.textContent = "";
        setCreateButtons(false);
        settlePinJoin();
        isConnecting = false;
      }
      break;
    }

    case "pin-error": {
      autoJoinSettled();
      // Translate structured error codes from server
      let msg;
      if      (data.code === "rate-limited")        msg = I18N[LANG].pinRateLimited(data.remaining);
      else if (data.code === "session-join-locked") msg = I18N[LANG].sessionJoinLocked(data.remaining);
      else if (data.code === "wrong-pin")           msg = I18N[LANG].pinAttemptsLeft(data.attemptsLeft);
      else if (data.code === "not-found")     msg = t("sessionNotFound");
      else if (data.code === "full")          msg = t("sessionFull");
      else if (data.code === "own-room")      msg = t("ownRoom");
      else                                    msg = data.message || "Error";

      /* Route by which join is waiting for an answer, not by how the page was
         opened. _isAutoJoin stays true for the life of a page that arrived by
         invite link, so a wrong PIN typed there later was reported in the lobby
         — behind the dialog — and left the dialog's button disabled. */
      const listJoin = listJoinId;
      listJoinId = null;
      const target = G.joinRefusalTarget({
        pinJoin: pinJoinInFlight, listJoin: Boolean(listJoin), autoJoinPage: _isAutoJoin
      });

      if (target === "toast") {
        /* A tap on a room the list showed as open. If it wants a PIN after all
           — the list was stale — ask for it rather than complain: that is what
           the user would have been shown had the list been right. */
        if (data.code === "pin-required") openPinModal(listJoin);
        else { showToast(msg, "error"); requestSessionList(); }
      } else if (target === "lobby" && data.code === "held-elsewhere") {
        /* Another copy of this link holds the seat, and this one was not on
           screen when it asked. Nothing more joins by itself from here; the
           button takes the seat if this is the copy the person wants. */
        inviteMovedAway = true;
        const note = document.createElement("div");
        note.style.cssText = "color:var(--orange);text-align:center";
        note.textContent = t("heldElsewhere");
        lobbyStatus.replaceChildren(note, continueHereButton());
        setLobbyButtons(false);
        isConnecting = false;
      } else if (target === "lobby") {
        const wrap = document.createElement("span");
        wrap.style.color = "var(--danger-text)";
        /* Said once. A second line, "the room may have expired", followed
           every refusal — after "not found — it may have expired", and
           after "full", where it was wrong. */
        wrap.textContent = I18N[LANG].couldNotJoin(msg);
        lobbyStatus.replaceChildren(wrap);
        setLobbyButtons(false);
        isConnecting = false;
      } else {
        pinError.textContent = msg;
        settlePinJoin();
      }
      break;
    }
  }
}

/* ══════════════════════════════════════════════
   SCREEN TRANSITIONS
══════════════════════════════════════════════ */

/* ── Keep the screen on ─────────────────────
   While a room is open — waiting for a guest, or chatting — the screen does
   not dim and lock by itself. A locked phone pauses the page: an iPhone cuts
   its link to the server at once, and the direct link soon after, so the
   most common way a chat was lost was the phone being put down for a minute.
   The power button still locks it; this only stops the timeout.

   The browser lets go of the lock whenever the page is hidden, so it is taken
   again when the page comes back. Safari may want a tap first, so a tap takes
   it too if it is missing. Where there is no Screen Wake Lock, or the browser
   says no (battery saver), the screen simply behaves as usual.            */
let screenLock = null;          // the WakeLockSentinel, while held
let screenLockWanted = false;
let screenLockPending = false;

async function keepScreenOn(on) {
  screenLockWanted = on;
  if (!on) {
    const held = screenLock;
    screenLock = null;
    if (held) held.release().catch(() => {});
    return;
  }
  if (screenLock || screenLockPending || !("wakeLock" in navigator)) return;
  if (document.visibilityState !== "visible") return;     // asked for again on return
  screenLockPending = true;
  try {
    const lock = await navigator.wakeLock.request("screen");
    if (!screenLockWanted) { lock.release().catch(() => {}); return; }   // left while it was granted
    screenLock = lock;
    lock.addEventListener("release", () => { if (screenLock === lock) screenLock = null; });
  } catch (_) {
    /* Refused — battery saver, or no tap yet in Safari. Not an error. */
  } finally {
    screenLockPending = false;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && screenLockWanted) keepScreenOn(true);
});
document.addEventListener("pointerdown", () => {
  if (screenLockWanted && !screenLock) keepScreenOn(true);
});

/* ── The phone's Back button during a chat ──
   To a phone, Back means "leave this page", so it closed the page and the chat
   with it — for both people, mid-sentence. While a chat is on screen the page
   now holds one history entry of its own, so Back lands on this page instead
   of leaving it, and asks "Leave the chat?" (G.backPress). Leaving still works
   — the question's Leave, or the X at the top, which asks the same — and Home or the app
   switcher keep the chat going while another app is used.

   During a call that fills the screen, Back makes the call small instead,
   with the chat underneath — as the call's own chat button does. It used to
   ask "Leave the chat?" over the call, one tap from ending both.

   Chrome skips a history entry a page added before the user had touched it,
   so Back would sail past it: a page opened from an invite link and connected
   untouched. There the entry is added at the first tap instead.

   Closing the tab or the window mid-chat asks first too (beforeunload) —
   listened for only while a chat is on, since merely listening for it can
   keep a browser from caching the page.                                  */
const leaveChatOverlay = document.getElementById("leaveChatOverlay");
let backGuardArmed = false;

/** Over, here: ended — its way back to the lobby showing — or moved to
    another browser (seat-taken), which offers "Continue here" instead and
    has nothing left to end for anyone. */
function chatEndedHere() {
  return Boolean(chatMessages.querySelector(".reconnect-sys-wrap")) || inviteMovedAway;
}

function chatLiveNow() {
  return G.chatIsLive({
    chatOpen: !chatScreen.classList.contains("hidden"),
    chatEnded: chatEndedHere()
  });
}

function warnBeforeUnload(e) {
  if (!chatLiveNow()) return;
  e.preventDefault();
  e.returnValue = "";
}

function armBackGuard() {
  if (backGuardArmed) return;
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;   // at the first tap instead
  history.pushState({ dcChat: true }, "");
  backGuardArmed = true;
}

/** The chat is over or left: give the entry back, so Back in the lobby goes
    where it always did. Only ever our own entry — going back past it would
    leave the page. */
function disarmBackGuard() {
  leaveChatOverlay.classList.add("hidden");
  window.removeEventListener("beforeunload", warnBeforeUnload);
  if (!backGuardArmed) return;
  backGuardArmed = false;
  if (history.state && history.state.dcChat) history.back();
}

window.addEventListener("popstate", () => {
  const action = G.backPress({
    chatOpen: !chatScreen.classList.contains("hidden"),
    chatEnded: chatEndedHere(),
    asking: !leaveChatOverlay.classList.contains("hidden"),
    viewing: viewingImage(),
    callFull: callFillsScreen()
  });
  if (action === "ignore") return;
  backGuardArmed = false;                  // Back has just used our entry
  if (action === "close") { closeImageViewer(); armBackGuard(); return; }
  if (action === "mini")  { setCallMini(true); armBackGuard(); return; }   // the chat, with the call small
  if (action === "lobby") { leaveBtn.click(); return; }
  armBackGuard();                          // still in the chat: hold the next Back too
  leaveChatOverlay.classList.toggle("hidden", action === "stay");
});

document.addEventListener("pointerdown", () => {
  if (!backGuardArmed && chatLiveNow()) armBackGuard();
});

document.getElementById("leaveChatStayBtn").onclick = () => leaveChatOverlay.classList.add("hidden");
document.getElementById("leaveChatLeaveBtn").onclick = () => leaveBtn.click();
leaveChatOverlay.onclick = e => { if (e.target === leaveChatOverlay) leaveChatOverlay.classList.add("hidden"); };

/* ── A connection that never comes up ───────
   Some networks block direct connections, and with no relay server two such
   devices cannot reach each other at all. Both sides used to sit on
   "Connecting…" for as long as anyone watched. After CONNECT_GIVE_UP_MS with
   no channel, the chat says so and what to try (G.connectStalled). It keeps
   trying underneath: a slow network that gets there late still connects. */
const CONNECT_GIVE_UP_MS = 30_000;
let connectWatch = null;

function watchConnecting() {
  clearConnectWatch();
  connectWatch = setTimeout(() => {
    connectWatch = null;
    if (!G.connectStalled({
      chatOpen: !chatScreen.classList.contains("hidden"),
      channelOpen: dataChannel?.readyState === "open",
      keyAgreed: e2eReady
    })) return;
    appendSys(t("sysNoDirectRoute"));
    showReconnectButton();
  }, CONNECT_GIVE_UP_MS);
}

function clearConnectWatch() {
  clearTimeout(connectWatch);
  connectWatch = null;
}

function switchToChat(sessionId, { keepMessages = false } = {}) {
  keepScreenOn(true);
  watchConnecting();
  armBackGuard();
  window.addEventListener("beforeunload", warnBeforeUnload);
  lobbyScreen.classList.add("hidden");
  chatScreen.classList.remove("hidden");
  document.getElementById("langSwitcher").style.display = "none";
  chatSessionLabel.textContent = roomTitle(sessionId);
  setQuality(`⬤ ${t("connecting")}`, "");
  if (!keepMessages) {
    savedInChat = null;                    // a new chat, perhaps someone else
    closeReactionBar();
    chatMessages.replaceChildren();
    _stickToBottom = true;                 // a new chat starts at its newest
    newMessagesBtn.classList.add("hidden");
  }
  sendBtn.disabled = true;
  voiceCallBtn.disabled = true;
  videoCallBtn.disabled = true;
}

leaveBtn.onclick = (e) => {
  /* The X, pressed by hand in a chat that is on: the same question Back asks.
     The app's own clicks — the question's Leave among them — are not
     trusted events, and leave at once as they always did (G.leaveAsks). */
  if (G.leaveAsks({ byHand: Boolean(e && e.isTrusted), chatLive: chatLiveNow() })) {
    leaveChatOverlay.classList.remove("hidden");
    return;
  }
  closeImageViewer();               // its picture is about to be let go of
  closeReactionBar();
  keepScreenOn(false);
  clearConnectWatch();
  forgetHostRoom();
  hostKey = null;
  guestKey = null;
  reclaimPending = false;
  seatPending = false;
  peerServerAway = false;
  wsSend({ type: "leave-session", sessionId: currentSession?.sessionId });
  endCall(false);
  closePeerConnection();
  revokeTrackedBlobUrls(); // free all file/image/voice blob memory
  currentSession = null;
  roomSecret = null;
  pendingRoomSecret = null;
  /* Leaving ends the code room entirely — the word and the wrong-guess count go
     with it. */
  roomKind = "pin";
  pakeCode = null;
  codeFailures = 0;
  codeLockedUntil = 0;
  isHost = false;
  isConnecting = false;
  /* A saved person met, or still waited for: over too. Their row is back to
     a name to tap. */
  meeting = null;
  pendingMeet = null;
  knockSent = false;
  quickCall = null;                 // a call asked for from their row goes too
  quickCallArmed = null;
  savedInChat = null;
  drawPeople();
  chatScreen.classList.add("hidden");
  lobbyScreen.classList.remove("hidden");
  /* After the chat is off screen, so the Back this queues finds no chat and
     does nothing — whenever the browser gets round to it. */
  disarmBackGuard();
  document.getElementById("langSwitcher").style.display = "";
  createInfo.textContent = "";
  lobbyStatus.replaceChildren();
  showLobbyTab("rooms");
  /* All of the lobby's controls, not just Create: a page that joined from an
     invite link had the name field and Refresh switched off for the join, and
     nothing switched them on again after the chat. */
  setLobbyButtons(false);
  sessionIdInput.value = "";
  requestSessionList();
  /* An update arrived while the chat was going. This is the moment it stops
     costing anything to take it. */
  if (updatePending) fetchNewPage(updatePending);
};

/* ══════════════════════════════════════════════
   STATS
══════════════════════════════════════════════ */

/**
 * The candidate pair ICE actually settled on.
 *
 * transport.selectedCandidatePairId names it outright where available; the scan
 * is a fallback for browsers that omit it. Reading any succeeded pair is not
 * good enough — several can succeed and only one carries traffic.
 */
const selectedCandidatePair = DCS.selectedCandidatePair;

/**
 * How the two sides are actually reaching each other.
 *
 * "relayed" is the one that matters: it means a TURN server sits in the middle
 * carrying every packet. The contents stay encrypted end to end, but that
 * server learns who is talking to whom and for how long — a different trust
 * situation from a direct connection, and one the user should not have to infer
 * from a candidate type like "srflx".
 *
 * Returns null while ICE is still deciding.
 */
const describeConnectionPath = DCS.describePath;

/** Writes the path badge that sits after the connection state in the header. */
function renderConnectionPath(path) {
  _lastPath = path;
  if (!path) { connectionPath.classList.add("hidden"); connectionPath.title = ""; return; }
  const label = { direct: "pathDirect", local: "pathLocal", relayed: "pathRelayed" }[path.kind];
  const hint  = { direct: "pathDirectHint", local: "pathLocalHint", relayed: "pathRelayedHint" }[path.kind];
  connectionPath.textContent = t(label);
  connectionPath.title       = t(hint);
  connectionPath.className   = `path-badge path-${path.kind}`;
}

async function pollStats() {
  const conn = pc;
  if (!conn) return;
  try {
    const stats = await conn.getStats();
    /* The connection can end, or be replaced, while that was being fetched.
       What came back then describes a chat that is over, and writing it would
       put the last peer's route and address back on screen. */
    if (pc !== conn) return;
    const path  = describeConnectionPath(stats);
    const pair  = selectedCandidatePair(stats);

    const { sent, recv } = DCS.trafficTotals(stats, pair);
    const quality = DCS.qualityFromRtt(pair && pair.currentRoundTripTime);

    const parts = [];
    if (quality) {
      parts.push(`RTT: ${quality.ms}ms`);
      setQuality(`⬤ ${t(quality.key)}`, quality.cls);
    }
    renderConnectionPath(path);
    _lastAddresses = DCS.pathAddresses(stats);
    renderShieldFacts();

    if (sent)  parts.push(`↑ ${fmtBytes(sent)}`);
    if (recv)  parts.push(`↓ ${fmtBytes(recv)}`);
    /* The header says direct or relayed in words; the detail belongs here. */
    if (path) parts.push(`${path.local.candidateType} → ${path.remote.candidateType}`);
    statsBar.textContent = parts.join("   ");
  } catch (_) {}
}

function startStatsPolling() {
  if (statsInterval) clearInterval(statsInterval);
  statsInterval = setInterval(pollStats, 2000);
  /* And once now. The route is known the moment the connection is up; waiting
     for the first tick left the badge and the panel blank for two seconds. */
  pollStats();
}

const fmtBytes = DCS.fmtBytes;

function setQuality(text, cls) {
  /* Writes the state only. The path badge is a separate child of
     #connectionQuality so it survives every state change. */
  connectionState.textContent = text;
  connectionQuality.className = "quality-label " + cls;
}

/* ══════════════════════════════════════════════
   TEXT MESSAGING + TYPING
══════════════════════════════════════════════ */

sendBtn.onclick = sendTextMessage;

/* Enter sends on a computer and starts a new line on a phone, whose keyboard
   has no Shift to hold and whose ↵ key says "new line" (G.enterSends). Asked
   at each press: a tablet can turn into a laptop and back. The keyboard is
   told too, so the key it draws says what it will do. */
const typingWithFinger = () => window.matchMedia?.("(pointer: coarse)").matches === true;
messageInput.setAttribute("enterkeyhint", typingWithFinger() ? "enter" : "send");
messageInput.addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  if (!G.enterSends({ touch: typingWithFinger(), shift: e.shiftKey, composing: e.isComposing || e.keyCode === 229 })) return;
  e.preventDefault();
  sendTextMessage();
});
messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + "px";
  /* A taller box takes its extra lines out of the message list above it. */
  if (_stickToBottom) scrollBottom();
  updateMessageCounter();
  sendTypingSignal();
});

/** The "9500 / 10000" counter: shown near the limit, red past it. Nothing is
    cut off — a long paste stays whole in the box, to be trimmed or split. */
function updateMessageCounter() {
  const length = messageInput.value.trim().length;
  const { counter, over } = G.draftState(length);
  messageCounter.classList.toggle("hidden", !counter);
  messageCounter.classList.toggle("over", over);
  messageCounter.textContent = counter ? `${length} / ${G.MAX_MESSAGE_CHARS}` : "";
  if (over) messageInput.setAttribute("aria-invalid", "true");
  else messageInput.removeAttribute("aria-invalid");
}

function sendTypingSignal() {
  if (!dcReady()) return;
  dcSend({ type: "typing" });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => dcSend({ type: "typing-stop" }), 1500);
}

async function sendTextMessage() {
  const text = messageInput.value.trim();
  if (!text || !dcReady()) return;
  if (!e2eReady) {
    appendSys(t("e2eWaiting"));
    return;
  }
  /* Said, not silently dropped: the text stays in the box to be trimmed. */
  if (!G.messageFits(text)) {
    showToast(I18N[LANG].messageTooLong(G.MAX_MESSAGE_CHARS), "warn");
    announce(I18N[LANG].messageTooLong(G.MAX_MESSAGE_CHARS));
    return;
  }
  const msgId = ++msgIdCounter;

  /* Whatever else fails here — the channel closing as Send is pressed — says
     so too, and the text stays in the box rather than vanishing. */
  try {
    const n = ++e2eSendSeq;
    const { ct, iv } = await e2eEncrypt(text, DC.messageAad(myRole(), n, "text", msgId));
    dataChannel.send(JSON.stringify({ type: "text", ct, iv, msgId, n }));
  } catch (err) {
    console.error("Message not sent:", err);
    showToast(t("messageNotSent"), "warn");
    return;
  }

  const row = appendBubble("me", text);
  addAckTick(row, msgId);
  pendingAcks[msgId] = row;
  markReactable(row, G.reactionKey("text", msgId));
  messageInput.value = "";
  messageInput.style.height = "auto";
  updateMessageCounter();
  dcSend({ type: "typing-stop" });
}

/**
 * Every message from the data channel lands here — once as it arrived, and once
 * more for whatever an `e2e-dc` envelope held. `sealed` tells the two apart and
 * is true only on that second pass, so it cannot be claimed by the sender.
 */
function handleTextMessage(data, sealed = false) {
  /* File announcements and call setup are sent sealed, so they are believed
     only sealed. Checking `text` alone left every other type open: a clear
     transfer-meta drew a file bubble with any name, and a clear call-request
     raised the incoming-call prompt — after e2eFailClosed() as well as before.
     See mayHandleFrame for who is in a position to send one. */
  const type = data && data.type;
  if (!G.mayHandleFrame(type, sealed)) {
    console.warn(`Dropping "${type}" — it arrived outside the encrypted envelope`);
    return;
  }

  switch (type) {

    case "e2e-dc":
      if (!e2eReady) break;
      /* Opens only as the other side's, at the number it carries — and a
         number already taken is a copy, delivered again. */
      e2eDecrypt(data.ct, data.iv, DC.messageAad(peerRole(), data.n, "e2e-dc"))
        .then(json => {
          if (!DC.takeSeal(e2eRecvSeen, data.n)) { console.warn(`Dropping envelope ${data.n} — delivered before`); return; }
          handleTextMessage(JSON.parse(json), true);
        })
        .catch(err => console.error("E2E envelope decrypt failed:", err));
      break;

    case "text":
      /* Only ever show a message the agreed key opened. sendTextMessage refuses
         to send until e2eReady, so an unencrypted body is never a real peer —
         and rendering one would undo e2eFailClosed(): that disables sending, but
         a middleman caught swapping keys could still write into this window.
         Same rule, and same silent drop, as the e2e-dc envelope above. */
      if (!G.mayRenderText(data, e2eReady)) {
        console.warn("Dropping a text message that was not end-to-end encrypted");
        break;
      }
      e2eDecrypt(data.ct, data.iv, DC.messageAad(peerRole(), data.n, "text", data.msgId))
        .then(plain => {
          if (!DC.takeSeal(e2eRecvSeen, data.n)) { console.warn(`Dropping message ${data.n} — delivered before`); return; }
          /* The same limit the sending app keeps — held here too, since the
             other side can run a changed one. */
          if (!G.messageFits(plain)) {
            console.warn(`Dropping a ${plain.length}-character message — over the limit`);
            appendSys(t("messageTooLongArrived"));
            return;
          }
          markReactable(appendBubble("peer", plain), G.reactionKey("text", data.msgId));
          dcSend({ type: "ack", msgId: data.msgId });
        })
        .catch(err => {
          console.error("Decrypt failed:", err);
          appendBubble("peer", "⚠️ [decrypt error]");
        });
      break;

    case "e2e-pubkey":
      /* Exactly one exchange per channel. A second key re-derived the
         verification code while leaving the key in use untouched, so the code
         on screen stopped matching the key it was supposed to describe. */
      if (!G.mayAcceptPeerKey({ peerKeySeen: e2ePeerKeySeen })) {
        console.warn("Ignoring a second e2e-pubkey — this channel already agreed a key");
        break;
      }
      e2ePeerKeySeen = true;
      e2eDeriveKey(data.key);
      break;

    case "e2e-confirm":
      handleE2eConfirm(data).catch(err => {
        console.error("E2E confirmation failed:", err);
        e2eFailClosed();
      });
      break;

    case "e2e-fail":
      e2eFailClosed();
      break;

    case "pake-msg":
      /* Only ever on a code room, and only one per channel. */
      if (roomKind === "code") handlePakeMessage(data);
      break;

    case "pake-confirm":
      if (roomKind === "code") handlePakeConfirm(data);
      break;

    case "ack":
      if (pendingAcks[data.msgId]) { markDelivered(pendingAcks[data.msgId]); delete pendingAcks[data.msgId]; }
      break;

    case "typing":
      if (!peerTyping) {
        peerTyping = true;
        typingIndicator.textContent = t("peerTyping");
        typingIndicator.classList.remove("hidden");
      }
      break;

    case "typing-stop":
      peerTyping = false;
      typingIndicator.classList.add("hidden");
      break;

    case "reaction":
      receiveReaction(data);
      break;

    /* Saving each other — see "SAVED PEOPLE". Sealed only: none is on the
       list of types believed in the clear. */
    case "save-offer":
      receiveSaveOffer(data);
      break;

    case "save-accept":
      receiveSaveAccept();
      break;

    case "save-decline":
      receiveSaveDecline(data);
      break;

    case "peer-info":
      /* The other side describing its device. Two fields are kept and nothing
         else, and neither is ever written to the page as it arrived — see
         peerDevice. Reaching here at all means the envelope opened it:
         peer-info is not on the list of types accepted in the clear, so whoever
         carries the packets cannot plant a device name in the security panel. */
      peerDevice = { os: data.os, browser: data.browser };
      renderShieldFacts();
      sendPeerInfo();   // the host's answer; a no-op for the guest, who went first
      if (isHost) shareKnockAddress();   // likewise: the guest is listening now
      if (isHost) quickCallPeerReady();  // and a call asked for from their row can ring there
      break;

    case "knock-address":
      receiveKnockAddress(data);
      break;

    case "transfer-meta":
      handleTransferMeta(data);
      break;

    case "transfer-abort": {
      /* One of ours, turned away by the other side: stop sending it, and say
         it was not accepted rather than "ask the sender" to the sender. */
      const outgoing = outgoingTransfers.get(data.id);
      if (outgoing) {
        outgoing.stopped = true;
        failTransfer(data.id, "transferRefused");
        break;
      }
      /* One we already refused: its bubble already says so. */
      if (refusedTransfers.has(data.id)) break;
      /* The sender gave up. Without this the placeholder waits for a
         transfer-done that is never coming. */
      delete recvBuffers[data.id];
      takeOrphanChunks(data.id);
      failTransfer(data.id);
      break;
    }

    case "transfer-done":
      assembleTransfer(data.id).catch(err => {
        console.error("Transfer assemble failed:", err);
        failTransfer(data.id);
      });
      break;

    case "call-request":
      handleCallRequest(data);
      break;

    case "call-reject": {
      /* Hung up while it was still ringing here — the caller gave up, or
         stopped waiting (see startRinging): a missed call, not an ended one. */
      const missed = !callRequestModal.classList.contains("hidden");
      endCall(false);
      appendSys(t(missed ? "sysMissedCall" : "sysCallEnded"));
      if (missed) noticeArrival();
      break;
    }

    case "call-accept":
      initiateCallOffer(data.withVideo);
      break;

    case "call-offer":
      handleIncomingCallOffer(data);
      break;

    case "call-answer":
      handleCallAnswer(data);
      break;

    case "call-ice":
      handleCallIce(data.candidate);
      break;

    case "call-restart":
      handleCallRestart(data);
      break;

    case "call-restart-answer":
      handleCallRestartAnswer(data);
      break;

    case "call-away":
    case "call-back":
      /* Their page was hidden — a locked screen, or another app — or is back. */
      if (!inCall) break;
      peerAway = data.type === "call-away";
      updateCallPauseNote();
      break;

    case "call-mic":
      /* Their phone paused their microphone and could not wake it — or it is
         back (see "A microphone the phone has paused"). */
      if (!inCall) break;
      peerMicSilent = data.silent === true;
      updateCallPauseNote();
      break;
  }
}

/* ══════════════════════════════════════════════
   BINARY TRANSFER PROTOCOL
══════════════════════════════════════════════ */

const makeTransferId = DC.makeTransferId;

async function sendBinary(file, kind) {
  if (!dcReady()) return;
  if (!e2eReady) { appendSys(t("e2eWaiting")); return; }

  // File size limit — prevent OOM and very long transfers
  const maxMb = Math.round(MAX_P2P_FILE_BYTES / 1024 / 1024);
  if (file.size > MAX_P2P_FILE_BYTES) {
    showToast(I18N[LANG].fileTooLargeP2P(maxMb), "warn");
    return;
  }

  const id = makeTransferId();
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const mimeType = file.type || "audio/webm";
  /* A picture the other side would not draw (an SVG, say) goes as a file, so
     both sides show the same thing. */
  kind = G.presentAs(kind, mimeType).kind;

  await dcSendE2e({
    type: "transfer-meta", id,
    name: file.name || "voice.webm", size: file.size,
    mimeType, kind, totalChunks
  });

  const localUrl = trackBlobUrl(URL.createObjectURL(file));  // tracked — revoked on leave
  if (kind === "file")  appendFileBubble("me", localUrl, file.name, file.size, null);
  if (kind === "image") resolveImageNow("me", localUrl, file.name);
  if (kind === "voice") resolveVoiceNow("me", localUrl, file.name);
  attachSendProgress(id);
  markReactable(findTransferRow(id), G.reactionKey("file", id));

  const idBytes = new TextEncoder().encode(id);
  let lastPct = -1;
  const outgoing = { stopped: false };
  outgoingTransfers.set(id, outgoing);
  try {
  for (let i = 0; i < totalChunks; i++) {
    /* Turned away by the other side; its transfer-abort already marked the
       bubble failed. Sending the rest would only be dropped. */
    if (outgoing.stopped) return;
    /* Read one slice at a time. file.arrayBuffer() would pull the whole file
       into the JS heap — 150 MB of it in the worst case — when only 64 KB is
       needed; the File itself stays backed by disk. */
    const chunk = await file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE).arrayBuffer();
    const { iv, ct } = await e2eEncryptBytes(chunk, DC.chunkAad(myRole(), id, i));
    const packet = DC.packChunk(idBytes, iv, ct);
    await drainBuffer();
    dataChannel.send(packet.buffer);

    const pct = Math.floor(((i + 1) / totalChunks) * 100);
    if (pct !== lastPct) { lastPct = pct; setTransferProgress(id, pct, "sending"); }
  }
  } catch (err) {
    /* The peer leaving mid-transfer is the ordinary case: dataChannel is set to
       null underneath the loop and send() throws. Nothing caught it, so the
       progress line stopped updating and sat at whatever percentage it had
       reached — for good. The sender was told the peer had left, while the file
       still claimed to be uploading. */
    console.error(`Transfer ${id} failed while sending:`, err);
    failTransfer(id);
    /* If the channel survived, the receiver is still waiting on a
       transfer-done that will never arrive. Tell it. */
    dcSendE2e({ type: "transfer-abort", id }).catch(() => {});
    return;
  } finally {
    outgoingTransfers.delete(id);
  }

  clearSendProgress(id);
  await dcSendE2e({ type: "transfer-done", id });
}

/* Plaintext chunks are folded into a Blob every DECRYPT_BATCH, so the JS heap
   holds at most one batch instead of the whole file. Blobs of this size get
   spilled to disk by the browser rather than kept in the heap. */
const DECRYPT_BATCH = 32;   // ~2 MB of plaintext per fold

/** Fresh receive state for one incoming transfer. `shown` is the verdict from
    G.incomingTransfer: the kind to show it as and the type its blob gets. */
function newRecvBuffer(meta, shown) {
  return {
    blobParts: [],            // decrypted batches, already out of the heap
    pending:   [],            // decrypted chunks awaiting the next fold
    received:  0,
    bytes:     0,             // plaintext so far, held to `size`
    failed:    false,
    lastPct:   -1,
    chain:     Promise.resolve(),   // serialises decryption so order is preserved
    name: meta.name, size: meta.size,
    kind: shown.kind, blobType: shown.blobType, totalChunks: meta.totalChunks
  };
}

/** A file is announced. Take it, or turn it away before a byte is stored. */
function handleTransferMeta(data) {
  if (recvBuffers[data.id]) return;   // already arriving under this id; keep that one
  if (refusedTransfers.has(data.id)) return;   // turned away once; not again under the same id
  const buffers = Object.values(recvBuffers);
  const verdict = G.incomingTransfer({
    meta: data,
    maxBytes:    MAX_P2P_FILE_BYTES,
    budgetBytes: INCOMING_BUDGET_BYTES,
    activeBytes: buffers.reduce((sum, b) => sum + b.size, 0),
    activeCount: buffers.length
  });
  if (!verdict.ok) { refuseTransfer(data.id, verdict.reason); return; }

  const info = newRecvBuffer(data, verdict);
  recvBuffers[data.id] = info;
  if (info.kind === "file")  appendFileBubble("peer", null, data.name, data.size, data.id);
  if (info.kind === "image") appendImagePlaceholder("peer", data.id, data.name);
  if (info.kind === "voice") appendVoicePlaceholder("peer", data.id);
  markReactable(findTransferRow(data.id), G.reactionKey("file", data.id));
  announce(info.kind === "voice" ? t("srNewVoice")
         : `${t(info.kind === "image" ? "srNewImage" : "srNewFile")}: ${data.name || ""}`);
  noticeArrival();
  /* Chunks that outran this message: feed them through in arrival order. */
  for (const early of takeOrphanChunks(data.id)) acceptChunk(info, data.id, early);
}

/**
 * Turns a transfer away — announced over the limit, or caught breaking its own
 * announcement mid-way. Frees what it holds, says so in the chat, drops whatever
 * more arrives for it, and tells the sender, whose app stops sending.
 */
function refuseTransfer(id, reason, info = null) {
  console.warn(`Transfer ${id}: refused — ${reason}`);
  const valid = typeof id === "string" && id.length === DC.TRANSFER_ID_LEN;
  /* `info` is passed from inside a transfer, which may already be off the
     table — assembleTransfer takes it off before the last chunks finish. */
  if (!info && valid) info = recvBuffers[id] || null;
  if (info) {
    info.failed = true;
    info.blobParts = [];
    info.pending = [];
    if (recvBuffers[id] === info) delete recvBuffers[id];
  }
  if (valid) {
    takeOrphanChunks(id);
    rememberRefused(id);
  }
  if (info) failTransfer(id, "transferRefused");
  else appendSys(t("transferRefused"));
  if (valid && dcReady()) dcSendE2e({ type: "transfer-abort", id }).catch(() => {});
}

/** Decrypt on arrival rather than hoarding ciphertext until transfer-done. */
function acceptChunk(info, id, packet) {
  /* The channel keeps order, so the count so far is this chunk's place. It
     opens only there, and only as the other side's (DC.chunkAad): a chunk
     delivered twice, out of place or handed back fails the transfer rather
     than quietly corrupting the file. */
  const index = info.received;
  info.received++;
  info.chain = info.chain
    .then(async () => {
      if (info.failed) return;
      /* Too short to hold an IV — the stream is corrupt, so fail the transfer
         instead of skipping bytes and delivering a damaged file. */
      const split = DC.splitChunkBody(packet);
      if (!split) throw new Error(`chunk shorter than IV (${packet.byteLength}B)`);
      const plain = await e2eDecryptBytes(split.ct, split.iv, DC.chunkAad(peerRole(), id, index));
      if (info.failed) return;   // refused while this chunk was decrypting
      info.bytes += plain.byteLength;
      /* The announced size is the most this transfer may hold. One byte past
         it and the sender is not keeping its word: stop storing now, rather
         than at a transfer-done that a changed app need never send. */
      if (!G.withinDeclaredSize(info.bytes, info.size)) {
        refuseTransfer(id, `more than the ${info.size} bytes announced`, info);
        return;
      }
      info.pending.push(plain);
      if (info.pending.length >= DECRYPT_BATCH) {
        info.blobParts.push(new Blob(info.pending));
        info.pending = [];
      }
    })
    .catch(err => {
      info.failed = true;
      console.error(`Transfer ${id}: chunk could not be decrypted —`, err);
    });
  reportTransferProgress(id, info);
}

function handleBinaryChunk(buffer) {
  const { id, body: chunkData } = DC.unpackChunk(buffer);

  /* Turned away already — the sender has not heard yet. */
  if (refusedTransfers.has(id)) return;

  const info = recvBuffers[id];
  /* No honest sender makes a chunk this big. Not decrypted, not parked. */
  if (chunkData.byteLength > MAX_CHUNK_BODY) {
    if (info) refuseTransfer(id, `a ${chunkData.byteLength}-byte chunk`, info);
    return;
  }
  if (info) { acceptChunk(info, id, chunkData); return; }

  /* Metadata is still decrypting — hold the chunk rather than dropping it.
     Past the cap we do drop, and assembleTransfer reports the gap. */
  if (orphanChunkCount >= ORPHAN_CHUNK_MAX) return;
  if (!orphanChunks[id]) orphanChunks[id] = [];
  orphanChunks[id].push(chunkData);
  orphanChunkCount++;
}

/* ── Transfer progress ──────────────────────── */

/** The one place a transfer id becomes a selector.
    The id arrives in transfer-meta, so the peer chooses it: unescaped, a
    crafted value could break the selector or steer it at a different message's
    bubble. Every lookup goes through here so no call site can forget. */
function findTransferRow(id) {
  return chatMessages.querySelector(`[data-tid="${CSS.escape(String(id))}"]`);
}

function setTransferProgress(id, pct, mode) {
  const row = findTransferRow(id);
  const el  = row && row.querySelector(".transfer-pending");
  if (el) el.textContent = `${t(mode)} ${pct}%`;
}

function reportTransferProgress(id, info) {
  if (!Number.isFinite(info.totalChunks) || info.totalChunks <= 0) return;
  /* Hold at 99% until assembly finishes, so 100% means genuinely done. */
  const pct = Math.min(99, Math.floor((info.received / info.totalChunks) * 100));
  if (pct === info.lastPct) return;
  info.lastPct = pct;
  setTransferProgress(id, pct, "receiving");
}

/** Tag the just-appended local bubble so the sender sees progress too. */
function attachSendProgress(id) {
  const row = chatMessages.lastElementChild;
  if (!row || !row.classList.contains("bubble-row")) return;
  row.dataset.tid = id;
  const host = row.querySelector(".bubble") || row;
  const line = document.createElement("div");
  line.className = "transfer-pending send-progress";
  line.style.cssText = "color:var(--muted);font-size:11px;margin-top:4px";
  line.textContent = `${t("sending")} 0%`;
  host.appendChild(line);
}

function clearSendProgress(id) {
  const row = findTransferRow(id);
  const line = row && row.querySelector(".send-progress");
  if (line) line.remove();
}

async function assembleTransfer(id) {
  if (refusedTransfers.has(id)) return;   // turned away; its bubble already says so
  const info = recvBuffers[id];
  delete recvBuffers[id];
  takeOrphanChunks(id);          // metadata never arrived for these, if any

  if (!info) {
    console.error(`Transfer ${id}: no metadata received`);
    appendSys(t("transferFailed"));
    return;
  }

  await info.chain;   // let any still-queued decryptions finish

  if (refusedTransfers.has(id)) return;   // turned away by one of those last chunks
  if (info.failed) { failTransfer(id); return; }

  /* totalChunks is authoritative. A short count means chunks were lost, and a
     silently truncated file is worse than a visible failure. Older peers may
     omit the field — skip the check rather than fail their transfers. */
  if (Number.isFinite(info.totalChunks) && info.received !== info.totalChunks) {
    console.error(`Transfer ${id}: expected ${info.totalChunks} chunks, got ${info.received}`);
    failTransfer(id);
    return;
  }

  /* Every byte announced, and no more — the same promise, checked at the end. */
  if (info.bytes !== info.size) {
    console.error(`Transfer ${id}: announced ${info.size} bytes, got ${info.bytes}`);
    failTransfer(id);
    return;
  }

  if (info.pending.length) {
    info.blobParts.push(new Blob(info.pending));
    info.pending = [];
  }
  /* blobType, never the sender's own type: see G.presentAs. */
  const blob = new Blob(info.blobParts, { type: info.blobType });
  info.blobParts = [];
  const url = trackBlobUrl(URL.createObjectURL(blob));  // tracked — revoked on leave

  if (info.kind === "file")  resolveFileBubble(id, url, info.name);
  if (info.kind === "image") resolveImagePlaceholder(id, url, info.name);
  if (info.kind === "voice") resolveVoicePlaceholder(id, url, info.name);
}

/** Marks a receiving placeholder as failed rather than delivering a truncated file. */
function failTransfer(id, messageKey = "transferFailed") {
  const row     = findTransferRow(id);
  const pending = row && row.querySelector(".transfer-pending");
  if (!pending) { appendSys(t(messageKey)); return; }
  pending.textContent = `⚠️ ${t(messageKey)}`;
  pending.classList.remove("transfer-pending");
  pending.classList.add("transfer-failed");
  pending.style.color = "var(--danger-text)";   // beats the inline colour set on the placeholder
  scrollBottom();
}

function drainBuffer() {
  return new Promise(resolve => {
    const deadline = Date.now() + 30_000; // give up after 30s — don't freeze forever
    const check = () => {
      if (!dataChannel || dataChannel.bufferedAmount < 262144) { resolve(); return; }
      if (Date.now() > deadline) { resolve(); return; } // channel stalled — proceed anyway
      setTimeout(check, 50);
    };
    check();
  });
}

/* ══════════════════════════════════════════════
   IMAGE SEND
══════════════════════════════════════════════ */

sendImageBtn.onclick = () => { attachMenu.classList.add("hidden"); imageInput.click(); };
/* Several at once: the picker used to take one, and a dozen photos meant a
   dozen trips through the menu. Sent one after another (sendFiles). Read
   before the picker is emptied, so the same ones can be picked again. */
imageInput.onchange = () => {
  const files = Array.from(imageInput.files || []);
  imageInput.value = "";
  sendFiles(files, "image");
};

/* ══════════════════════════════════════════════
   FILE SEND
══════════════════════════════════════════════ */

sendFileBtn.onclick = () => { attachMenu.classList.add("hidden"); fileInput.click(); };
fileInput.onchange = () => {
  const files = Array.from(fileInput.files || []);
  fileInput.value = "";
  sendFiles(files, "file");
};

/* ══════════════════════════════════════════════
   VOICE NOTE
══════════════════════════════════════════════ */

voiceRecordBtn.addEventListener("click", toggleVoiceRecord);
voiceRecordBtn.title = t("recordVoice");

let _isRecording = false;

/**
 * Releases the microphone and resets the button. Safe to call repeatedly, and
 * from anywhere — the stream is held at module scope precisely so that any code
 * path can switch the hardware off, not just the one that turned it on.
 */
function releaseVoiceCapture() {
  if (voiceStream) {
    voiceStream.getTracks().forEach(track => track.stop());
    voiceStream = null;
  }
  _isRecording = false;
  voiceRecordBtn.classList.remove("recording");
  voiceRecordBtn.title = t("recordVoice");
}

/**
 * Throws away a recording in progress: microphone off, audio dropped, nothing
 * sent. Called when the room goes away, since a recording only ever belongs to
 * the room it started in.
 */
function abandonVoiceRecording() {
  if (!_isRecording && !voiceStream) return;
  voiceDiscard = true;
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch (_) { /* onstop may not fire — clean up below */ }
  }
  if (mediaRecorder && mediaRecorder.state !== "inactive") return;   // onstop will finish it
  voiceChunks = [];
  voiceSession = null;
  releaseVoiceCapture();
}

/** A recorder for a voice note, in a format both sides can play
    (G.pickVoiceFormat) — or in the browser's own choice, if it will make
    none of them. */
function newVoiceRecorder(stream) {
  const format = G.pickVoiceFormat(type => MediaRecorder.isTypeSupported(type));
  if (format) {
    try { return new MediaRecorder(stream, { mimeType: format }); }
    catch (_) { /* said it could, then would not: let it choose */ }
  }
  return new MediaRecorder(stream);
}

async function toggleVoiceRecord() {
  /* Stopping comes first and is never gated on the connection: a recording in
     progress must always be stoppable, including after the peer has gone. */
  if (_isRecording) {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
    else releaseVoiceCapture();
    return;
  }

  /* Opening the microphone takes a moment and _isRecording only turns true once
     it has opened. A second press in that gap — a double-click — opened a second
     stream over the first, and the first could then never be stopped. */
  if (!G.mayStartRecording({ recording: _isRecording, opening: voiceOpening })) return;

  if (!dcReady()) return;
  if (!e2eReady) { appendSys(t("e2eWaiting")); return; }

  let stream = null;
  /* The room this press was made in. Read before the await below: by the time
     the microphone opens it may no longer be the room on screen. */
  const askedIn = currentSession && currentSession.sessionId;
  voiceOpening = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    /* A permission prompt can stay up for as long as the user likes, and the
       room can end underneath it. abandonVoiceRecording() ran then and found
       nothing to stop, so without this the microphone came on afterwards — in
       the lobby, with no button left to turn it off. */
    if (!G.mayKeepMicOpen({ askedIn, currentRoom: currentSession && currentSession.sessionId,
                            channelOpen: dcReady() })) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }

    voiceStream  = stream;
    voiceChunks  = [];
    voiceDiscard = false;
    /* Remember which room this belongs to. onstop can run long after, in a
       different room entirely — see the check there. */
    voiceSession = askedIn;

    const recorder = mediaRecorder = newVoiceRecorder(stream);
    let startedAt = 0;
    mediaRecorder.ondataavailable = e => voiceChunks.push(e.data);

    mediaRecorder.onstop = () => {
      const chunks     = voiceChunks;
      const discard    = voiceDiscard;
      const recordedIn = voiceSession;
      voiceChunks  = [];
      voiceDiscard = false;
      voiceSession = null;
      releaseVoiceCapture();

      /* Refuse to deliver audio to anyone but the room it was recorded in. The
         recorder outlives the room otherwise: leave while recording, join
         somewhere else, press the button again, and this would hand the new
         peer everything captured since — including the time in between. */
      if (!G.mayDeliverRecording({ recordedIn, currentRoom: currentSession && currentSession.sessionId,
                                   discarded: discard, channelOpen: dcReady() })) {
        if (!discard && chunks.length) console.warn("Discarding a voice note: the room it was recorded in is gone");
        return;
      }
      /* Labelled what it really is — it used to be called WebM whatever it
         was, and an iPhone showed "Error" in place of its own. */
      const type = G.voiceType(recorder.mimeType, chunks[0] && chunks[0].type);
      const blob = new Blob(chunks, { type });
      /* A tap and an at-once second tap record next to nothing, which plays
         on neither side: said, and not sent. */
      if (!G.voiceLongEnough(Date.now() - startedAt, blob.size)) {
        showToast(t("voiceTooShort"), "warn");
        return;
      }
      sendBinary(new File([blob], G.voiceFileName(type), { type }), "voice");
    };

    mediaRecorder.start();
    startedAt = Date.now();
    _isRecording = true;
    voiceRecordBtn.classList.add("recording");
    voiceRecordBtn.title = t("stopRecord");

  } catch (err) {
    /* getUserMedia may well have succeeded and MediaRecorder then failed — an
       unsupported codec does exactly that. The stream is live either way and
       must not be left running, which would keep the microphone on with the
       browser's recording indicator lit until the tab closed. */
    if (stream) stream.getTracks().forEach(track => track.stop());
    voiceStream = null;
    releaseVoiceCapture();
    const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
    showToast(denied ? t("micDenied") : t("micFailed"), "warn");
    if (!denied) console.error("Voice recording failed to start:", err);
  } finally {
    voiceOpening = false;
  }
}

/* ══════════════════════════════════════════════
   CALLS
══════════════════════════════════════════════ */

voiceCallBtn.onclick = () => requestCall(false);
videoCallBtn.onclick = () => requestCall(true);

/* ── A call nobody answers ──────────────────
   The other person away from the screen, or in another app, and nothing
   ended a call they never saw: the caller sat on "Calling…" for as long as
   anyone watched. After G.CALL_RING_MS it stops and says "No answer". The
   other side is told as for any hang-up, and notes a missed call (the
   call-reject case).                                                      */
let callRingTimer = null;

function startRinging() {
  stopRinging();
  callRingTimer = setTimeout(() => {
    callRingTimer = null;
    if (!G.callUnanswered({ inCall, answered: Boolean(callPc) })) return;
    endCall(true);
    appendSys(t("sysNoAnswer"));
  }, G.CALL_RING_MS);
}

function stopRinging() {
  clearTimeout(callRingTimer);
  callRingTimer = null;
}

function requestCall(withVideo) {
  if (inCall) return;
  if (!dcReady() || !pc) { appendSys(t("callNeedLink")); return; }
  if (!e2eReady) { appendSys(t("e2eWaiting")); return; }
  if (!isChatLinkUp()) { appendSys(t("callNeedLink")); return; }
  inCall = true;
  pendingCallVideo = withVideo;
  dcSendCallSignal({ type: "call-request", withVideo });
  showCallOverlay(withVideo ? t("videoCallingOut") : t("voiceCallingOut"), withVideo);
  startRinging();
}

function handleCallRequest(data) {
  if (inCall) {
    dcSendCallSignal({ type: "call-reject" });
    return;
  }
  const kind = data.withVideo ? t("incomingVideo") : t("incomingVoice");
  // Show a styled in-app modal instead of the browser's confirm() dialog
  callRequestIcon.textContent = data.withVideo ? "📹" : "📞";
  callRequestTitle.textContent = I18N[LANG].incomingCall(kind);
  callAcceptBtn.textContent  = t("callAccept");
  callDeclineBtn.textContent = t("callDecline");
  callRequestModal.classList.remove("hidden");
  startIncomingRing();

  const cleanup = () => { stopIncomingRing(); callRequestModal.classList.add("hidden"); };

  callDeclineBtn.onclick = () => {
    cleanup();
    dcSendCallSignal({ type: "call-reject" });
  };

  callAcceptBtn.onclick = () => {
    cleanup();
    if (!pc || !isChatLinkUp()) {
      appendSys(t("callNeedLink"));
      dcSendCallSignal({ type: "call-reject" });
      return;
    }
    inCall = true;
    pendingCallVideo = data.withVideo;
    dcSendCallSignal({ type: "call-accept", withVideo: data.withVideo });
    showCallOverlay(t("connecting"), data.withVideo);
    // If ontrack already fired and stored the remote stream, play it now
    if (remoteVideo.srcObject && remoteVideo._pendingPlay) {
      remoteVideo._pendingPlay = false;
      playRemoteCallMedia();
      callStatusLabel.textContent = t("callConnected");
    }
  };
}

/** How much capture the user actually agreed to.

    pendingCallVideo is set the moment they press a call button or Accept, so it
    is the only record of what they consented to. The peer's withVideo flag rides
    in on every later message and cannot be trusted on its own: answering a voice
    call with `withVideo: true` would otherwise turn the camera on.

    The peer may still ask for less — no camera on their side is a fair reason to
    answer a video call with audio only — so this is an AND, not an override. */
function consentedVideo(peerWantsVideo) {
  return G.consentedVideo(pendingCallVideo, peerWantsVideo);
}

/* The call's camera, the same whether it is starting or starting again — and
   facing whichever way it was last flipped, so a restart after the screen was
   locked does not quietly turn a back camera round to the front. */
const CALL_VIDEO = { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } };
let cameraFacing = "user";              // "user" is the front camera, "environment" the back
function callVideo() {
  return { ...CALL_VIDEO, facingMode: cameraFacing };
}

async function attachCallMedia(withVideo) {
  stopLocalCallMedia();
  callMediaRestarts = 0;
  audioInputsSeen = null;               // device changes while this sets up are not headphones
  clearTimeout(audioChangeTimer);
  cameraFacing = "user";                // every call starts on the front camera
  showCameraFacing();
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: withVideo ? callVideo() : false
  });
  localStream.getTracks().forEach(watchCallTrack);
  localVideo.srcObject = localStream;
  localVideo.muted = true;
  updateLocalVideoAspect();
  localVideo.onloadedmetadata = updateLocalVideoAspect;
  localStream.getVideoTracks().forEach(track => {
    track.onunmute = updateLocalVideoAspect;
    track.onended = () => localVideo.style.removeProperty("--local-video-aspect");
  });
  localVideo.play().catch(() => {}); // explicit play — needed on some mobile browsers
  for (const track of localStream.getTracks()) {
    await attachCallTrack(track, localStream);
  }
  updateFlipCamBtn();
  updateSpeakerBtn();
  updateShareBtn();
  noteAudioInputs();
  watchCallStats(true);
}

/* ── What the call's video is doing ─────────
   One line under the call's status: what arrives (↓) and what goes (↑) —
   format, size, frames a second, rate. Added to find out why a laptop saw
   nothing of an iPhone: "not sent", "not arriving" and "arriving but not
   decoded" all look like the same black picture, and these figures tell them
   apart. Empty in a voice call — there is no video either way.             */
let callStatsTimer = null;
let callStatsLast  = null;

function describeCallVideo(side, none) {
  if (!side) return none;
  const parts = [side.codec || "?"];
  if (side.width && side.height) parts.push(`${side.width}×${side.height}`);
  parts.push(`${side.fps} fps`);
  if (side.kbps !== null) parts.push(`${side.kbps} kb/s`);
  return parts.join(" · ");
}

/* And the sound, on a line of its own — in a voice call too. Added when an
   Android phone heard nothing from an iPhone: the rate each way says whether
   sound is sent and arrives at all, and the level whether it is sound or
   silence. A level of exactly 0 is a microphone sending zeros; "<1%" a quiet
   room. */
let callAudioLast = null;

function describeCallSound(side) {
  if (!side) return "—";
  const parts = [];
  if (side.kbps !== null) parts.push(`${side.kbps} kb/s`);
  if (side.level !== null) parts.push(side.level > 0 && side.level < 0.01 ? "<1%" : `${Math.round(side.level * 100)}%`);
  return parts.join(" ") || "…";
}

async function updateCallStats() {
  if (!inCall || !callPc) return;
  let report;
  try { report = await callPc.getStats(); } catch (_) { return; }
  const video = DCS.callVideoStats(report, callStatsLast);
  const sound = DCS.callAudioStats(report, callAudioLast);
  callStatsLast = video;
  callAudioLast = sound;
  const lines = [];
  if (video.in || video.out) lines.push(`↓ ${describeCallVideo(video.in, t("callVideoNone"))}`, `↑ ${describeCallVideo(video.out, "—")}`);
  if (sound.in || sound.out) lines.push(`${t("callSound")} ↓ ${describeCallSound(sound.in)} · ↑ ${describeCallSound(sound.out)}`);
  callStats.textContent = lines.join("\n");
  noteMicLevel(sound.out);
}

function watchCallStats(on) {
  clearInterval(callStatsTimer);
  callStatsTimer = null;
  callStatsLast = null;
  callAudioLast = null;
  callStats.textContent = "";
  resetMicCheck();                          // a call starting, or over: nothing paused yet
  if (on) callStatsTimer = setInterval(updateCallStats, 2000);
}

/* ── Upright pictures only ──────────────────
   Reported: a laptop in Edge heard an iPhone but never saw it, and the call's
   own figures showed the phone's video arriving and decoding. Turned sideways,
   the phone appeared. An iPhone held upright sends its picture sideways with
   an instruction to turn it (the video-orientation header extension), and
   Edge on that laptop drew such pictures black. The laptop's camera never
   needs turning, which is why the phone always saw the laptop.

   So the extension is taken out of every call description this side writes.
   A call negotiates it only if both offer and answer carry it, so either
   side leaving it out is enough — an older app on the other end included.
   Without it the sender turns the picture upright itself before sending, and
   every receiver gets a picture it only has to show. A browser that will not
   take the changed description is given the original: the call goes ahead as
   it always did.                                                          */
function withoutRotationExtension(desc) {
  const sdp = String(desc?.sdp || "").replace(/^a=extmap:\d+(?:\/\w+)? urn:3gpp:video-orientation\r?\n/gm, "");
  return { type: desc?.type, sdp };
}

async function setCallLocalDescription(desc) {
  const upright = withoutRotationExtension(desc);
  if (upright.sdp === desc.sdp) return callPc.setLocalDescription(desc);
  try { await callPc.setLocalDescription(upright); }
  catch (_) { await callPc.setLocalDescription(desc); }
}

/* ── The call's video format ────────────────
   Reported: a laptop (Edge) calling an iPhone heard it but never saw it,
   while the iPhone saw the laptop. The format is chosen from the list of
   whoever places the call. Chrome and Edge list VP8 first, so the iPhone had
   to send VP8, which it can only do in software, and its picture never
   arrived. An iPhone placing the call lists H.264 first — what every iPhone
   encodes in hardware — and phone-to-phone calls always worked.

   So both sides list H.264 first, before the offer and before the answer.
   Where both have it, every call uses it; a browser without it falls back to
   the rest of the list as before, and one that will not take a preference
   keeps its own order.                                                     */
function h264First(codecs) {
  const h264 = codecs.filter(c => /^video\/h264$/i.test(c.mimeType));
  return [...h264, ...codecs.filter(c => !h264.includes(c))];
}

function preferCallVideoCodecs() {
  if (!callPc || typeof RTCRtpReceiver === "undefined" || typeof RTCRtpReceiver.getCapabilities !== "function") return;
  const codecs = RTCRtpReceiver.getCapabilities("video")?.codecs;
  if (!codecs?.length) return;
  for (const transceiver of callPc.getTransceivers()) {
    if (transceiver.receiver?.track?.kind !== "video" || transceiver.stopped) continue;
    if (typeof transceiver.setCodecPreferences !== "function") continue;
    try { transceiver.setCodecPreferences(h264First(codecs)); }
    catch (_) { /* this browser keeps its own order */ }
  }
}

function updateLocalVideoAspect() {
  const videoTrack = localStream?.getVideoTracks()[0];
  const settings = videoTrack?.getSettings?.() || {};
  const width = localVideo.videoWidth || settings.width;
  const height = localVideo.videoHeight || settings.height;
  if (width && height) {
    localVideo.style.setProperty("--local-video-aspect", `${width} / ${height}`);
  }
}

/* ══════════════════════════════════════════════
   THE SELF-VIEW: MIRRORED HERE, MOVABLE
   ─────────────────────────────────────────────
   The mirror belongs to style.css alone — a transform on #localVideo. It flips
   the picture on this screen and nothing else: the track sent to the other side
   is the camera's own, so they see you the right way round. Flipping the track
   instead would send them a mirror image.

   The self-view can be dragged anywhere inside the call. Until it is, CSS keeps
   it in its corner; once moved it is placed by left/top, and put back inside
   whenever the call or the picture changes size — a phone turned on its side,
   a camera whose shape is known only once it starts — so it can never end up
   off screen with no way to reach it.
══════════════════════════════════════════════ */

const SELF_VIEW_MARGIN = 8;

/** Where the self-view goes when asked to sit at (x, y): the nearest spot that
    keeps all of it inside the call, `margin` clear of every edge. Null when the
    call or the picture has no size — hidden, so nothing to measure against —
    because believing a size of 0 would throw it into the top-left corner. */
function selfViewPosition(o) {
  if (!(o.w > 0 && o.h > 0 && o.areaW > 0 && o.areaH > 0)) return null;
  if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) return null;
  const maxX = Math.max(o.margin, o.areaW - o.w - o.margin);
  const maxY = Math.max(o.margin, o.areaH - o.h - o.margin);
  return {
    x: Math.min(Math.max(o.x, o.margin), maxX),
    y: Math.min(Math.max(o.y, o.margin), maxY)
  };
}

function moveSelfView(x, y) {
  const at = selfViewPosition({
    x, y,
    w: localVideo.offsetWidth, h: localVideo.offsetHeight,
    areaW: callOverlay.clientWidth, areaH: callOverlay.clientHeight,
    margin: SELF_VIEW_MARGIN
  });
  if (!at) return;
  localVideo.style.left   = `${at.x}px`;
  localVideo.style.top    = `${at.y}px`;
  localVideo.style.right  = "auto";
  localVideo.style.bottom = "auto";
}

let selfViewDrag = null;   // { id, dx, dy, x0, y0, moved } while a finger or the mouse holds it
const SELF_VIEW_SLOP = 6;  // px a finger may wander and still be a tap

localVideo.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || callSwapped) return;   // big, it is not the one to drag or tap
  const box = localVideo.getBoundingClientRect();
  selfViewDrag = { id: e.pointerId, dx: e.clientX - box.left, dy: e.clientY - box.top,
                   x0: e.clientX, y0: e.clientY, moved: false };
  localVideo.setPointerCapture(e.pointerId);
  e.preventDefault();
});

localVideo.addEventListener("pointermove", (e) => {
  if (!selfViewDrag || e.pointerId !== selfViewDrag.id) return;
  if (!selfViewDrag.moved && Math.hypot(e.clientX - selfViewDrag.x0, e.clientY - selfViewDrag.y0) < SELF_VIEW_SLOP) return;
  selfViewDrag.moved = true;
  localVideo.classList.add("dragging");
  const area = callOverlay.getBoundingClientRect();
  moveSelfView(e.clientX - area.left - selfViewDrag.dx, e.clientY - area.top - selfViewDrag.dy);
});

/** Let go: a drag ends where it is; a tap — never moved past the slop, and
    not a cancelled press — swaps the two pictures (setCallSwapped). */
function endSelfViewDrag(e) {
  if (!selfViewDrag || e.pointerId !== selfViewDrag.id) return;
  const tapped = e.type === "pointerup" && !selfViewDrag.moved;
  selfViewDrag = null;
  localVideo.classList.remove("dragging");
  if (tapped) setCallSwapped(true);
}
localVideo.addEventListener("pointerup", endSelfViewDrag);
localVideo.addEventListener("pointercancel", endSelfViewDrag);
localVideo.addEventListener("lostpointercapture", endSelfViewDrag);

/* Never moved: CSS has it, and keeps it in its corner. Moved: hold it where it
   was put, as far as the new size allows. */
function keepSelfViewInside() {
  if (!localVideo.style.left) return;
  /* The call made small shows the self-view in its own corner (style.css);
     measured against the small call, this would lose the place it was put.
     Swapped, it fills the call: held to that size, it would come back in
     the top-left corner rather than where it was put. */
  if (callMini || callSwapped) return;
  moveSelfView(parseFloat(localVideo.style.left), parseFloat(localVideo.style.top));
}
/* ── Your own picture big ───────────────────
   Asked for: in a video call, a tap on your own small picture to see it big.
   It swaps the pictures' places, not their streams: theirs plays their sound,
   and moving their stream into the muted self-view would silence them. Theirs
   goes small where yours was, and a tap on it swaps back. Not in a voice call
   (no pictures) nor the small call (side by side already); a call that ends,
   or is made small, comes back the usual way round. */
let callSwapped = false;

function setCallSwapped(on) {
  if (on && (callMini || callOverlay.classList.contains("voice-only") || callOverlay.classList.contains("hidden"))) return;
  callSwapped = on;
  callOverlay.classList.toggle("swapped", on);
  if (on) {
    /* Theirs small, with its own shape, where yours was put — or in its corner. */
    if (remoteVideo.videoWidth && remoteVideo.videoHeight) {
      remoteVideo.style.setProperty("--remote-video-aspect", `${remoteVideo.videoWidth} / ${remoteVideo.videoHeight}`);
    }
    for (const side of ["left", "top", "right", "bottom"]) remoteVideo.style[side] = localVideo.style[side];
  } else {
    for (const side of ["left", "top", "right", "bottom"]) remoteVideo.style[side] = "";
  }
}

remoteVideo.addEventListener("click", () => { if (callSwapped) setCallSwapped(false); });

if (window.ResizeObserver) {
  const selfViewSizes = new ResizeObserver(keepSelfViewInside);
  selfViewSizes.observe(callOverlay);
  selfViewSizes.observe(localVideo);
}

const makeSharedVerificationCode = DC.makeSharedVerificationCode;
const normalizeVerifyCode        = DC.normalizeVerifyCode;

/* Each state changes three things together — colour (the class), glyph and
   label — so none of them has to carry the meaning alone: colour is no use to
   someone who cannot tell amber from green, and a tick drawn in amber would
   say "checked" about a chat nobody has checked. */
const SHIELD_LOOK = {
  idle: { icon: "shield",             label: () => t("verifyKeys") },
  warn: { icon: "shield-exclamation", label: () => t("verifyWarn") },
  ok:   { icon: "shield-check",       label: () => t(e2eSecureMode ? "verifyAuto" : "verifyOk") }
};

/** Redraws the shield in the header. Amber is the case that matters: the link
    is up but unauthenticated — precisely where a man-in-the-middle would
    otherwise be invisible. This used to be a banner across the whole chat; the
    shield now does that job on its own, so every change to the verification
    state has to come through here. */
function updateShield() {
  if (!keyVerifyDropdown || !keyVerifyBtn || !keyVerifyIcon) return;
  const state = G.shieldState({ ready: e2eReady, secure: e2eSecureMode, verified: e2eVerified });
  for (const name of Object.keys(SHIELD_LOOK)) {
    keyVerifyDropdown.classList.toggle(`verify-${name}`, name === state);
  }
  const look  = SHIELD_LOOK[state];
  const label = look.label();
  keyVerifyIcon.className = `ti ti-${look.icon}`;
  keyVerifyBtn.title = label;
  keyVerifyBtn.setAttribute("aria-label", label);
  /* The panel's first line says in a sentence what the shield says in a
     colour, so the two are redrawn together and cannot disagree. */
  renderShieldFacts();
}

/* What the chat is encrypted with. Written out rather than read from the keys,
   which do not expose it in a form worth showing — so test/client-source.test.js
   checks these words against the calls that actually do the work. The second
   half names how the key was agreed: ECDH for most rooms, SPAKE2 for a code one. */
const MESSAGE_CIPHER_ECDH   = "AES-256-GCM · ECDH P-256";
const MESSAGE_CIPHER_SPAKE2 = "AES-256-GCM · SPAKE2 P-256";
const CALL_CIPHER           = "DTLS-SRTP";

/** Fills in the facts under the verification code. Called whenever any of them
    can have changed: the shield's state, the route, or what the peer said. */
function renderShieldFacts() {
  if (!factWhoCanRead) return;
  const state = G.shieldState({ ready: e2eReady, secure: e2eSecureMode, verified: e2eVerified });
  const live  = state !== "idle";

  /* "Only the two of you" is a claim about there being no middleman, and it is
     only true once that has been checked. An unverified chat is encrypted to
     whoever is on the other end of the key exchange — which is the peer, unless
     someone got in between. So the amber sentence says that instead. */
  factWhoCanRead.textContent = t({ idle: "factReadIdle", warn: "factReadWarn", ok: "factReadOk" }[state]);
  factWhoCanRead.className   = `fact-read ${state}`;

  factCipherValue.textContent = live ? (keyAgreement === "SPAKE2" ? MESSAGE_CIPHER_SPAKE2 : MESSAGE_CIPHER_ECDH) : "—";
  factCallsValue.textContent  = live ? CALL_CIPHER : "—";

  const path = _lastPath;
  factPathValue.textContent = path
    ? t({ direct: "pathDirect", local: "pathLocal", relayed: "pathRelayed" }[path.kind])
    : "—";

  /* An address the browser will not give is said to be hidden. A dash means
     there is nothing to show yet, or that a relay stands in for the devices.
     Only a real address is set in the fixed-width face — words in it read as
     if they were one. */
  const showAddress = (el, value) => {
    el.textContent = _lastAddresses ? (value || t("factHidden")) : "—";
    el.classList.toggle("mono",  Boolean(_lastAddresses && value));
    el.classList.toggle("quiet", Boolean(_lastAddresses && !value));
  };
  showAddress(factYourIpValue, _lastAddresses && _lastAddresses.local);
  showAddress(factPeerIpValue, _lastAddresses && _lastAddresses.remote);

  factYourDeviceValue.textContent = DCS.deviceLabel(MY_DEVICE) || t("factUnknown");
  factPeerDeviceValue.textContent = live ? (DCS.deviceLabel(peerDevice) || t("factUnknown")) : "—";
}

function updateKeyVerifyUi() {
  updateShield();
  if (!keyVerifyCode || !keyVerifyInput || !keyVerifyStatus) return;

  /* A code room (SPAKE2) verifies from the shared word and produces no
     comparison code, so the code box and the "compare the code" hint would sit
     empty and misleading. Show them only when there is a code to compare — the
     ECDH paths, whether verified by hand or by the invite link. */
  const hasCode = Boolean(e2eVerifyCode);
  keyVerifyCode.classList.toggle("hidden", !hasCode);
  if (keyVerifyHint) keyVerifyHint.classList.toggle("hidden", !hasCode);
  keyVerifyCode.textContent = e2eVerifyCode || "----";
  if (!e2eVerifyCode) keyVerifyInput.value = "";

  if (e2eSecureMode) {
    /* Authenticated by the invite-link secret or the shared word — nothing for
       the user to compare. */
    keyVerifyInput.classList.add("hidden");
    keyVerifyStatus.textContent = t("verifyAuto");
  } else {
    keyVerifyInput.classList.remove("hidden");
    keyVerifyStatus.textContent = e2eVerified ? t("verifyMatch") : t("verifyPending");
  }
  keyVerifyStatus.classList.toggle("ok", e2eVerified || e2eSecureMode);
  keyVerifyStatus.classList.toggle("bad", false);
}

if (keyVerifyInput) {
  keyVerifyInput.addEventListener("input", () => {
    const typed = normalizeVerifyCode(keyVerifyInput.value);
    const expected = normalizeVerifyCode(e2eVerifyCode);
    e2eVerified = Boolean(expected && typed && typed === expected);
    keyVerifyStatus.textContent = e2eVerified
      ? t("verifyMatch")
      : (typed ? t("verifyMismatch") : t("verifyPending"));
    keyVerifyStatus.classList.toggle("ok", e2eVerified);
    keyVerifyStatus.classList.toggle("bad", Boolean(typed && !e2eVerified));
    updateShield();
    maybeOfferSave();     // checked by hand: now they can be saved
  });
}

/* Draw the shield and its panel once at load, so neither is ever blank — the
   markup alone has an empty sentence and no state. Placed here because
   everything they read is declared above this line. */
updateShield();

function ensureOutgoingCallTransceivers(withVideo) {
  if (!callPc) return;
  const hasAudio = callPc.getTransceivers().some(t => t.receiver?.track?.kind === "audio" && !t.stopped);
  const hasVideo = callPc.getTransceivers().some(t => t.receiver?.track?.kind === "video" && !t.stopped);
  if (!hasAudio) callPc.addTransceiver("audio", { direction: "sendrecv" });
  if (withVideo && !hasVideo) callPc.addTransceiver("video", { direction: "sendrecv" });
}

function stopLocalCallMedia() {
  if (localStream) {
    localStream.getTracks().forEach(tr => tr.stop());
    localStream = null;
  }
  if (callPc) {
    callPc.getSenders().forEach(sender => {
      if (sender.track && (sender.track.kind === "audio" || sender.track.kind === "video")) {
        try { callPc.removeTrack(sender); } catch (_) {}
      }
    });
  }
  localVideo.srcObject = null;
  localVideo.onloadedmetadata = null;
  localVideo.style.removeProperty("--local-video-aspect");
}

async function attachCallTrack(track, stream) {
  if (!callPc) return;
  const reusable = callPc.getTransceivers().find(transceiver =>
    transceiver.receiver?.track?.kind === track.kind &&
    !transceiver.sender?.track &&
    !transceiver.stopped
  );

  if (reusable) {
    reusable.direction = "sendrecv";
    await reusable.sender.replaceTrack(track);
    return;
  }

  callPc.addTrack(track, stream);
}

async function drainCallIceQueue() {
  if (!callPc || !callPc.remoteDescription || !callPc.remoteDescription.type) return;
  while (callIceQueue.length) {
    try { await callPc.addIceCandidate(new RTCIceCandidate(callIceQueue.shift())); }
    catch (e) { console.warn("queued call-ice add failed:", e); }
  }
}

/** A call that could not be set up: no camera, a refused permission, a
    description the browser would not take.

    Ended here every time — the call may have been hung up while the camera was
    still opening, and ending it again is what turns that camera back off. The
    other side is told only if the call was still on; if it was not, whoever
    ended it already told them. It used to end quietly on every path, and the
    other side sat on a dark "Connecting…" screen until someone pressed End. */
function callSetupFailed(where, err) {
  const stillOn = inCall;
  endCall(stillOn);
  if (!stillOn) return;
  console.error(`${where}:`, err);
  appendSys(I18N[LANG].sysCallFailed(err?.message || String(err)));
}

async function handleCallAnswer(data) {
  if (!callPc || !inCall) return;
  try {
    await callPc.setRemoteDescription(new RTCSessionDescription(data.answer));
  } catch (e) {
    callSetupFailed("Call answer rejected", e);
    return;
  }
  await drainCallIceQueue();
  callStatusLabel.textContent = t("callConnected");
  appendSys(t("sysCallSecure"));
  if (remoteVideo._pendingPlay) {
    remoteVideo._pendingPlay = false;
    playRemoteCallMedia();
  }
}

async function handleCallIce(candidate) {
  if (!candidate) return;
  if (callPc && callPc.remoteDescription && callPc.remoteDescription.type) {
    try { await callPc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) {
      /* During a fresh route (call-restart) a candidate for it can arrive
         before the description it belongs to — the two travel separately.
         Kept, and tried again once that description is in; one that still
         does not fit is dropped then. */
      callIceQueue.push(candidate);
    }
  } else {
    callIceQueue.push(candidate);
  }
}

/* ── A call whose link drops ────────────────
   Reported, asking for steadier connections: a call whose link failed —
   Wi-Fi to mobile data mid-call, a moment without signal — simply ended,
   while the chat beside it tried again. Now the call tries too
   (G.callRecovery): the side that placed it asks for a fresh route — an ICE
   restart, over the chat's encrypted channel, on the same connection, so the
   camera and microphone carry on — after a few seconds down, and again now
   and then. Only that side asks, so two offers never cross. The call says
   "Reconnecting…" meanwhile, and both sides give up and say so once it has
   been down for half a minute.                                           */
let callOfferer      = false;          // this side placed the call
let callDownSince    = 0;
let callRestartAt    = 0;
let callRestarts     = 0;
let callRecoverTimer = null;

function watchCallLink() {
  const state = callPc?.connectionState;
  if (state === "connected") { stopCallRecovery(); return; }
  if (state !== "disconnected" && state !== "failed") return;
  if (!callDownSince) callDownSince = Date.now();
  if (!callRecoverTimer) callRecoverTimer = setInterval(stepCallRecovery, 1000);
}

function stepCallRecovery() {
  if (!inCall || !callPc) { stopCallRecovery(); return; }
  const now = Date.now();
  const action = G.callRecovery({
    state: callPc.connectionState, offerer: callOfferer,
    downFor: now - callDownSince, sinceRestart: now - callRestartAt, restarts: callRestarts
  });
  if (action === "none") { stopCallRecovery(); return; }
  if (action === "give-up") {
    stopCallRecovery();
    endCall(true);
    appendSys(t("callLinkLost"));
    return;
  }
  /* The ask travels on the chat's channel; with that down too, wait for it. */
  if (action === "restart" && dcReady()) {
    callRestartAt = now;
    callRestarts++;
    restartCallRoute();
  }
}

function stopCallRecovery() {
  clearInterval(callRecoverTimer);
  callRecoverTimer = null;
  callDownSince = callRestartAt = callRestarts = 0;
}

async function restartCallRoute() {
  const pc = callPc;
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    if (callPc !== pc) return;
    await setCallLocalDescription(offer);
    dcSendCallSignal({ type: "call-restart", offer: pc.localDescription });
  } catch (err) {
    console.error("Could not ask for a fresh route for the call:", err);
  }
}

/** The other side asking for a fresh route: answered on the same connection. */
async function handleCallRestart(data) {
  if (!inCall || !callPc || !data?.offer) return;
  const pc = callPc;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    await drainCallIceQueue();
    const answer = await pc.createAnswer();
    if (callPc !== pc) return;
    await setCallLocalDescription(answer);
    dcSendCallSignal({ type: "call-restart-answer", answer: pc.localDescription });
  } catch (err) {
    console.error("Could not answer the call's fresh route:", err);
  }
}

async function handleCallRestartAnswer(data) {
  if (!inCall || !callPc || !data?.answer || callPc.signalingState !== "have-local-offer") return;
  try {
    await callPc.setRemoteDescription(new RTCSessionDescription(data.answer));
    await drainCallIceQueue();
  } catch (err) {
    console.error("Could not take the call's fresh route:", err);
  }
}

async function initiateCallOffer(peerWantsVideo) {
  if (!pc || !currentSession) return;
  /* Reached only by the peer answering a call we placed, which is what set
     inCall in requestCall(). Without this check a peer could send call-accept
     out of the blue and attachCallMedia() below would open the camera and
     microphone with nothing on screen having asked. Mirrors the guard in
     handleIncomingCallOffer — both doors reach the same getUserMedia. */
  if (!G.mayCaptureForCall(inCall)) {
    console.warn("Ignoring unsolicited call-accept — no call was placed");
    dcSendCallSignal({ type: "call-reject" });
    return;
  }
  stopRinging();                       // answered
  const withVideo = consentedVideo(peerWantsVideo);
  showCallOverlay(withVideo ? t("videoConnecting") : t("voiceConnecting"), withVideo);
  try {
    createCallPeerConnection();
    callOfferer = true;                 // this side asks for a fresh route if the link drops
    ensureOutgoingCallTransceivers(withVideo);
    await attachCallMedia(withVideo);
    preferCallVideoCodecs();
    const offer = await callPc.createOffer();
    await setCallLocalDescription(offer);
    // Send offer immediately — trickle ICE candidates will follow via call-ice messages
    dcSendCallSignal({
      type: "call-offer",
      offer: callPc.localDescription,
      withVideo
    });
  } catch (e) {
    callSetupFailed("Call offer error", e);
  }
}

async function handleIncomingCallOffer(data) {
  if (!pc || !currentSession) return;
  /* An offer is only legitimate after call-request → the user pressing accept,
     which is what sets inCall. Without this check a peer could skip straight to
     call-offer and attachCallMedia() would open the camera and microphone with
     no prompt shown. (handleTextMessage only lets call signaling through when
     it came out of the encrypted envelope, so the sender is always the peer.) */
  if (!G.mayCaptureForCall(inCall)) {
    console.warn("Ignoring unsolicited call offer — no call was accepted");
    dcSendCallSignal({ type: "call-reject" });
    return;
  }
  const withVideo = consentedVideo(data.withVideo);
  showCallOverlay(t("connecting"), withVideo);
  try {
    createCallPeerConnection();
    callOfferer = false;                // the other side asks; this one answers
    // setRemoteDescription fires ontrack immediately, before the local media is
    // attached below, so the stream is stored and played once we are ready
    await callPc.setRemoteDescription(new RTCSessionDescription(data.offer));
    await drainCallIceQueue();
    await attachCallMedia(withVideo);
    preferCallVideoCodecs();
    const answer = await callPc.createAnswer();
    await setCallLocalDescription(answer);
    // Send answer immediately — trickle ICE candidates follow via call-ice messages
    dcSendCallSignal({
      type: "call-answer",
      answer: callPc.localDescription
    });
    callStatusLabel.textContent = t("callConnected");
    appendSys(t("sysCallSecure"));
    // If ontrack already fired and stored a stream, play it now
    if (remoteVideo._pendingPlay) {
      remoteVideo._pendingPlay = false;
      playRemoteCallMedia();
    }
  } catch (e) {
    callSetupFailed("Call answer error", e);
  }
}

function stopCallMedia(clearOverlay = true) {
  stopLocalCallMedia();
  remoteVideo.srcObject = null;
  isMuted = false;
  isCamOff = false;
  localVideo.classList.remove("cam-off");
  toggleMuteBtn.replaceChildren(tablerIcon("microphone"));
  toggleCamBtn.replaceChildren(tablerIcon("camera"));
  flipCamBtn.classList.add("hidden");
  speakerBtn.classList.add("hidden");
  sharingScreen = false;                    // the screen's track went with the rest
  if (screenMix) { screenMix.close(); screenMix = null; }   // and its sound, which was never in localStream
  updateShareBtn();
  audioInputsSeen = null;                   // the next call notes its own
  watchCallStats(false);
  cameraFacing = "user";
  showCameraFacing();
  if (clearOverlay) {
    callOverlay.classList.add("hidden");
    callOverlay.classList.remove("voice-only");
    remoteVideo.classList.remove("hidden");
    localVideo.classList.remove("hidden");
    stopCallChrome();
    resetCallMini();
  }
}

function showCallOverlay(statusText, withVideo) {
  callStatusLabel.textContent = statusText;
  callOverlay.classList.remove("hidden");
  callOverlay.classList.toggle("voice-only", !withVideo);
  // Show the peer name in voice-only avatar
  const nameEl = document.getElementById("voiceCallPeerName");
  if (nameEl) nameEl.textContent = roomTitle(currentSession?.sessionId || "");
  if (withVideo) {
    remoteVideo.classList.remove("hidden");
    localVideo.classList.remove("hidden");
  } else {
    remoteVideo.classList.remove("hidden");
    localVideo.classList.add("hidden");
  }
  showCallChrome();
}

/* ── The call's controls step aside ─────────
   Reported: during a call the "connected" label and the buttons stayed on
   screen for good, and a shared screen was hard to see behind them. Once the
   call is connected and nothing has been touched for a few seconds, the
   status, the figures and the buttons fade (G.callChromeMayHide); on a
   computer the pointer goes too. Any tap, click, key or movement over the
   call brings them back.

   The tap that brings them back does only that: for a moment after, the
   buttons take no taps, so a tap on the empty screen cannot land on a button
   that was invisible when the finger came down. The self-view and the "away"
   note are not part of it — they stay.                                      */
const CALL_CHROME_IDLE_MS = 4000;
const callControls = callOverlay.querySelector(".call-controls");
let callChromeTimer = null;

function showCallChrome() {
  const wasHidden = callOverlay.classList.contains("chrome-hidden");
  callOverlay.classList.remove("chrome-hidden");
  if (wasHidden) {
    callOverlay.classList.add("chrome-waking");
    setTimeout(() => callOverlay.classList.remove("chrome-waking"), 350);
  }
  clearTimeout(callChromeTimer);
  callChromeTimer = setTimeout(hideCallChrome, CALL_CHROME_IDLE_MS);
}

function hideCallChrome() {
  callChromeTimer = null;
  if (callOverlay.classList.contains("hidden")) return;     // no call on screen
  if (callMini) return;                                     // the small call has no controls to fade
  const mayHide = G.callChromeMayHide({
    inCall,
    connected: callPc?.connectionState === "connected",
    video: !callOverlay.classList.contains("voice-only"),
    /* :hover sticks after a tap on a phone; only a real pointer counts */
    pointerOnControls: window.matchMedia?.("(hover: hover)").matches === true && callControls.matches(":hover"),
    keyboardInControls: Boolean(callControls.querySelector(":focus-visible"))
  });
  /* Not yet — still connecting, say: look again later rather than never. */
  if (!mayHide) { callChromeTimer = setTimeout(hideCallChrome, CALL_CHROME_IDLE_MS); return; }
  callOverlay.classList.add("chrome-hidden");
}

function stopCallChrome() {
  clearTimeout(callChromeTimer);
  callChromeTimer = null;
  callOverlay.classList.remove("chrome-hidden", "chrome-waking");
}

for (const type of ["pointermove", "pointerdown", "focusin"]) {
  callOverlay.addEventListener(type, () => { if (!callOverlay.classList.contains("hidden")) showCallChrome(); });
}
document.addEventListener("keydown", () => { if (!callOverlay.classList.contains("hidden")) showCallChrome(); });

/* ── The call made small, to use the chat ───
   A call covered the whole chat: nothing could be read, typed or sent, nor a
   file looked at, until it ended. The chat button among the call's controls
   makes it small — their picture and yours side by side in the corner under
   the header for a video call, a strip there for a voice call — with the chat usable
   underneath. A tap on it, or its expand button, brings the call back; its
   red button hangs up. The picture and the sound go on throughout: the same
   elements, only smaller.

   While the call fills the screen, whatever arrives in the chat is counted on
   the chat button, and the controls come back to show it (noteCallChat).  */
const callChatBtn   = document.getElementById("callChatBtn");
const callChatCount = document.getElementById("callChatCount");
let callMini       = false;
let callChatUnread = 0;

function setCallMini(on) {
  if (on && callSwapped) setCallSwapped(false);   // side by side in the small call: the usual way round
  callMini = on;
  callOverlay.classList.toggle("mini", on);
  if (on) {
    stopCallChrome();                 // nothing fades in the small call
    callChatUnread = 0;               // the chat is in view: all of it seen
    drawCallChatCount();
  } else {
    showCallChrome();
  }
}

/** A call is on and fills the screen — not made small, not over. */
function callFillsScreen() {
  return !callOverlay.classList.contains("hidden") && !callMini;
}

/** The call is over: the next one starts full size, with nothing counted. */
function resetCallMini() {
  if (callSwapped) setCallSwapped(false);         // and the next call starts the usual way round
  callMini = false;
  callOverlay.classList.remove("mini");
  callChatUnread = 0;
  drawCallChatCount();
}

function drawCallChatCount() {
  callChatCount.textContent = callChatUnread > 9 ? "9+" : String(callChatUnread);
  callChatCount.classList.toggle("hidden", !callChatUnread);
}

/** Something arrived in the chat. While the call fills the screen, count it
    on the chat button — and bring the controls back, so the count is seen. */
function noteCallChat() {
  if (callMini || callOverlay.classList.contains("hidden")) return;
  callChatUnread++;
  drawCallChatCount();
  showCallChrome();
}

callChatBtn.onclick = () => setCallMini(true);
document.getElementById("callExpandBtn").onclick = () => setCallMini(false);
document.getElementById("callMiniEndBtn").onclick = () => endCall(true);
/* ── The small call can be moved ────────────
   Wherever it sat it covered a corner of the chat, and that corner might be
   the one being read. It can be dragged anywhere in the chat, by finger or
   mouse, and stays where it is put — for the rest of the call and the next,
   kept inside as the chat changes size (a keyboard opening, a phone turned
   on its side) — until moved again. Its two buttons are for pressing, not
   for dragging by. The same sum keeps it inside as keeps the self-view
   inside the call: selfViewPosition.

   A press that ends where it began is a tap, and brings the call back; one
   that moved does not. That is decided when the finger lifts, not by
   "click": a finger held for dragging is sent no click at all, so a tap on
   the small call did nothing on a phone. The call comes back under the
   finger, so for a moment its buttons take nothing — a click that does
   follow cannot press the one that is now there, End call perhaps.      */
const MINI_MARGIN = 8;
const MINI_DRAG_SLOP = 6;          // px a finger may wander and still be a tap
let miniDrag = null;               // { id, dx, dy, x0, y0, moved } while held
let miniAt   = null;               // where it was put, once moved

/** Puts the small call at (x, y) in the chat, or as near as fits. */
function placeMini(x, y) {
  const at = selfViewPosition({
    x, y,
    w: callOverlay.offsetWidth, h: callOverlay.offsetHeight,
    areaW: chatScreen.clientWidth, areaH: chatScreen.clientHeight,
    margin: MINI_MARGIN
  });
  if (!at) return;
  miniAt = at;
  callOverlay.style.setProperty("--mini-x", `${at.x}px`);
  callOverlay.style.setProperty("--mini-y", `${at.y}px`);
  callOverlay.classList.add("moved");
}

callOverlay.addEventListener("pointerdown", e => {
  if (!callMini || e.button !== 0 || e.target.closest(".call-mini-btn")) return;
  const box = callOverlay.getBoundingClientRect();
  miniDrag = { id: e.pointerId, dx: e.clientX - box.left, dy: e.clientY - box.top,
               x0: e.clientX, y0: e.clientY, moved: false };
  callOverlay.setPointerCapture(e.pointerId);
});

callOverlay.addEventListener("pointermove", e => {
  if (!miniDrag || e.pointerId !== miniDrag.id) return;
  if (!miniDrag.moved && Math.hypot(e.clientX - miniDrag.x0, e.clientY - miniDrag.y0) < MINI_DRAG_SLOP) return;
  miniDrag.moved = true;
  callOverlay.classList.add("dragging");
  const area = chatScreen.getBoundingClientRect();
  placeMini(e.clientX - area.left - miniDrag.dx, e.clientY - area.top - miniDrag.dy);
});

function endMiniDrag(e) {
  if (!miniDrag || e.pointerId !== miniDrag.id) return;
  const tapped = e.type === "pointerup" && !miniDrag.moved;     // not a cancelled press
  miniDrag = null;
  callOverlay.classList.remove("dragging");
  if (!tapped) return;
  setCallMini(false);
  callOverlay.classList.add("chrome-waking");
  setTimeout(() => callOverlay.classList.remove("chrome-waking"), 350);
}
callOverlay.addEventListener("pointerup", endMiniDrag);
callOverlay.addEventListener("pointercancel", endMiniDrag);
callOverlay.addEventListener("lostpointercapture", endMiniDrag);

/** Never moved: CSS has it, in its corner. Moved: held where it was put, as
    far as the chat's new size — or the call's, video or voice — allows. */
function keepMiniInside() {
  if (callMini && miniAt) placeMini(miniAt.x, miniAt.y);
}
if (window.ResizeObserver) {
  const miniSizes = new ResizeObserver(keepMiniInside);
  miniSizes.observe(chatScreen);
  miniSizes.observe(callOverlay);
}

function tablerIcon(name, size, color) {
  const icon = document.createElement("i");
  icon.className = `ti ti-${name}`;
  icon.setAttribute("aria-hidden", "true");
  if (size) icon.style.fontSize = `${size}px`;
  if (color) icon.style.color = color;
  return icon;
}

toggleMuteBtn.onclick = () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  toggleMuteBtn.replaceChildren(tablerIcon(isMuted ? "microphone-off" : "microphone"));
};

toggleCamBtn.onclick = () => {
  if (!localStream) return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  toggleCamBtn.replaceChildren(tablerIcon(isCamOff ? "camera-off" : "camera"));
  localVideo.classList.toggle("cam-off", isCamOff);   // the small call shows no black square for you
};

/* ── Flipping the camera ─────────────────────
   Front to back and back again, mid-call. The other camera's track goes into
   the same sender (replaceTrack): no new call, nothing renegotiated, the other
   side just sees a different picture.

   - The camera in use is stopped before the other one is opened. Many phones
     run only one camera at a time and refuse the second while the first is
     open; and iOS stops the first itself, which watchCallTrack would take for
     the camera dying and start a restart in the middle of the flip. stop()
     fires no "ended", so stopping it here sets nothing off.
   - G.mayFlipCamera is asked before opening — a call that is on, with a camera
     already in it, nothing else changing it — and the call is checked again
     once the camera has opened, as at every other opening.
   - If the other camera will not open, the one that was in use is opened
     again, so a failed flip leaves the call as it was, not without a picture.
   - Only the front camera is mirrored (showCameraFacing). The back one shows
     the world, and text in it should read the right way round here too.     */
async function flipCamera() {
  const current = localStream?.getVideoTracks()[0];
  if (!G.mayFlipCamera({ inCall, hasVideo: Boolean(current), busy: restartingCallMedia, sharing: sharingScreen })) return;
  restartingCallMedia = true;               // shared with the restart after a lock: one change at a time
  flipCamBtn.disabled = true;
  const pc = callPc;
  const sender = pc?.getSenders().find(s => s.track === current);
  const was = cameraFacing;
  const next = was === "environment" ? "user" : "environment";
  current.stop();
  try {
    let opened, facing = next, flipFailed = false;
    try {
      opened = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...CALL_VIDEO, facingMode: { exact: next } } });
    } catch (err) {
      console.error("Could not open the other camera:", err);
      flipFailed = true;
      facing = was;
      opened = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...CALL_VIDEO, facingMode: was } });
    }
    /* Hung up, or another call begun, while the camera was opening: put it straight back. */
    if (!G.mayCaptureForCall(inCall) || callPc !== pc || !localStream) {
      opened.getTracks().forEach(track => track.stop());
      return;
    }
    const track = opened.getVideoTracks()[0];
    track.enabled = !isCamOff;              // camera off stays off
    watchCallTrack(track);
    track.onunmute = updateLocalVideoAspect;
    track.onended = () => localVideo.style.removeProperty("--local-video-aspect");
    if (sender) await sender.replaceTrack(track);
    else        await attachCallTrack(track, localStream);
    cameraFacing = facing;
    /* A fresh stream, not a track swapped into the one on screen — Safari may
       never draw a track added to a stream it is already showing. */
    localStream = new MediaStream([...localStream.getAudioTracks(), track]);
    localVideo.srcObject = localStream;
    localVideo.play().catch(() => {});
    showCameraFacing();
    if (flipFailed) showToast(t("cameraFlipFailed"), "warn");
  } catch (err) {
    /* Neither camera would open. The call goes on with sound, and coming back
       to the page tries the camera again (restartEndedCallMedia). */
    console.error("Could not reopen the camera after a failed flip:", err);
    showToast(t("callMediaRestartFailed"), "warn");
  } finally {
    restartingCallMedia = false;
    flipCamBtn.disabled = false;
  }
}

/** The self-view is mirrored for the front camera only — never the back
    camera, and never a shared screen. */
function showCameraFacing() {
  localVideo.classList.toggle("back-camera", cameraFacing === "environment");
  localVideo.classList.toggle("screen-share", sharingScreen);
}

/** Shown only on a device with a camera on each side — see G.flipCameraOffered.
    The answer is read after the device list arrives, so a call that ended in
    the meantime is not given the button back. */
async function updateFlipCamBtn() {
  let cameras = 0;
  try { cameras = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput").length; }
  catch (_) { /* no list, no flip */ }
  const track = localStream?.getVideoTracks()[0];
  flipCamBtn.classList.toggle("hidden", !G.flipCameraOffered({
    inCall, hasVideo: Boolean(track), facing: track?.getSettings?.().facingMode, cameras
  }));
}

flipCamBtn.onclick = () => flipCamera();

/* ── Sharing the screen ─────────────────────
   In a video call, from a browser that can — a computer's; no iPhone or iPad
   browser can share its screen. The browser's own picker chooses the screen,
   window or tab, and is the consent: nothing is shared without it.

   The screen takes the camera's place in the same sender (replaceTrack): no new
   call, and the other side sees the screen where the camera was. The camera is
   stopped meanwhile — nothing is captured that is not being sent — and opened
   again when sharing stops, by the button or by the browser's own "Stop
   sharing" (the track ending).

   While sharing, the self-view shows what is shared, not mirrored; the flip
   has nothing to flip; headphones moving move only the microphone; and the
   page being hidden — the sharer is usually in the window being shown — does
   not tell the other side they have gone away.                              */
const SHARE_SUPPORTED = typeof navigator.mediaDevices?.getDisplayMedia === "function";
let sharingScreen = false;
let camOffBeforeShare = false;              // a camera turned off before sharing comes back off

/* Reported: shared from a laptop, the whole screen went out at full size —
   2560×1600 and more — and it was costly and laggy, worst on the phone
   receiving it. So a shared screen is held to Full HD at most, with its shape
   kept, and to its profile's size, frame rate and data rate (below). It is
   asked three ways, since browsers differ in which
   they honour — of the picker, of the captured track, and of the sender, whose
   limit is the one nothing ignores — and lifted again for the camera when
   sharing stops.                                                           */
const SCREEN_MAX = { width: 1920, height: 1080 };
/* What a share is held to, by what it most likely is. With its sound — ticked
   in the browser's picker — a share is nearly always a video, and moves: sent
   for motion. Without, it is a page to read: Full HD, sent for sharp detail.
   Reported: documents were fine at 15, videos were not at 30; then asked for
   videos at 60 frames a second, one step down in size — so 720p (1280×720)
   at 60, at the same 4 Mb/s Full HD at 30 had, about as much per pixel — and
   documents at 30, smoother to scroll. A page that sits still costs little at
   any rate, so its 2.5 Mb/s stays. The picker is asked for the most either
   takes; the track and the sender are then held to the one it is. */
const SCREEN_PROFILES = { still: { width: 1920, height: 1080, fps: 30, bitrate: 2_500_000, hint: "detail" }, moving: { width: 1280, height: 720, fps: 60, bitrate: 4_000_000, hint: "motion" } };
const SCREEN_CAPTURE = { width: { max: SCREEN_MAX.width }, height: { max: SCREEN_MAX.height }, frameRate: { max: SCREEN_PROFILES.moving.fps } };

function screenProfile(withSound) {
  return withSound ? SCREEN_PROFILES.moving : SCREEN_PROFILES.still;
}

/* ── The shared screen's sound ──────────────
   Reported: a video playing on the laptop sounded bad on the phone. Only the
   picture was shared, so its sound reached the call through the laptop's
   microphone, off its speakers — and the call's echo and noise filters, made
   for speech, chopped it up. Now, where the browser offers it (a tab's sound,
   or on Windows the whole screen's), the shared sound is mixed into the call
   directly with the microphone: the call has one sound to send. The
   microphone stays its own track underneath, so muting it mutes the voice and
   leaves the shared sound playing. Speakers still reach the microphone too;
   headphones on the sharing side keep it clean, which a tip says once.     */
let screenMix = null;

function mixScreenSound(mic, sound) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const out = ctx.createMediaStreamDestination();
  const source = track => {
    const node = ctx.createMediaStreamSource(new MediaStream([track]));
    node.connect(out);
    return node;
  };
  let micNode = source(mic);
  const soundNode = source(sound);
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const track = out.stream.getAudioTracks()[0];
  track.contentHint = "music";              // not squeezed as if it were only a voice
  return {
    track,
    setMic(next) { micNode.disconnect(); micNode = source(next); },
    close() {
      try { micNode.disconnect(); soundNode.disconnect(); } catch (_) { /* already apart */ }
      sound.stop();
      track.stop();
      ctx.close().catch(() => {});
    }
  };
}

/** How far a screen of this size is scaled down to fit `max` — Full HD,
    unless a profile says less — and never up. */
function screenScale(width, height, max = SCREEN_MAX) {
  if (!(width > 0 && height > 0)) return 1;
  return Math.max(1, width / max.width, height / max.height);
}

/** The track's own limits for a profile: its size and its frame rate. */
function screenConstraints(profile) {
  return { width: { max: profile.width }, height: { max: profile.height }, frameRate: { max: profile.fps } };
}

/** The sender's limits: Full HD at the profile's rate for a screen, none for
    the camera (screen null). */
async function limitScreenSender(sender, screen, profile = SCREEN_PROFILES.still) {
  if (!sender || typeof sender.getParameters !== "function") return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) return;   // nothing negotiated yet to limit
    const { width, height } = screen?.getSettings?.() || {};
    for (const encoding of params.encodings) {
      if (screen) {
        encoding.maxBitrate = profile.bitrate;
        encoding.maxFramerate = profile.fps;
        encoding.scaleResolutionDownBy = screenScale(width, height, profile);
      } else {
        delete encoding.maxBitrate;
        delete encoding.maxFramerate;
        encoding.scaleResolutionDownBy = 1;
      }
    }
    await sender.setParameters(params);
  } catch (_) { /* a browser that will not take limits sends as it would have */ }
}

async function startScreenShare() {
  const camera = localStream?.getVideoTracks()[0];
  if (sharingScreen) return;
  if (!G.mayShareScreen({ inCall, hasVideo: Boolean(camera), busy: restartingCallMedia, supported: SHARE_SUPPORTED })) return;
  restartingCallMedia = true;               // one change to the call's devices at a time
  shareBtn.disabled = true;
  const pc = callPc;
  try {
    let display;
    /* Nothing awaited before this: the picker needs the tap that asked for it. */
    /* audio: the picker offers to share the sound too — a tab's, or on Windows
       the whole screen's — and the person ticks it or not. */
    try { display = await navigator.mediaDevices.getDisplayMedia({ video: SCREEN_CAPTURE, audio: true, systemAudio: "include" }); }
    catch (_) { return; }                   // the picker closed, or sharing refused: the call goes on as it was
    const screen = display.getVideoTracks()[0];
    const sound  = display.getAudioTracks()[0] || null;
    /* Hung up, or another call begun, while the picker was up: put it straight back. */
    if (!G.mayCaptureForCall(inCall) || callPc !== pc || !localStream || !screen) {
      display.getTracks().forEach(track => track.stop());
      return;
    }
    const profile = screenProfile(Boolean(sound));
    screen.contentHint = profile.hint;      // a page kept sharp; a video kept moving
    screen.onended = () => stopScreenShare();
    /* The track is asked again for the profile's size and rate — and where the
       picker did not hold to Full HD, for that too. */
    try { await screen.applyConstraints(screenConstraints(profile)); } catch (_) { /* the sender's limit still holds */ }
    const sender = pc.getSenders().find(s => s.track === camera);
    if (sender) await sender.replaceTrack(screen);
    else        await attachCallTrack(screen, localStream);
    await limitScreenSender(pc.getSenders().find(s => s.track === screen), screen, profile);
    if (sound) {
      const mic = localStream.getAudioTracks()[0];
      const voice = pc.getSenders().find(s => s.track === mic);
      try {
        if (!mic || !voice) throw new Error("no microphone in the call to mix with");
        screenMix = mixScreenSound(mic, sound);
        await voice.replaceTrack(screenMix.track);
        showToast(t("shareSoundTip"), "info");
      } catch (err) {
        /* The picture is still shared; only its sound is not. */
        console.error("Could not share the screen's sound:", err);
        if (screenMix) screenMix.close(); else sound.stop();
        screenMix = null;
      }
    }
    camera.stop();                          // only once the screen is in its place
    sharingScreen = true;
    camOffBeforeShare = isCamOff;
    isCamOff = false;                       // sharing is choosing to be seen — the screen, not the camera
    toggleCamBtn.replaceChildren(tablerIcon("camera"));
    localStream = new MediaStream([...localStream.getAudioTracks(), screen]);
    localVideo.srcObject = localStream;
    localVideo.play().catch(() => {});
    showCameraFacing();
    updateFlipCamBtn();
  } finally {
    restartingCallMedia = false;
    shareBtn.disabled = false;
    updateShareBtn();
  }
}

async function stopScreenShare() {
  const screen = localStream?.getVideoTracks()[0];
  if (!sharingScreen || !screen) return;
  /* Another change is finishing — the share only just began, say. Once it has. */
  if (restartingCallMedia) { setTimeout(stopScreenShare, 300); return; }
  restartingCallMedia = true;
  shareBtn.disabled = true;
  sharingScreen = false;
  screen.onended = null;
  /* As it was before sharing: a camera turned off then is off again now. */
  isCamOff = camOffBeforeShare;
  toggleCamBtn.replaceChildren(tablerIcon(isCamOff ? "camera-off" : "camera"));
  const pc = callPc;
  const sender = pc?.getSenders().find(s => s.track === screen);
  try {
    if (!G.mayCaptureForCall(inCall)) return;   // hung up: the call's own ending stops everything
    /* The voice alone again, in the sender the mix was in. */
    if (screenMix) {
      const voice = pc?.getSenders().find(s => s.track === screenMix.track);
      const mic = localStream?.getAudioTracks()[0];
      if (voice && mic) await voice.replaceTrack(mic);
      screenMix.close();
      screenMix = null;
    }
    let camera = null;
    try {
      camera = (await navigator.mediaDevices.getUserMedia({ audio: false, video: callVideo() })).getVideoTracks()[0];
    } catch (err) {
      /* No camera: the screen stops anyway, and is left ended in the call, so
         coming back to the page tries the camera again (restartEndedCallMedia). */
      console.error("Could not open the camera again after sharing:", err);
      showToast(t("callMediaRestartFailed"), "warn");
    }
    if (!G.mayCaptureForCall(inCall) || callPc !== pc || !localStream) { camera?.stop(); return; }
    if (camera) {
      camera.enabled = !isCamOff;
      watchCallTrack(camera);
      camera.onunmute = updateLocalVideoAspect;
      camera.onended = () => localVideo.style.removeProperty("--local-video-aspect");
      if (sender) await sender.replaceTrack(camera);
      else        await attachCallTrack(camera, localStream);
      localStream = new MediaStream([...localStream.getAudioTracks(), camera]);
      localVideo.srcObject = localStream;
      localVideo.play().catch(() => {});
    }
    /* The camera goes out at its own size again — and so does one that a
       later return to the page brings back, if it would not open now. */
    await limitScreenSender(sender, null);
    screen.stop();
    showCameraFacing();
    updateFlipCamBtn();
  } finally {
    restartingCallMedia = false;
    shareBtn.disabled = false;
    updateShareBtn();
  }
}

function updateShareBtn() {
  shareBtn.classList.toggle("hidden", !G.shareOffered({
    inCall, hasVideo: Boolean(localStream?.getVideoTracks().length), supported: SHARE_SUPPORTED
  }));
  shareBtn.classList.toggle("sharing", sharingScreen);
  shareBtn.replaceChildren(tablerIcon(sharingScreen ? "screen-share-off" : "screen-share"));
  shareBtn.setAttribute("aria-label", t(sharingScreen ? "stopSharing" : "shareScreen"));
}

shareBtn.onclick = () => (sharingScreen ? stopScreenShare() : startScreenShare());

/* ── Headphones connected mid-call ──────────
   Reported: Bluetooth headphones connected during a video call on an iPhone,
   and the other person went on coming out of the phone's speaker. There a
   call's sound goes wherever its microphone is, and the call's microphone was
   the phone's own — opened before the headphones arrived.

   So while a call is on, a change in the phone's microphones — headphones on
   or off — opens the microphone again, which picks whatever the phone now
   prefers, and swaps it into the call in place (replaceTrack: nothing
   renegotiated). The sound follows it. The new one is opened before the old
   is stopped, so if it will not open the call keeps the sound it had. A
   change that is only a camera leaves the microphone alone.                  */
/* The call's microphones as noted once its own devices were in — null until
   then, and between calls. It used to start as "" and was never cleared, so
   while a call was still setting up it was compared with the last call's list
   (or with nothing): a phone reporting a device change as its camera and
   microphone started looked like headphones, and the call's microphone — or
   microphone and camera — was opened again in the middle of being set up.
   Reported as a laptop that could hear the phone but never saw it. */
let audioInputsSeen = null;
let audioChangeTimer = null;

async function audioInputsNow() {
  try {
    return (await navigator.mediaDevices.enumerateDevices())
      .filter(d => d.kind === "audioinput")
      .map(d => `${d.deviceId}|${d.label}`).sort().join(",");
  } catch (_) { return ""; }
}

/** What the call started with — a change is measured against it. */
function noteAudioInputs() {
  const pc = callPc;
  audioInputsNow().then(list => { if (callPc === pc && inCall) audioInputsSeen = list; });
}

function micCount(list) {
  return list ? list.split(",").length : 0;
}

async function followAudioDevice() {
  const old = localStream?.getAudioTracks()[0];
  if (!G.mayMoveMic({ inCall, hasAudio: Boolean(old), busy: restartingCallMedia })) return;
  /* Not noted yet: the call's own devices are still starting, and a change
     now is them, not headphones. */
  if (audioInputsSeen === null) return;
  const list = await audioInputsNow();
  if (list === audioInputsSeen) return;
  /* While a screen is shared there is no camera to open again: the
     microphone moves alone, and the share goes on. */
  const action = G.micChangeAction({
    before: micCount(audioInputsSeen), after: micCount(list), hasVideo: Boolean(localStream?.getVideoTracks().length) && !sharingScreen
  });
  audioInputsSeen = list;
  /* Headphones taken off in a video call: as the call started, so the sound
     goes back to the loudspeaker rather than the earpiece. */
  if (action === "mic-and-camera") { await restartLikeCallStart(); return; }
  restartingCallMedia = true;               // one change to the call's devices at a time
  const pc = callPc;
  try {
    const fresh = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    /* Hung up, or another call begun, while it was opening: put it straight back. */
    if (!G.mayCaptureForCall(inCall) || callPc !== pc || !localStream) {
      fresh.getTracks().forEach(track => track.stop());
      return;
    }
    const mic = fresh.getAudioTracks()[0];
    mic.enabled = !isMuted;                 // muted stays muted
    watchCallTrack(mic);
    const sender = pc?.getSenders().find(s => s.track === old);
    /* While a screen's sound is mixed in, the sender carries the mix: the new
       microphone goes into the mix in the old one's place. */
    if (screenMix)   screenMix.setMic(mic);
    else if (sender) await sender.replaceTrack(mic);
    else             await attachCallTrack(mic, localStream);
    localStream = new MediaStream([mic, ...localStream.getVideoTracks()]);
    old.stop();                             // only once the new one is in the call
  } catch (err) {
    console.error("Could not move the call's microphone to the new device:", err);
  } finally {
    restartingCallMedia = false;
  }
}

/* ── The loudspeaker ────────────────────────
   Reported: after headphones came off mid-call, the sound was on the
   iPhone's quiet earpiece, and there was no way to get the loudspeaker back.
   A page on an iPhone cannot choose between them — no browser there offers
   it. What it can do is what happens as a video call starts, which is when
   the phone picks the loudspeaker: stop the call's microphone and camera
   altogether and open both again (restartLikeCallStart). The headphones
   coming off do that by themselves (micChangeAction); the button does it on
   request. The picture blinks while the camera comes back.

   Only on an iPhone or iPad, only in a video call (G.speakerOffered). It is
   the phone's decision in the end: if it keeps the earpiece, this cannot
   overrule it.                                                              */
async function restartLikeCallStart() {
  const old = localStream;
  if (!G.mayMoveMic({ inCall, hasAudio: Boolean(old?.getAudioTracks()[0]), busy: restartingCallMedia })) return;
  if (sharingScreen) return;                // it would put the camera back over the shared screen
  const withVideo = old.getVideoTracks().length > 0;
  restartingCallMedia = true;               // shared with the flip and the restart after a lock
  speakerBtn.disabled = true;
  const pc = callPc;
  const senders = old.getTracks().map(track => ({ kind: track.kind, sender: pc?.getSenders().find(s => s.track === track) }));
  /* All of it stopped first: the phone decides where the sound goes when the
     capture starts, and it has to start. stop() fires no "ended". */
  old.getTracks().forEach(track => track.stop());
  try {
    const fresh = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo ? callVideo() : false });
    /* Hung up, or another call begun, while it was opening: put it straight back. */
    if (!G.mayCaptureForCall(inCall) || callPc !== pc || !localStream) {
      fresh.getTracks().forEach(track => track.stop());
      return;
    }
    for (const track of fresh.getTracks()) {
      track.enabled = track.kind === "audio" ? !isMuted : !isCamOff;   // muted stays muted, camera off stays off
      watchCallTrack(track);
      if (track.kind === "video") {
        track.onunmute = updateLocalVideoAspect;
        track.onended = () => localVideo.style.removeProperty("--local-video-aspect");
      }
      const sender = senders.find(s => s.kind === track.kind)?.sender;
      if (sender) await sender.replaceTrack(track);
      else        await attachCallTrack(track, fresh);
    }
    localStream = fresh;
    localVideo.srcObject = localStream;
    localVideo.play().catch(() => {});
    showCameraFacing();
  } catch (err) {
    /* Left ended, so coming back to the page tries again (restartEndedCallMedia). */
    console.error("Could not open the call's microphone and camera again:", err);
    showToast(t("callMediaRestartFailed"), "warn");
  } finally {
    restartingCallMedia = false;
    speakerBtn.disabled = false;
  }
}

function updateSpeakerBtn() {
  speakerBtn.classList.toggle("hidden", !G.speakerOffered({
    inCall, hasVideo: Boolean(localStream?.getVideoTracks().length), os: MY_DEVICE.os
  }));
}

speakerBtn.onclick = () => restartLikeCallStart();

/* Connecting headphones fires this more than once; act on where it settles. */
navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  clearTimeout(audioChangeTimer);
  audioChangeTimer = setTimeout(followAudioDevice, 600);
});

endCallBtn.onclick = () => endCall(true);

function endCall(notify = true) {
  stopRinging();
  inCall = false;
  peerAway = false;
  updateCallPauseNote();
  pendingCallVideo = false;
  callIceQueue = [];
  remoteVideo._pendingPlay = false;
  stopIncomingRing();
  callRequestModal.classList.add("hidden");
  if (notify && dcReady()) dcSendCallSignal({ type: "call-reject" });
  stopCallMedia(true);
  closeCallPeerConnection();
}

/* ── A call across a locked screen ──────────
   A phone locked mid-call pauses the page. Two things went wrong after:

   - its microphone and camera could stay off. The phone may stop them for
     good while locked, and nothing started them again, so back on the screen
     the call was still up but the other side heard and saw nothing. Coming
     back now starts again whatever ended (G.tracksToRestart) and swaps it into
     the call in place — no new call, no renegotiation.
   - the other side was left with a frozen picture, or silence, and no word
     why. Each side now tells the other when its page is hidden and when it is
     back (call-away, call-back, sealed like all call signalling), and the call
     screen says so (G.callPauseNote). If that message never gets out before
     the phone sleeps, the call's own link going down says "Reconnecting…".  */
const callPauseNote = document.getElementById("callPauseNote");
const callPauseText = document.getElementById("callPauseText");
let peerAway = false;                  // the other side's page is hidden, by its own word
let restartingCallMedia = false;
let callMediaRestarts = 0;
const CALL_MEDIA_RESTART_MAX = 5;      // a device that keeps failing is not retried for ever

function updateCallPauseNote() {
  const note = G.callPauseNote({ inCall, peerAway, peerMicSilent, linkState: callPc?.connectionState });
  callPauseText.textContent = note === "away" ? t("callPeerAway") : note === "reconnecting" ? t("reconnecting")
                            : note === "mic" ? t("callPeerMicSilent") : "";
  callPauseNote.classList.toggle("hidden", !note);
}

/* ── A microphone the phone has paused ──────
   Reported: an Android phone heard nothing at all from an iPhone — from the
   start of the call, voice or video, now and then — while the iPhone heard
   the Android phone, in Safari. A phone can pause a page's microphone without
   ending it: the track says it is muted (by the phone — the person's own
   mute only switches it off), or it stays live and sends nothing but zeros.
   Only a microphone that ended was ever started again (watchCallTrack).

   Now both are watched (G.micCheck): the track's mute and unmute, and its
   level in the call's stats every two seconds. Paused a moment, the
   microphone is opened again as a call starts it — with the camera in a
   video call, so an iPhone keeps the loudspeaker (restartLikeCallStart).
   Still paused after two tries, this side says "Your microphone isn't
   picking up sound — tap to try again" (the tap tries again), and the other
   is told (call-mic, sealed like all call signalling), so its silence is
   not taken for a fault at that end.                                       */
let micZeroSince  = 0;        // our microphone has read exactly 0 in the stats since
let micMutedSince = 0;        // the phone has had our microphone muted since
let micHeard      = false;    // this microphone has sent sound — anything above 0 — at least once
let micReopens    = 0;
let micToldSilent = false;    // the other side has been told our microphone is silent
let peerMicSilent = false;    // theirs is, by their word

function resetMicCheck() {
  micZeroSince = micMutedSince = micReopens = 0;
  micHeard = micToldSilent = peerMicSilent = false;
  callMicNote.classList.add("hidden");
  callTapToHear.classList.add("hidden");
}

/** The microphone's level from the call's stats. Exactly 0, while it is on
    and not muted by the person, starts the clock on "zeros" — but only until
    it has sent any sound at all. The fault reported was silence from the
    start; once a microphone has been heard, quiet is someone being quiet,
    whatever a phone's noise filter makes of it. */
function noteMicLevel(out) {
  const mic = localStream?.getAudioTracks()[0];
  if (out && out.level > 0) micHeard = true;
  if (micHeard || !out || out.level !== 0 || !mic || !mic.enabled) micZeroSince = 0;
  else if (!micZeroSince) micZeroSince = Date.now();
  checkMic();
}

function checkMic() {
  const mic = localStream?.getAudioTracks()[0];
  const now = Date.now();
  if (mic && mic.muted) { if (!micMutedSince) micMutedSince = now; }
  else micMutedSince = 0;
  const since = micMutedSince || micZeroSince;
  const action = G.micCheck({
    inCall, hasMic: Boolean(mic), userMuted: isMuted || Boolean(mic && !mic.enabled),
    visible: document.visibilityState === "visible",
    pausedBy: micMutedSince ? "phone" : micZeroSince ? "zeros" : null,
    pausedFor: since ? now - since : -1, reopens: micReopens
  });
  if (action === "ok") { micReopens = 0; tellMicSilent(false); return; }
  if (action === "wait") return;
  if (action === "reopen") {
    micReopens++;
    micZeroSince = micMutedSince = 0;       // the new microphone's own clock, and not heard yet
    micHeard = false;
    restartLikeCallStart();
    return;
  }
  tellMicSilent(true);
}

function tellMicSilent(silent) {
  callMicNote.classList.toggle("hidden", !silent);
  if (silent === micToldSilent || !dcReady()) return;
  micToldSilent = silent;
  dcSendCallSignal({ type: "call-mic", silent }).catch(() => {});
}

callMicNote.onclick = () => {
  micReopens = 0;
  micZeroSince = micMutedSince = 0;
  micHeard = false;
  callMicNote.classList.add("hidden");
  restartLikeCallStart();
};

callTapToHear.onclick = () => {
  remoteVideo.play().then(() => callTapToHear.classList.add("hidden")).catch(() => {});
};

/** A call track that ends while the page is showing — the phone took the
    camera, say — is started again at once; one that ends while hidden waits
    for the page to come back. stop() on hanging up fires no "ended". */
function watchCallTrack(track) {
  track.addEventListener("ended", () => {
    if (document.visibilityState === "visible") restartEndedCallMedia();
  });
  /* Paused by the phone, not ended: see "A microphone the phone has paused". */
  if (track.kind !== "audio") return;
  track.addEventListener("mute", () => setTimeout(checkMic, G.MIC_CHECK.phoneMs + 100));
  track.addEventListener("unmute", checkMic);
}

async function restartEndedCallMedia() {
  if (restartingCallMedia || !localStream || !callPc) return;
  const kinds = G.tracksToRestart({
    inCall, tracks: localStream.getTracks().map(({ kind, readyState }) => ({ kind, readyState }))
  });
  if (!kinds.length || callMediaRestarts >= CALL_MEDIA_RESTART_MAX) return;
  restartingCallMedia = true;
  callMediaRestarts++;
  try {
    const fresh = await navigator.mediaDevices.getUserMedia({
      audio: kinds.includes("audio"),
      video: kinds.includes("video") ? callVideo() : false
    });
    /* Hung up while the phone was asking: put it all straight back. */
    if (!G.mayCaptureForCall(inCall) || !callPc || !localStream) {
      fresh.getTracks().forEach(track => track.stop());
      return;
    }
    const kept = localStream.getTracks().filter(track => track.readyState !== "ended");
    for (const track of fresh.getTracks()) {
      /* Muted stays muted, camera off stays off. */
      track.enabled = track.kind === "audio" ? !isMuted : !isCamOff;
      watchCallTrack(track);
      const old = localStream.getTracks().find(o => o.kind === track.kind && o.readyState === "ended");
      const sender = old && callPc.getSenders().find(s => s.track === old);
      if (sender) await sender.replaceTrack(track);
      else        await attachCallTrack(track, localStream);
    }
    /* A fresh stream rather than a track swapped into the old one: Safari may
       never draw a track added to a stream it is showing. The self-view gets
       it only when the camera was the one restarted — otherwise its picture
       has not changed, and handing it over would only make it flicker. */
    localStream = new MediaStream([...kept, ...fresh.getTracks()]);
    if (kinds.includes("video")) {
      localVideo.srcObject = localStream;
      localVideo.play().catch(() => {});
    }
  } catch (err) {
    console.error("Could not start the call's microphone or camera again:", err);
    showToast(t("callMediaRestartFailed"), "warn");
  } finally {
    restartingCallMedia = false;
  }
}

document.addEventListener("visibilitychange", () => {
  if (!inCall) return;
  const away = document.visibilityState === "hidden";
  /* Sharing a screen, the sharer is usually in the window being shown — the
     page hidden behind it is not someone gone away. */
  if (dcReady() && !(away && sharingScreen)) dcSendCallSignal({ type: away ? "call-away" : "call-back" }).catch(() => {});
  if (!away) restartEndedCallMedia();
});

/* ══════════════════════════════════════════════
   ATTACH MENU
══════════════════════════════════════════════ */

attachBtn.onclick = e => { e.stopPropagation(); attachMenu.classList.toggle("hidden"); };
document.addEventListener("click", () => attachMenu.classList.add("hidden"));

/* ══════════════════════════════════════════════
   PICTURE VIEWER
   ─────────────────────────────────────────────
   A picture in the chat opened in a new browser tab. On a phone that took
   the person out of the chat — the page behind it could be paused, the way
   the Back button used to lose a chat — and getting back meant finding the
   tab. It now opens here, over the chat, fitted to the screen: a tap zooms
   in where it lands, a finger (or the wheel) looks round, a tap fits it
   again. Save keeps it; ✕, Esc, a tap on the dark round it, or the phone's
   Back closes it (G.backPress "close"). Nothing leaves the page.
══════════════════════════════════════════════ */
const imageViewer      = document.getElementById("imageViewer");
const imageViewerStage = document.getElementById("imageViewerStage");
const imageViewerImg   = document.getElementById("imageViewerImg");
const imageViewerName  = document.getElementById("imageViewerName");
const imageViewerSave  = document.getElementById("imageViewerSave");
const imageViewerClose = document.getElementById("imageViewerClose");
const VIEWER_ZOOM = 2.5;             // times the fitted size
let viewerOpener = null;             // what had the focus, to give it back

function openImageViewer(url, name) {
  viewerOpener = document.activeElement;
  imageViewerImg.src = url;
  imageViewerImg.alt = name || t("image");
  imageViewerName.textContent = name || "";
  imageViewerSave.href = url;
  imageViewerSave.download = name || "image";
  zoomViewer(false);
  imageViewer.classList.remove("hidden");
  imageViewerClose.focus();
}

function viewingImage() {
  return !imageViewer.classList.contains("hidden");
}

function closeImageViewer() {
  if (!viewingImage()) return;
  imageViewer.classList.add("hidden");
  zoomViewer(false);
  imageViewerImg.removeAttribute("src");
  if (viewerOpener && typeof viewerOpener.focus === "function") viewerOpener.focus();
  viewerOpener = null;
}

/** In, to VIEWER_ZOOM times the fitted size with the point tapped kept under
    the finger; or back to fitted. */
function zoomViewer(on, at) {
  if (!on) {
    imageViewer.classList.remove("zoomed");
    imageViewerImg.style.width = "";
    return;
  }
  const fitted = imageViewerImg.getBoundingClientRect();
  if (!(fitted.width > 0)) return;              // not drawn yet
  const fx = at ? (at.x - fitted.left) / fitted.width : 0.5;
  const fy = at ? (at.y - fitted.top) / fitted.height : 0.5;
  imageViewerImg.style.width = `${Math.round(fitted.width * VIEWER_ZOOM)}px`;
  imageViewer.classList.add("zoomed");
  const stage = imageViewerStage.getBoundingClientRect();
  const px = at ? at.x - stage.left : stage.width / 2;
  const py = at ? at.y - stage.top : stage.height / 2;
  imageViewerStage.scrollLeft = fx * imageViewerImg.offsetWidth - px;
  imageViewerStage.scrollTop  = fy * imageViewerImg.offsetHeight - py;
}

imageViewerImg.addEventListener("click", e => {
  e.stopPropagation();
  zoomViewer(!imageViewer.classList.contains("zoomed"), { x: e.clientX, y: e.clientY });
});
/* The dark round the picture: out of a zoom, or — fitted — closed. */
imageViewerStage.addEventListener("click", e => {
  if (e.target !== imageViewerStage) return;
  if (imageViewer.classList.contains("zoomed")) zoomViewer(false);
  else closeImageViewer();
});
imageViewerClose.onclick = closeImageViewer;
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && viewingImage()) closeImageViewer();
});

/* ══════════════════════════════════════════════
   PASTE OR DROP A FILE
   ─────────────────────────────────────────────
   On a computer a file reached the chat only through the paperclip menu. A
   picture pasted into the message box — a screenshot, Ctrl+V — is now sent
   as a picture, and files dropped on the chat are sent one after another,
   each as what it is (G.droppedKind). Text pastes as text, as always. And a
   file dropped anywhere else on the page no longer opens in the tab in place
   of the page, which ended the chat.
══════════════════════════════════════════════ */
const dropHint = document.getElementById("dropHint");
let dragDepth = 0;                   // dragenter/leave fire for every child crossed

/** Sends files one after another, each finished before the next begins: as
    `kind` when the person said which (the photo or the file button), else
    each as what it is. */
async function sendFiles(files, kind) {
  for (const file of files) await sendBinary(file, kind || G.droppedKind(file.type));
}

function carriesFiles(e) {
  return Boolean(e.dataTransfer) && Array.from(e.dataTransfer.types || []).includes("Files");
}

function hideDropHint() {
  dragDepth = 0;
  dropHint.classList.add("hidden");
}

messageInput.addEventListener("paste", e => {
  const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
  if (!files.length) return;          // text: pasted as text
  e.preventDefault();
  sendFiles(files);
});

chatScreen.addEventListener("dragenter", e => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropHint.classList.remove("hidden");
});
chatScreen.addEventListener("dragover", e => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
chatScreen.addEventListener("dragleave", e => {
  if (!carriesFiles(e)) return;
  if (--dragDepth <= 0) hideDropHint();
});
chatScreen.addEventListener("drop", e => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  hideDropHint();
  sendFiles(Array.from(e.dataTransfer.files || []));
});
/* Anywhere else, a dropped file would open in the tab in place of the page. */
window.addEventListener("dragover", e => { if (carriesFiles(e)) e.preventDefault(); });
window.addEventListener("drop", e => { if (carriesFiles(e)) e.preventDefault(); });

/* ══════════════════════════════════════════════
   REACTIONS
   ─────────────────────────────────────────────
   A message could only be answered with another message. Now any message —
   text, picture, voice note or file, either side's — takes an emoji: hold it
   with a finger, or right-click it or use the small button beside it with a
   mouse, and a bar of six opens (G.REACTIONS). The one picked shows under
   the message on both screens; picked again, it is taken back; another
   replaces it. One each per message.

   A reaction goes sealed, like everything else said (dcSendE2e) — "reaction"
   is not one of the types accepted in the clear — and arrives as a message
   both sides can name (G.reactionKey) with one of the six, or it is not
   drawn (G.reactionValid). Holding a message on a phone no longer selects
   its text, so the bar copies a text message too.
══════════════════════════════════════════════ */
const reactionBar  = document.getElementById("reactionBar");
const LONG_PRESS_MS = 450;
let reactingTo   = null;     // the message the bar is open for
let pressTimer   = null;     // a finger held on a message
let pressStart   = null;     // where it went down
let swallowClick = null;     // the message whose next click the hold has used

for (const emoji of G.REACTIONS) {
  const choice = document.createElement("button");
  choice.type = "button";
  choice.className = "reaction-choice";
  choice.dataset.emoji = emoji;
  choice.textContent = emoji;
  choice.setAttribute("aria-label", emoji);
  reactionBar.appendChild(choice);
}
const reactionCopy = document.createElement("button");
reactionCopy.type = "button";
reactionCopy.className = "reaction-copy";
reactionCopy.dataset.i18nAria = "copyBtn";
reactionCopy.setAttribute("aria-label", t("copyBtn"));
reactionCopy.appendChild(tablerIcon("copy"));
reactionBar.appendChild(reactionCopy);

/** Lets a message be reacted to, named by `key` (G.reactionKey). A message
    with no name both sides share is left as it was. */
function markReactable(row, key) {
  if (!row || !key) return;
  row.dataset.reactKey = key;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "react-open";
  open.dataset.i18nAria = "react";
  open.setAttribute("aria-label", t("react"));
  open.appendChild(tablerIcon("mood-smile"));
  open.onclick = e => { e.stopPropagation(); openReactionBar(row); };
  row.appendChild(open);
}

/** The newest message of `who`'s with this name. (A guest who opens the same
    invite again starts counting afresh; the newest is the one meant.) */
function findReactRow(who, key) {
  const rows = chatMessages.querySelectorAll(`.bubble-row.${who}[data-react-key="${CSS.escape(key)}"]`);
  return rows.length ? rows[rows.length - 1] : null;
}

/** A text message's words, for Copy; nothing for a picture or a file. */
function reactRowText(row) {
  const bubble = row.querySelector(".bubble");
  return String(row.dataset.reactKey || "").startsWith("t:") && bubble ? bubble.textContent : "";
}

/** The badge under a message: theirs and yours (G.reactionBadge). */
function drawReactions(row) {
  const shown = G.reactionBadge(row.dataset.reactMine || "", row.dataset.reactTheirs || "");
  let badge = row.querySelector(".reactions");
  if (!shown.length) { if (badge) badge.remove(); return; }
  if (!badge) {
    badge = document.createElement("button");
    badge.type = "button";
    badge.className = "reactions";
    badge.onclick = e => { e.stopPropagation(); openReactionBar(row); };
    row.querySelector(".bubble").after(badge);
  }
  badge.textContent = shown.map(s => (s.count > 1 ? `${s.emoji} ${s.count}` : s.emoji)).join(" ");
  badge.classList.toggle("mine", Boolean(row.dataset.reactMine));
}

function openReactionBar(row) {
  reactingTo = row;
  const mine = row.dataset.reactMine || "";
  for (const choice of reactionBar.querySelectorAll(".reaction-choice")) {
    choice.classList.toggle("chosen", choice.dataset.emoji === mine);
  }
  reactionCopy.classList.toggle("hidden", !reactRowText(row));
  reactionBar.classList.remove("hidden");
  /* Over the message, or under it if there is no room above; inside the chat. */
  const area = chatScreen.getBoundingClientRect();
  const box  = (row.querySelector(".bubble") || row).getBoundingClientRect();
  const w = reactionBar.offsetWidth, h = reactionBar.offsetHeight;
  let top = box.top - area.top - h - 6;
  if (top < 70) top = box.bottom - area.top + 6;
  const left = (row.classList.contains("me") ? box.right - w : box.left) - area.left;
  reactionBar.style.left = `${Math.max(8, Math.min(left, area.width - w - 8))}px`;
  reactionBar.style.top  = `${top}px`;
}

function closeReactionBar() {
  if (!reactingTo) return;
  reactingTo = null;
  reactionBar.classList.add("hidden");
}

/** Gives a reaction — or, picked again, takes it back — and tells the other side. */
async function react(row, picked) {
  if (!dcReady() || !e2eReady) { showToast(t("messageNotSent"), "warn"); return; }
  const emoji = G.nextReaction(row.dataset.reactMine || "", picked);
  const sent = await dcSendE2e({ type: "reaction", key: row.dataset.reactKey, mine: row.classList.contains("me"), emoji })
    .catch(() => false);
  if (!sent) { showToast(t("messageNotSent"), "warn"); return; }
  row.dataset.reactMine = emoji;
  drawReactions(row);
}

/** The other side's reaction arrived — on its message or yours. */
function receiveReaction(data) {
  if (!G.reactionValid(data)) return;
  const row = findReactRow(data.mine ? "peer" : "me", data.key);
  if (!row) return;
  row.dataset.reactTheirs = data.emoji;
  drawReactions(row);
  if (data.emoji && !data.mine) {
    announce(I18N[LANG].srReaction(data.emoji));
    noticeArrival();
  }
}

function copyMessage(row) {
  const text = reactRowText(row);
  if (!text) return;
  const done = () => showToast(t("copiedBtn"), "info");
  navigator.clipboard.writeText(text).then(done).catch(() => {
    const field = document.createElement("textarea");
    field.value = text;
    document.body.appendChild(field);
    field.select();
    document.execCommand("copy");
    field.remove();
    done();
  });
}

reactionBar.addEventListener("click", e => {
  const button = e.target.closest("button");
  const row = reactingTo;
  if (!button || !row) return;
  closeReactionBar();
  if (button === reactionCopy) copyMessage(row);
  else react(row, button.dataset.emoji);
});

/* A mouse: right-click a message — the bar, in place of the browser's menu. */
chatMessages.addEventListener("contextmenu", e => {
  const row = e.target.closest(".bubble-row[data-react-key]");
  if (!row) return;
  e.preventDefault();
  if (reactingTo !== row) openReactionBar(row);
});

/* A finger: held still on a message. */
function cancelPress() {
  clearTimeout(pressTimer);
  pressTimer = null;
}
chatMessages.addEventListener("pointerdown", e => {
  if (e.pointerType === "mouse") return;
  const row = e.target.closest(".bubble-row[data-react-key]");
  if (!row || e.target.closest(".react-open, .reactions")) return;
  cancelPress();
  pressStart = { x: e.clientX, y: e.clientY };
  pressTimer = setTimeout(() => { pressTimer = null; swallowClick = row; openReactionBar(row); }, LONG_PRESS_MS);
});
chatMessages.addEventListener("pointermove", e => {
  if (pressTimer && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) cancelPress();
});
chatMessages.addEventListener("pointerup", cancelPress);
chatMessages.addEventListener("pointercancel", cancelPress);
/* The finger lifting after a hold is not a tap: it does not open the picture
   or follow the link it was held on. Caught on the way down, before them. */
chatMessages.addEventListener("click", e => {
  const used = swallowClick;
  swallowClick = null;
  if (used && e.target.closest(".bubble-row") === used) { e.preventDefault(); e.stopPropagation(); }
}, true);

/* Closed by a touch anywhere else, Esc, or the chat moving under it. */
document.addEventListener("pointerdown", e => {
  if (reactingTo && !reactionBar.contains(e.target)) closeReactionBar();
}, true);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeReactionBar(); });
chatMessages.addEventListener("scroll", closeReactionBar);

/* ══════════════════════════════════════════════
   BUBBLE RENDERERS
══════════════════════════════════════════════ */

/** A message's words, its web addresses made links (G.splitLinks) that open in
    a new tab, so the chat stays where it is. A web address used to be plain
    text, to be copied out by hand. Built from text and <a> alone, never from
    markup: nothing in a message can become anything but words or an http(s)
    link. Each link says where it really goes when pointed at. */
function fillMessage(el, text) {
  const parts = G.splitLinks(text);
  if (!parts.some(part => part.href)) { el.textContent = text; return; }
  for (const part of parts) {
    if (!part.href) { el.appendChild(document.createTextNode(part.text)); continue; }
    const link = document.createElement("a");
    link.href = part.href;
    link.textContent = part.text;
    link.title = part.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    el.appendChild(link);
  }
}

function appendBubble(who, text) {
  const row    = document.createElement("div");
  row.className = `bubble-row ${who}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  fillMessage(bubble, text);
  row.appendChild(bubble);
  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = now();
  row.appendChild(meta);
  chatMessages.appendChild(row);
  scrollBottom(who === "me");       // what you sent, you see; theirs waits if you are reading
  if (who === "peer") { announce(`${t("srNewMessage")}: ${text}`); noticeArrival(); }
  return row;
}

function resolveImageNow(who, url, name) {
  const row    = document.createElement("div");
  row.className = `bubble-row ${who}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const img = document.createElement("img");
  img.src = url; img.alt = name;
  img.onclick = () => openImageViewer(url, name);
  bubble.appendChild(img);
  row.appendChild(bubble);
  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = now();
  row.appendChild(meta);
  chatMessages.appendChild(row);
  scrollBottom(who === "me");
}

/** A voice note's player. One this browser cannot play — a note from a
    browser that records in a format this one does not know — becomes a line
    saying so, with a way to save it, rather than a player saying "Error". */
function voicePlayer(url, name) {
  const audio = document.createElement("audio");
  audio.src = url; audio.controls = true;
  audio.onerror = () => {
    const link = document.createElement("a");
    link.href = url;
    link.download = name || "voice";
    link.textContent = `⚠️ ${t("voiceCantPlay")}`;
    audio.replaceWith(link);
  };
  return audio;
}

function resolveVoiceNow(who, url, name) {
  const row    = document.createElement("div");
  row.className = `bubble-row ${who}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const wrap = document.createElement("div");
  wrap.className = "voice-bubble";
  wrap.appendChild(tablerIcon("microphone", 18, "var(--accent-text)"));
  wrap.appendChild(voicePlayer(url, name));
  bubble.appendChild(wrap);
  row.appendChild(bubble);
  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = now();
  row.appendChild(meta);
  chatMessages.appendChild(row);
  scrollBottom(who === "me");
}

function appendImagePlaceholder(who, id, name) {
  const row    = document.createElement("div");
  row.className = `bubble-row ${who}`;
  row.dataset.tid = id;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const label = document.createElement("div");
  label.className = "transfer-pending";
  label.style.cssText = "color:var(--muted);font-size:13px";
  label.textContent = `🖼️ ${name || t("image")} — ${t("receiving")}`;
  bubble.appendChild(label);
  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = now();
  bubble.appendChild(meta);
  row.appendChild(bubble);
  chatMessages.appendChild(row);
  scrollBottom();
}

function resolveImagePlaceholder(id, url, name) {
  const row = findTransferRow(id);
  if (!row) return;
  const bubble = row.querySelector(".bubble");
  const img = document.createElement("img");
  /* Opening it full size is offered only once it has drawn as a picture. One
     that will not draw — a HEIC photo outside Safari, or bytes that are no
     picture at all — is offered as a download instead of a broken image. */
  img.onload  = () => { img.onclick = () => openImageViewer(url, name); };
  img.onerror = () => {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.textContent = `🖼️ ${name || t("image")} — ${t("download")}`;
    img.replaceWith(link);
  };
  img.src = url; img.alt = name;
  bubble.replaceChildren(img);
  let meta = row.querySelector(".bubble-meta");
  if (!meta) { meta = document.createElement("div"); meta.className = "bubble-meta"; row.appendChild(meta); }
  meta.textContent = now();
  scrollBottom();
}

function appendFileBubble(who, url, name, size, id) {
  const row    = document.createElement("div");
  row.className = `bubble-row ${who}`;
  if (id) row.dataset.tid = id;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const fileBubble = document.createElement("div");
  fileBubble.className = "file-bubble";
  const icon = document.createElement("div");
  icon.className = "file-icon";
  icon.appendChild(tablerIcon("file", 22));
  const info = document.createElement("div");
  const fileName = document.createElement("div");
  fileName.className = "file-name";
  fileName.textContent = name;
  const fileSize = document.createElement("div");
  fileSize.className = "file-size";
  fileSize.textContent = fmtBytes(size);
  info.append(fileName, fileSize);
  if (url) {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.textContent = t("download");
    info.appendChild(link);
  } else {
    const pending = document.createElement("span");
    pending.className = "file-pending transfer-pending";
    pending.style.cssText = "color:var(--muted);font-size:12px";
    pending.textContent = t("receiving");
    info.appendChild(pending);
  }
  fileBubble.append(icon, info);
  bubble.appendChild(fileBubble);
  row.appendChild(bubble);
  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = now();
  row.appendChild(meta);
  chatMessages.appendChild(row);
  scrollBottom(who === "me");
}

function resolveFileBubble(id, url, name) {
  const row = findTransferRow(id);
  if (!row) return;
  const pending = row.querySelector(".file-pending");
  if (pending) {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.textContent = t("download");
    pending.replaceWith(link);
  }
}

function appendVoicePlaceholder(who, id) {
  const row    = document.createElement("div");
  row.className = `bubble-row ${who}`;
  row.dataset.tid = id;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const vb = document.createElement("div");
  vb.className = "voice-bubble";
  const mic = document.createElement("span");
  mic.textContent = "🎤";
  const pending = document.createElement("span");
  pending.className = "transfer-pending";
  pending.style.cssText = "color:var(--muted);font-size:12px";
  pending.textContent = t("receiving");
  vb.append(mic, pending);
  bubble.appendChild(vb);
  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = now();
  bubble.appendChild(meta);
  row.appendChild(bubble);
  chatMessages.appendChild(row);
  scrollBottom();
}

function resolveVoicePlaceholder(id, url, name) {
  const row = findTransferRow(id);
  if (!row) return;
  const vb = row.querySelector(".voice-bubble");
  if (!vb) return;
  const mic = document.createElement("span");
  mic.textContent = "🎤";
  vb.replaceChildren(mic, voicePlayer(url, name));
  scrollBottom();
}

function appendSys(text) {
  const el = document.createElement("div");
  el.className = "sys-msg";
  el.textContent = text;
  chatMessages.appendChild(el);
  scrollBottom();
  announce(text);
}

function addAckTick(row, msgId) {
  let meta = row.querySelector(".bubble-meta");
  if (!meta) {
    meta = document.createElement("div");
    meta.className = "bubble-meta";
    row.appendChild(meta);
  }
  const tick = document.createElement("span");
  tick.className = "ack-tick sent";
  tick.textContent = "✓";
  tick.dataset.msgId = msgId;
  meta.appendChild(tick);
}

function markDelivered(row) {
  const tick = row.querySelector(".ack-tick");
  if (tick) { tick.className = "ack-tick delivered"; tick.textContent = "✓✓"; }
}

function now() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* ── Reading older messages ─────────────────
   Every arrival scrolled the chat to the bottom, even while someone had
   scrolled up to read something earlier: it was pulled away from under them.
   Now the chat stays put while they read, and a "↓ New messages" button over
   the message box says something came; it takes them down. Their own
   messages still go to the bottom (`force`) — they want to see what they
   sent. Reaching the bottom by hand puts the button away too (the scroll
   listener, beside fitToVisibleArea). */
function scrollBottom(force = false) {
  if (force || _stickToBottom) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
    _stickToBottom = true;
    newMessagesBtn.classList.add("hidden");
    return;
  }
  newMessagesBtn.classList.remove("hidden");
}
newMessagesBtn.onclick = () => scrollBottom(true);

/* ══════════════════════════════════════════════
   LEAVE A MESSAGE
══════════════════════════════════════════════ */

leaveFileBtn.onclick = () => leaveFile.click();

leaveFile.onchange = () => {
  const f = leaveFile.files[0];
  const mb = leaveAttachMaxMbRounded();
  if (f && f.size > maxLeaveAttachBytes) {
    setLeaveStatus(I18N[LANG].leaveFileTooBig(mb), "err");
    leaveFile.value = "";
    leaveFileName.textContent = "";
    const span = leaveFileBtn.querySelector("span[data-i18n]");
    if (span) span.textContent = t("attachFile");
    return;
  }
  leaveFileName.textContent = f ? `${f.name} (${fmtBytes(f.size)})` : "";
  // Update the text span inside leaveFileBtn
  const span = leaveFileBtn.querySelector("span[data-i18n]");
  if (span) span.textContent = f ? t("changeFile") : t("attachFile");
};

leaveSendBtn.onclick = async () => {
  const msg = leaveMessage.value.trim();
  if (!msg) { setLeaveStatus(t("writeFirst"), "err"); return; }
  const lf = leaveFile.files[0];
  const mb = leaveAttachMaxMbRounded();
  if (lf && lf.size > maxLeaveAttachBytes) {
    setLeaveStatus(I18N[LANG].leaveFileTooBig(mb), "err");
    return;
  }
  leaveSendBtn.disabled = true;
  setLeaveStatus(t("sending"), "sending");

  const fd = new FormData();
  fd.append("message", msg);
  fd.append("name", senderName.value.trim());
  if (lf) fd.append("file", lf);

  try {
    const res  = await fetch(`${SERVER_URL}/api/send-message`, {
      method: "POST",
      headers: { "X-DC-Client": "1" },
      body: fd
    });
    /* Turned away because other messages were being sent at that moment —
       said in the user's language, not the server's English. */
    if (res.status === 503) { setLeaveStatus(t("emailBusy"), "err"); return; }
    const json = await res.json();
    if (res.ok && json.ok) {
      setLeaveStatus(t("msgSent"), "ok");
      leaveMessage.value = "";
      senderName.value   = "";
      leaveFile.value    = "";
      leaveFileName.textContent = "";
      const span = leaveFileBtn.querySelector("span[data-i18n]");
      if (span) span.textContent = t("attachFile");
    } else {
      setLeaveStatus(leaveErrorText(json), "err");
    }
  } catch (_) {
    setLeaveStatus(t("networkErr"), "err");
  } finally {
    leaveSendBtn.disabled = false;
  }
};

/** Why a message was not sent, in the user's language. The server's words
    were English, and one of them passed on whatever the mail service said. */
function leaveErrorText(json) {
  const code = json && json.code;
  if (code === "rate-limited")     return I18N[LANG].emailRateLimited(Number(json.remaining) || 60);
  if (code === "message-too-long") return I18N[LANG].emailTooLong(Number(json.max) || 5000);
  if (code === "file-too-large")   return I18N[LANG].leaveFileTooBig(Number(json.maxMb) || leaveAttachMaxMbRounded());
  if (code === "message-required") return t("writeFirst");
  if (code === "not-configured")   return t("emailUnavailable");
  return t("emailFailed");
}

function setLeaveStatus(text, type) {
  leaveStatus.textContent = text;
  leaveStatus.className   = "leave-status " + type;
}

/* ══════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════ */

function dcReady() {
  return dataChannel && dataChannel.readyState === "open";
}

function dcSend(obj) {
  if (dcReady()) dataChannel.send(JSON.stringify(obj));
}
