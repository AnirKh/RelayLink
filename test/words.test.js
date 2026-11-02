/*
  The last English, in the user's language.

  - The server's refusals — a room name taken or not allowed, too many rooms,
    a message it would not send — were shown as it wrote them, in English, to
    Mongolian readers too; and one passed on whatever the mail service said,
    as "detail". The server now says why with a code, and the page says it.
  - Nine of the chat's icon buttons were named in English only, so a screen
    reader read them in English whatever the page's language.

  The room-refusal case and leaveErrorText are lifted out of app.js and run;
  server.js and index.html are read. The server's answers themselves are
  checked in test/integration/server.test.js.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");
const G      = require("../guards.js");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8").replace(/\r\n/g, "\n");
const app    = read("app.js");
const server = read("server.js");
const html   = read("index.html");
const I18N = new Function("localStorage", `${read("i18n.js")}; return I18N;`)({ getItem: () => null });
const between = (from, to) => {
  const a = app.indexOf(from), b = app.indexOf(to, a);
  assert.ok(a > 0 && b > a, `${from} … ${to} not found in app.js`);
  return app.slice(a, b);
};
const fn = name => {
  const m = app.match(new RegExp(`^(?:async )?function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(m, `${name} not found as a top-level function in app.js`);
  return m[0];
};

/* ══════════════════════════════════════════
   A room the server would not make
══════════════════════════════════════════ */

test("each of the server's room refusals has words, in both languages", () => {
  assert.deepEqual(Object.keys(G.SERVER_ERROR_KEYS).sort(), ["invalid-name", "name-taken", "too-many-rooms"]);
  for (const key of Object.values(G.SERVER_ERROR_KEYS)) {
    for (const lang of ["mn", "en"]) assert.equal(typeof I18N[lang][key], "string", `${lang}.${key}`);
  }
  assert.equal(G.serverErrorKey("name-taken"), "roomNameTaken");
  for (const code of [undefined, null, 7, "", "toString", "__proto__", "something-new"]) {
    assert.equal(G.serverErrorKey(code), null, String(code));
  }
});

const ERROR_CASE = between('    case "error": {', '    case "pin-error": {');

function refusal(data, { autoJoin = false, lang = "mn", meeting = false } = {}) {
  const log = { toasts: [], status: [], ended: 0 };
  new Function("G", "t", "console", "document", "lobbyStatus", "createInfo", "showToast", "autoJoinSettled",
    "setLobbyButtons", "setCreateButtons", "settlePinJoin", "endMeeting", "start", `
    let _isAutoJoin = start.autoJoin, isConnecting = true, pendingCreate = {};
    let pendingMeet = start.meeting ? { type: "meet-session" } : null;
    function deliver(data) { switch (data.type) {\n${ERROR_CASE}\n} }
    deliver(start.data);`
  )(G, k => I18N[lang][k], { error() {} }, { createElement: () => ({ style: {}, textContent: "" }) },
    { replaceChildren: el => log.status.push(el.textContent) }, {}, m => log.toasts.push(m), () => {},
    () => {}, () => {}, () => {}, () => { log.ended++; }, { autoJoin, data, meeting });
  return log;
}

test("a tap on a saved person that the server refuses ends the wait, and says why in a toast — on an invite page too", () => {
  for (const autoJoin of [false, true]) {
    const log = refusal({ type: "error", code: "too-many-rooms", message: "x" }, { meeting: true, autoJoin });
    assert.equal(log.ended, 1, "the person's row is a name to tap again");
    assert.deepEqual(log.toasts, [I18N.mn.tooManyRooms]);
    assert.deepEqual(log.status, [], "not the invite's status line: this was no invite");
  }
  assert.equal(refusal({ type: "error", code: "name-taken", message: "x" }).ended, 0, "and only a tap on a person");
});

test("a room name already taken is said in Mongolian — it was shown in the server's English", () => {
  assert.deepEqual(refusal({ type: "error", code: "name-taken", message: "Session name is already in use" }).toasts,
    [I18N.mn.roomNameTaken]);
  assert.deepEqual(refusal({ type: "error", code: "invalid-name", message: "Invalid session name" }, { lang: "en" }).toasts,
    [I18N.en.roomNameInvalid]);
  assert.deepEqual(refusal({ type: "error", code: "too-many-rooms", message: "x" }).toasts, [I18N.mn.tooManyRooms]);
});

