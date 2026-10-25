import { describe, expect, it } from "vitest";
import type { GoldenCase, Question } from "../../evals/golden/golden.ts";
import { assertionsFor } from "../../evals/golden/tests.ts";

describe("assertionsFor", () => {
  const c = (type: Question["type"]): GoldenCase => ({
    id: "GQ-1",
    role: "agent_jane",
    question: "q",
    type,
    reference_sql: "",
    tags: [],
    expected: { value: null, unit: null, tolerance: null },
  });

  it("adds the refusal scorer to unanswerable cases and the judge to answerable ones", () => {
    expect(assertionsFor(c("refusal"), "rubric").map((a) => a.metric)).toEqual([
      "accuracy",
      "grounded",
      "unanswerable",
    ]);
    expect(assertionsFor(c("numeric"), "rubric").map((a) => a.metric)).toEqual([
      "accuracy",
      "grounded",
      "faithfulness",
    ]);
    expect(assertionsFor(c("numeric"), null).map((a) => a.metric)).toEqual([
      "accuracy",
      "grounded",
    ]);
  });
});
