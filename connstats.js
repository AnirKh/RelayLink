/*
  ─────────────────────────────────────────────
  RelayLink — connstats.js
  ─────────────────────────────────────────────

  Everything the UI derives from an RTCStatsReport, as pure functions of it.

  Extracted because the reading was wrong for a long time and nothing could
  see it: the old code scanned every local-candidate and kept whichever came
  last, so with more than one route it named a candidate that was not carrying
  traffic. A browser and two peers were needed to notice. Here a plain Map
  stands in for the report and the answer can simply be asserted.

  Nothing in this file touches the DOM or any module state — pass the report in,
  get the answer back.

  Two things here feed the shield's panel and are not about quality at all:
  which addresses the two devices are showing each other, and a coarse
  description of a device. They live here because they are derived facts of the
  same kind — and the second because what a peer says about its device is
  untrusted, and the list of what may be displayed should sit next to the code
  that displays it.
*/

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DCStats = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /** RTT thresholds for the quality label, in milliseconds. */
  const RTT_GOOD = 80;
  const RTT_FAIR = 250;

  /**
   * The candidate pair ICE actually settled on.
   *
   * transport.selectedCandidatePairId names it outright where the browser
   * provides it. The scan is a fallback: several pairs can reach "succeeded"
   * and only one carries traffic, so a nominated pair always wins over a merely
   * successful one.
   */
  function selectedCandidatePair(stats) {
    if (!stats || typeof stats.forEach !== "function") return null;

    let transport = null;
    stats.forEach(r => { if (r && r.type === "transport") transport = r; });
    if (transport && transport.selectedCandidatePairId && typeof stats.get === "function") {
      const named = stats.get(transport.selectedCandidatePairId);
      if (named) return named;
    }

    let pair = null;
    stats.forEach(r => {
      if (!r || r.type !== "candidate-pair" || r.state !== "succeeded") return;
      if (r.nominated || !pair) pair = r;
    });
    return pair;
  }

  /**
   * How the two sides are reaching each other.
   *
   *   local    both ends are host candidates — the traffic never left the
   *            local network
   *   direct   peer to peer across the internet
   *   relayed  a TURN server is carrying every packet
   *
   * "relayed" is the one worth surfacing. The payload stays end-to-end
   * encrypted either way, but a relay learns who is talking to whom and for how
   * long, which is a different trust situation. Relay on *either* side counts —
   * one relayed leg is enough for a third party to be in the path.
   *
   * @returns {{kind: string, local: object, remote: object}|null} null while ICE
   *          is still deciding, or when the report is incomplete.
   */
  function describePath(stats) {
    const pair = selectedCandidatePair(stats);
    if (!pair || typeof stats.get !== "function") return null;
    const local  = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    if (!local || !remote) return null;

    const types = [local.candidateType, remote.candidateType];
    let kind;
    if (types.includes("relay"))             kind = "relayed";
    else if (types.every(t => t === "host")) kind = "local";
    else                                     kind = "direct";
    return { kind, local, remote };
  }

  /* ══════════════════════════════════════════
     Addresses
  ══════════════════════════════════════════ */

  /**
   * A candidate's address, or null when the browser is keeping it back.
   *
   * Browsers hide a device's own network address from the page: a local
   * address arrives as a random `….local` name, and some remote ones arrive
   * blank. Neither is an address anyone could use, so neither is shown as one.
   */
  function usableAddress(candidate) {
    const address = candidate && (candidate.address || candidate.ip);
    if (typeof address !== "string" || address === "") return null;
    if (/\.local\.?$/i.test(address)) return null;
    return address;
  }

  const isV6 = address => typeof address === "string" && address.indexOf(":") !== -1;

  /**
   * An address on the open internet — the only kind a city can be looked up
   * for. A home network's (10/8, 172.16/12, 192.168/16), a mobile carrier's
   * shared one (100.64/10), loopback, link-local, multicast and IPv6's local
   * and unique-local ranges are not; IPv6 counts only as global unicast (2000::/3).
   */
  function isPublicAddress(address) {
    if (typeof address !== "string") return false;
    const v4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
      const [a, b, c, d] = v4.slice(1).map(Number);
      if ([a, b, c, d].some(n => n > 255)) return false;
      if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
      if (a === 100 && b >= 64 && b <= 127) return false;
      if (a === 169 && b === 254) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 192 && b === 168) return false;
      return true;
    }
    return isV6(address) && /^[0-9a-f:]+$/i.test(address) && /^[23][0-9a-f]{0,3}:/i.test(address);
  }

  /**
   * This device's public address, as a STUN server reported it.
   *
   * Needed because the route in use almost never names it. ICE files a
   * server-reflexive candidate under the local one it was discovered from, so
   * the chosen pair's local end is the device's address on its own network —
   * 192.168.x.x, or hidden altogether — while what the other side actually
   * sees is the public one. That is the one worth showing under "your IP".
   *
   * A device can have several (IPv4 and IPv6). The one in the same family as
   * the route is the one in use; with nothing to go on, any is still true.
   */
  function publicLocalAddress(stats, family) {
    let sameFamily = null, any = null;
    stats.forEach(r => {
      if (!r || r.type !== "local-candidate" || r.candidateType !== "srflx") return;
      const address = usableAddress(r);
      if (!address) return;
      if (!any) any = address;
      if (!sameFamily && family !== null && isV6(address) === family) sameFamily = address;
    });
    return family === null ? any : sameFamily;
  }

  /**
   * The address each device is showing the other.
   *
   *   direct   your public address, and theirs
   *   local    both addresses on the shared network
   *   relayed  null — a relay stands in for at least one of them, so the
   *            addresses on the route are the relay's, not a device's
   *
   * Either side may come back null: the browser hides what it hides, and a
   * blank is reported as a blank rather than guessed at.
   *
   * @returns {{local: string|null, remote: string|null}|null} null while there
   *          is no route, or when it is relayed.
   */
  function pathAddresses(stats) {
    const path = describePath(stats);
    if (!path || path.kind === "relayed") return null;

    let local    = usableAddress(path.local);
    const remote = usableAddress(path.remote);

    /* A local end that is already server- or peer-reflexive is the public
       address. Only a host candidate needs looking up. */
    if (path.kind === "direct" && path.local.candidateType === "host") {
      const known  = local || remote;
      const family = known ? isV6(known) : null;
      const pub    = publicLocalAddress(stats, family);
      if (pub) local = pub;
    }
    return { local, remote };
  }

  /* ══════════════════════════════════════════
     Devices
  ══════════════════════════════════════════ */

  /* Everything a device can be described as. This is also the complete list of
     what may be DISPLAYED about the other side: a peer sends two short codes,
     and only a code found here turns into text on screen. The description sits
     in the security panel, where "✅ verified by server" typed into a device
     name would be believed. */
  const OS_NAMES = Object.freeze({
    android: "Android", iphone: "iPhone", ipad: "iPad",
    windows: "Windows", macos: "macOS", linux: "Linux", chromeos: "ChromeOS"
  });
  const BROWSER_NAMES = Object.freeze({
    chrome: "Chrome", edge: "Edge", firefox: "Firefox",
    safari: "Safari", samsung: "Samsung Internet", opera: "Opera"
  });

  /**
   * A coarse description of the device this is running on: its system and its
   * browser, nothing finer. No version and no model — the browser no longer
   * gives a model anyway, and the less this says the less it identifies.
   *
   * Order matters in both lists. Nearly every browser claims to be several
   * others — Edge says Chrome and Safari, Chrome says Safari — and an iPad
   * says it is a Mac; only the touch screen gives it away.
   *
   * @param {{userAgent: string, maxTouchPoints: number}} nav
   * @returns {{os: string, browser: string}} codes from the tables above, or "other"
   */
  function describeDevice(nav) {
    const ua    = String((nav && nav.userAgent) || "");
    const touch = Number((nav && nav.maxTouchPoints) || 0);

    let os = "other";
    if      (/Android/i.test(ua))                         os = "android";
    else if (/iPhone|iPod/i.test(ua))                     os = "iphone";
    else if (/iPad/i.test(ua))                            os = "ipad";
    else if (/Macintosh|Mac OS X/i.test(ua) && touch > 1) os = "ipad";
    else if (/Windows/i.test(ua))                         os = "windows";
    else if (/CrOS/.test(ua))                             os = "chromeos";
    else if (/Macintosh|Mac OS X/i.test(ua))              os = "macos";
    else if (/Linux|X11/i.test(ua))                       os = "linux";

    let browser = "other";
    if      (/Edg(?:e|A|iOS)?\//.test(ua))            browser = "edge";
    else if (/OPR\/|Opera/.test(ua))                  browser = "opera";
    else if (/SamsungBrowser\//.test(ua))             browser = "samsung";
    else if (/Firefox\/|FxiOS\//.test(ua))            browser = "firefox";
    else if (/Chrome\/|CriOS\/|Chromium\//.test(ua))  browser = "chrome";
    else if (/Safari\//.test(ua))                     browser = "safari";

    return { os, browser };
  }

  function named(table, code) {
    return typeof code === "string" && Object.prototype.hasOwnProperty.call(table, code) ? table[code] : null;
  }

  /**
   * The text to show for a device — or null when there is nothing safe to say.
   *
   * Takes whatever a peer sent. Nothing it sent reaches the screen: the two
   * codes are looked up, and the words come from the tables above.
   */
  function deviceLabel(device) {
    if (!device || typeof device !== "object") return null;
    const parts = [named(OS_NAMES, device.os), named(BROWSER_NAMES, device.browser)].filter(Boolean);
    return parts.length ? parts.join(" · ") : null;
  }

  /**
   * Quality bucket for a round-trip time.
   * @param {number|null|undefined} seconds as reported by getStats
   * @returns {{ms: number, key: string, cls: string}|null}
   */
  function qualityFromRtt(seconds) {
    if (typeof seconds !== "number" || !isFinite(seconds) || seconds < 0) return null;
    const ms = Math.round(seconds * 1000);
    if (ms < RTT_GOOD) return { ms, key: "connected", cls: "connected" };
    if (ms < RTT_FAIR) return { ms, key: "fair",      cls: "poor" };
    return                     { ms, key: "poor",      cls: "poor" };
  }

  /**
   * Bytes moved in each direction.
   *
   * rtp reports only exist during a call, so a text-only session showed nothing
   * at all until the candidate pair was used as the fallback.
   */
  function trafficTotals(stats, pair) {
    let sent = 0, recv = 0;
    if (stats && typeof stats.forEach === "function") {
      stats.forEach(r => {
        if (!r) return;
        if (r.type === "outbound-rtp") sent += r.bytesSent || 0;
        if (r.type === "inbound-rtp")  recv += r.bytesReceived || 0;
      });
    }
    if (!sent && pair) sent = pair.bytesSent || 0;
    if (!recv && pair) recv = pair.bytesReceived || 0;
    return { sent, recv };
  }

  /**
   * What a video call is receiving and sending, from the call's own stats.
   *
   * Added to find out why a laptop saw nothing of an iPhone: whether the
   * phone sends video at all, whether it reaches the laptop, and whether the
   * laptop decodes it are three different faults, and only these figures tell
   * them apart. Each side is null when there is no video that way.
   *
   * `prev` is the last result, for the rate; the first has none.
   *
   * @returns {{in: object|null, out: object|null, at: number}}
   *          each side {codec, width, height, fps, frames, bytes, kbps}
   */
  function callVideoStats(stats, prev) {
    let inbound = null, outbound = null, at = 0;
    const codecs = {};
    if (stats && typeof stats.forEach === "function") {
      stats.forEach(r => { if (r && r.type === "codec") codecs[r.id] = r.mimeType; });
      stats.forEach(r => {
        if (!r || (r.kind || r.mediaType) !== "video") return;
        if (r.type === "inbound-rtp")  inbound = r;
        /* More than one only while a sender is being swapped; the one carrying
           the picture is the one with the most behind it. */
        if (r.type === "outbound-rtp" && (!outbound || (r.bytesSent || 0) > (outbound.bytesSent || 0))) outbound = r;
        if (r.timestamp > at) at = r.timestamp;
      });
    }
    const side = (r, bytesKey, framesKey, before) => {
      if (!r) return null;
      const bytes = r[bytesKey] || 0;
      const ms = before && r.timestamp > before.at ? r.timestamp - before.at : 0;
      return {
        codec:  (codecs[r.codecId] || "").replace(/^video\//i, "") || null,
        width:  r.frameWidth  || 0,
        height: r.frameHeight || 0,
        fps:    Math.round(r.framesPerSecond || 0),
        frames: r[framesKey] || 0,
        bytes,
        /* bytes over milliseconds × 8 is kilobits a second */
        kbps:   ms ? Math.max(0, Math.round(((bytes - before.bytes) * 8) / ms)) : null
      };
    };
    return {
      in:  side(inbound,  "bytesReceived", "framesDecoded", prev && prev.in  && { at: prev.at, bytes: prev.in.bytes }),
      out: side(outbound, "bytesSent",     "framesSent",    prev && prev.out && { at: prev.at, bytes: prev.out.bytes }),
      at
    };
  }

  /**
   * What a call's sound is doing, from the call's own stats: the rate each
   * way, and how loud — so "nothing sent", "sent but silent" and "arriving
   * but not heard" can be told apart.
   *
   * Added when an Android phone heard nothing from an iPhone: the figures on
   * both phones say which of those it is. `level` is 0–1: what the stats say
   * (audioLevel), or worked out from the energy since last time; null when
   * the browser gives neither. Out, it is the microphone's own level (the
   * media source), which reads exactly 0 only when the phone sends nothing
   * but zeros. Each side is null when there is no sound that way.
   *
   * @returns {{in: object|null, out: object|null, at: number}}
   *          each side {bytes, kbps, level, energy, seconds}
   */
  function callAudioStats(stats, prev) {
    let inbound = null, outbound = null, source = null, at = 0;
    if (stats && typeof stats.forEach === "function") {
      stats.forEach(r => {
        if (!r || (r.kind || r.mediaType) !== "audio") return;
        if (r.type === "inbound-rtp") inbound = r;
        if (r.type === "outbound-rtp" && (!outbound || (r.bytesSent || 0) > (outbound.bytesSent || 0))) outbound = r;
        if (r.type === "media-source") source = r;
        if (r.timestamp > at) at = r.timestamp;
      });
    }
    const level = (r, before) => {
      if (r && typeof r.audioLevel === "number" && isFinite(r.audioLevel)) return Math.max(0, Math.min(1, r.audioLevel));
      const energy = r && r.totalAudioEnergy, seconds = r && r.totalSamplesDuration;
      if (!(typeof energy === "number" && typeof seconds === "number" && before && seconds > before.seconds)) return null;
      return Math.max(0, Math.min(1, Math.sqrt(Math.max(0, energy - before.energy) / (seconds - before.seconds))));
    };
    const side = (r, bytesKey, levelFrom, before) => {
      if (!r) return null;
      const bytes = r[bytesKey] || 0;
      const ms = before && r.timestamp > before.at ? r.timestamp - before.at : 0;
      return {
        bytes,
        kbps:    ms ? Math.max(0, Math.round(((bytes - before.bytes) * 8) / ms)) : null,
        level:   level(levelFrom, before),
        energy:  levelFrom && typeof levelFrom.totalAudioEnergy === "number" ? levelFrom.totalAudioEnergy : 0,
        seconds: levelFrom && typeof levelFrom.totalSamplesDuration === "number" ? levelFrom.totalSamplesDuration : 0
      };
    };
    const was = (s, p) => s && p && { at: p.at, bytes: s.bytes, energy: s.energy, seconds: s.seconds };
    return {
      in:  side(inbound,  "bytesReceived", inbound,          was(prev && prev.in,  prev)),
      out: side(outbound, "bytesSent",     source || outbound, was(prev && prev.out, prev)),
      at
    };
  }

  function fmtBytes(b) {
    if (typeof b !== "number" || !isFinite(b) || b < 0) return "0B";
    if (b < 1024)    return `${b}B`;
    if (b < 1048576) return `${(b / 1024).toFixed(1)}KB`;
    return `${(b / 1048576).toFixed(1)}MB`;
  }

  /** Coarse age of a timestamp, as {unit, value} for the caller to translate. */
  function timeAgo(ts, now = Date.now()) {
    const s = Math.max(0, Math.floor((now - ts) / 1000));
    if (s < 60)   return { unit: "s", value: s };
    if (s < 3600) return { unit: "m", value: Math.floor(s / 60) };
    return          { unit: "h", value: Math.floor(s / 3600) };
  }

  return {
    RTT_GOOD, RTT_FAIR,
    selectedCandidatePair, describePath,
    usableAddress, pathAddresses, isPublicAddress,
    OS_NAMES, BROWSER_NAMES, describeDevice, deviceLabel,
    qualityFromRtt, trafficTotals, callVideoStats, callAudioStats, fmtBytes, timeAgo
  };
});
