/*
  Source-level checks on app.js.

  app.js needs a browser and two peers to run, so these read it as text rather
  than executing it. That is a weaker guarantee than a runtime test, and the
  split is deliberate:

    guards.js + connstats.js hold the decisions, and their own tests prove the
    answers are right — every combination, with no browser involved.

    These tests prove app.js actually ASKS, and asks at the right moment. A
    correct guard that nothing calls is worth nothing, and no test of guards.js
    could ever notice.

  What remains here is what cannot be extracted: that outgoing messages go
  through wsSend, that none of them carries the room secret, that call signaling
  never touches the WebSocket, and that a peer-chosen transfer id reaches a
  selector through exactly one escaped helper.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

/** Comments mention the same identifiers as the code, which throws off any
    check about ordering — strip them before reasoning about statements. */
function withoutComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Top-level function declarations, by name. Bodies end at a closing brace in
    column 0, which is how every function in app.js is written. */
function topLevelFunctions(src) {
  const found = new Map();
  for (const m of src.matchAll(/^(?:async\s+)?function (\w+)\s*\([^)]*\)\s*\{[\s\S]*?^\}/gm)) {
    found.set(m[1], m[0]);
  }
  return found;
}

/** Every `wsSend({ ... })` literal in app.js. Payloads here are flat objects. */
function wsSendPayloads() {
  return Array.from(appSrc.matchAll(/wsSend\(\s*\{[^}]*\}/g)).map(m => m[0]);
}

test("app.js does send messages through wsSend", () => {
  /* Guards the checks below: if the call shape changes, they would silently
     pass by matching nothing at all. */
  assert.ok(wsSendPayloads().length >= 5, "expected several wsSend call sites");
});

test("no wsSend payload mentions a secret", () => {
  /* The realistic regression: someone adds the room secret to an outgoing
     message. See README, "Invite links" — only sessionId and token may go
     over the WebSocket. */
  for (const payload of wsSendPayloads()) {
    assert.ok(!/secret/i.test(payload), `wsSend payload references a secret:\n${payload}`);
  }
});

test("join-session sends only the fields the server needs", () => {
  const joins = wsSendPayloads().filter(p => p.includes("join-session"));
  assert.ok(joins.length > 0, "expected at least one join-session send");
  /* `visible` is whether the page is on screen — a copy of a link may take a
     seat from another only then. A yes or a no, nothing of the room's. */
  const allowed = new Set(["type", "sessionId", "pin", "token", "visible"]);
  for (const payload of joins) {
    for (const [, key] of payload.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) {
      assert.ok(allowed.has(key), `join-session must not carry "${key}":\n${payload}`);
    }
    const visible = payload.match(/visible:\s*([^,}]+)/);
    if (visible) assert.equal(visible[1].trim(), 'document.visibilityState === "visible"', "visible must be the page's own visibility and nothing else");
  }
});

test("wsSend runs the leak guard before sending", () => {
  /* Cheap structural check that the guard was not removed or moved below the
     send. Its behaviour is covered in protocol.test.js. */
  const body = appSrc.match(/function wsSend\(obj\)\s*\{[\s\S]*?\n\}/);
  assert.ok(body, "wsSend not found");
  assert.ok(body[0].includes("payloadLeaksSecret"), "wsSend no longer calls the guard");
  assert.ok(
    body[0].indexOf("payloadLeaksSecret") < body[0].indexOf("ws.send"),
    "the guard must run before the message goes out");
});

