/**
 * Adopts the recordings of an eval-live run as the committed replay set.
 *
 *   tsx scripts/adopt-recordings.ts <artifact dir> [--run <run id>] [--repo owner/name]
 *
 * Copies app.json and judge.json (golden set) and, when present, security-app.json (security
 * suite) from the downloaded artifact into evals/recordings/. It then replays both suites with
 * them, writes baseline.json and security-baseline.json from those replays (so the baselines
 * always match the current scorers and checks) and rewrites the recorded-scores and
 * security-scores blocks in README.md. Exits 1 when a replayed case errors, such as a missing
 * recording.
 *
 * Passing evals/recordings itself re-derives the baselines and the README blocks from the
 * committed recordings, for example after recording locally with Ollama.
 */
import { spawnSync } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildSummary, parseResults, scoreTable } from "../evals/report/summary.ts";
import {
  buildSecuritySummary,
  parseSecurityResults,
  securityBaseline,
  securityTables,
} from "../evals/report/security.ts";
import { loadSecurityCases } from "../evals/security/cases.ts";

const RECORDINGS = "evals/recordings";

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

async function adopt(file: string): Promise<boolean> {
  const from = path.join(source ?? "", file);
  const to = path.join(RECORDINGS, file);
  if (!existsSync(from)) return false;
  if (path.resolve(from) !== path.resolve(to)) {
    await copyFile(from, to);
    console.log(`Copied ${from} to ${to}`);
  }
  return true;
}

await adopt("app.json");
await adopt("judge.json");
const hasSecurity = await adopt("security-app.json");

function replay(script: string, env: Record<string, string>): void {
  const run = spawnSync("npm", ["run", script], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (run.status !== 0) process.exit(run.status ?? 1);
}

/** Readable origin of a recordings file, for example `Groq (openai/gpt-oss-120b)`. */
async function modelsIn(file: string): Promise<{ provider: string; models: string }> {
  const recordings = JSON.parse(await readFile(file, "utf8")) as Record<string, { model: string }>;
  const models = [...new Set(Object.values(recordings).map((r) => r.model))].sort();
  // Groq model ids carry an owner ("openai/gpt-oss-120b"), Ollama tags a size ("qwen3:4b").
  const provider = models.every((m) => m.includes("/"))
    ? "Groq"
    : models.every((m) => m.includes(":") && !m.includes("/"))
      ? "Ollama"
      : "mixed providers";
  return { provider, models: models.join(", ") };
}

const date = new Date().toLocaleDateString("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const origin = values.run
  ? `[eval-live run ${values.run}](https://github.com/${values.repo}/actions/runs/${values.run})`
  : path.resolve(source) === path.resolve(RECORDINGS)
    ? "a local recording run"
    : "an eval-live run";

// Golden set.
replay("eval", { LLM_PROVIDER: "replay", JUDGE_PROVIDER: "replay", EVAL_SUBSET: "full" });
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
const app = await modelsIn(path.join(RECORDINGS, "app.json"));
const judge = await modelsIn(path.join(RECORDINGS, "judge.json"));
const blocks: Record<string, string[]> = {
  "recorded-scores": [
    `The committed recordings come from ${app.provider} (app \`${app.models}\`, judge \`${judge.models}\`),`,
    `${origin}, adopted on ${date}. Replayed with the current app and scorers:`,
    "",
    "| Metric (40 cases, replay) | Result | Target | Met |",
    "| --- | --- | --- | --- |",
    ...summary.metrics.map(
      (m) =>
        `| ${m.metric} | ${m.display} | ${m.target} | ${m.met === null ? "—" : m.met ? "yes" : "no"} |`,
    ),
  ],
};

// Security suite.
if (hasSecurity) {
  replay("security", { LLM_PROVIDER: "replay", SECURITY_SUBSET: "full" });
  const security = parseSecurityResults(JSON.parse(await readFile("out/security.json", "utf8")));
  const securitySummary = buildSecuritySummary(security, await loadSecurityCases());
  if (securitySummary.errors > 0 || security.length === 0) {
    console.error(
      `${String(securitySummary.errors)} replayed security case(s) errored; not adopted.`,
    );
    process.exit(1);
  }
  await writeFile(
    path.join(RECORDINGS, "security-baseline.json"),
    `${JSON.stringify(securityBaseline(security), null, 2)}\n`,
  );
  const sec = await modelsIn(path.join(RECORDINGS, "security-app.json"));
  blocks["security-scores"] = [
    `The committed security recordings come from ${sec.provider} (\`${sec.models}\`), ${origin},`,
    `adopted on ${date}. Replayed with the current app and checks:`,
    "",
    ...securityTables(securitySummary),
  ];
} else {
  console.log("No security-app.json in the artifact; security recordings unchanged.");
}

let readme = await readFile(values.readme, "utf8");
for (const [name, lines] of Object.entries(blocks)) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const from = readme.indexOf(start);
  const to = readme.indexOf(end);
  if (from === -1 || to < from) {
    console.error(`${values.readme} has no ${start} ... ${end} block; baselines written.`);
    process.exit(1);
  }
  const block = [start, "", ...lines, "", end].join("\n");
  readme = readme.slice(0, from) + block + readme.slice(to + end.length);
}
await writeFile(values.readme, readme);
spawnSync("npx", ["prettier", "--write", values.readme, path.join(RECORDINGS, "*baseline.json")], {
  stdio: "inherit",
});
console.log(`Adopted ${source}: baselines and ${values.readme} updated. Review with git diff.`);
