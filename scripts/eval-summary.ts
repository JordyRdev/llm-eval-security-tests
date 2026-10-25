/**
 * Summarises a promptfoo run: prints the metrics, writes them to the GitHub step summary and
 * to out/eval-summary.json.
 *
 *   tsx scripts/eval-summary.ts out/results.json [--subset full|pr|fork] [--title "..."]
 *       [--baseline evals/recordings/baseline.json] [--write-baseline <file>]
 *
 * Exits 1 when a case errored (pipeline error or replay miss) or, with --baseline, when any
 * per-case score differs from the committed baseline (replay must be deterministic).
 * Thresholds are reported, not enforced; that is scripts/check-thresholds.ts in phase 4.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseSubset } from "../evals/golden/golden.ts";
import {
  buildSummary,
  diffBaseline,
  parseResults,
  scoreTable,
  toMarkdown,
} from "../evals/report/summary.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    subset: { type: "string", default: process.env["EVAL_SUBSET"] ?? "full" },
    title: { type: "string", default: "Golden-set eval" },
    baseline: { type: "string" },
    "write-baseline": { type: "string" },
    out: { type: "string", default: "out/eval-summary.json" },
  },
});

const resultsFile = positionals[0] ?? "out/results.json";
const results = parseResults(JSON.parse(await readFile(resultsFile, "utf8")));
const summary = buildSummary(results, parseSubset(values.subset));
let markdown = toMarkdown(summary, values.title);
let failed = summary.errors > 0;

if (results.length === 0) {
  markdown += "\nNo results found.\n";
  failed = true;
}

const scores = scoreTable(results);
if (values["write-baseline"]) {
  await writeFile(values["write-baseline"], `${JSON.stringify(scores, null, 2)}\n`);
  console.log(`Wrote baseline ${values["write-baseline"]}`);
}
if (values.baseline) {
  const baseline = JSON.parse(await readFile(values.baseline, "utf8")) as typeof scores;
  const changed = diffBaseline(scores, baseline);
  if (changed.length > 0) {
    markdown += `\nScores differ from the baseline for: ${changed.join(", ")}\n`;
    failed = true;
  } else {
    markdown += "\nAll per-case scores equal the committed baseline (replay is deterministic).\n";
  }
}

console.log(markdown);
await mkdir(path.dirname(values.out), { recursive: true });
await writeFile(values.out, `${JSON.stringify(summary, null, 2)}\n`);
const stepSummary = process.env["GITHUB_STEP_SUMMARY"];
if (stepSummary) await appendFile(stepSummary, markdown);
if (summary.errors > 0) console.error(`${String(summary.errors)} case(s) errored`);
process.exit(failed ? 1 : 0);
