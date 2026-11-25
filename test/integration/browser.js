/*
  A real browser for a test: Chromium, driven over its DevTools protocol.

  Every other test runs app.js against stand-ins — a <video> that is an
  object, a connection that is a class with two methods. Those cannot show a
  picture going black, a player restarting, or a figure that never fills in,
  and three such faults reached phones at once (a grey "play" picture, a black
  flash with flicker as a call starts, the incoming video's figures empty).
  This drives the real page in a real engine, with a fake camera and
  microphone, so a call is a call.

  No package: Node's own WebSocket speaks the protocol. Not a test file
  itself — call.test.js uses it. Skipped where no Chromium or Chrome is found
  (CHROME_PATH names one explicitly).
*/

"use strict";

const { spawn, execFileSync } = require("node:child_process");
const fs   = require("node:fs");
const os   = require("node:os");
const path = require("node:path");

function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try { return execFileSync("which", [name], { encoding: "utf8" }).trim() || null; } catch (_) {}
  }
  return null;
}

/** One protocol connection: send() resolves with the answer to that call. */
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let next = 1;
    const waiting = new Map();
    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      const w = msg.id && waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(`${w.method}: ${msg.error.message}`));
      else w.resolve(msg.result);
    };
    ws.onerror = () => reject(new Error(`could not reach the browser at ${url}`));
    ws.onopen = () => resolve({
      send(method, params = {}) {
        const id = next++;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => waiting.set(id, { resolve: res, reject: rej, method }));
      },
      close() { try { ws.close(); } catch (_) {} }
    });
  });
}

/**
 * Starts a browser of its own — its own profile, so two of them are two
 * devices, not two tabs sharing one storage — and hands back its page.
 * `setup` runs in the page before any of the page's own scripts, on every load.
 */
async function openBrowser(binary, setup) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ortoo-browser-"));
  const proc = spawn(binary, [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--use-fake-ui-for-media-stream",          // camera and microphone allowed, no prompt
    "--use-fake-device-for-media-stream",      // a moving test picture and a tone
    "--autoplay-policy=no-user-gesture-required",
    "--disable-features=WebRtcHideLocalIpsWithMdns",   // plain local addresses: no mDNS on a test machine
    /* GitHub's Ubuntu runners forbid the user namespaces Chrome's sandbox is
       built on, and Chrome dies at once without a word. The test browser only
       ever opens this test's own local page. */
    ...(process.env.CI ? ["--no-sandbox"] : []),
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const endpoint = await new Promise((resolve, reject) => {
    let said = "";
    const fail = setTimeout(() => reject(new Error(`browser did not start. It printed:\n${said}`)), 30_000);
    proc.stderr.on("data", chunk => {
      said = (said + chunk).slice(-4000);
      const m = said.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(fail); resolve(m[1]); }
    });
    proc.on("exit", (code, signal) => { clearTimeout(fail); reject(new Error(`browser ${binary} ended (${signal || `code ${code}`}). It printed:\n${said}`)); });
  });

  const port = new URL(endpoint).port;
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find(t => t.type === "page");
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: setup });

  const page = {
    goto: url => cdp.send("Page.navigate", { url }),
    /** The value of `expr`, run in the page — awaited if it is a promise. */
    async eval(expr) {
      const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`in the page: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    },
    /** Waits for `expr` to be truthy in the page, or fails naming it. */
    async waitFor(expr, what, ms = 60_000) {
      const end = Date.now() + ms;
      let last = null;
      while (Date.now() < end) {
        try { const v = await page.eval(expr); if (v) return v; } catch (e) { last = e; }
        await new Promise(r => setTimeout(r, 200));
      }
      throw new Error(`timed out after ${ms / 1000}s waiting for ${what}${last ? ` (last error: ${last.message})` : ""}`);
    },
    async close() {
      cdp.close();
      await new Promise(resolve => {
        if (proc.exitCode !== null) return resolve();
        const hard = setTimeout(() => proc.kill("SIGKILL"), 5000);
        proc.once("exit", () => { clearTimeout(hard); resolve(); });
        proc.kill();
      });
      /* On Windows the browser can hold its files a moment after it ends: one
         run in three failed here with EPERM, after the call itself passed. A
         left-over temporary folder is not a failed call. */
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (_) { /* left in temp */ }
    }
  };
  return page;
}

module.exports = { findBrowser, openBrowser };
