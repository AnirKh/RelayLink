/*
  The lobby's three tabs — Rooms, Create room, Email — actually run.

  The lobby used to be three cards stacked one under another: create a room,
  the rooms open now, and a form to email the owner. Now it is one section at
  a time, Rooms first, because most people arriving are joining someone.

  Splitting it had one trap. The create card's status line was also where the
  lobby said things that have nothing to do with creating: the server waking
  up, "Joining…" from an invite link, an invite link that failed. With Rooms
  open by default, all of that would have been said inside a hidden tab. Those
  now go to a status line above the tabs; the Create tab keeps only its own.

  showLobbyTab(), lobbyTabKeyTarget() and renderSessionList() are lifted out of
  app.js and run against stand-ins; the markup is read from index.html.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const read = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\r\n/g, "\n");
const app  = read("app.js");
const html = read("index.html");
const I18N = new Function("localStorage", `${read("i18n.js")}; return I18N;`)({ getItem: () => null });

const fn = name => {
  const m = app.match(new RegExp(`^(?:async )?function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(m, `${name} not found as a top-level function in app.js`);
  return m[0];
};

/** The opening tag of the element with this id. */
const tag = id => {
  const m = html.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`));
  assert.ok(m, `#${id} not in index.html`);
  return m[0];
};
/** Everything inside the element with this id, by counting nested <div>s. */
const inner = id => {
  const start = html.indexOf(tag(id)) + tag(id).length;
  let depth = 1, i = start;
  const re = /<\/?div\b[^>]*>/g;
  re.lastIndex = start;
  for (let m; (m = re.exec(html)); ) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) { i = m.index; break; }
  }
  return html.slice(start, i);
};

const TABS = [
  { id: "tabRooms",  name: "rooms",  panel: "panelRooms" },
  { id: "tabCreate", name: "create", panel: "panelCreate" },
  { id: "tabMail",   name: "mail",   panel: "panelMail" }
];

/* ══════════════════════════════════════════
   The page
══════════════════════════════════════════ */

test("three tabs, each naming a panel that exists, in the order Rooms, Create, Email", () => {
  const order = TABS.map(t => html.indexOf(tag(t.id)));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  for (const t of TABS) {
    const button = tag(t.id);
    assert.match(button, /role="tab"/);
    assert.match(button, new RegExp(`aria-controls="${t.panel}"`));
    assert.match(button, new RegExp(`data-tab="${t.name}"`));
    assert.match(tag(t.panel), /role="tabpanel"/);
    assert.match(tag(t.panel), new RegExp(`aria-labelledby="${t.id}"`));
  }
});

test("the page opens on Rooms: its tab selected, its panel the only one showing", () => {
  assert.match(tag("tabRooms"), /aria-selected="true"/);
  assert.doesNotMatch(tag("panelRooms"), /\bhidden\b/);
  for (const t of TABS.slice(1)) {
    assert.match(tag(t.id), /aria-selected="false"/);
    assert.match(tag(t.id), /tabindex="-1"/, "one tab stop for the row");
    assert.match(tag(t.panel), /class="[^"]*\bhidden\b/);
  }
});

test("each section's controls are inside its own panel", () => {
  assert.match(inner("panelRooms"),  /id="sessionsList"/);
  assert.match(inner("panelRooms"),  /id="refreshBtn"/);
  assert.match(inner("panelCreate"), /id="sessionId"/);
  assert.match(inner("panelCreate"), /id="createBtn"/);
  assert.match(inner("panelCreate"), /id="createCodeBtn"/);
  assert.match(inner("panelCreate"), /id="createInfo"/);
  assert.match(inner("panelMail"),   /id="leaveMessage"/);
  assert.match(inner("panelMail"),   /id="leaveSendBtn"/);
});

test("the lobby's status line sits outside every panel, so it shows on any tab", () => {
  for (const t of TABS) assert.doesNotMatch(inner(t.panel), /id="lobbyStatus"/);
  assert.match(tag("lobbyStatus"), /role="status"/);
  assert.ok(html.indexOf(tag("lobbyStatus")) < html.indexOf(tag("panelRooms")), "above the panels");
});

test("every tab label exists in both languages", () => {
  for (const key of ["tabRooms", "tabCreate", "tabMail", "lobbyTabsLabel"]) {
    for (const lang of ["mn", "en"]) assert.equal(typeof I18N[lang][key], "string", `${lang}.${key}`);
  }
});

/* ══════════════════════════════════════════
   Messages that are not about creating
══════════════════════════════════════════ */

