/*
  The app's own files from this server: compressed, and kept.

  Asked about speed: the page's files went out exactly as on disk — app.js
  alone 454 KB — and every visit asked again about each of them. Now they go
  compressed (brotli, else gzip), a file asked for with the current build is
  kept by the browser for a year, and anything else is asked about each time
  and answered "not modified" when it is not. See "THE APP'S OWN FILES" in
  server.js. A real server, real requests.
*/

"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const http   = require("node:http");
const path   = require("node:path");
const zlib   = require("node:zlib");
const { startServer, waitForServer, stopServer } = require("./serve.js");

const PORT = 3193;
const ROOT = path.join(__dirname, "..", "..");
const BUILD = fs.readFileSync(path.join(ROOT, "app.js"), "utf8").match(/^const APP_BUILD = "([^"]+)";/m)[1];

function get(urlPath, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers, timeout: 5000 }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

const unpack = r => (r.headers["content-encoding"] === "br" ? zlib.brotliDecompressSync(r.body)
                   : r.headers["content-encoding"] === "gzip" ? zlib.gunzipSync(r.body) : r.body);

let server;
test.before(async () => {
  /* STATIC_SETTLE_MS: a fresh checkout's app.js may be only seconds old. */
  server = startServer({ PORT: String(PORT), STATIC_SETTLE_MS: "0" });
  await waitForServer(server, async () => (await get("/api/ping")).status === 200);
});
test.after(() => stopServer(server));

test("compressed where the browser takes it — brotli first, gzip else — and the same file underneath", async () => {
  const file = fs.readFileSync(path.join(ROOT, "app.js"));
  const gz = await get("/app.js", { "Accept-Encoding": "gzip" });
  assert.equal(gz.headers["content-encoding"], "gzip");
  assert.ok(gz.body.length < file.length / 3, `gzip: ${gz.body.length} of ${file.length}`);
  assert.deepEqual(unpack(gz), file);
  assert.match(gz.headers.vary, /Accept-Encoding/i, "a cache in between must keep them apart");

  /* Brotli is worked out in the background: gzip goes until it is ready. */
  let br;
  for (let i = 0; i < 50; i++) {
    br = await get("/app.js", { "Accept-Encoding": "gzip, deflate, br" });
    if (br.headers["content-encoding"] === "br") break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(br.headers["content-encoding"], "br");
  assert.ok(br.body.length < gz.body.length, `brotli ${br.body.length}, smaller than gzip ${gz.body.length}`);
  assert.deepEqual(unpack(br), file);
  assert.match(br.headers["content-type"], /javascript/);
  assert.equal(Number(br.headers["content-length"]), br.body.length);

  const plain = await get("/app.js");
  assert.equal(plain.headers["content-encoding"], undefined, "a browser that asks for none gets none");
  assert.deepEqual(plain.body, file);
});

test("the page and its styles compressed too; fonts and pictures, already compressed, left as they are", async () => {
  for (const [url, file] of [["/", "index.html"], ["/style.css", "style.css"], ["/i18n.js", "i18n.js"]]) {
    const r = await get(url, { "Accept-Encoding": "gzip" });
    assert.equal(r.headers["content-encoding"], "gzip", url);
    assert.deepEqual(unpack(r), fs.readFileSync(path.join(ROOT, file)), url);
  }
  for (const url of ["/vendor/tabler/fonts/tabler-icons.woff2", "/icons/icon-192.png"]) {
    const r = await get(url, { "Accept-Encoding": "gzip, br" });
    assert.equal(r.status, 200, url);
    assert.equal(r.headers["content-encoding"], undefined, url);
  }
});

test("nothing but the app's own files is compressed: no secret is ever mixed into one", async () => {
  const ping = await get("/api/ping", { "Accept-Encoding": "gzip, br" });
  assert.equal(ping.status, 200);
  assert.equal(ping.headers["content-encoding"], undefined);
});

test("asked for with the current build: kept for a year; anything else asked about each time", async () => {
  const kept = await get(`/app.js?v=${BUILD}`);
  assert.equal(kept.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal((await get(`/vendor/tabler/tabler-icons.min.css?v=${BUILD}`)).headers["cache-control"], "public, max-age=31536000, immutable");
  for (const url of ["/app.js", "/app.js?v=202601010000-00000000", "/", "/sw.js", "/vendor/tabler/fonts/tabler-icons.woff2?v3.31.0"]) {
    assert.equal((await get(url)).headers["cache-control"], "no-cache", `${url}: asked about every time`);
  }
});

test("asked about again, unchanged: \"not modified\", nothing sent", async () => {
  const first = await get("/style.css", { "Accept-Encoding": "gzip" });
  assert.ok(first.headers.etag);
  const again = await get("/style.css", { "Accept-Encoding": "gzip", "If-None-Match": first.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  /* Another encoding is another file: not taken for the one it holds. */
  const other = await get("/style.css", { "If-None-Match": first.headers.etag });
  assert.equal(other.status, 200);
});

test("HEAD answers with the headers alone; a file not on the list is not served", async () => {
  const head = await get("/app.js", { "Accept-Encoding": "gzip" }, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers["content-encoding"], "gzip");
  assert.equal((await get("/server.js")).status, 404);
  assert.equal((await get("/package.json")).status, 404);
});

test("an update's files are not kept until they have been still a while", () => {
  /* settledBuild() lifted out of server.js and run against a stand-in disk. */
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8").replace(/\r\n/g, "\n");
  const body = src.match(/^let staticBuild = [\s\S]*?^function settledBuild\([\s\S]*?^\}/m);
  assert.ok(body, "settledBuild not found in server.js");
  let mtimeMs = 1_000_000;
  const disk = { statSync: () => ({ mtimeMs }), readFileSync: () => `const APP_BUILD = "${BUILD}";\n` };
  const settledBuild = new Function("fs", "path", "__dirname", "STATIC_SETTLE_MS", `${body[0]}\nreturn settledBuild;`)(disk, path, ROOT, 10_000);
  assert.equal(settledBuild(mtimeMs + 3_000), null, "written 3 s ago: an update may still be writing");
  assert.equal(settledBuild(mtimeMs + 10_000), BUILD, "still for 10 s: its build");
  mtimeMs = 2_000_000;
  assert.equal(settledBuild(mtimeMs + 1_000), null, "written again: wait again");
});

test("which encodings a browser takes: its own q=0 says no, \"*\" stands for the rest", () => {
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8").replace(/\r\n/g, "\n");
  const body = src.match(/^function takesEncoding\([\s\S]*?^\}/m);
  assert.ok(body, "takesEncoding not found in server.js");
  const takes = new Function(`${body[0]}\nreturn takesEncoding;`)();
  assert.equal(takes("gzip, deflate, br, zstd", "br"), true, "Chrome's list: brotli, though named after gzip");
  assert.equal(takes("gzip, deflate, br", "gzip"), true);
  assert.equal(takes("gzip;q=1.0, br;q=0", "br"), false);
  assert.equal(takes("*", "gzip"), true);
  assert.equal(takes("*;q=0.5, br;q=0", "br"), false, "named beats *");
  assert.equal(takes("identity", "gzip"), false);
  assert.equal(takes(undefined, "gzip"), false);
  assert.equal(takes("", "br"), false);
});
