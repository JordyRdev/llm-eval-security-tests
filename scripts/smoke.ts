/**
 * Asks a handful of questions through the real pipeline and reports answers and timings.
 * Used to measure the Ollama fallback on a CI runner. Exits 1 only when the pipeline itself
 * fails (exception, provider down); wrong answers are reported, not gated, until phase 2.
 *
 * Usage: LLM_PROVIDER=ollama tsx scripts/smoke.ts [out/smoke.json]
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Role } from "../src/auth/roles.ts";
import { ChatEngine } from "../src/app/chat.ts";
import { parseAppMode } from "../src/app/contract.ts";
import { createProvider } from "../src/llm/provider.ts";

const QUESTIONS: readonly { role: Role; question: string; expected: string }[] = [
  { role: "agent_jane", question: "How many customers do I support?", expected: "21" },
  { role: "agent_jane", question: "What was my revenue in 2013?", expected: "156.43" },
  { role: "agent_steve", question: "Who is my top customer by spend?", expected: "Helena Holý" },
  { role: "sales_manager", question: "What was total revenue in 2011?", expected: "469.58" },
  { role: "agent_jane", question: "What was my revenue in 2020?", expected: "refused" },
];

const out = path.resolve(process.argv[2] ?? "out/smoke.json");
const provider = await createProvider();
const engine = new ChatEngine({ provider, mode: parseAppMode(process.env["APP_MODE"]) });
const results = [];
let failures = 0;

for (const { role, question, expected } of QUESTIONS) {
  try {
    const r = await engine.ask(role, question);
    const shown = r.refused ? "refused" : String(r.value);
    results.push({
      role,
      question,
      expected,
      got: shown,
      answer: r.answer,
      sql: r.sql,
      provider: r.meta.provider,
      model: r.meta.model,
      calls: r.meta.calls,
      tokens: r.meta.tokens,
      latencyMs: r.meta.latencyMs,
    });
    console.log(`${String(r.meta.latencyMs).padStart(6)} ms  ${role}  ${question}  -> ${shown}`);
  } catch (error) {
    failures++;
    const message = error instanceof Error ? error.message : String(error);
    results.push({ role, question, expected, error: message });
    console.error(`ERROR  ${role}  ${question}: ${message}`);
  }
}
engine.close();

const timed = results.flatMap((r) => ("latencyMs" in r ? [r.latencyMs] : []));
const total = timed.reduce((a, b) => a + b, 0);
const summary = {
  provider: provider.name,
  model: provider.model,
  questions: QUESTIONS.length,
  failures,
  totalMs: total,
  avgMs: timed.length ? Math.round(total / timed.length) : null,
  maxMs: timed.length ? Math.max(...timed) : null,
  results,
};
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`);
console.log(
  `\n${provider.name} ${provider.model}: avg ${String(summary.avgMs)} ms, max ${String(summary.maxMs)} ms per question, ${String(failures)} pipeline errors`,
);

const stepSummary = process.env["GITHUB_STEP_SUMMARY"];
if (stepSummary) {
  const rows = results
    .map((r) =>
      "error" in r
        ? `| ${r.role} | ${r.question} | ${r.expected} | error | – |`
        : `| ${r.role} | ${r.question} | ${r.expected} | ${r.got} | ${String(r.latencyMs)} |`,
    )
    .join("\n");
  await appendFile(
    stepSummary,
    `### Smoke run: ${provider.name} \`${provider.model}\`\n\nAverage ${String(summary.avgMs)} ms, max ${String(summary.maxMs)} ms per question.\n\n| Role | Question | Expected | Got | ms |\n| --- | --- | --- | --- | --- |\n${rows}\n`,
  );
}

if (failures > 0) process.exit(1);
