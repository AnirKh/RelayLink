/*
  Which of these commits did GitHub's tests pass? Run by update.sh as the
  server's own user (dc), with the commits between the Pi's copy and
  origin/main, newest first. Prints the newest that passed — or nothing, and
  the Pi stays as it is until the timer's next look.

  The copy that runs is the one at the Pi's HEAD: the last commit that passed,
  never one still waiting to.

  One question to GitHub per look, however many commits there are: the recent
  runs of .github/workflows/tests.yml on main that succeeded. Asked without an
  account — the repository is public — which GitHub allows 60 times an hour
  from one address; the timer looks every two minutes, and asks only when
  there is something new.

  Anything else — GitHub not answering or refusing, a run still going, one
  that failed — prints nothing: the Pi never moves to a commit whose tests
  have not passed. Why it could not tell goes to stderr, for the journal.
*/

"use strict";

const REPO       = "AnirKh/RelayLink";
const WORKFLOW   = "tests.yml";
const TIMEOUT_MS = 15_000;

/** The commits whose tests passed, among the recent runs on main. */
async function passedCommits(fetch, repo) {
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/runs?branch=main&status=success&per_page=50`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/vnd.github+json", "user-agent": "relaylink-pi-update", "x-github-api-version": "2022-11-28" }
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const body = await res.json();
  return new Set((body.workflow_runs || []).filter(r => r.conclusion === "success").map(r => r.head_sha));
}

/** The newest of `candidates` (newest first) that GitHub's tests passed, or null. */
async function newestPassed(candidates, { fetch = globalThis.fetch, repo = REPO } = {}) {
  const shas = candidates.filter(s => /^[0-9a-f]{40}$/.test(s));
  if (!shas.length) return null;
  const passed = await passedCommits(fetch, repo);
  return shas.find(s => passed.has(s)) || null;
}

module.exports = { newestPassed, REPO, WORKFLOW };

if (require.main === module) {
  newestPassed(process.argv.slice(2))
    .then(sha => { if (sha) process.stdout.write(`${sha}\n`); })
    .catch(err => { process.stderr.write(`Could not ask GitHub about the tests: ${err.message}\n`); });
}