test("the server waking, and joining by invite link, are said on the status line, not in the Create tab", () => {
  for (const name of ["wakeServer", "checkAutoJoin", "autoJoinTimedOut"]) {
    const body = fn(name);
    assert.doesNotMatch(body, /createInfo/, `${name} writes into the Create tab`);
    assert.match(body, /lobbyStatus\.replaceChildren/, `${name} says nothing on the status line`);
  }
  const onOpen = app.slice(app.indexOf("ws.onopen"), app.indexOf("ws.onopen") + 900);
  assert.doesNotMatch(onOpen, /createInfo/, "the server-ready notice clears the Create tab");
});

test("an invite link that is refused, or errors, is said on the status line", () => {
  const lobbyBranch = app.slice(app.indexOf('} else if (target === "lobby") {'));
  assert.match(lobbyBranch.slice(0, lobbyBranch.indexOf("} else {")), /lobbyStatus\.replaceChildren\(wrap\)/);
  const autoErr = app.slice(app.indexOf("if (_isAutoJoin && isConnecting) {"));
  assert.match(autoErr.slice(0, autoErr.indexOf("} else {")), /lobbyStatus\.replaceChildren\(msg\)/);
});

test("a created room brings its host to the Create tab, where the PIN is", () => {
  const created = app.slice(app.indexOf('case "session-created":'));
  const body = created.slice(0, created.indexOf("createInfo.replaceChildren(ready"));
  assert.match(body, /showLobbyTab\("create"\)/);
});

test("a room expiring is also said as a toast to a host on another tab", () => {
  const expired = app.slice(app.indexOf('t("roomExpired")'));
  assert.match(expired.slice(0, 600), /if \(activeLobbyTab !== "create"\) showToast\(/);
});

test("coming back from a chat lands on Rooms, with the status line cleared", () => {
  /* The Leave button's handler — a code room's host going back to waiting
     also shows the lobby, but stays on the Create tab, where its room is. */
  const leave = app.slice(app.indexOf("leaveBtn.onclick = (e) => {"));
  const back = leave.slice(leave.indexOf('lobbyScreen.classList.remove("hidden");'));
  const body = back.slice(0, back.indexOf("requestSessionList();"));
  assert.match(body, /showLobbyTab\("rooms"\)/);
  assert.match(body, /lobbyStatus\.replaceChildren\(\)/);
});

/* ══════════════════════════════════════════
   Switching, run
══════════════════════════════════════════ */

function stand() {
  const classes = () => {
    const set = new Set();
    return { set, toggle: (c, on) => (on ? set.add(c) : set.delete(c)), contains: c => set.has(c) };
  };
  const panels = {}, tabs = [];
  for (const t of TABS) {
    panels[t.panel] = { classList: classes() };
    const attrs = { "aria-controls": t.panel };
    tabs.push({ dataset: { tab: t.name }, tabIndex: 0, attrs,
                getAttribute: k => attrs[k], setAttribute: (k, v) => { attrs[k] = v; } });
  }
  let listRequests = 0, inboxLooks = 0;
  const run = new Function("lobbyTabs", "document", "requestSessionList", "inboxViewed", `
    let activeLobbyTab = "rooms";
    ${fn("showLobbyTab")}
    return { showLobbyTab, active: () => activeLobbyTab };
  `)(tabs, { getElementById: id => panels[id] }, () => { listRequests++; }, () => { inboxLooks++; });
  const showing = () => TABS.filter(t => !panels[t.panel].classList.contains("hidden")).map(t => t.name);
  const selected = () => tabs.filter(t => t.attrs["aria-selected"] === "true").map(t => t.dataset.tab);
  return { ...run, tabs, showing, selected, listRequests: () => listRequests, inboxLooks: () => inboxLooks };
}

test("choosing a tab shows its panel and hides the other two", () => {
  const s = stand();
  for (const t of TABS) {
    s.showLobbyTab(t.name);
    assert.deepEqual(s.showing(), [t.name]);
    assert.deepEqual(s.selected(), [t.name]);
    assert.equal(s.active(), t.name);
    assert.deepEqual(s.tabs.map(x => x.tabIndex), TABS.map(x => (x.name === t.name ? 0 : -1)));
  }
});

test("the Notes tab looked at is the owner's inbox looked at — every time, and only that tab", () => {
  const s = stand();
  s.showLobbyTab("create");
  assert.equal(s.inboxLooks(), 0);
  s.showLobbyTab("mail");
  s.showLobbyTab("mail");
  assert.equal(s.inboxLooks(), 2, "looked at again: what came since is read too");
});

test("a name that is not a tab changes nothing", () => {
  const s = stand();
  s.showLobbyTab("create");
  for (const bad of ["", "settings", undefined, "__proto__"]) {
    s.showLobbyTab(bad);
    assert.deepEqual(s.showing(), ["create"]);
  }
});

test("going to Rooms refreshes the list; staying on it does not ask again", () => {
  const s = stand();
  s.showLobbyTab("rooms");                 // already there on arrival
  assert.equal(s.listRequests(), 0);
  s.showLobbyTab("create");
  s.showLobbyTab("rooms");
  assert.equal(s.listRequests(), 1);
  s.showLobbyTab("rooms");
  assert.equal(s.listRequests(), 1);
});

test("arrow keys move along the tabs and wrap; Home and End go to the ends", () => {
  const target = new Function(`${fn("lobbyTabKeyTarget")}; return lobbyTabKeyTarget;`)();
  assert.equal(target("ArrowRight", 0, 3), 1);
  assert.equal(target("ArrowRight", 2, 3), 0);
  assert.equal(target("ArrowLeft", 0, 3), 2);
  assert.equal(target("ArrowLeft", 1, 3), 0);
  assert.equal(target("Home", 2, 3), 0);
  assert.equal(target("End", 0, 3), 2);
  for (const key of ["Enter", " ", "a", "ArrowDown", "Tab"]) assert.equal(target(key, 1, 3), -1);
});

/* ══════════════════════════════════════════
   The room count on the Rooms tab
══════════════════════════════════════════ */

test("the Rooms tab shows how many rooms are open, and nothing when there are none", () => {
  const el = () => {
    const set = new Set();
    return { textContent: "", dataset: {}, children: [], className: "",
             classList: { toggle: (c, on) => (on ? set.add(c) : set.delete(c)), contains: c => set.has(c) },
             append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); },
             replaceChildren(...c) { this.children = c; } };
  };
  const roomsCount = el(), sessionsList = el();
  const render = new Function(
    "document", "roomsCount", "sessionsList", "t", "I18N", "LANG", "timeAgo",
    "joinOpenRoom", "openCodeJoin", "openPinModal", "G", "isHost", "currentSession",
    `let _lastSessionList = [];\n${fn("renderSessionList")}\nreturn renderSessionList;`
  )({ createElement: el, createTextNode: s => ({ textContent: s }) }, roomsCount, sessionsList,
    k => I18N.en[k], I18N, "en", () => "1m", () => {}, () => {}, () => {}, require("../guards.js"), false, null);

  render([{ sessionId: "a", createdAt: 0 }, { sessionId: "b", createdAt: 0, open: true }]);
  assert.equal(roomsCount.textContent, "2");
  assert.equal(roomsCount.classList.contains("hidden"), false);

  render([]);
  assert.equal(roomsCount.classList.contains("hidden"), true);
  render(undefined);
  assert.equal(roomsCount.classList.contains("hidden"), true);
});

