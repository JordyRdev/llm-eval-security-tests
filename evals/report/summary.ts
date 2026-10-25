/**
 * Reads a promptfoo results file and turns it into the eval metrics of the plan:
 * accuracy, made-up content, unanswerable handling and judge faithfulness.
 */
import type { Subset } from "../golden/golden.ts";

export const METRICS = ["accuracy", "grounded", "unanswerable", "faithfulness"] as const;
export type Metric = (typeof METRICS)[number];

export interface CaseResult {
  readonly id: string;
  readonly type: string;
  readonly role: string;
  readonly error: string | null;
  readonly scores: Partial<Record<Metric, number>>;
  readonly reasons: Partial<Record<Metric, string>>;
  readonly latencyMs: number | null;
  readonly answer: string | null;
}

export interface MetricSummary {
  readonly metric: string;
  readonly value: number | null;
  readonly display: string;
  readonly target: string;
  readonly met: boolean | null;
}

export interface EvalSummary {
  readonly subset: Subset;
  readonly cases: number;
  readonly errors: number;
  /** App latency per case; only the query time in replay runs. */
  readonly latency: { readonly meanMs: number; readonly maxMs: number };
  readonly metrics: MetricSummary[];
  readonly results: CaseResult[];
}

interface RawComponent {
  readonly score?: number;
  readonly reason?: string;
  readonly assertion?: { readonly metric?: string };
}

interface RawResult {
  readonly error?: string | null;
  readonly failureReason?: number;
  readonly latencyMs?: number;
  readonly response?: { readonly output?: unknown; readonly error?: string };
  readonly metadata?: Record<string, unknown>;
  readonly testCase?: { readonly metadata?: Record<string, unknown> };
  readonly vars?: Record<string, unknown>;
  readonly gradingResult?: { readonly componentResults?: readonly RawComponent[] } | null;
}

interface RawFile {
  readonly results?: { readonly results?: readonly RawResult[] };
}

function isMetric(value: unknown): value is Metric {
  return typeof value === "string" && (METRICS as readonly string[]).includes(value);
}

function answerOf(output: unknown): string | null {
  if (typeof output !== "string") return null;
  try {
    const parsed = JSON.parse(output) as { answer?: unknown };
    return typeof parsed.answer === "string" ? parsed.answer : null;
  } catch {
    return null;
  }
}

const GRADER_ERROR = /^(?:\w*Error\b|Could not extract JSON)/;

function text(value: unknown): string {
  return typeof value === "string" ? value : "?";
}

