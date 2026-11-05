/*
  Is the Pi answering? Run by .github/workflows/pi-uptime.yml every ten
  minutes — from GitHub, outside the home network and outside the tailnet,
  through Tailscale Funnel: the way every user reaches it.

  The alert is a GitHub issue, so each change is said once:

    - the Pi stops answering → an issue is opened, mentioning the owner, and
      GitHub emails them;
    - it answers again → a comment saying when, and the issue is closed —
      emailed too.

  While it stays down nothing more is sent, and the job itself succeeds: a
  scheduled run that fails is emailed by GitHub every time, every ten
  minutes. The job fails only when the check cannot be made at all (GitHub's
  API refusing, say) — and then GitHub's own email is the right one: the
  monitoring is what is broken.

  One missed answer is not an outage: three tries, half a minute apart.
*/

"use strict";

const PING_URL   = "https://raspberrypi.vulture-manta.ts.net/dc/api/ping";
const TRIES      = 3;
const GAP_MS     = 30_000;
const TIMEOUT_MS = 15_000;
const LABEL      = "pi-down";

/** Why one try failed, or null if the Pi answered { ok: true }. */
async function pingOnce(fetch, url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": "relaylink-uptime" } });
    if (!res.ok) return `HTTP ${res.status}`;
    const body = await res.json().catch(() => null);
    return body && body.ok === true ? null : "answered, but not with ok: true";
  } catch (err) {
    return (err.cause && err.cause.code) || (err.name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000} s` : err.message);
  }
}

/** Up at the first answer; down only after every try failed. */
async function check({ fetch, wait, url }) {
  const problems = [];
  for (let i = 0; i < TRIES; i++) {
    const problem = await pingOnce(fetch, url);
    if (!problem) return { up: true, problems };
    problems.push(problem);
    if (i < TRIES - 1) await wait(GAP_MS);
  }
  return { up: false, problems };
}

/** What to do, from what was seen and whether an alert is already open. */
function decide(up, openIssue) {
  if (!up && !openIssue) return "open";
  if (up && openIssue) return "close";
  return "nothing";
}

function issueBody(owner, url, problems) {
  return [
    `@${owner} — the app's server on the Raspberry Pi did not answer \`${url}\` ${problems.length} times in a row, half a minute apart:`,
    "",
    ...problems.map((p, i) => `- try ${i + 1}: ${p}`),
    "",
    "Until it answers, new chats cannot start and notes cannot be left or collected. Chats already open between two devices go on.",
    "",
    "Worth checking: the Pi has power and internet; on the Pi, `tailscale funnel status` and `systemctl status direct-connection`.",
    "",
    "This issue closes itself when the Pi answers again (checked every ten minutes by `.github/workflows/pi-uptime.yml`)."
  ].join("\n");
}

/**
 * One check, and the issue opened or closed to match.
 * @returns {Promise<string>} what happened, for the job's log
 */
async function run({ env = process.env, fetch = globalThis.fetch, wait = ms => new Promise(r => setTimeout(r, ms)), now = () => new Date() } = {}) {
  const token = env.GITHUB_TOKEN, repo = env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are needed");
  const url = env.PI_PING_URL || PING_URL;
  const api = env.GITHUB_API_URL || "https://api.github.com";

  async function gh(method, path, body, okStatus = []) {
    const res = await fetch(`${api}/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
        "user-agent": "relaylink-uptime", ...(body ? { "content-type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!res.ok && !okStatus.includes(res.status)) throw new Error(`GitHub ${method} ${path}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  const state = await check({ fetch, wait, url });
  const listed = await gh("GET", `/issues?state=open&labels=${LABEL}&per_page=20`);
  const issue = (listed || []).find(i => !i.pull_request) || null;
  const at = `${now().toISOString().slice(0, 16).replace("T", " ")} UTC`;

  switch (decide(state.up, issue)) {
    case "open": {
      await gh("POST", "/labels", { name: LABEL, color: "d73a4a", description: "The Raspberry Pi server is not answering" }, [422]);
      const made = await gh("POST", "/issues", {
        title: `🔴 The Pi is not answering (since ${at})`,
        labels: [LABEL],
        body: issueBody(repo.split("/")[0], url, state.problems)
      });
      return `down: opened #${made.number}`;
    }
    case "close":
      await gh("POST", `/issues/${issue.number}/comments`, { body: `🟢 Answering again at ${at}.` });
      await gh("PATCH", `/issues/${issue.number}`, { state: "closed", state_reason: "completed" });
      return `up again: closed #${issue.number}`;
    default:
      return state.up ? "up" : `still down: #${issue.number} stays open`;
  }
}

module.exports = { run, check, decide, pingOnce, PING_URL, TRIES, GAP_MS, LABEL };

if (require.main === module) {
  run().then(said => console.log(said), err => { console.error(err.message); process.exit(1); });
}
