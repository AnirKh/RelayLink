/*
  A test reporter for GitHub Actions — used by `npm run test:ci`, beside the
  usual spec output.

  A job's log is shown only to people signed in to GitHub with rights to the
  repository, and a failure sits thousands of lines down it. The run's own
  page is public. So each failing test is also said where that page shows it:

    - an annotation (`::error file=…,line=…,title=…::message`), listed on the
      run's page and marked on the file in the commit;
    - a section in the job's summary ($GITHUB_STEP_SUMMARY): the test's name,
      where it is, and its error.

  A test that failed only because a subtest of it did is not reported again —
  the subtest is.
*/

import { appendFileSync } from "node:fs";
import { relative } from "node:path";

/* Workflow commands are one line: newlines and % are encoded, and in the
   properties also : and , (see GitHub's "Workflow commands" docs). */
const escData = s => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escProp = s => escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

export default async function* githubReporter(source) {
  const failed = [];
  for await (const event of source) {
    if (event.type !== "test:fail") continue;
    const { name, file, line, details } = event.data;
    const error = details && details.error;
    if (error && error.failureType === "subtestsFailed") continue;
    const cause = error && error.cause ? error.cause : error;
    const message = (cause && (cause.stack || cause.message)) || String(cause || "failed");
    const where = file ? relative(process.cwd(), file).split("\\").join("/") : "";
    failed.push({ name, where, line, message });
    const place = where ? `file=${escProp(where)},line=${line || 1},` : "";
    yield `::error ${place}title=${escProp(name)}::${escData(message.split("\n")[0])}\n`;
  }
  if (failed.length && process.env.GITHUB_STEP_SUMMARY) {
    const parts = failed.map(f =>
      `### ✖ ${f.name}\n\n\`${f.where}${f.line ? `:${f.line}` : ""}\`\n\n\`\`\`\n${f.message.slice(0, 3000)}\n\`\`\`\n`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## ${failed.length} failing test${failed.length === 1 ? "" : "s"} (Node ${process.versions.node})\n\n${parts.join("\n")}\n`);
  }
}