/** One entry per test case, sorted by id. */
export function parseResults(file: unknown): CaseResult[] {
  const rows = (file as RawFile).results?.results ?? [];
  return rows
    .map((row) => {
      const meta = { ...row.testCase?.metadata, ...row.metadata };
      const scores: Partial<Record<Metric, number>> = {};
      const reasons: Partial<Record<Metric, string>> = {};
      let graderError: string | null = null;
      for (const component of row.gradingResult?.componentResults ?? []) {
        const metric = component.assertion?.metric;
        if (!isMetric(metric)) continue;
        // A judge that could not run (replay miss, model down) is an error, not a low score.
        if (GRADER_ERROR.test(component.reason ?? "")) graderError ??= component.reason ?? null;
        scores[metric] = component.score ?? 0;
        reasons[metric] = component.reason ?? "";
      }
      // promptfoo also puts assertion failures in `error`; failureReason 2 marks a real error.
      const error =
        row.response?.error ?? (row.failureReason === 2 ? row.error : null) ?? graderError;
      return {
        id: text(meta["id"] ?? row.vars?.["id"]),
        type: text(meta["type"]),
        role: text(meta["role"] ?? row.vars?.["role"]),
        error: error && error.length > 0 ? error : null,
        scores,
        reasons,
        latencyMs: typeof row.latencyMs === "number" ? row.latencyMs : null,
        answer: answerOf(row.response?.output),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Targets from the plan. They are reported here; the gate (exit code) comes with phase 4. */
export const TARGETS: Record<Subset, Partial<Record<Metric, number>>> = {
  pr: { accuracy: 11 / 12, grounded: 1, unanswerable: 1 },
  full: { accuracy: 0.9, grounded: 0.98, unanswerable: 0.95, faithfulness: 0.85 },
  fork: { accuracy: 0.6 },
};

const LABELS: Record<Metric, string> = {
  accuracy: "Accuracy",
  grounded: "Made-up content",
  unanswerable: "Unanswerable and out-of-role",
  faithfulness: "Faithfulness (judge)",
};

function percent(value: number): string {
  return `${(value * 100).toFixed(1)} %`;
}

function summarize(
  metric: Metric,
  results: readonly CaseResult[],
  target: number | undefined,
): MetricSummary {
  const scored = results.filter((r) => r.scores[metric] !== undefined);
  const label = LABELS[metric];
  if (scored.length === 0) {
    return { metric: label, value: null, display: "not run", target: "—", met: null };
  }
  const sum = scored.reduce((acc, r) => acc + (r.scores[metric] ?? 0), 0);
  const mean = sum / scored.length;
  if (metric === "grounded") {
    // Shown as the share of answers with a made-up number; lower is better.
    const madeUp = scored.filter((r) => (r.scores[metric] ?? 0) < 1).length;
    const rate = madeUp / scored.length;
    return {
      metric: label,
      value: rate,
      display: `${String(madeUp)} of ${String(scored.length)} (${percent(rate)})`,
      target: target === undefined ? "—" : target === 1 ? "0" : `≤ ${percent(1 - target)}`,
      met: target === undefined ? null : rate <= 1 - target + 1e-9,
    };
  }
  if (metric === "faithfulness") {
    return {
      metric: label,
      value: mean,
      display: `mean ${mean.toFixed(2)} over ${String(scored.length)}`,
      target: target === undefined ? "—" : `mean ≥ ${target.toFixed(2)}`,
      met: target === undefined ? null : mean >= target - 1e-9,
    };
  }
  return {
    metric: label,
    value: mean,
    display: `${String(sum)} of ${String(scored.length)} (${percent(mean)})`,
    target: target === undefined ? "—" : `≥ ${percent(target)}`,
    met: target === undefined ? null : mean >= target - 1e-9,
  };
}

function latencyOf(results: readonly CaseResult[]): EvalSummary["latency"] {
  const values = results.map((r) => r.latencyMs ?? 0);
  if (values.length === 0) return { meanMs: 0, maxMs: 0 };
  const sum = values.reduce((a, b) => a + b, 0);
  return { meanMs: Math.round(sum / values.length), maxMs: Math.max(...values) };
}

export function buildSummary(results: readonly CaseResult[], subset: Subset): EvalSummary {
  const targets = TARGETS[subset];
  return {
    subset,
    cases: results.length,
    errors: results.filter((r) => r.error !== null).length,
    latency: latencyOf(results),
    metrics: METRICS.map((m) => summarize(m, results, targets[m])),
    results: [...results],
  };
}

/** Per-case scores, used as the determinism baseline for replay runs. */
export function scoreTable(
  results: readonly CaseResult[],
): Record<string, Partial<Record<Metric, number>>> {
  return Object.fromEntries(results.map((r) => [r.id, r.scores]));
}

/** Case ids whose scores differ from the baseline (missing or extra cases count too). */
export function diffBaseline(
  actual: Record<string, Partial<Record<Metric, number>>>,
  baseline: Record<string, Partial<Record<Metric, number>>>,
): string[] {
  const ids = new Set([...Object.keys(actual), ...Object.keys(baseline)]);
  return [...ids]
    .filter((id) => JSON.stringify(actual[id] ?? null) !== JSON.stringify(baseline[id] ?? null))
    .sort();
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function toMarkdown(summary: EvalSummary, title: string): string {
  const lines = [
    `### ${title}`,
    "",
    `Subset \`${summary.subset}\`: ${String(summary.cases)} cases, ${String(summary.errors)} errors, app latency mean ${String(summary.latency.meanMs)} ms and max ${String(summary.latency.maxMs)} ms per case. Targets are reported only; the gate follows in phase 4.`,
    "",
    "| Metric | Result | Target | Met |",
    "| --- | --- | --- | --- |",
    ...summary.metrics.map(
      (m) =>
        `| ${m.metric} | ${m.display} | ${m.target} | ${m.met === null ? "—" : m.met ? "yes" : "no"} |`,
    ),
    "",
    "| Case | Type | Accuracy | Grounded | Refusal | Judge | Note |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  const show = (v: number | undefined) => (v === undefined ? "—" : String(v));
  for (const r of summary.results) {
    const failed = METRICS.filter((m) => (r.scores[m] ?? 1) < 1).map((m) => r.reasons[m] ?? "");
    const note = r.error ?? [...new Set(failed)].join("; ");
    lines.push(
      `| ${r.id} | ${r.type} | ${show(r.scores.accuracy)} | ${show(r.scores.grounded)} | ${show(r.scores.unanswerable)} | ${show(r.scores.faithfulness)} | ${cell(note).slice(0, 200)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
