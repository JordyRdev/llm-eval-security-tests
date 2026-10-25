/**
 * Adopts the recordings of an eval-live run as the committed replay set.
 *
 *   tsx scripts/adopt-recordings.ts <artifact dir> [--run <run id>] [--repo owner/name]
 *
 * Copies app.json and judge.json from the downloaded artifact into evals/recordings/, replays
 * the full golden set with them, writes evals/recordings/baseline.json from that replay (so the
 * baseline always matches the current scorers) and rewrites the recorded-scores block in
 * README.md. Exits 1 when a replayed case errors, such as a missing recording.
 */
import { spawnSync } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildSummary, parseResults, scoreTable } from "../evals/report/summary.ts";

const RECORDINGS = "evals/recordings";
const START = "<!-- recorded-scores:start -->";
const END = "<!-- recorded-scores:end -->";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    run: { type: "string" },
    repo: {
      type: "string",
      default: process.env["GITHUB_REPOSITORY"] ?? "JordyRdev/llm-eval-security-tests",
    },
    readme: { type: "string", default: "README.md" },
  },
});

const dir = positionals[0];
if (!dir) {
  console.error("Usage: tsx scripts/adopt-recordings.ts <artifact dir> [--run <run id>]");
  process.exit(2);
}

// `gh run download <run> -D <dir>` puts the artifact in <dir>/<artifact name>/.
const candidates = [
  path.join(dir, RECORDINGS),
  path.join(dir, "groq-live-recordings", RECORDINGS),
  dir,
];
const source = candidates.find((c) => existsSync(path.join(c, "app.json")));
if (!source) {
  console.error(`No app.json found in ${candidates.join(", ")}`);
  process.exit(2);
}
for (const file of ["app.json", "judge.json"]) {
  await copyFile(path.join(source, file), path.join(RECORDINGS, file));
  console.log(`Copied ${path.join(source, file)} to ${path.join(RECORDINGS, file)}`);
}

const run = spawnSync("npm", ["run", "eval"], {
  stdio: "inherit",
  env: { ...process.env, LLM_PROVIDER: "replay", JUDGE_PROVIDER: "replay", EVAL_SUBSET: "full" },
});
if (run.status !== 0) process.exit(run.status ?? 1);

const results = parseResults(JSON.parse(await readFile("out/results.json", "utf8")));
const summary = buildSummary(results, "full");
if (summary.errors > 0 || results.length === 0) {
  console.error(`${String(summary.errors)} replayed case(s) errored; recordings not adopted.`);
  process.exit(1);
}
await writeFile(
  path.join(RECORDINGS, "baseline.json"),
  `${JSON.stringify(scoreTable(results), null, 2)}\n`,
);

async function modelsIn(file: string): Promise<string> {
  const recordings = JSON.parse(await readFile(file, "utf8")) as Record<string, { model: string }>;
  return [...new Set(Object.values(recordings).map((r) => r.model))].sort().join(", ");
}
const appModels = await modelsIn(path.join(RECORDINGS, "app.json"));
const judgeModels = await modelsIn(path.join(RECORDINGS, "judge.json"));
const date = new Date().toLocaleDateString("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const origin = values.run
  ? `[eval-live run ${values.run}](https://github.com/${values.repo}/actions/runs/${values.run})`
  : "an eval-live run";

const block = [
  START,
  "",
  `The committed recordings come from Groq (app \`${appModels}\`, judge \`${judgeModels}\`),`,
  `${origin}, adopted on ${date}. Replayed with the current app and scorers:`,
  "",
  "| Metric (40 cases, replay) | Result | Target | Met |",
  "| --- | --- | --- | --- |",
  ...summary.metrics.map(
    (m) =>
      `| ${m.metric} | ${m.display} | ${m.target} | ${m.met === null ? "—" : m.met ? "yes" : "no"} |`,
  ),
  "",
  END,
].join("\n");

const readme = await readFile(values.readme, "utf8");
const from = readme.indexOf(START);
const to = readme.indexOf(END);
if (from === -1 || to < from) {
  console.error(
    `${values.readme} has no ${START} ... ${END} block; baseline written, README unchanged.`,
  );
  process.exit(1);
}
await writeFile(values.readme, readme.slice(0, from) + block + readme.slice(to + END.length));
spawnSync("npx", ["prettier", "--write", values.readme], { stdio: "inherit" });
console.log(`Adopted ${source}: baseline and ${values.readme} updated. Review with git diff.`);
