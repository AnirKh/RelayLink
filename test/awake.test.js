/*
  A locked screen, and the chat that used to end with it — actually run.

  The bug: put a phone down for a minute and the chat was gone. A phone whose
  screen locks pauses the page; an iPhone cuts the page's link to the server
  almost at once. The server saw that link drop, told the other side "peer
  left", and the other side's app ended the chat — although the chat runs
  directly between the two phones, and that link was still up, or would have
  been when the screen came back on.

  Two fixes, both here:
    - the server's word alone no longer ends a working chat; the direct link
      decides (G.serverLeaveEndsChat, G.linkLostForGood)
    - while a room is open the screen does not lock by itself (keepScreenOn,
      Screen Wake Lock)

  The peer-disconnected case, the ICE state handler, endChatLinkLost,
  showReconnectButton and the keep-the-screen-on block are lifted out of
  app.js and run against stand-ins.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");
const G      = require("../guards.js");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");

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

test("the server saying the other side left does not end a chat whose direct link is up", () => {
  for (const iceState of ["connected", "completed", "checking", "disconnected"]) {
    assert.equal(G.serverLeaveEndsChat({ channelOpen: true, iceState }), false, iceState);
  }
});

test("it does end a chat whose direct link is not up", () => {
  for (const iceState of ["failed", "closed", "new", undefined]) {
    assert.equal(G.serverLeaveEndsChat({ channelOpen: true, iceState }), true, String(iceState));
  }
  for (const channelOpen of [false, undefined, "open", 1]) {
    assert.equal(G.serverLeaveEndsChat({ channelOpen, iceState: "connected" }), true,
      `a channel that is not open (${channelOpen}) — still connecting, or already closed`);
  }
  assert.equal(G.serverLeaveEndsChat(undefined), true);
});

test("a failed link is final only once the server has dropped the room", () => {
  assert.equal(G.linkLostForGood({ iceState: "failed", serverRoomGone: true }), true);
  assert.equal(G.linkLostForGood({ iceState: "failed", serverRoomGone: false }), false, "the server can still carry an ICE restart");
  for (const iceState of ["disconnected", "connected", "checking", "closed"]) {
    assert.equal(G.linkLostForGood({ iceState, serverRoomGone: true }), false, iceState);
  }
  assert.equal(G.linkLostForGood({ iceState: "failed", serverRoomGone: "yes" }), false);
  assert.equal(G.linkLostForGood(undefined), false);
});

/* ══════════════════════════════════════════
   The server's notice, run
══════════════════════════════════════════ */

const PEER_DISCONNECTED = between('    case "peer-disconnected":', '    case "session-expired":');

function notice({ channel = "open", ice = "connected" } = {}) {
  const log = { sys: [], ended: 0, closed: 0, buttons: 0 };
  const run = new Function(
    "G", "t", "roomEventIsOurs", "dataChannel", "pc", "appendSys", "endCall", "closePeerConnection", "showReconnectButton",
    `let serverRoomGone = false;
     function deliver(data) { switch (data.type) {\n${PEER_DISCONNECTED}\n} }
     deliver({ type: "peer-disconnected", sessionId: "r" });
     return serverRoomGone;`
  );
  const serverRoomGone = run(G, k => k, () => true,
    channel === null ? null : { readyState: channel }, ice === null ? null : { iceConnectionState: ice },
    k => log.sys.push(k), () => log.ended++, () => log.closed++, () => log.buttons++);
  return { ...log, serverRoomGone };
}

test("a locked screen on the other side: the notice comes, and the chat goes on", () => {
  const r = notice({ channel: "open", ice: "connected" });
  assert.deepEqual(r.sys, [], "nothing said");
  assert.equal(r.closed, 0, "the direct link is not torn down");
  assert.equal(r.buttons, 0);
  assert.equal(r.serverRoomGone, true, "remembered: nothing can be repaired through the server now");
});

test("the notice still ends a chat that never got going, or whose link has failed", () => {
  for (const [channel, ice] of [[null, null], ["connecting", "checking"], ["open", "failed"], ["closed", "connected"]]) {
    const r = notice({ channel, ice });
    assert.deepEqual(r.sys, ["sysPeerLeft"], `${channel} / ${ice}`);
    assert.equal(r.closed, 1);
    assert.equal(r.buttons, 1);
  }
});

/* ══════════════════════════════════════════
   The direct link failing, run
══════════════════════════════════════════ */

