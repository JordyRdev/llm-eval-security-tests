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

  describe("categorical answers whose value is the winning metric", () => {
    const genre: ScoreCase = {
      type: "categorical",
      question: "Which genre do my customers buy most?",
      expected: {
        value: "Rock",
        unit: null,
        tolerance: null,
        margin: { winner_score: 304, runner_up: "Latin", runner_up_score: 139 },
      },
    };
    const country: ScoreCase = {
      type: "categorical",
      question: "Which country brings me the most revenue?",
      expected: {
        value: "USA",
        unit: null,
        tolerance: null,
        margin: { winner_score: 239.72, runner_up: "Portugal", runner_up_score: 77.24 },
      },
    };
    const agent: ScoreCase = {
      type: "categorical",
      question: "Which agent has the highest revenue?",
      expected: {
        value: "Jane Peacock",
        unit: null,
        tolerance: null,
        margin: { winner_score: 833.04, runner_up: "Margaret Park", runner_up_score: 775.4 },
      },
    };

    it("passes the label from the answer when it is in rows_used (genre, country, agent)", () => {
      const rock = out({
        answer: "Your customers buy the most Rock genre, generating $300.96 in revenue.",
        value: 300.96,
        unit: "USD",
        rows_used: [{ genre: "Rock", revenue: 300.96 }],
      });
      const usa = out({
        answer: "USA generates the highest revenue of $239.72.",
        value: 239.72,
        unit: "USD",
        rows_used: [{ country: "USA", revenue: 239.72 }],
      });
      const jane = out({
        answer: "Jane Peacock has the highest revenue of 833.04 USD.",
        value: 833.04,
        unit: "USD",
        rows_used: [{ EmployeeId: 3, AgentName: "Jane Peacock", Revenue: 833.04 }],
      });
      expect(scoreAccuracy(rock, genre).pass).toBe(true);
      expect(scoreAccuracy(usa, country).pass).toBe(true);
      expect(scoreAccuracy(jane, agent).pass).toBe(true);
    });

    it("joins name columns of a row and ignores case and accents", () => {
      const result = out({
        answer: "your top customer is HELENA HOLY.",
        value: 49.62,
        rows_used: [{ FirstName: "Helena", LastName: "Holý", spend: 49.62 }],
      });
      expect(scoreAccuracy(result, categorical).pass).toBe(true);
    });

    it("fails a wrong label in the answer", () => {
      const latin = out({
        answer: "Your customers buy the most Latin tracks ($139.00).",
        value: 139,
        rows_used: [{ genre: "Latin", revenue: 139 }],
      });
      expect(scoreAccuracy(latin, genre).pass).toBe(false);
    });

    it("fails a label that is not in rows_used", () => {
      const result = out({
        answer: "Rock is the top genre with $300.96.",
        value: 300.96,
        rows_used: [{ revenue: 300.96 }],
      });
      expect(scoreAccuracy(result, genre).reason).toMatch(/rows_used does not contain/);
    });

    it("fails an answer that also names the runner-up", () => {
      const result = out({
        answer: "Rock or Latin, both around $300.",
        value: 300.96,
        rows_used: [
          { genre: "Rock", revenue: 300.96 },
          { genre: "Latin", revenue: 139 },
        ],
      });
      expect(scoreAccuracy(result, genre).reason).toMatch(/runner-up/);
    });

    it("fails a wrong name in value even when the answer names the label", () => {
      const result = out({
        answer: "Rock is the top genre.",
        value: "Latin",
        rows_used: [{ genre: "Rock", revenue: 300.96 }],
      });
      expect(scoreAccuracy(result, genre).pass).toBe(false);
    });

    it("does not accept a longer label or part of a word", () => {
      const rockAndRoll = out({
        answer: "Your top genre is Rock And Roll.",
        value: 12,
        rows_used: [{ genre: "Rock And Roll", revenue: 12 }],
      });
      expect(scoreAccuracy(rockAndRoll, genre).pass).toBe(false);
      const ausa = out({
        answer: "AUSA brings the most.",
        value: 1,
        rows_used: [{ country: "AUSA" }],
      });
      expect(scoreAccuracy(ausa, country).pass).toBe(false);
    });
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
