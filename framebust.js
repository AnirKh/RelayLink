/*
  ─────────────────────────────────────────────
  RelayLink — framebust.js
  ─────────────────────────────────────────────

  Stops the app being operated inside someone else's page.

  server.js sends `X-Frame-Options: DENY` and `frame-ancestors 'none'`, which
  covers the copy the server serves itself. Neither reaches the GitHub Pages build: Pages
  serves static files and cannot set headers, and browsers ignore
  frame-ancestors in a <meta> tag. So on Pages there was nothing at all — the
  page could be framed invisibly and its buttons clicked through, including
  Accept on an incoming call, which opens the camera and microphone.

  This is the only mechanism that works there, so it has to hold on its own:

    1. index.html hides the page up front with #antiClickjack. Nothing is
       visible or clickable until this file decides it is safe. Failing closed
       matters — if this script never runs, the page stays blank rather than
       becoming a clickable target.
    2. Not framed  → remove that style, carry on as normal.
    3. Framed      → stop parsing before app.js can load and connect, then
       replace the page with a notice and a link to open it properly.

  Loaded from <head>, before anything else, and deliberately dependency-free:
  it must run even if every other file fails.

  CSP note: script-src is 'self', so this cannot be inlined the way a classic
  framebuster is. It has to be its own file.
*/

(function () {
  "use strict";

  var framed;
  try {
    framed = window.self !== window.top;
  } catch (_) {
    /* Reading window.top across origins can throw. Something is wrapping us. */
    framed = true;
  }

  /** Undo the pre-emptive hide in index.html. */
  function reveal() {
    var style = document.getElementById("antiClickjack");
    if (style && style.parentNode) style.parentNode.removeChild(style);
  }

  if (!framed) {
    reveal();
    return;
  }

  /* Try to replace the framing page outright. Works unless the frame is
     sandboxed without allow-top-navigation, which is the case worth planning
     for — an attacker chooses the sandbox flags. */
  try {
    window.top.location = window.self.location.href;
  } catch (_) { /* blocked — fall through to the notice */ }

  /* Navigation was refused or is still pending. Halt parsing so app.js never
     loads: inside a frame it must not open a WebSocket, create a room, or leave
     any control on screen to be clicked. */
  try { window.stop(); } catch (_) { /* not supported — the CSS hide still holds */ }

  var noticeShown = false;
  function showNotice() {
    if (noticeShown) return;      // both triggers below may fire
    noticeShown = true;
    var body = document.body;
    if (!body) {
      body = document.createElement("body");
      document.documentElement.appendChild(body);
    }
    body.replaceChildren();

    /* These hexes are the one place the palette is repeated rather than read
       from style.css. window.stop() above can end parsing before the
       stylesheet loads, so a var() here would resolve to nothing and leave
       unreadable text. Keep them in step with :root in style.css by hand. */
    var wrap = document.createElement("div");
    wrap.style.cssText =
      "font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;" +
      "background:#15151a;color:#e8e5de;min-height:100vh;margin:0;" +
      "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
      "gap:14px;text-align:center;padding:24px;box-sizing:border-box";

    var icon = document.createElement("div");
    icon.textContent = "⚠️";
    icon.style.cssText = "font-size:40px";

    /* i18n.js never loaded, so both languages are spelled out here. */
    var mn = document.createElement("p");
    mn.textContent = "Энэ аппыг өөр вэб сайтын дотор ажиллуулах боломжгүй.";
    mn.style.cssText = "margin:0;font-size:16px;font-weight:600";

    var en = document.createElement("p");
    en.textContent = "This app cannot run inside another website.";
    en.style.cssText = "margin:0;font-size:14px;color:#9b98a4";

    var link = document.createElement("a");
    link.href = window.self.location.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Шууд нээх / Open directly";
    link.style.cssText =
      "margin-top:6px;padding:10px 18px;border-radius:8px;background:#7fa8d4;" +
      "color:#12121a;text-decoration:none;font-size:14px";

    wrap.append(icon, mn, en, link);
    body.appendChild(wrap);
    reveal();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", showNotice);
    /* window.stop() can end parsing without firing DOMContentLoaded, so do not
       rely on it alone. */
    setTimeout(showNotice, 0);
  } else {
    showNotice();
  }
})();