test("the guard covers every variable a room secret can live in", () => {
  /* join-session is sent while the secret is still in pendingRoomSecret;
     roomSecret is not assigned until the server confirms. Checking only
     roomSecret would leave the guard inert during that very message. */
  const holders = Array.from(appSrc.matchAll(/^let (roomSecret|pendingRoomSecret)\b/gm))
    .map(m => m[1]);
  assert.deepEqual(new Set(holders), new Set(["roomSecret", "pendingRoomSecret"]),
    "a secret-holding variable was added or renamed — update roomSecretsInPlay()");

  const guarded = appSrc.match(/function roomSecretsInPlay\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(guarded, "roomSecretsInPlay not found");
  for (const holder of [...holders, "_autoSecret"]) {
    assert.ok(guarded[0].includes(holder), `roomSecretsInPlay omits ${holder}`);
  }
});

test("every path to the camera asks the guard first", () => {
  /* attachCallMedia() calls getUserMedia. Whether the answer is right is
     guards.test.js's job — this checks only that app.js asks, and asks before
     capturing, which no amount of testing guards.js could establish.

     Written against whichever functions reach attachCallMedia rather than a
     fixed pair of names: the guard was added to one of the two doors first and
     the other went unnoticed for a release. A third door must not be able to. */
  const reaching = Array.from(topLevelFunctions(withoutComments(appSrc)))
    .filter(([name, body]) => name !== "attachCallMedia" && body.includes("attachCallMedia("));

  assert.ok(reaching.length >= 2,
    `expected the call-offer and call-accept paths, found ${reaching.length}`);

  for (const [name, body] of reaching) {
    assert.ok(body.includes("mayCaptureForCall("), `${name} does not ask mayCaptureForCall`);
    assert.ok(
      body.indexOf("mayCaptureForCall(") < body.indexOf("attachCallMedia("),
      `${name} must ask before capturing, not after`);
  }
});

test("every function that opens the camera or microphone itself asks first", () => {
  /* The test above follows attachCallMedia. Three other doors open a device
     directly — the voice-note recorder, the restart after a lock, the camera
     flip — and a fourth must not be able to open one without asking. Each
     has its own question, and every one of them starts from mayCaptureForCall
     or the recorder's own lock. */
  const opening = Array.from(topLevelFunctions(withoutComments(appSrc)))
    .filter(([name, body]) => name !== "attachCallMedia" && body.includes("getUserMedia("));
  assert.ok(opening.length >= 3, `expected the recorder, the restart and the flip, found ${opening.map(([n]) => n).join(", ")}`);
  const asks = /\b(?:G\.)?(?:mayCaptureForCall|mayFlipCamera|mayMoveMic|tracksToRestart|mayStartRecording)\(/;
  for (const [name, body] of opening) {
    const m = body.match(asks);
    assert.ok(m, `${name} opens a device without asking a guard`);
    assert.ok(m.index < body.indexOf("getUserMedia("), `${name} must ask before opening, not after`);
  }
});

test("a call that cannot be set up tells the other side", () => {
  /* Every path that opens the camera or takes the other side's description can
     fail — a refused permission, a camera another app holds. Those paths used
     to end the call with endCall(false): this side went back to the chat and
     the other side was never told, left on a dark "Connecting…" screen.

     Found by what they do rather than by name, like the camera test above. */
  const fns = topLevelFunctions(withoutComments(appSrc));
  /* A fresh route for a call already going (call-restart) is not setting one
     up: a failed attempt must not end the call — the recovery tries again,
     and ends it, telling the other side, only once it gives up. Checked on
     its own below. */
  const restarting = new Set(["handleCallRestart", "handleCallRestartAnswer"]);
  const settingUp = Array.from(fns)
    .filter(([name, body]) => name !== "attachCallMedia" && !restarting.has(name) &&
      (body.includes("attachCallMedia(") || body.includes("callPc.setRemoteDescription(")));
  for (const name of restarting) {
    const body = fns.get(name);
    assert.ok(body, `${name} not found`);
    assert.ok(!/endCall\(/.test(body), `${name}: a failed fresh route must leave the call to the recovery, not end it`);
    assert.ok(body.indexOf("try {") < body.indexOf("setRemoteDescription("), `${name} takes a description outside its try`);
  }
  assert.match(fns.get("stepCallRecovery"), /if \(action === "give-up"\) \{\s*\n\s*stopCallRecovery\(\);\s*\n\s*endCall\(true\);/,
    "giving up tells the other side");

  assert.ok(settingUp.length >= 3,
    `expected the offer, the answer and the accepted answer, found ${settingUp.map(([n]) => n).join(", ")}`);

  for (const [name, body] of settingUp) {
    assert.ok(body.includes("callSetupFailed("), `${name} must hand its failure to callSetupFailed`);
    assert.ok(!body.includes("endCall(false)"), `${name} ends the call without telling the other side`);
    assert.ok(body.indexOf("try {") < body.indexOf("callPc.setRemoteDescription(") ||
              !body.includes("callPc.setRemoteDescription("),
      `${name} takes a description outside its try — a failure there is never handled`);
  }
});

test("callSetupFailed tells the other side only while the call is still on", () => {
  /* Run, not read: the two halves pull opposite ways. Hung up while the camera
     was opening, the call must still be ended — that is what turns the camera
     back off — but a second "call ended" must not be sent. */
  const src = topLevelFunctions(appSrc).get("callSetupFailed");
  assert.ok(src, "callSetupFailed not found");

  const run = inCall => {
    const did = { endCall: [], sys: [] };
    new Function("inCall", "endCall", "appendSys", "I18N", "LANG", "console", `${src}\ncallSetupFailed("x", new Error("no camera"));`)(
      inCall, notify => did.endCall.push(notify), line => did.sys.push(line),
      { en: { sysCallFailed: msg => `failed: ${msg}` } }, "en", { error() {} });
    return did;
  };

  assert.deepEqual(run(true),  { endCall: [true],  sys: ["failed: no camera"] }, "still on: end it, tell them, say why");
  assert.deepEqual(run(false), { endCall: [false], sys: [] }, "already over: release the camera, say nothing more");
});

test("the peer cannot add video to a call the user asked to keep voice-only", () => {
  /* withVideo rides in on the peer's messages; pendingCallVideo is what the
     user actually pressed. Answering a voice call with withVideo:true would
     otherwise switch the camera on. */
  const fns = topLevelFunctions(withoutComments(appSrc));
  for (const name of ["initiateCallOffer", "handleIncomingCallOffer"]) {
    const body = fns.get(name);
    assert.ok(body, `${name} not found`);
    assert.ok(body.includes("consentedVideo("),
      `${name} must gate video on what the user agreed to, not on the peer's flag`);
  }
  const helper = fns.get("consentedVideo");
  assert.ok(helper, "consentedVideo not found");
  assert.ok(helper.includes("pendingCallVideo"), "consentedVideo must read the user's choice");
});

test("an incoming text message is put to the guard", () => {
  /* What counts as displayable is guards.test.js's job. Two things it cannot
     see are checked here: that handleTextMessage consults the guard at all, and
     that no plaintext body is read anywhere in it — a fallback would undo
     failing closed, letting a middleman caught swapping keys still write into
     the chat window. */
  const handler = topLevelFunctions(withoutComments(appSrc)).get("handleTextMessage");
  assert.ok(handler, "handleTextMessage not found");
  assert.ok(!/data\.text\b/.test(handler),
    "handleTextMessage must not render an unencrypted message body");
  assert.ok(handler.includes("mayRenderText("),
    "the text case must ask the guard rather than deciding inline");
});

test("transfer ids reach a selector through exactly one escaped helper", () => {
  /* The id comes from transfer-meta, so the peer picks it. Unescaped it can
     break the selector or steer it at another message's bubble. */
  const builders = Array.from(appSrc.matchAll(/\[data-tid="\$\{([^}]*)\}"\]/g))
    .map(m => m[1]);
  assert.equal(builders.length, 1,
    `expected one place building this selector, found ${builders.length} — route them through findTransferRow()`);
  assert.ok(/CSS\.escape/.test(builders[0]), "the selector must escape the id");
});

test("call signaling never goes over the WebSocket", () => {
  /* Accepting call offers from the signaling server would let it start
     getUserMedia without the peer asking; sending them there would expose the
     call setup it is not meant to see. Both directions must stay on the
     encrypted data channel. */
  for (const payload of wsSendPayloads()) {
    assert.ok(!/["']call-/.test(payload), `call signaling must not use wsSend:\n${payload}`);
  }
  const signalingHandler = appSrc.match(/async function handleSignaling\(data\)[\s\S]*?\n\}/);
  assert.ok(signalingHandler, "handleSignaling not found");
  assert.ok(
    !/case\s+"call-(offer|answer|ice)"/.test(signalingHandler[0]),
    "handleSignaling must not accept call signaling from the WebSocket");
});

test("only what came out of the envelope is ever marked sealed", () => {
  /* mayHandleFrame trusts its `sealed` argument completely, so the whole rule
     rests on who is able to pass true. Exactly one call may: the one fed by
     e2eDecrypt. The raw channel handler must never pass anything. */
  const src = withoutComments(appSrc);

  const sealedCalls = Array.from(src.matchAll(/handleTextMessage\([^\n]*,\s*true\s*\)/g));
  assert.equal(sealedCalls.length, 1, `expected one sealed call site, found ${sealedCalls.length}`);
  const leadUp = src.slice(Math.max(0, sealedCalls[0].index - 400), sealedCalls[0].index);
  assert.ok(/e2eDecrypt\(/.test(leadUp), "the sealed call must be the one the envelope's decryption feeds");
  /* And only once its number is taken: a copy delivered again is not handled. */
  assert.ok(/DC\.takeSeal\(e2eRecvSeen, data\.n\)[^\n]*return;/.test(leadUp.slice(leadUp.lastIndexOf("e2eDecrypt("))),
    "the envelope must pass the replay check before it is handled");

  const onmessage = src.match(/dataChannel\.onmessage\s*=[\s\S]*?\n  \};/);
  assert.ok(onmessage, "dataChannel.onmessage not found");
  assert.ok(onmessage[0].includes("handleTextMessage("), "raw frames no longer reach handleTextMessage");
  assert.ok(!/handleTextMessage\([^\n]*,/.test(onmessage[0]),
    "a frame straight off the channel must never be passed as sealed");
});

test("handleTextMessage asks the guard before acting on any message", () => {
  const handler = topLevelFunctions(withoutComments(appSrc)).get("handleTextMessage");
  assert.ok(handler, "handleTextMessage not found");
  assert.ok(handler.includes("mayHandleFrame("), "handleTextMessage must ask whether a frame may be handled");
  assert.ok(handler.indexOf("mayHandleFrame(") < handler.indexOf("switch ("),
    "the check must come before the dispatch, not inside one case of it");
});

test("what the app sends in the clear is what it accepts in the clear", () => {
  /* The list in guards.js and the senders here have to agree in both
     directions. A type sent clear but not listed is silently dropped by the
     other side; a type sent sealed but listed is a hole left open for nothing. */
  const { CLEAR_TYPES } = require("../guards.js");
  const src = withoutComments(appSrc);

  const clearSent  = new Set(Array.from(
    src.matchAll(/(?:\bdcSend|dataChannel\.send)\(\s*(?:JSON\.stringify\(\s*)?\{\s*type:\s*"([^"]+)"/g)).map(m => m[1]));
  const sealedSent = new Set(Array.from(
    src.matchAll(/(?:dcSendE2e|dcSendCallSignal)\(\s*\{\s*type:\s*"([^"]+)"/g)).map(m => m[1]));

  /* Guards the two checks below against matching nothing at all. */
  assert.ok(clearSent.size >= 5,  `expected several clear sends, found ${[...clearSent]}`);
  assert.ok(sealedSent.size >= 8, `expected the transfer and call types, found ${[...sealedSent]}`);

  for (const type of clearSent) {
    assert.ok(CLEAR_TYPES.includes(type), `"${type}" is sent in the clear but the peer would refuse it`);
  }
  for (const type of sealedSent) {
    assert.ok(!CLEAR_TYPES.includes(type), `"${type}" is always sent sealed, so it must not be accepted in the clear`);
  }
});

test("the record button asks before opening the microphone, and again once it is open", () => {
  /* Two gaps, one on each side of the await. Before: a double-click opened two
     streams and only one could ever be stopped. After: the room could end
     while the permission prompt was up, and the microphone came on anyway. */
  const fn = topLevelFunctions(withoutComments(appSrc)).get("toggleVoiceRecord");
  assert.ok(fn, "toggleVoiceRecord not found");
  const opens = fn.indexOf("getUserMedia(");
  assert.ok(opens > -1, "toggleVoiceRecord no longer opens the microphone itself — update this test");

  assert.ok(fn.includes("mayStartRecording("), "a press must ask whether it may open the microphone");
  assert.ok(fn.indexOf("mayStartRecording(") < opens, "that question must come before opening, not after");
  assert.ok(fn.indexOf("mayKeepMicOpen(") > opens, "the room must be checked again once the microphone has opened");
  assert.ok(/finally\s*\{\s*voiceOpening\s*=\s*false/.test(fn),
    "the opening flag must clear on every exit, or one refused permission leaves the button dead");
});

test("the PIN dialog always opens with a working Join button", () => {
  /* Join was only re-enabled after a refusal, so one successful join left it
     disabled for every room after. */
  const fns = topLevelFunctions(withoutComments(appSrc));
  assert.ok(fns.get("settlePinJoin"), "settlePinJoin not found");
  assert.ok(/pinJoinBtn\.disabled\s*=\s*false/.test(fns.get("settlePinJoin")), "settlePinJoin must re-enable Join");
  assert.ok(fns.get("openPinModal").includes("settlePinJoin("), "opening the dialog must re-arm its button");

  const joined = withoutComments(appSrc).match(/case "session-joined":[\s\S]*?break;/);
  assert.ok(joined && joined[0].includes("settlePinJoin("), "a successful join must settle the dialog too");
});

test("server news about a room is checked against the room on screen", () => {
  /* These messages used to name no room. The handler assumed the current one,
     so an abandoned room expiring closed the chat in a different one. */
  const handler = appSrc.match(/async function handleSignaling\(data\)[\s\S]*?\n\}/);
  assert.ok(handler, "handleSignaling not found");
  const body = withoutComments(handler[0]);

  for (const type of ["guest-joined", "peer-disconnected", "session-expired"]) {
    const branch = body.match(new RegExp(`case "${type}":[\\s\\S]*?break;`));
    assert.ok(branch, `no ${type} case in handleSignaling`);
    assert.ok(branch[0].includes("roomEventIsOurs("), `${type} must check which room it is about before acting`);
  }
  const helper = topLevelFunctions(withoutComments(appSrc)).get("roomEventIsOurs");
  assert.ok(helper && helper.includes("mayApplyRoomEvent("), "roomEventIsOurs must ask the guard");
});

/* ── The shield ──────────────────────────────
   The shield in the chat header is the only standing sign of whether anyone
   has checked a chat for a middleman. It replaced a full-width banner, so the
   checks below are about it not going quiet or lying. */

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const styleSrc = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

test("the shield's state comes from the guard, not from app.js", () => {
  const fn = topLevelFunctions(withoutComments(appSrc)).get("updateShield");
  assert.ok(fn, "updateShield not found");
  assert.ok(fn.includes("shieldState("), "updateShield must ask guards.js what the shield should say");
  for (const input of ["e2eReady", "e2eSecureMode", "e2eVerified"]) {
    assert.ok(fn.includes(input), `updateShield must pass ${input} to the guard`);
  }
});

test("every change to the verification state redraws the shield", () => {
  /* There is no banner behind it any more. A path that changes the state
     without coming through here leaves the old colour on screen. */
  const src = withoutComments(appSrc);
  const fns = topLevelFunctions(src);
  assert.ok(fns.get("updateKeyVerifyUi").includes("updateShield("), "updateKeyVerifyUi must redraw the shield");

  /* Typing the code is the one change made outside updateKeyVerifyUi. */
  const typing = src.match(/keyVerifyInput\.addEventListener\("input"[\s\S]*?\n  \}\);/);
  assert.ok(typing, "the verification-code input handler was not found");
  assert.ok(typing[0].includes("e2eVerified ="), "expected the handler to set e2eVerified — update this test if it moved");
  assert.ok(typing[0].includes("updateShield("), "typing the code must redraw the shield");

  for (const name of ["e2eActivate", "e2eFailClosed", "closePeerConnection", "e2eInit"]) {
    assert.ok(fns.get(name) && fns.get(name).includes("updateKeyVerifyUi("), `${name} changes the state and must redraw`);
  }
});

test("each shield state has its own glyph and its own label", () => {
  /* Colour cannot be the only difference: it is no use to someone who cannot
     tell amber from green, and a tick drawn in amber would say "checked". */
  const table = withoutComments(appSrc).match(/const SHIELD_LOOK = \{[\s\S]*?\n\};/);
  assert.ok(table, "SHIELD_LOOK not found");
  const icons = Array.from(table[0].matchAll(/icon:\s*"([^"]+)"/g)).map(m => m[1]);
  assert.equal(icons.length, 3, "expected idle, warn and ok");
  assert.equal(new Set(icons).size, 3, `two states share a glyph: ${icons}`);
  assert.ok(!/warn:\s*\{\s*icon:\s*"shield-check"/.test(table[0]), "the unverified state must not show a tick");

  const fn = topLevelFunctions(withoutComments(appSrc)).get("updateShield");
  assert.ok(fn.includes("aria-label"), "the state must be readable, not only visible");
});

test("the page starts with a plain shield, not a tick", () => {
  const icon = indexSrc.match(/<i id="keyVerifyIcon" class="([^"]*)"/);
  assert.ok(icon, "#keyVerifyIcon not found in index.html");
  assert.equal(icon[1], "ti ti-shield", "before anything is checked the shield must not claim a check");
});

test("the wide warning banner is gone, and nothing still expects it", () => {
  assert.ok(!/verifyBanner|verify-banner/.test(indexSrc), "index.html still has the banner");
  assert.ok(!/verifyBanner|verify-banner/.test(withoutComments(appSrc)), "app.js still refers to the banner");
  assert.ok(!/verify-banner/.test(styleSrc), "style.css still styles the banner");
});

test("amber and green are the shield's, and nothing overrides them", () => {
  assert.match(styleSrc, /\.key-verify\.verify-warn\s+summary\.icon-btn\s*\{\s*color:\s*var\(--orange\)/);
  assert.match(styleSrc, /\.key-verify\.verify-ok\s+summary\.icon-btn\s*\{\s*color:\s*var\(--green\)/);

  /* Opening the panel used to turn the shield green on its own — which would
     now read as "verified" on a chat nobody has checked. */
  const open = styleSrc.match(/\.key-verify\[open\]\s+summary\s*\{([^}]*)\}/);
  assert.ok(open, "the open-panel rule was not found");
  assert.ok(!/(^|[;\s])color\s*:/.test(open[1]), "an open panel must not recolour the shield");
});

/* ── What the chat says when a room connects ── */

test("joining a room writes one line in the chat, and only once the key is agreed", () => {
  /* Three lines used to appear on every join. One does now — "Connected" —
     and where it is written matters as much as how many: said when the channel
     opens, it would also be said about a chat that then fails the key check. */
  const src = withoutComments(appSrc);
  const fns = topLevelFunctions(src);

  const onopen = src.match(/dataChannel\.onopen\s*=[\s\S]*?\n  \};/);
  assert.ok(onopen, "dataChannel.onopen not found");
  assert.ok(!onopen[0].includes("appendSys("), "the channel opening must not announce anything by itself");

  const activate = fns.get("e2eActivate");
  assert.ok(activate, "e2eActivate not found");
  const said = Array.from(activate.matchAll(/appendSys\((.*?)\);/g)).map(m => m[1].trim());
  assert.deepEqual(said, ['t("sysConnected")'], "e2eActivate should say exactly one thing: connected");

  assert.equal((src.match(/"sysConnected"/g) || []).length, 1, "\"connected\" must have one source, or it gets said twice");
  assert.ok(!fns.get("e2eFailClosed").includes("sysConnected"), "a chat that failed the key check must never say connected");
});

test("the verification code is not written into the chat", () => {
  /* It lives in the shield's panel. Removed from the chat on request. */
  const src = withoutComments(appSrc);
  for (const call of src.matchAll(/appendSys\(([^;]*)\);/g)) {
    assert.ok(!/e2eVerifyCode/.test(call[1]), `a system message still carries the code: ${call[0]}`);
  }
});

test("failures are still reported in the chat", () => {
  /* Trimming the join messages must not have taken the warnings with them. */
  const fns = topLevelFunctions(withoutComments(appSrc));
  assert.ok(/appendSys\(t\("e2eMismatch"\)\)/.test(fns.get("e2eFailClosed")), "a failed key check must still say so");
  assert.ok(/appendSys\(t\("e2eFailed"\)\)/.test(fns.get("e2eDeriveKey")), "a failed key derivation must still say so");
  const signaling = withoutComments(appSrc).match(/async function handleSignaling\(data\)[\s\S]*?\n\}/)[0];
  assert.ok(/appendSys\(t\("sysPeerLeft"\)\)/.test(signaling), "the other side leaving must still say so");
});

/* ── Open rooms ───────────────────────────────
   A room created without a PIN lets in whoever taps it first. The checks
   below are about a room never being treated as open by accident. */

test("the lobby has a button for each kind of room", () => {
  assert.match(indexSrc, /<button id="createBtn"/, "the PIN-room button is missing");
  assert.match(indexSrc, /<button id="createOpenBtn"/, "the open-room button is missing");
  assert.match(indexSrc, /<button id="createCodeBtn"/, "the code-room button is missing");
  const src = withoutComments(appSrc);
  assert.match(src, /createBtn\.onclick\s*=\s*\(\)\s*=>\s*createRoom\("pin"\)/, "the PIN-room button must ask for a PIN room");
  assert.match(src, /createOpenBtn\.onclick\s*=\s*\(\)\s*=>\s*createRoom\("open"\)/, "the open-room button must ask for an open room");
  assert.match(src, /createCodeBtn\.onclick\s*=\s*\(\)\s*=>\s*createRoom\("code"\)/, "the code-room button must ask for a code room");
});

test("the two create buttons are only ever switched together", () => {
  /* One left enabled while the other waits lets a second create go out. */
  const src = withoutComments(appSrc);
  const helper = topLevelFunctions(src).get("setCreateButtons");
  assert.ok(helper, "setCreateButtons not found");
  assert.ok(helper.includes("createBtn.disabled") && helper.includes("createOpenBtn.disabled"));
  const outside = src.replace(helper, "");
  assert.ok(!/create(Open)?Btn\.disabled\s*=/.test(outside),
    "a create button is switched on its own somewhere — use setCreateButtons()");
});

test("a room is treated as open only on an explicit true", () => {
  /* An older server sends no flag, and anything else truthy is a mistake.
     Reading `if (open)` would skip the PIN dialog for a room that wants one. */
  const src = withoutComments(appSrc);
  /* Matched directly: topLevelFunctions() expects a closing brace in column 0,
     and the one-line function just above this one does not have it. */
  const list = (src.match(/function renderSessionList\(sessions\)\s*\{[\s\S]*?\n\}/) || [])[0];
  assert.ok(list, "renderSessionList not found");
  assert.ok(list.includes("open === true"), "the room list must compare the flag with true");
  assert.ok(list.includes("joinOpenRoom(") && list.includes("openPinModal("), "the list must offer both ways in");

  const created = src.match(/case "session-created": \{[\s\S]*?\n      break;/);
  assert.ok(created, "session-created case not found");
  assert.ok(created[0].includes("data.open === true"), "the host's own panel must compare the flag with true");
});

test("joining an open room sends its name and nothing else", () => {
  const fn = topLevelFunctions(withoutComments(appSrc)).get("joinOpenRoom");
  assert.ok(fn, "joinOpenRoom not found");
  assert.match(fn, /wsSend\(\{\s*type:\s*"join-session",\s*sessionId\s*\}\)/);
  assert.ok(fn.includes("pendingRoomSecret = null"),
    "an open join has no invite-link secret — a stale one must not be carried into it");
});

test("a refused join is routed by the guard", () => {
  const signaling = withoutComments(appSrc).match(/async function handleSignaling\(data\)[\s\S]*?\n\}/)[0];
  const refused = signaling.match(/case "pin-error": \{[\s\S]*?\n      break;/);
  assert.ok(refused, "pin-error case not found");
  assert.ok(refused[0].includes("joinRefusalTarget("), "the pin-error case must ask the guard where the reason goes");
  assert.ok(!/if \(_isAutoJoin\b/.test(refused[0]), "routing on how the page was opened is the bug the guard replaced");
});

/* ── Noticing an update ───────────────────────
   A page left open across an update kept running the old code. These check
   the pieces that let it find out and act — the decisions themselves are in
   build.test.js. */

test("a page introduces itself before it asks for anything", () => {
  /* The server tells an up-to-date page from an ancient one by whether hello
     came before the list request. Sent the other way round, every current page
     would be told to reload on every connection. */
  const src = withoutComments(appSrc);
  const onopen = src.match(/ws\.onopen\s*=[\s\S]*?\n  \};/);
  assert.ok(onopen, "ws.onopen not found");
  const hello = onopen[0].search(/wsSend\(\{\s*type:\s*"hello",\s*build:\s*APP_BUILD\s*\}\)/);
  const list  = onopen[0].indexOf("requestSessionList(");
  assert.ok(hello > -1, "ws.onopen must send hello with the page's build");
  assert.ok(list > -1 && hello < list, "hello must go out before the room list is requested");
});

test("the server's build is put to the guard, not acted on directly", () => {
  const src = withoutComments(appSrc);
  const signaling = src.match(/async function handleSignaling\(data\)[\s\S]*?\n\}/)[0];
  assert.match(signaling, /case "hello":\s*handleServerBuild\(data\.build\);/);

  const fn = topLevelFunctions(src).get("handleServerBuild");
  assert.ok(fn, "handleServerBuild not found");
  assert.ok(fn.includes("updateAction("), "the decision to reload belongs to guards.js");
  assert.ok(fn.includes("pageIsBusy()"), "it must know whether a reload would throw something away");
  assert.ok(fn.indexOf("updateAction(") < fn.indexOf("fetchNewPage("), "decide first, then act");
});

test("a reload never happens in the middle of a chat, a join, or a sentence", () => {
  const fn = topLevelFunctions(withoutComments(appSrc)).get("pageIsBusy");
  assert.ok(fn, "pageIsBusy not found");
  for (const sign of ["currentSession", "isConnecting", "pinJoinInFlight", "listJoinId", "leaveMessage.value", "sessionIdInput.value"]) {
    assert.ok(fn.includes(sign), `pageIsBusy must look at ${sign}`);
  }
});

test("an update that arrived during a chat is taken on leaving it", () => {
  const leave = withoutComments(appSrc).match(/leaveBtn\.onclick\s*=[\s\S]*?\n\};/);
  assert.ok(leave, "the leave handler was not found");
  assert.match(leave[0], /if \(updatePending\) fetchNewPage\(updatePending\);/);
});

test("a fresh page is always fetched under an address no cache has seen", () => {
  /* A plain reload can be answered from the same cache that held the stale
     page. The invite, if any, must ride along in the fragment and nowhere else. */
  const fn = topLevelFunctions(withoutComments(appSrc)).get("fetchNewPage");
  assert.ok(fn, "fetchNewPage not found");
  assert.match(fn, /location\.replace\(`\$\{location\.pathname\}\?r=\$\{encodeURIComponent\(build\)\}\$\{location\.hash\}`\)/);
  assert.ok(!/location\.reload\(/.test(withoutComments(appSrc)), "location.reload() can hand back the cached page — use fetchNewPage()");
});

/* ── The facts in the shield's panel ──────────
   Who can read the chat, how it is encrypted, and what the two devices show
   each other. It is the security panel, so each line has to be true. */

test("the panel names the encryption the code actually uses", () => {
  /* The label is written out by hand. If the cipher, the key size or the curve
     ever changes, this is what stops the panel going on describing the old one. */
  const src = withoutComments(appSrc);
  const ecdh   = (src.match(/const MESSAGE_CIPHER_ECDH\s*=\s*"([^"]+)";/) || [])[1];
  const spake2 = (src.match(/const MESSAGE_CIPHER_SPAKE2\s*=\s*"([^"]+)";/) || [])[1];
  assert.ok(ecdh && spake2, "the message-cipher labels were not found");

  const protocolSrc = fs.readFileSync(path.join(__dirname, "..", "protocol.js"), "utf8");
  assert.match(protocolSrc, /\{\s*name:\s*"AES-GCM",\s*length:\s*256\s*\}/, "protocol.js no longer derives an AES-GCM 256 key");
  assert.match(ecdh, /AES-256-GCM/, "the label must name the message cipher");
  assert.match(spake2, /AES-256-GCM/, "the code-room label must name the message cipher too");

  assert.match(src, /generateKey\(\s*\{\s*name:\s*"ECDH",\s*namedCurve:\s*"P-256"\s*\}/, "app.js no longer generates an ECDH P-256 key pair");
  assert.match(ecdh, /ECDH P-256/, "the ECDH label must name the key exchange");

  /* The code room agrees its key with SPAKE2 (pake.js), so its label says so. */
  const pakeSrc = fs.readFileSync(path.join(__dirname, "..", "pake.js"), "utf8");
  assert.match(pakeSrc, /SPAKE2/, "pake.js is where SPAKE2 lives");
  assert.match(spake2, /SPAKE2 P-256/, "the code-room label must name SPAKE2");

  assert.match(src, /const CALL_CIPHER\s*=\s*"DTLS-SRTP";/);
});

test("\"only the two of you\" is said only about a verified chat", () => {
  /* The sentence is a claim that nobody is in the middle. On an unverified
     chat that has not been checked, so it must say so instead of promising. */
  const fn = topLevelFunctions(withoutComments(appSrc)).get("renderShieldFacts");
  assert.ok(fn, "renderShieldFacts not found");
  assert.ok(fn.includes("shieldState("), "the sentence must follow the shield's own state");
  assert.match(fn, /\{\s*idle:\s*"factReadIdle",\s*warn:\s*"factReadWarn",\s*ok:\s*"factReadOk"\s*\}\[state\]/,
    "each state needs its own sentence, chosen by the state and nothing else");

  /* And the shield and the sentence are redrawn together, so they cannot disagree. */
  assert.ok(topLevelFunctions(withoutComments(appSrc)).get("updateShield").includes("renderShieldFacts("),
    "updateShield must redraw the facts");
});

test("the unverified sentence does not claim what the verified one does", () => {
  /* Read from the strings themselves, in both languages. */
  const i18nSrc = fs.readFileSync(path.join(__dirname, "..", "i18n.js"), "utf8");
  const I18N = new Function("localStorage", `${i18nSrc}; return I18N;`)({ getItem: () => null });
  for (const lang of ["mn", "en"]) {
    assert.notEqual(I18N[lang].factReadWarn, I18N[lang].factReadOk);
    assert.ok(I18N[lang].factReadWarn.length > 0 && I18N[lang].factReadOk.length > 0);
  }
  assert.match(I18N.en.factReadWarn, /not verified/i);
  assert.ok(!/only the two of you/i.test(I18N.en.factReadWarn), "an unverified chat must not be told it is private to two people");
  assert.ok(!/зөвхөн та хоёр/i.test(I18N.mn.factReadWarn), "an unverified chat must not be told it is private to two people");
});

test("what the peer says about its device never reaches the page directly", () => {
  const src = withoutComments(appSrc);

  /* Two fields are kept, and nothing else of the message. */
  const handler = src.match(/case "peer-info":[\s\S]*?break;/);
  assert.ok(handler, "peer-info case not found");
  assert.match(handler[0], /peerDevice = \{\s*os:\s*data\.os,\s*browser:\s*data\.browser\s*\};/);

  /* Every read of it goes through the lookup that only returns our own words. */
  const reads = Array.from(src.matchAll(/[^\n]*\bpeerDevice\b[^\n]*/g)).map(m => m[0].trim())
    .filter(line => !/^let peerDevice\b/.test(line) && !/peerDevice\s*=\s*(null|\{)/.test(line));
  assert.ok(reads.length >= 1, "expected peerDevice to be displayed somewhere");
  for (const line of reads) {
    assert.ok(/DCS\.deviceLabel\(peerDevice\)/.test(line), `peerDevice is used outside deviceLabel: ${line}`);
  }
});

test("the addresses shown come from this browser's own statistics", () => {
  /* Never from anything the other side sent. */
  const src = withoutComments(appSrc);
  const writes = Array.from(src.matchAll(/_lastAddresses\s*=\s*([^;]+);/g)).map(m => m[1].trim());
  assert.ok(writes.includes("DCS.pathAddresses(stats)"), "addresses must be read from getStats()");
  for (const value of writes) {
    assert.ok(value === "null" || value === "DCS.pathAddresses(stats)", `_lastAddresses is set from something else: ${value}`);
  }
});

test("a chat that has ended takes its addresses and device off the panel", () => {
  const fn = topLevelFunctions(withoutComments(appSrc)).get("closePeerConnection");
  for (const reset of ["_lastAddresses = null", "peerDevice     = null", "peerInfoSent   = false"]) {
    assert.ok(fn.includes(reset), `closePeerConnection must reset: ${reset}`);
  }
  assert.ok(fn.indexOf("_lastAddresses = null") < fn.indexOf("updateKeyVerifyUi("), "reset first, then redraw");

  /* And a statistics read that was still in flight must not write them back. */
  const poll = topLevelFunctions(withoutComments(appSrc)).get("pollStats");
  assert.ok(poll, "pollStats not found");
  assert.match(poll, /if \(pc !== conn\) return;/);
  assert.ok(poll.indexOf("if (pc !== conn) return;") < poll.indexOf("_lastAddresses ="), "check before writing");
});

test("the guest introduces itself first, and each side only once", () => {
  /* The host activates before it has sent the confirmation that makes the
     guest ready. An introduction sent then can overtake the confirmation and
     be dropped, and the guest never learns what it is talking to. */
  const fns = topLevelFunctions(withoutComments(appSrc));
  assert.match(fns.get("e2eActivate"), /if \(!isHost\) \{ sendPeerInfo\(\); shareKnockAddress\(\); rotateMailKey\(\); flushOutbox\(\); \}/,
    "and where to knock for it, the same way");

  const send = fns.get("sendPeerInfo");
  assert.ok(send, "sendPeerInfo not found");
  assert.match(send, /if \(peerInfoSent\) return;\s*peerInfoSent = true;/, "once per channel — or two sides answer each other for ever");
  assert.match(send, /dcSendE2e\(\{\s*type:\s*"peer-info",\s*os:\s*MY_DEVICE\.os,\s*browser:\s*MY_DEVICE\.browser\s*\}\)/,
    "only the two codes are sent, and only inside the envelope");

  const handler = withoutComments(appSrc).match(/case "peer-info":[\s\S]*?break;/)[0];
  assert.ok(handler.includes("sendPeerInfo()"), "the host answers when the guest's introduction arrives");
});

/* ── Code rooms (SPAKE2) ──────────────────────
   A code room agrees its key from a shared word with SPAKE2. The word is
   proven between the two phones; these guard what must never slip. */

test("the shared word is never sent to the server", () => {
  /* Every wsSend payload is a flat object literal; none may carry the word.
     create-session sends a boolean `code:` flag, not the word itself. */
  const src = withoutComments(appSrc);
  for (const m of src.matchAll(/wsSend\(\s*\{[^}]*\}/g)) {
    assert.ok(!/pakeCode/.test(m[0]), `a wsSend payload references the word:\n${m[0]}`);
  }
  /* And the create message carries only the flag. It is built as
     pendingCreate — kept until the server answers, so a Create pressed while
     the link is down is sent once it is up — and sent from there, so every
     value pendingCreate can hold is checked too. */
  const create = src.match(/pendingCreate = \{ type: "create-session"[^}]*\}/);
  assert.ok(create && /code: kind === "code"/.test(create[0]), "create-session must send a code flag, not the word");
  assert.ok(!/pakeCode/.test(create[0]), "create-session must not carry the word");
  for (const m of src.matchAll(/pendingCreate\s*=\s*([^;]+);/g)) {
    assert.ok(m[1] === "null" || m[1] === create[0].slice("pendingCreate = ".length),
      `pendingCreate is given something other than the create message:\n${m[0]}`);
  }
  assert.match(src, /wsSend\(pendingCreate\)/, "the create message is sent as built");
});

test("a code room runs SPAKE2, every other room runs ECDH", () => {
  const onopen = withoutComments(appSrc).match(/dataChannel\.onopen\s*=[\s\S]*?\n  \};/)[0];
  assert.match(onopen, /if \(roomKind === "code"\) await pakeBegin\(\);/);
  assert.match(onopen, /else\s+await e2eInit\(\);/);
});

test("the handshake messages are believed only on a code room", () => {
  const src = withoutComments(appSrc);
  const dispatch = topLevelFunctions(src).get("handleTextMessage");
  assert.ok(dispatch, "handleTextMessage not found");
  for (const type of ["pake-msg", "pake-confirm"]) {
    const branch = dispatch.match(new RegExp('case "' + type + '":[\\s\\S]*?break;'));
    assert.ok(branch, "no " + type + " case");
    assert.ok(/roomKind === "code"/.test(branch[0]), type + " must act only on a code room");
  }
  /* And they are allowed through the clear-frame guard, since they precede any key. */
  const { CLEAR_TYPES } = require("../guards.js");
  assert.ok(CLEAR_TYPES.includes("pake-msg") && CLEAR_TYPES.includes("pake-confirm"));
});

test("a matched word authenticates the channel, a wrong one closes it", () => {
  const fns = topLevelFunctions(withoutComments(appSrc));
  const confirm = fns.get("handlePakeConfirm");
  assert.ok(confirm, "handlePakeConfirm not found");
  assert.ok(confirm.includes("verifyPeerConfirm("), "it must check the peer's tag");
  assert.ok(/e2eActivate\(key, true\)/.test(confirm), "a match means an authenticated, green channel");
  assert.ok(confirm.includes("pakeFailClosed"), "no match must fail closed");

  const fail = fns.get("pakeFailClosed");
  assert.ok(fail && fail.includes("e2eReady = false"), "a failed handshake must not leave the channel open");
});

test("a code room offers no invite link", () => {
  /* The link carries the ECDH room secret, which a code room does not use —
     a guest clicking it would just fail to connect. */
  /* The panel is drawn by showRoomReady — on creating the room, and again when
     a code room's host is back waiting after a failed attempt. */
  const panel = topLevelFunctions(withoutComments(appSrc)).get("showRoomReady");
  assert.ok(panel, "showRoomReady not found");
  assert.ok(/if \(isCode\) createInfo\.replaceChildren\(ready, pinBox\)/.test(panel),
    "a code room's panel must omit the invite link");
  const created = withoutComments(appSrc).match(/case "session-created": \{[\s\S]*?\n      break;/)[0];
  assert.match(created, /showRoomReady\(data\)/, "the room's creation draws that panel");
});

/* ══════════════════════════════════════════
   The same invite link, opened again
══════════════════════════════════════════ */

const caseBlock = type => {
  const m = withoutComments(appSrc).match(new RegExp(`case "${type}":[\\s\\S]*?\\n\\s*break;`));
  assert.ok(m, `case "${type}" not found in app.js`);
  return m[0];
};

test("a copy whose seat moved to another browser never joins with the link again", () => {
  /* The two copies would take the seat back and forth: the one left in the
     app's browser loses its socket when the phone puts it to sleep, and the
     retry after a reconnect would send the join again. */
  const block = caseBlock("seat-taken");
  assert.match(block, /inviteMovedAway = true;/);
  assert.match(block, /currentSession = null;/);
  assert.ok(!/showReconnectButton\(\)|wsSend\(/.test(block), "nothing to offer, nothing to send");
  assert.ok(block.indexOf("dataChannel.onclose = null") < block.indexOf("closePeerConnection()"),
    "let go of quietly — its channel closing would write \"connection closed\"");

  const join = topLevelFunctions(withoutComments(appSrc)).get("checkAutoJoin");
  assert.match(join, /if \(!_isAutoJoin \|\| _autoJoinSent \|\| inAppHold \|\| inviteMovedAway\) return;/);
});

test("a copy that lost the seat, or was refused it, offers to continue there — and only a tap takes it", () => {
  /* Reported: a copy in the background took the seat from the Safari page the
     guest was looking at. Now the server lets only an on-screen copy take a
     seat, and every copy that ends up without one has a button, so whichever
     one the person is looking at can become the one in use. */
  const taken = caseBlock("seat-taken");
  assert.match(taken, /chatMessages\.appendChild\(continueHereButton\(\)\);/);
  /* Its channel's close handler is not let run, so what it would have tidied
     is tidied here: seen left behind in a browser, call buttons still on and
     the old link's figures still showing. */
  assert.match(taken, /voiceCallBtn\.disabled = true;\s*\n\s*videoCallBtn\.disabled = true;\s*\n\s*statsBar\.textContent = "";/);

  const errors = withoutComments(appSrc).match(/case "pin-error": \{[\s\S]*?\n    \}/);
  assert.ok(errors, 'case "pin-error" not found');
  const held = errors[0].match(/data\.code === "held-elsewhere"\) \{[\s\S]*?\} else if/);
  assert.ok(held, "held-elsewhere is not handled on its own");
  assert.match(held[0], /inviteMovedAway = true;/, "nothing more joins by itself from that copy");
  assert.match(held[0], /continueHereButton\(\)/);

  const fns = topLevelFunctions(withoutComments(appSrc));
  const button = fns.get("continueHereButton");
  assert.match(button, /btn\.onclick = continueWithInviteHere;/, "the join is the tap's, not a timer's");
  const cont = fns.get("continueWithInviteHere");
  assert.match(cont, /inviteMovedAway = false;\s*\n\s*_autoJoinSent = false;/, "this copy is the one in use now");
  assert.match(cont, /checkAutoJoin\(\)/, "through the same join as the link's own, on-screen flag and all");
  assert.ok(cont.indexOf("leaveBtn.click()") < cont.indexOf("checkAutoJoin()"), "back to the lobby first, where the answer is shown");
});

test("the host keeps the chat on screen when the guest's link moves to another browser", () => {
  const block = caseBlock("guest-joined");
  assert.match(block, /switchToChat\(currentSession\.sessionId, \{ keepMessages: data\.replaced === true \}\)/);
  assert.ok(block.indexOf("dataChannel.onclose = null") < block.indexOf("createPeerConnection()"),
    "the old channel is let go of quietly before the new connection");
  assert.ok(block.indexOf("switchToChat(") < block.indexOf('t("guestReopened")'), "said after the screen is set up, so it is not cleared");
  const sw = topLevelFunctions(withoutComments(appSrc)).get("switchToChat");
  assert.match(sw, /if \(!keepMessages\) \{\s*\n\s*savedInChat = null;[\s\S]*?closeReactionBar\(\);\s*\n\s*chatMessages\.replaceChildren\(\);/);
});