function link({ serverRoomGone }) {
  const log = { sys: [], quality: [], renegotiations: 0, closed: 0, buttons: 0, repairing: 0, repaired: 0 };
  let made = null;
  class RTCPeerConnection { constructor() { made = this; } close() {} restartIce() {} }
  /* closePeerConnection is stood in for so the real one's DOM is not needed;
     the repair's own steps are tested in chatrepair.test.js — here, only
     whether a link going down starts one. */
  const run = new Function(
    "G", "t", "RTCPeerConnection", "ICE_CONFIG", "currentSession", "wsSend", "setQuality", "startStatsPolling",
    "handleFullRenegotiation", "setupDataChannel", "appendSys", "endCall", "showReconnectButton", "closed", "flag",
    "watchChatLink", "stopChatRepair",
    `let pc = null, dataChannel = null, serverRoomGone = false;
     function closePeerConnection() { closed(); }
     ${fn("createPeerConnection")}
     ${fn("endChatLinkLost")}
     createPeerConnection();
     serverRoomGone = flag;
     return { pc: () => pc, roomGone: () => serverRoomGone };`
  );
  const api = run(G, k => k, RTCPeerConnection, {}, { sessionId: "r" }, () => {}, (text, cls) => log.quality.push(cls),
    () => {}, () => log.renegotiations++, () => {}, k => log.sys.push(k), () => {}, () => log.buttons++,
    () => log.closed++, serverRoomGone, () => log.repairing++, () => log.repaired++);
  const to = state => { made.iceConnectionState = state; made.oniceconnectionstatechange(); };
  return { ...log, log, to, api };
}

test("a link that fails while the server still has the room is repaired through it, as before", () => {
  /* The repair now has steps of its own — a couple of seconds' wait, either
     side able to start it — so going down starts it rather than firing one
     offer there and then. See chatrepair.test.js for the steps. */
  const l = link({ serverRoomGone: false });
  const closedBefore = l.log.closed;
  l.to("failed");
  assert.equal(l.log.repairing, 1, "the repair is started");
  assert.deepEqual(l.log.sys, []);
  assert.equal(l.log.closed, closedBefore);
});

test("a link that only goes disconnected is repaired too — it used to get a restartIce() nothing acted on", () => {
  const l = link({ serverRoomGone: false });
  l.to("disconnected");
  assert.equal(l.log.repairing, 1);
  l.to("connected");
  assert.equal(l.log.repaired, 1, "and the repair stops once the link is back");
});

test("a link that fails after the server dropped the room ends the chat and says so, instead of retrying for ever", () => {
  const l = link({ serverRoomGone: true });
  const closedBefore = l.log.closed;
  l.to("failed");
  assert.equal(l.log.renegotiations, 0, "nobody to carry a restart");
  assert.deepEqual(l.log.sys, ["sysLinkLost"]);
  assert.equal(l.log.closed, closedBefore + 1);
  assert.equal(l.log.buttons, 1);
});

test("a link that only wavers is left to recover, server or no server", () => {
  const l = link({ serverRoomGone: true });
  l.to("disconnected");
  l.to("connected");
  assert.deepEqual(l.log.sys, []);
  assert.equal(l.log.buttons, 0);
});

test("a fresh connection starts with the server holding the room", () => {
  const l = link({ serverRoomGone: true });
  assert.equal(l.api.roomGone(), true);
  const src = fn("createPeerConnection");
  assert.ok(src.indexOf("serverRoomGone = false") > src.indexOf("closePeerConnection()"),
    "reset after the old connection is closed, before the new one exists");
});

/* ══════════════════════════════════════════
   The rest of the wiring
══════════════════════════════════════════ */

