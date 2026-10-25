import { describe, expect, it } from "vitest";
import {
  buildSummary,
  diffBaseline,
  parseResults,
  scoreTable,
  toMarkdown,
} from "../../evals/report/summary.ts";

function row(id: string, type: string, scores: Record<string, number>, error?: string) {
  return {
    latencyMs: 100,
    error: error ?? (scores["accuracy"] === 0 ? "assertion failed" : null),
    failureReason: error ? 2 : scores["accuracy"] === 0 ? 1 : 0,
    response: error
      ? { error }
      : { output: JSON.stringify({ answer: `answer ${id}`, value: 1, refused: false }) },
    testCase: { metadata: { id, type, role: "agent_jane" } },
    vars: { id },
    gradingResult: error
      ? null
      : {
          componentResults: Object.entries(scores).map(([metric, score]) => ({
            score,
            reason: score < 1 ? `${metric} failed` : "ok",
            assertion: { metric },
          })),
        },
  };
}

const file = {
  results: {
    results: [
      row("GQ-002", "numeric", { accuracy: 0, grounded: 0, faithfulness: 0.5 }),
      row("GQ-001", "numeric", { accuracy: 1, grounded: 1, faithfulness: 1 }),
      row("GQ-010", "unanswerable", { accuracy: 1, grounded: 1, unanswerable: 1 }),
      row("GQ-012", "refusal", {}, "ReplayMissError: no recording"),
    ],
  },
};

describe("eval summary", () => {
  it("parses promptfoo results into sorted per-case scores", () => {
    const results = parseResults(file);
    expect(results.map((r) => r.id)).toEqual(["GQ-001", "GQ-002", "GQ-010", "GQ-012"]);
    expect(results[1]?.scores).toEqual({ accuracy: 0, grounded: 0, faithfulness: 0.5 });
    expect(results[1]?.answer).toBe("answer GQ-002");
    expect(results[3]?.error).toContain("ReplayMissError");
  });

  it("counts a judge that could not run as an error", () => {
    const broken = row("GQ-003", "numeric", { accuracy: 1, grounded: 1 });
    const components = broken.gradingResult?.componentResults ?? [];
    components.push({
      score: 0,
      reason: "ReplayMissError: No recording for request abc",
      assertion: { metric: "faithfulness" },
    });
    const [result] = parseResults({ results: { results: [broken] } });
    expect(result?.error).toMatch(/ReplayMissError/);
  });

  it("computes the plan metrics and compares them with the subset targets", () => {
    const summary = buildSummary(parseResults(file), "full");
    expect(summary.errors).toBe(1);
    const byName = Object.fromEntries(summary.metrics.map((m) => [m.metric, m]));
    expect(byName["Accuracy"]).toMatchObject({ value: 2 / 3, met: false });
    expect(byName["Made-up content"]).toMatchObject({ value: 1 / 3, met: false });
    expect(byName["Unanswerable and out-of-role"]).toMatchObject({ value: 1, met: true });
    expect(byName["Faithfulness (judge)"]).toMatchObject({ value: 0.75, met: false });
    expect(summary.latency).toEqual({ meanMs: 100, maxMs: 100 });
  });

  it("marks metrics that did not run", () => {
    const summary = buildSummary(parseResults(file).slice(0, 2), "fork");
    const faithfulness = summary.metrics.find((m) => m.metric === "Faithfulness (judge)");
    expect(summary.metrics.find((m) => m.metric === "Unanswerable and out-of-role")?.display).toBe(
      "not run",
    );
    expect(faithfulness?.met).toBeNull();
  });

  it("finds cases whose scores differ from the baseline", () => {
    const scores = scoreTable(parseResults(file));
    expect(diffBaseline(scores, scores)).toEqual([]);
    const changed = { ...scores, "GQ-001": { accuracy: 0 } };
    delete (changed as Record<string, unknown>)["GQ-010"];
    expect(diffBaseline(scores, changed)).toEqual(["GQ-001", "GQ-010"]);
  });

  it("renders a markdown table with the failure reasons", () => {
    const markdown = toMarkdown(buildSummary(parseResults(file), "full"), "Test run");
    expect(markdown).toContain("### Test run");
    expect(markdown).toContain("| Accuracy | 2 of 3 (66.7 %) | ≥ 90.0 % | no |");
    expect(markdown).toContain("accuracy failed; grounded failed");
    expect(markdown).toContain("ReplayMissError");
  });
});