test("on an invite page it is said on the status line, in the same words", () => {
  assert.deepEqual(refusal({ type: "error", code: "name-taken", message: "x" }, { autoJoin: true }).status,
    [`❌ ${I18N.mn.roomNameTaken}`]);
});

test("a refusal with no code, or one this page does not know, is shown as the server wrote it", () => {
  const notice = "Шинэ хувилбар гарлаа — хуудсаа хааж дахин нээнэ үү. · A new version is out";
  assert.deepEqual(refusal({ type: "error", message: notice }).toasts, [notice]);
  assert.deepEqual(refusal({ type: "error", code: "from-the-future", message: "Later" }).toasts, ["Later"]);
});

test("the server names every room refusal it sends — all but the bilingual reload notice", () => {
  const sends = [...server.matchAll(/ws\.send\(JSON\.stringify\(\{ type: "error",([^}]*)\}\)\)/g)].map(m => m[1]);
  assert.ok(sends.length >= 4, `expected the server's error sends, found ${sends.length}`);
  for (const body of sends) {
    if (/message: RELOAD_NOTICE/.test(body)) continue;
    assert.match(body, /code: "[a-z-]+"/, `no code: ${body.trim()}`);
  }
});

/* ══════════════════════════════════════════
   A note that was not left
══════════════════════════════════════════ */

function leaveSays(code, lang = "mn") {
  return new Function("I18N", "LANG", "t", "noteFileMaxMb", `${fn("leaveErrorText")}; return leaveErrorText;`)(
    I18N, lang, k => I18N[lang][k], () => 25)(code);
}

test("why a note was not left, in the user's language", () => {
  assert.equal(leaveSays("no-inbox"), I18N.mn.noteNoInbox);
  assert.equal(leaveSays("no-answer", "en"), I18N.en.networkErr);
  assert.equal(leaveSays("too-many"), I18N.mn.noteTooMany);
  for (const code of ["full", "server-full"]) assert.equal(leaveSays(code), I18N.mn.noteInboxFull, code);
  assert.equal(leaveSays("too-large"), I18N.mn.leaveFileTooBig(25));
  assert.equal(leaveSays("busy"), I18N.mn.mailTryLater);
  assert.equal(leaveSays("off"), I18N.mn.mailFilesOff);
  for (const other of ["invalid", "constructor", undefined, null, 7]) assert.equal(leaveSays(other), I18N.mn.noteFailed, String(other));
});

test("every refusal of a request from the server carries a code", () => {
  const answers = server.split("\n").filter(line => /res\.status\(\d+\)\.json\(/.test(line));
  assert.ok(answers.length >= 4, `expected the server's refusals, found ${answers.length}`);
  for (const line of answers) assert.match(line, /code: "[a-z-]+"/, `no code: ${line.trim()}`);
});

test("the words for a note not left are in both languages", () => {
  for (const key of ["noteNoInbox", "noteTooMany", "noteInboxFull", "noteFailed", "noteTooLong", "leaveFileTooBig", "writeFirst",
                     "networkErr", "mailTryLater", "mailFilesOff"]) {
    for (const lang of ["mn", "en"]) assert.ok(key in I18N[lang], `${lang}.${key}`);
  }
});

/* ══════════════════════════════════════════
   Buttons a screen reader names
══════════════════════════════════════════ */

test("no button is named in English only — each takes its name from the page's language", () => {
  for (const id of ["toggleMuteBtn", "toggleCamBtn", "endCallBtn", "leaveBtn", "voiceCallBtn", "videoCallBtn",
                    "attachBtn", "voiceRecordBtn", "sendBtn"]) {
    const tag = html.match(new RegExp(`<button id="${id}"[^>]*>`));
    assert.ok(tag, `${id} not found`);
    const key = tag[0].match(/data-i18n-aria="([^"]+)"/);
    assert.ok(key, `${id} is named in one language only`);
    for (const lang of ["mn", "en"]) assert.equal(typeof I18N[lang][key[1]], "string", `${lang}.${key[1]}`);
  }
  const english = [...html.matchAll(/aria-label="([A-Za-z][A-Za-z ]*)"/g)].map(m => m[1]);
  assert.deepEqual(english, [], "an English-only name is left in the page");
});
