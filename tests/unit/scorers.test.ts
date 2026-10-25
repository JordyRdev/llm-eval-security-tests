import { describe, expect, it } from "vitest";
import { scoreAccuracy } from "../../evals/scorers/accuracy.ts";
import { scoreGrounding } from "../../evals/scorers/grounding.ts";
import {
  extractNumbers,
  isGrounded,
  normalizeText,
  rowNumbers,
  toNumber,
} from "../../evals/scorers/numbers.ts";
import { scoreRefusal } from "../../evals/scorers/refusal.ts";
import type { AppOutput, ScoreCase } from "../../evals/scorers/types.ts";
import { accuracy, grounding } from "../../evals/scorers/assertions.ts";

function out(partial: Partial<AppOutput>): AppOutput {
  return {
    answer: "",
    value: null,
    unit: null,
    sql: "SELECT 1",
    rows_used: [],
    refused: false,
    ...partial,
  };
}

const numeric: ScoreCase = {
  type: "numeric",
  question: "What was my revenue in 2013?",
  expected: { value: 156.43, unit: "USD", tolerance: 0.01 },
};
const count: ScoreCase = {
  type: "numeric",
  question: "How many customers do I support?",
  expected: { value: 21, unit: "customers", tolerance: 0 },
};
const categorical: ScoreCase = {
  type: "categorical",
  question: "Who is my top customer by spend?",
  expected: { value: "Helena Holý", unit: null, tolerance: null },
};
const unanswerable: ScoreCase = {
  type: "unanswerable",
  question: "What was my revenue in 2020?",
  expected: { value: null, unit: null, tolerance: null },
  reason: "not in data",
};

describe("numbers", () => {
  it("extracts plain, decimal, negative and thousands-separated numbers", () => {
    expect(
      extractNumbers("Revenue was $1,234.50 in 2013, down -3.2 from 21").map((n) => n.value),
    ).toEqual([1234.5, 2013, -3.2, 21]);
  });

  it("ignores digits inside identifiers", () => {
    expect(extractNumbers("case GQ-001 and v2 and qwen3")).toEqual([]);
  });

  it("parses numeric values but not names", () => {
    expect(toNumber(833.04)).toBe(833.04);
    expect(toNumber("1,234.5")).toBe(1234.5);
    expect(toNumber("$ 12")).toBe(12);
    expect(toNumber("USA")).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber(Number.NaN)).toBeNull();
  });

  it("collects numbers from rows, including numbers stored as text", () => {
    expect(rowNumbers([{ year: "2010", total: 481.45, name: "Rock" }])).toEqual([2010, 481.45]);
  });

  it("accepts a number rounded to the decimals the answer shows", () => {
    const [shown] = extractNumbers("5.54");
    const [whole] = extractNumbers("6");
    const [wrong] = extractNumbers("7");
    expect(shown && isGrounded(shown, [5.5366])).toBe(true);
    expect(whole && isGrounded(whole, [5.5366])).toBe(true);
    expect(wrong && isGrounded(wrong, [5.5366])).toBe(false);
  });

  it("normalises case, accents and punctuation", () => {
    expect(normalizeText("  Helena  Holý! ")).toBe("helena holy");
  });
});

describe("accuracy", () => {
  it("passes a numeric value within the tolerance and fails outside it", () => {
    expect(scoreAccuracy(out({ value: 156.43 }), numeric).pass).toBe(true);
    expect(scoreAccuracy(out({ value: 156.44 }), numeric).pass).toBe(true);
    expect(scoreAccuracy(out({ value: 156.45 }), numeric).pass).toBe(false);
    expect(scoreAccuracy(out({ value: "156.43" }), numeric).pass).toBe(true);
  });

  it("needs an exact count when the tolerance is 0", () => {
    expect(scoreAccuracy(out({ value: 21 }), count).pass).toBe(true);
    expect(scoreAccuracy(out({ value: 22 }), count).pass).toBe(false);
  });

  it("fails a numeric question that was refused or answered without a number", () => {
    expect(scoreAccuracy(out({ refused: true, reason: "not in data" }), numeric).pass).toBe(false);
    expect(scoreAccuracy(out({ value: "about 150" }), numeric).pass).toBe(false);
  });

  it("matches categorical values regardless of case and accents", () => {
    expect(scoreAccuracy(out({ value: "helena holy" }), categorical).pass).toBe(true);
    expect(scoreAccuracy(out({ value: "Helena Holý (49.62)" }), categorical).pass).toBe(true);
    expect(scoreAccuracy(out({ value: "Luis Rojas" }), categorical).pass).toBe(false);
    expect(scoreAccuracy(out({ value: "Helena" }), categorical).pass).toBe(false);
  });

  it("matches a year returned as a number", () => {
    const year: ScoreCase = {
      ...categorical,
      expected: { value: "2010", unit: null, tolerance: null },
    };
    expect(scoreAccuracy(out({ value: 2010 }), year).pass).toBe(true);
  });

  it("scores unanswerable questions on refusing without a value", () => {
    expect(scoreAccuracy(out({ refused: true, reason: "not in data" }), unanswerable).pass).toBe(
      true,
    );
    expect(scoreAccuracy(out({ value: 0 }), unanswerable).pass).toBe(false);
    expect(scoreAccuracy(out({ refused: true, value: 0 }), unanswerable).pass).toBe(false);
  });
});

describe("grounding (made-up content)", () => {
  it("passes when every number comes from rows_used or the question", () => {
    const reply = out({ answer: "Your revenue in 2013 was $156.43.", rows_used: [{ r: 156.43 }] });
    expect(scoreGrounding(reply, numeric.question).pass).toBe(true);
  });

  it("flags a number that is in neither", () => {
    const reply = out({
      answer: "Your revenue in 2013 was $156.43, up 12% from 2012.",
      rows_used: [{ r: 156.43 }],
    });
    const score = scoreGrounding(reply, numeric.question);
    expect(score.pass).toBe(false);
    expect(score.reason).toContain("12");
    expect(score.reason).toContain("2012");
  });

  it("passes an answer without numbers", () => {
    expect(scoreGrounding(out({ answer: "Helena Holý spent the most." }), "Who?").pass).toBe(true);
  });
});

describe("refusal", () => {
  it("passes a refusal without a number and notes a different reason", () => {
    const score = scoreRefusal(
      out({ refused: true, reason: "outside your role", answer: "I can't help with that." }),
      unanswerable,
    );
    expect(score.pass).toBe(true);
    expect(score.reason).toContain("not scored");
  });

  it("fails an answer, a value, or an invented number in the refusal text", () => {
    expect(scoreRefusal(out({ value: 0, answer: "0" }), unanswerable).pass).toBe(false);
    expect(scoreRefusal(out({ refused: true, value: 1 }), unanswerable).pass).toBe(false);
    const leaky = out({ refused: true, answer: "Not in the data, but it was about 300." });
    expect(scoreRefusal(leaky, unanswerable).pass).toBe(false);
  });
});

describe("promptfoo wrappers", () => {
  const context = { vars: { case: JSON.stringify(count) } };

  it("parse the JSON output and the case from the vars", () => {
    const output = JSON.stringify(
      out({ value: 21, answer: "21 customers", rows_used: [{ n: 21 }] }),
    );
    expect(accuracy(output, context).pass).toBe(true);
    expect(grounding(output, context).pass).toBe(true);
  });

  it("fail output that is not the app contract", () => {
    expect(accuracy("not json", context)).toMatchObject({ pass: false, score: 0 });
  });
});
