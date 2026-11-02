/*
  The shield and its panel, actually run.

  client-source.test.js reads app.js as text and checks that the right calls
  are there. That was not enough for this: an early `return` in updateShield()
  left the panel's sentence — the one saying who can read the chat — never
  redrawn, and every text-level check still passed, because the call was still
  written in the file.

  So updateShield() and renderShieldFacts() are lifted out of app.js and run
  here against stand-in elements, with the real guards.js and connstats.js
  behind them. What is asserted is what ends up on screen.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const G   = require("../guards.js");
const DCS = require("../connstats.js");
const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

const grab = (pattern, what) => {
  const m = app.match(pattern);
  assert.ok(m, `${what} not found in app.js`);
  return m[0];
};
const SOURCE = [
  grab(/^const SHIELD_LOOK = \{[\s\S]*?^\};/m,               "SHIELD_LOOK"),
  grab(/^function updateShield\(\)\s*\{[\s\S]*?^\}/m,        "updateShield"),
  grab(/^const MESSAGE_CIPHER_ECDH\s*=\s*"[^"]*";/m,         "MESSAGE_CIPHER_ECDH"),
  grab(/^const MESSAGE_CIPHER_SPAKE2\s*=\s*"[^"]*";/m,       "MESSAGE_CIPHER_SPAKE2"),
  grab(/^const CALL_CIPHER\s*=\s*"[^"]*";/m,                 "CALL_CIPHER"),
  grab(/^function renderShieldFacts\(\)\s*\{[\s\S]*?^\}/m,   "renderShieldFacts")
].join("\n");

const ELEMENTS = ["keyVerifyDropdown", "keyVerifyBtn", "keyVerifyIcon", "factWhoCanRead", "factCipherValue",
                  "factCallsValue", "factPathValue", "factYourIpValue", "factPeerIpValue",
                  "factYourDeviceValue", "factPeerDeviceValue"];

function element() {
  const classes = new Set();
  return {
    textContent: "", className: "", title: "", attributes: {},
    classList: { toggle: (name, on) => { on ? classes.add(name) : classes.delete(name); }, has: name => classes.has(name) },
    setAttribute(name, value) { this.attributes[name] = value; }
  };
}

/** Draws the shield for one situation and hands back what is on screen.
    t() returns the key it was asked for, so a sentence can be named exactly. */
function draw({ ready = false, secure = false, verified = false, path = null, addresses = null,
                peer = null, mine = { os: "android", browser: "chrome" }, keyAgreement = "ECDH" } = {}) {
  const dom = Object.fromEntries(ELEMENTS.map(name => [name, element()]));
  let whereDrawn = 0;      // the owner's "Where are you?" button follows the shield — see where.test.js
  const names  = ["G", "DCS", "t", "e2eReady", "e2eSecureMode", "e2eVerified", "_lastPath", "_lastAddresses", "peerDevice", "MY_DEVICE", "keyAgreement", "drawWhereBtn", ...ELEMENTS];
  const values = [G, DCS, key => key, ready, secure, verified, path, addresses, peer, mine, keyAgreement, () => { whereDrawn++; }, ...ELEMENTS.map(n => dom[n])];
  new Function(...names, `${SOURCE}\nupdateShield();`)(...values);
  return {
    dom,
    whereDrawn,
    shield:   ["idle", "warn", "ok"].filter(s => dom.keyVerifyDropdown.classList.has(`verify-${s}`)),
    icon:     dom.keyVerifyIcon.className,
    label:    dom.keyVerifyBtn.attributes["aria-label"],
    sentence: dom.factWhoCanRead.textContent,
    cipher:   dom.factCipherValue.textContent,
    calls:    dom.factCallsValue.textContent,
    route:    dom.factPathValue.textContent,
    yourIp:   dom.factYourIpValue.textContent,
    theirIp:  dom.factPeerIpValue.textContent,
    yours:    dom.factYourDeviceValue.textContent,
    theirs:   dom.factPeerDeviceValue.textContent
  };
}

/* ══════════════════════════════════════════
   Who can read the chat
══════════════════════════════════════════ */

test("a verified chat is told only the two of them can read it", () => {
  assert.equal(draw({ ready: true, secure: true }).sentence, "factReadOk");
  assert.equal(draw({ ready: true, verified: true }).sentence, "factReadOk");
});

test("an unverified chat is told it is not verified — never that it is private", () => {
  /* The claim is that nobody is in the middle. Unverified, nobody has checked. */
  const seen = draw({ ready: true });
  assert.equal(seen.sentence, "factReadWarn");
  assert.equal(seen.dom.factWhoCanRead.className, "fact-read warn", "and it is coloured like the shield");
});

test("before a key exists the panel promises nothing", () => {
  assert.equal(draw({}).sentence, "factReadIdle");
  /* Flags left over from the last chat must not carry the promise into the next. */
  assert.equal(draw({ ready: false, secure: true, verified: true }).sentence, "factReadIdle");
});

