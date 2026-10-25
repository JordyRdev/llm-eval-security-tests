/**
 * Turns the golden set into promptfoo test cases.
 *
 * EVAL_SUBSET: `full` (40, default), `pr` (the 12 cases of the quality gate) or `fork`
 * (8 cases for the keyless Ollama run).
 */
import { loadGoldenCases, parseSubset, selectCases, type GoldenCase } from "./golden.ts";

const SCORERS = "file://scorers/assertions.ts";

interface Assertion {
  type: string;
  value: string;
  metric: string;
}

export function assertionsFor(testCase: GoldenCase): Assertion[] {
  const asserts: Assertion[] = [
    { type: "javascript", value: `${SCORERS}:accuracy`, metric: "accuracy" },
    { type: "javascript", value: `${SCORERS}:grounding`, metric: "grounded" },
  ];
  if (testCase.type === "unanswerable" || testCase.type === "refusal") {
    asserts.push({ type: "javascript", value: `${SCORERS}:refusal`, metric: "unanswerable" });
  }
  return asserts;
}

export default async function generateTests(): Promise<unknown[]> {
  const subset = parseSubset(process.env["EVAL_SUBSET"]);
  const cases = selectCases(await loadGoldenCases(), subset);
  return cases.map((c) => ({
    description: `${c.id} ${c.type} (${c.role}): ${c.question}`,
    vars: {
      id: c.id,
      role: c.role,
      question: c.question,
      case: JSON.stringify({
        type: c.type,
        question: c.question,
        expected: c.expected,
        reason: c.reason,
      }),
    },
    assert: assertionsFor(c),
    metadata: { id: c.id, type: c.type, role: c.role, tags: c.tags.join(",") },
  }));
}
