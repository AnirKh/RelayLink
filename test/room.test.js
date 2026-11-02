/*
  The host's own room — lost, made again, and shown in the list.

  - A room waiting for its guest went with the host's link to the server
    (power button, Wi-Fi switching, the server restarting), and nothing said so:
    the PIN and link stayed on screen for a room that no longer existed.
    Now the host is told, with a one-tap "Create again".
  - A Create pressed while that link was down sent nothing, and the page sat
    on "Creating…" with every create button disabled for good. Now it waits,
    and goes when the link is back.
  - The host's own room was listed with a Join button that could only fail.
    (Run in lobby.test.js, with the rest of the list.)
  - A refused invite link said "may have expired" twice.

  loseWaitingRoom, recreateRoom, createRoom and sendPendingCreate are lifted
  out of app.js and run against stand-ins.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");
const G      = require("../guards.js");

const read = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\r\n/g, "\n");
const app  = read("app.js");
const I18N = new Function("localStorage", `${read("i18n.js")}; return I18N;`)({ getItem: () => null });

const fn = name => {
  const m = app.match(new RegExp(`^(?:async )?function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(m, `${name} not found as a top-level function in app.js`);
  return m[0];
};
const between = (from, to) => {
  const a = app.indexOf(from), b = app.indexOf(to, a);
  assert.ok(a > 0 && b > a, `${from} … ${to} not found in app.js`);
  return app.slice(a, b);
};

/* ══════════════════════════════════════════
   The rules
══════════════════════════════════════════ */

test("a room is lost with the link only while its host is still waiting in it", () => {
  assert.equal(G.waitingRoomLost({ isHost: true, hasSession: true, chatStarted: false }), true);
  assert.equal(G.waitingRoomLost({ isHost: true, hasSession: true, chatStarted: true }), false,
    "a chat that has started runs directly, and goes on");
  assert.equal(G.waitingRoomLost({ isHost: false, hasSession: true, chatStarted: false }), false, "a guest has no room to lose");
  assert.equal(G.waitingRoomLost({ isHost: true, hasSession: false, chatStarted: false }), false, "no room yet");
  assert.equal(G.waitingRoomLost({ isHost: "yes", hasSession: true }), false);
  assert.equal(G.waitingRoomLost(undefined), false);
});

test("a room is yours only if you are hosting that very room", () => {
  assert.equal(G.isOwnRoom({ sessionId: "a", isHost: true, currentSessionId: "a" }), true);
  assert.equal(G.isOwnRoom({ sessionId: "a", isHost: true, currentSessionId: "b" }), false);
  assert.equal(G.isOwnRoom({ sessionId: "a", isHost: false, currentSessionId: "a" }), false, "a guest's room is not theirs");
  assert.equal(G.isOwnRoom({ sessionId: "", isHost: true, currentSessionId: "" }), false);
  assert.equal(G.isOwnRoom({ sessionId: "a", isHost: true, currentSessionId: undefined }), false);
  assert.equal(G.isOwnRoom(undefined), false);
});

/* ══════════════════════════════════════════
   The lobby, run
══════════════════════════════════════════ */