test("the sentence and the shield agree in every situation", () => {
  /* They are drawn by one call so that they cannot differ. Checked against the
     guard itself, for all eight combinations. */
  for (let bits = 0; bits < 8; bits++) {
    const o = { ready: Boolean(bits & 1), secure: Boolean(bits & 2), verified: Boolean(bits & 4) };
    const state = G.shieldState(o);
    const seen  = draw(o);
    const where = JSON.stringify(o);
    assert.deepEqual(seen.shield, [state], `shield class wrong for ${where}`);
    assert.equal(seen.sentence, { idle: "factReadIdle", warn: "factReadWarn", ok: "factReadOk" }[state], `sentence wrong for ${where}`);
    assert.equal(seen.sentence === "factReadOk", state === "ok", `"only the two of you" shown when the shield is ${state}: ${where}`);
    assert.ok(seen.label, `no readable label for ${where}`);
    assert.equal(seen.whereDrawn, 1, `the owner's "Where are you?" button is not redrawn for ${where}`);
  }
});

test("each state has its own glyph", () => {
  const icons = [draw({}), draw({ ready: true }), draw({ ready: true, verified: true })].map(s => s.icon);
  assert.equal(new Set(icons).size, 3, `two states share a glyph: ${icons}`);
  assert.ok(!/shield-check/.test(draw({ ready: true }).icon), "an unverified chat must not be drawn with a tick");
});

/* ══════════════════════════════════════════
   Encryption
══════════════════════════════════════════ */

test("the encryption is named once there is a key, and not before", () => {
  const live = draw({ ready: true });
  assert.match(live.cipher, /AES-256-GCM/);
  assert.match(live.cipher, /ECDH P-256/);
  assert.equal(live.calls, "DTLS-SRTP");

  const idle = draw({});
  assert.equal(idle.cipher, "—", "nothing is encrypted yet, so nothing is claimed");
  assert.equal(idle.calls, "—");
});

/* ══════════════════════════════════════════
   Addresses
══════════════════════════════════════════ */

const DIRECT = { kind: "direct" };

test("both addresses are shown on a direct connection", () => {
  const seen = draw({ ready: true, path: DIRECT, addresses: { local: "203.0.113.7", remote: "198.51.100.24" } });
  assert.equal(seen.route, "pathDirect");
  assert.equal(seen.yourIp, "203.0.113.7");
  assert.equal(seen.theirIp, "198.51.100.24");
  assert.ok(seen.dom.factYourIpValue.classList.has("mono") && !seen.dom.factYourIpValue.classList.has("quiet"));
});

test("an address the browser hides is said to be hidden", () => {
  const seen = draw({ ready: true, path: { kind: "local" }, addresses: { local: null, remote: "192.168.1.31" } });
  assert.equal(seen.yourIp, "factHidden");
  assert.equal(seen.theirIp, "192.168.1.31");
  assert.ok(seen.dom.factYourIpValue.classList.has("quiet") && !seen.dom.factYourIpValue.classList.has("mono"),
    "words must not be set like an address");
});

test("with no route, or a relayed one, there is a dash and not an address", () => {
  for (const path of [null, { kind: "relayed" }]) {
    const seen = draw({ ready: true, path, addresses: null });
    assert.equal(seen.yourIp, "—");
    assert.equal(seen.theirIp, "—");
    assert.ok(!seen.dom.factYourIpValue.classList.has("quiet"), "a dash is not 'hidden' — there is nothing to hide");
  }
  assert.equal(draw({ ready: true, path: { kind: "relayed" } }).route, "pathRelayed");
  assert.equal(draw({ ready: true }).route, "—");
});

/* ══════════════════════════════════════════
   Devices
══════════════════════════════════════════ */

test("each side's device is shown in our own words", () => {
  const seen = draw({ ready: true, peer: { os: "iphone", browser: "safari" } });
  assert.equal(seen.yours, "Android · Chrome");
  assert.equal(seen.theirs, "iPhone · Safari");
});

test("a device the other side has not described is unknown, not blank and not invented", () => {
  assert.equal(draw({ ready: true, peer: null }).theirs, "factUnknown");
  assert.equal(draw({ ready: true, peer: { os: "other", browser: "other" } }).theirs, "factUnknown");
});

test("nothing the other side wrote appears in the panel", () => {
  const planted = "✅ verified by server";
  const seen = draw({ ready: true, peer: { os: planted, browser: "<b>trusted</b>", note: planted } });
  assert.equal(seen.theirs, "factUnknown");
  for (const name of ELEMENTS) {
    const el = seen.dom[name];
    for (const text of [el.textContent, el.className, el.title, JSON.stringify(el.attributes)]) {
      assert.ok(!text.includes(planted) && !text.includes("<b>"), `${name} carries the peer's text`);
    }
  }
});

test("no chat means no device is claimed for the other side", () => {
  /* Even if a description is somehow still held from before. */
  assert.equal(draw({ ready: false, peer: { os: "iphone", browser: "safari" } }).theirs, "—");
});

test("a code room's panel names SPAKE2 as the key exchange", () => {
  /* The cipher line follows how the key was actually agreed. */
  assert.match(draw({ ready: true, verified: true, keyAgreement: "SPAKE2" }).cipher, /SPAKE2 P-256/);
  assert.match(draw({ ready: true, keyAgreement: "ECDH" }).cipher, /ECDH P-256/);
});