test("our own link to the server dropping mid-chat: our seat is taken back with our key, and only without one is the room gone", () => {
  /* It used to mark the room gone outright: the server deleted it when the
     link dropped. Now the server keeps the seat for a page that has its key. */
  const onclose = between("  ws.onclose   = () => {", "  ws.onerror");
  assert.match(onclose, /if \(pc && currentSession\) \{\s*\n\s*if \(isHost \? hostKey : guestKey\) seatPending = true;\s*\n\s*else serverRoomGone = true;/);
});

test("the channel closing after the server's notice is said as the other side leaving", () => {
  assert.match(between("  dataChannel.onclose = () => {", "showReconnectButton();"),
    /appendSys\(t\(serverRoomGone \? "sysPeerLeft" : "sysClosed"\)\)/);
});

test("however a chat ends, there is one Back button", () => {
  const children = [];
  const chatMessages = {
    querySelector: sel => children.find(c => sel === `.${c.className}`) || null,
    appendChild: c => children.push(c)
  };
  const document = { createElement: () => ({ className: "", appendChild() {} }) };
  const show = new Function("chatMessages", "document", "t", "leaveBtn", "scrollBottom", "keepScreenOn", "settleOutbox",
    `${fn("showReconnectButton")}\nreturn showReconnectButton;`)(chatMessages, document, k => k, {}, () => {}, () => {}, () => {});
  show(); show(); show();
  assert.equal(children.filter(c => c.className === "reconnect-sys-wrap").length, 1);
});

/* ══════════════════════════════════════════
   Keeping the screen on, run
══════════════════════════════════════════ */

const SCREEN = between("/* ── Keep the screen on ──", "/* ── The phone's Back button");

function phone({ api = true, visible = true, refuse = false } = {}) {
  const listeners = {};
  const log = { requests: 0, releases: 0 };
  let sentinels = [];
  const document = {
    visibilityState: visible ? "visible" : "hidden",
    addEventListener: (type, fn) => { listeners[type] = fn; }
  };
  let gate = null;
  const wakeLock = {
    request: kind => {
      assert.equal(kind, "screen");
      log.requests++;
      if (refuse) return Promise.reject(new Error("NotAllowedError"));
      const s = { handlers: {}, release() { log.releases++; return Promise.resolve(); },
                  addEventListener(type, fn) { this.handlers[type] = fn; } };
      sentinels.push(s);
      return gate ? gate.then(() => s) : Promise.resolve(s);
    }
  };
  const navigator = api ? { wakeLock } : {};
  const run = new Function("navigator", "document",
    `${SCREEN}\nreturn { keepScreenOn, held: () => Boolean(screenLock), wanted: () => screenLockWanted };`
  )(navigator, document);
  const settle = () => new Promise(r => setImmediate(r));
  return {
    ...run, log, listeners, document, settle,
    browserLetsGo: () => sentinels[sentinels.length - 1].handlers.release(),
    hold: () => { let open; gate = new Promise(r => { open = r; }); return () => { gate = null; open(); }; }
  };
}

test("a room opening keeps the screen on; leaving lets it sleep", async () => {
  const p = phone();
  await p.keepScreenOn(true);
  assert.equal(p.held(), true);
  await p.keepScreenOn(true);
  assert.equal(p.log.requests, 1, "asked once, not again while held");
  await p.keepScreenOn(false);
  assert.equal(p.held(), false);
  assert.equal(p.log.releases, 1);
});

test("the browser lets go when the page is hidden; coming back takes it again", async () => {
  const p = phone();
  await p.keepScreenOn(true);
  p.browserLetsGo();
  assert.equal(p.held(), false);
  p.listeners.visibilitychange();
  await p.settle();
  assert.equal(p.held(), true);
  assert.equal(p.log.requests, 2);
});

test("a hidden page does not ask; it asks once it is visible", async () => {
  const p = phone({ visible: false });
  await p.keepScreenOn(true);
  assert.equal(p.log.requests, 0);
  p.document.visibilityState = "visible";
  p.listeners.visibilitychange();
  await p.settle();
  assert.equal(p.held(), true);
});

test("after leaving, coming back to the page does not take the lock", async () => {
  const p = phone();
  await p.keepScreenOn(true);
  await p.keepScreenOn(false);
  p.listeners.visibilitychange();
  p.listeners.pointerdown();
  await p.settle();
  assert.equal(p.log.requests, 1);
});

test("refused — battery saver, or Safari wanting a tap — is not an error, and a tap tries again", async () => {
  const p = phone({ refuse: true });
  await p.keepScreenOn(true);        // must not throw
  assert.equal(p.held(), false);
  p.listeners.pointerdown();
  await p.settle();
  assert.equal(p.log.requests, 2);
});

test("leaving while the lock is still being granted gives it straight back", async () => {
  const p = phone();
  const open = p.hold();
  const asking = p.keepScreenOn(true);
  await p.keepScreenOn(false);
  open();
  await asking;
  assert.equal(p.held(), false);
  assert.equal(p.log.releases, 1);
});

test("no Screen Wake Lock in this browser: nothing happens, nothing breaks", async () => {
  const p = phone({ api: false });
  await p.keepScreenOn(true);
  assert.equal(p.held(), false);
});

test("the screen is kept on for a waiting host and a chat, and let go when it ends", () => {
  assert.match(fn("switchToChat"), /keepScreenOn\(true\)/);
  assert.match(between('case "session-created": {', "createInfo.style.textAlign"), /keepScreenOn\(true\)/);
  assert.match(between('case "session-expired": {', "currentSession = null;"), /keepScreenOn\(false\)/);
  assert.match(between("leaveBtn.onclick = (e) => {", "wsSend("), /keepScreenOn\(false\)/);
  assert.match(fn("showReconnectButton"), /keepScreenOn\(false\)/);
});