function lobby({ linkUp = true, tab = "create", hosting = { sessionId: "bat-room", kind: "pin" }, word = null } = {}) {
  const log = { sent: [], toasts: [], screenOn: [], lists: 0, chooseWord: 0, forgot: 0 };
  const node = tag => ({ tag, textContent: "", className: "", style: {}, children: [], onclick: null,
                         replaceChildren(...c) { this.children = c; } });
  const createInfo = node("div");
  const input = { value: "" };
  const ws = { readyState: linkUp ? 1 : 0 };
  const api = new Function(
    "G", "t", "WebSocket", "ws", "document", "createInfo", "sessionIdInput", "wsSend", "showToast",
    "setCreateButtons", "keepScreenOn", "renderSessionList", "openChooseCode", "forgetHostRoom", "log", "start",
    `let currentSession = start.hosting ? { sessionId: start.hosting.sessionId, token: "t" } : null;
     let roomKind = start.hosting ? start.hosting.kind : "pin";
     let isHost = Boolean(start.hosting), isConnecting = false, roomSecret = "s";
     let pakeCode = start.word, activeLobbyTab = start.tab, _lastSessionList = [];
     let pendingCreate = null, hostKey = "host-key", reclaimPending = true;
     ${fn("makeCreateKey")}
     ${fn("sendPendingCreate")}
     ${fn("createRoom")}
     ${fn("loseWaitingRoom")}
     ${fn("recreateRoom")}
     return { loseWaitingRoom, createRoom, sendPendingCreate,
              state: () => ({ currentSession, isHost, isConnecting, roomSecret, pendingCreate }) };`
  )(G, k => I18N.en[k], { OPEN: 1 }, ws, { createElement: node }, createInfo, input,
    m => { if (ws.readyState === 1) log.sent.push(m); },
    m => log.toasts.push(m), () => {}, on => log.screenOn.push(on), () => log.lists++,
    () => log.chooseWord++, () => log.forgot++, log, { hosting, tab, word });
  const button = () => createInfo.children.find(c => c.tag === "button");
  return { ...api, log, ws, createInfo, input, button, linkUp: () => { ws.readyState = 1; api.sendPendingCreate(); } };
}

/** A create as sent, without its key — checked on its own below. */
const withoutKey = ({ createKey, ...rest }) => {
  assert.match(String(createKey), /^[A-Za-z0-9_-]{24}$/, "every create carries a key of its own");
  return rest;
};

test("each create has its own key; the same create keeps it however often it is sent", () => {
  const l = lobby({ linkUp: true, hosting: null });
  l.input.value = "one-room";
  l.createRoom("pin");
  l.sendPendingCreate();
  assert.equal(l.log.sent[0].createKey, l.log.sent[1].createKey);
  const other = lobby({ linkUp: true, hosting: null });
  other.input.value = "one-room";
  other.createRoom("pin");
  assert.notEqual(other.log.sent[0].createKey, l.log.sent[0].createKey, "another page's create is another create");
});

test("a waiting room lost with the link: the host is told, and can make it again", () => {
  const l = lobby();
  l.loseWaitingRoom();
  assert.equal(l.createInfo.children[0].textContent, `⚠️ ${I18N.en.roomLost}`);
  assert.equal(l.button().textContent, I18N.en.recreateRoom);
  const s = l.state();
  assert.equal(s.currentSession, null, "no longer holding a room that is gone");
  assert.equal(s.isHost, false);
  assert.equal(s.roomSecret, null, "the old link's secret is dropped with it");
  assert.deepEqual(l.log.screenOn, [false], "nothing to keep the screen on for");
  assert.equal(l.log.lists, 1, "the list no longer calls it yours");
  assert.equal(l.log.forgot, 1, "nor does this tab keep it, to take back after a reload");
});

test("on another tab the host is told by a toast too", () => {
  const onCreate = lobby({ tab: "create" });
  onCreate.loseWaitingRoom();
  assert.deepEqual(onCreate.log.toasts, []);
  const onRooms = lobby({ tab: "rooms" });
  onRooms.loseWaitingRoom();
  assert.deepEqual(onRooms.log.toasts, [`⚠️ ${I18N.en.roomLost}`]);
});

test("Create again makes the same room — same name, same kind", () => {
  for (const kind of ["pin", "open"]) {
    const l = lobby({ hosting: { sessionId: "bat-room", kind } });
    l.loseWaitingRoom();
    l.button().onclick();
    assert.deepEqual(l.log.sent.map(withoutKey), [{ type: "create-session", sessionId: "bat-room", open: kind === "open", code: false }]);
  }
});