/* ══════════════════════════════════════════
   Your own room in the list
══════════════════════════════════════════ */

function listFor({ isHost, currentSession }) {
  const el = (tag = "div") => ({ tag, textContent: "", dataset: {}, children: [], className: "",
    classList: { toggle() {}, contains: () => false },
    append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); },
    replaceChildren(...c) { this.children = c; } });
  const sessionsList = el();
  new Function(
    "document", "roomsCount", "sessionsList", "t", "I18N", "LANG", "timeAgo",
    "joinOpenRoom", "openCodeJoin", "openPinModal", "G", "isHost", "currentSession",
    `let _lastSessionList = [];\n${fn("renderSessionList")}\nreturn renderSessionList;`
  )({ createElement: el, createTextNode: s => ({ textContent: s }) }, el(), sessionsList,
    k => I18N.en[k], I18N, "en", () => "1m", () => {}, () => {}, () => {}, require("../guards.js"), isHost, currentSession)
  ([{ sessionId: "mine", createdAt: 0 }, { sessionId: "theirs", createdAt: 0 }]);
  return Object.fromEntries(sessionsList.children.map(item => {
    const name = item.children[0].children[0].textContent.replace(/^\S+ /, "");
    const end = item.children[1];
    return [name, end.tag === "button" ? "join" : end.textContent];
  }));
}

test("the room you are hosting says so, with no Join button; every other room can be joined", () => {
  assert.deepEqual(listFor({ isHost: true, currentSession: { sessionId: "mine" } }),
                   { mine: I18N.en.roomYours, theirs: "join" });
});

test("a guest, or someone with no room, sees Join on every room", () => {
  assert.deepEqual(listFor({ isHost: false, currentSession: { sessionId: "mine" } }), { mine: "join", theirs: "join" });
  assert.deepEqual(listFor({ isHost: false, currentSession: null }), { mine: "join", theirs: "join" });
});
