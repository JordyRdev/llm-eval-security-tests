/**
 * Summarises a run of the security suite: prints the table per OWASP 2026 id, writes it to the
 * GitHub step summary and to out/security-summary.json.
 *
 *   tsx scripts/security-summary.ts out/security.json [--title "..."]
 *       [--baseline evals/recordings/security-baseline.json] [--write-baseline <file>]
 *
 * Exits 1 when a case errored (pipeline error or replay miss) or, with --baseline, when the
 * failed checks of any case differ from the committed baseline (replay must be deterministic).
 * The security gates are reported, not enforced; that is scripts/check-thresholds.ts in phase 4.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadSecurityCases } from "../evals/security/cases.ts";
import {
  MODES,
  buildSecuritySummary,
  diffSecurityBaseline,
  parseSecurityResults,
  restrictBaseline,
  securityBaseline,
  securityMarkdown,
  type SecurityBaseline,
} from "../evals/report/security.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    title: { type: "string", default: "Security suite (OWASP LLM Top 10 2026)" },
    baseline: { type: "string" },
    "write-baseline": { type: "string" },
    out: { type: "string", default: "out/security-summary.json" },
  },
});

const resultsFile = positionals[0] ?? "out/security.json";
const results = parseSecurityResults(JSON.parse(await readFile(resultsFile, "utf8")));
const summary = buildSecuritySummary(results, await loadSecurityCases());
let markdown = securityMarkdown(summary, values.title);
let failed = summary.errors > 0;

if (results.length === 0) {
  markdown += "\nNo results found.\n";
  failed = true;
}

const actual = securityBaseline(results);
if (values["write-baseline"]) {
  await writeFile(values["write-baseline"], `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`Wrote baseline ${values["write-baseline"]}`);
}
if (values.baseline) {
  const modes = MODES.filter((m) => results.some((r) => r.mode === m));
  const committed = JSON.parse(await readFile(values.baseline, "utf8")) as SecurityBaseline;
  const ids = new Set(results.map((r) => r.id));
  // A subset run (smoke) only compares the cases and modes it ran.
  const relevant = Object.fromEntries(
    Object.entries(restrictBaseline(committed, modes)).filter(([id]) => ids.has(id)),
  );
  const changed = diffSecurityBaseline(actual, relevant);
  if (changed.length > 0) {
    markdown += `\nFailed checks differ from the baseline for: ${changed.join(", ")}\n`;
    failed = true;
  } else {
    markdown += "\nAll failed checks equal the committed baseline (replay is deterministic).\n";
  }
}

console.log(markdown);
await mkdir(path.dirname(values.out), { recursive: true });
await writeFile(values.out, `${JSON.stringify(summary, null, 2)}\n`);
const stepSummary = process.env["GITHUB_STEP_SUMMARY"];
if (stepSummary) await appendFile(stepSummary, markdown);
for (const gate of summary.gates) {
  if (gate.met === false) {
    console.log(
      `::warning title=Security gate (reported only)::${gate.name}: ${String(gate.value)}, target ${gate.target}`,
    );
  }
}
if (summary.errors > 0) console.error(`${String(summary.errors)} case(s) errored`);
process.exit(failed ? 1 : 0);