test("a code room is made again with the same word, without asking for it, and the word is not sent", () => {
  const l = lobby({ hosting: { sessionId: "bat-room", kind: "code" }, word: "correct horse" });
  l.loseWaitingRoom();
  l.button().onclick();
  assert.equal(l.log.chooseWord, 0, "the guest already has the word; it is kept");
  assert.deepEqual(l.log.sent.map(withoutKey), [{ type: "create-session", sessionId: "bat-room", open: false, code: true }]);
  assert.ok(!JSON.stringify(l.log.sent).includes("correct horse"));
});

test("Create pressed while the link is down goes when the link is back", () => {
  const l = lobby({ linkUp: false, hosting: null });
  l.input.value = "new-room";
  l.createRoom("open");
  assert.deepEqual(l.log.sent, [], "dropped by wsSend, as before — but kept this time");
  assert.equal(l.state().isConnecting, true);
  l.linkUp();
  assert.deepEqual(l.log.sent.map(withoutKey), [{ type: "create-session", sessionId: "new-room", open: true, code: false }]);
});

test("a create that was sent but not answered before the link dropped is sent again", () => {
  const l = lobby({ linkUp: true, hosting: null });
  l.input.value = "new-room";
  l.createRoom("pin");
  assert.equal(l.log.sent.length, 1);
  l.ws.readyState = 3;                       // the link drops before the answer
  l.linkUp();
  assert.equal(l.log.sent.length, 2);
  assert.equal(l.log.sent[1].createKey, l.log.sent[0].createKey,
    "the same create, with the same key: the server answers it with the room it already made, not \"name taken\"");
});

test("a create made while the link is down is kept, and sent once it is up", () => {
  const l = lobby({ linkUp: false });
  l.loseWaitingRoom();
  l.button().onclick();                      // the link has not come back yet
  assert.deepEqual(l.log.sent, [], "nothing can be sent yet");
  assert.ok(l.state().pendingCreate, "kept");
  assert.equal(l.state().isConnecting, true, "and shown as creating, not dropped");
  l.linkUp();
  assert.deepEqual(l.log.sent.map(m => m.type), ["create-session"]);
});

/* ══════════════════════════════════════════
   The wiring
══════════════════════════════════════════ */

test("the link dropping holds a waiting room for taking back; the link returning sends a waiting create and takes it", () => {
  const onclose = between("  ws.onclose   = () => {", "  ws.onerror");
  assert.match(onclose, /if \(G\.waitingRoomLost\(\{ isHost, hasSession: Boolean\(currentSession\), chatStarted: Boolean\(pc\) \}\)\) \{/);
  assert.match(onclose, /if \(hostKey\) awaitReclaim\(\);\s*\n\s*else loseWaitingRoom\(\);/,
    "kept for taking back — or, from a server that gave no host key, said to be lost as before");
  const onopen = between("  ws.onopen    = () => {", "  ws.onclose");
  assert.match(onopen, /sendPendingCreate\(\);\s*\n\s*sendPendingMeet\(\);\s*\n\s*mailAtConnect\(\);\s*\n\s*restoreHostRoom\(\);\s*\n\s*sendReclaim\(\);/,
    "and a tap on a saved person, the same way — and messages written or waiting");
});

test("an answer — the room made, or refused — ends the wait", () => {
  assert.match(between('case "session-created": {', "isHost = true;"), /pendingCreate = null;/);
  const error = between('    case "error":', '    case "pin-error":');
  assert.match(error.slice(error.indexOf("} else {")), /pendingCreate = null;/);
});

test("a created room is shown as yours at once, not at the next list", () => {
  assert.match(between('case "session-created": {', "createInfo.style.textAlign"), /renderSessionList\(_lastSessionList\)/);
});

test("a refused invite link says why once", () => {
  const branch = between('} else if (target === "lobby") {', "} else {");
  assert.doesNotMatch(branch, /sessionExpired|<small|createElement\("small"\)/);
  assert.match(branch, /wrap\.textContent = I18N\[LANG\]\.couldNotJoin\(msg\);/);
  for (const lang of ["mn", "en"]) assert.equal(I18N[lang].sessionExpired, undefined, "the second line is gone from both languages");
});
