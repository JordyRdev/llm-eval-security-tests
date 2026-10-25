import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  EXPECTED_FILE,
  QUESTIONS_FILE,
  computeExpected,
  loadGoldenCases,
  loadQuestions,
  parseSubset,
  selectCases,
  type ExpectedFile,
  type Question,
} from "../../evals/golden/golden.ts";

const TEST_DB_DIR = inject("dbDir");

describe("golden questions", () => {
  let questions: Question[];

  beforeAll(async () => {
    questions = await loadQuestions();
  });

  it("has the planned mix of 40 questions", () => {
    const count = (type: string) => questions.filter((q) => q.type === type).length;
    expect(questions).toHaveLength(40);
    expect(count("numeric")).toBe(26);
    expect(count("categorical")).toBe(6);
    expect(count("unanswerable")).toBe(4);
    expect(count("refusal")).toBe(4);
  });

  it("has unique, ordered ids", () => {
    const ids = questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it("covers every role", () => {
    expect(new Set(questions.map((q) => q.role))).toEqual(
      new Set(["agent_jane", "agent_margaret", "agent_steve", "sales_manager"]),
    );
  });

  it("has a 12-case PR subset (GQ-001..012) and an 8-case fork subset", () => {
    const cases = questions.map((q) => ({
      ...q,
      expected: { value: null, unit: null, tolerance: null },
    }));
    expect(selectCases(cases, "pr").map((c) => c.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `GQ-${String(i + 1).padStart(3, "0")}`),
    );
    const fork = selectCases(cases, "fork");
    expect(fork).toHaveLength(8);
    expect(fork.filter((c) => c.type === "unanswerable" || c.type === "refusal").length).toBe(2);
    expect(selectCases(cases, "full")).toHaveLength(40);
  });

  it("rejects an unknown subset", () => {
    expect(parseSubset(undefined)).toBe("full");
    expect(() => parseSubset("all")).toThrow(/EVAL_SUBSET/);
  });
});

describe("expected answers", () => {
  it("are complete and generated from the pinned database", async () => {
    const expected = JSON.parse(await readFile(EXPECTED_FILE, "utf8")) as ExpectedFile;
    const pinned = (await readFile("data/raw/SHA256SUMS", "utf8")).split(/\s+/)[0];
    expect(expected.source_sha256).toBe(pinned);
    const cases = await loadGoldenCases();
    for (const c of cases) {
      if (c.type === "numeric") expect(typeof c.expected.value).toBe("number");
      if (c.type === "categorical") expect(typeof c.expected.value).toBe("string");
      if (c.type === "unanswerable" || c.type === "refusal") expect(c.expected.value).toBeNull();
    }
  });

  it("match the reference SQL on the test databases", async () => {
    const expected = JSON.parse(await readFile(EXPECTED_FILE, "utf8")) as ExpectedFile;
    for (const q of await loadQuestions()) {
      expect(computeExpected(q, TEST_DB_DIR), q.id).toEqual(expected.cases[q.id]);
    }
  });

  it("include the plan's worked examples", async () => {
    const byId = Object.fromEntries((await loadGoldenCases()).map((c) => [c.id, c.expected.value]));
    expect(byId["GQ-001"]).toBe(21);
    expect(byId["GQ-002"]).toBe(833.04);
    expect(byId["GQ-007"]).toBe("Helena Holý");
    expect(byId["GQ-008"]).toBe("Jane Peacock");
  });
});

describe("computeExpected", () => {
  const base = { role: "agent_jane" as const, question: "Test question?", tags: [] as string[] };

  it("refuses a categorical reference without a unique winner", () => {
    const tie: Question = {
      ...base,
      id: "GQ-900",
      type: "categorical",
      reference_sql: "SELECT 'a', 1 UNION ALL SELECT 'b', 1",
    };
    expect(() => computeExpected(tie, TEST_DB_DIR)).toThrow(/no unique winner/);
  });

  it("refuses an unanswerable reference that finds data", () => {
    const found: Question = {
      ...base,
      id: "GQ-901",
      type: "unanswerable",
      reason: "not in data",
      reference_sql: "SELECT COUNT(*) FROM Customer",
    };
    expect(() => computeExpected(found, TEST_DB_DIR)).toThrow(/prove absence/);
  });

  it("refuses a numeric reference that returns no number", () => {
    const empty: Question = {
      ...base,
      id: "GQ-902",
      type: "numeric",
      unit: "USD",
      tolerance: 0.01,
      reference_sql: "SELECT SUM(Total) FROM Invoice WHERE 1 = 0",
    };
    expect(() => computeExpected(empty, TEST_DB_DIR)).toThrow(/numeric reference/);
  });
});

describe("loadQuestions", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golden-test-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects a numeric question without a tolerance and duplicate ids", async () => {
    const file = path.join(dir, "q.yaml");
    await writeFile(
      file,
      "- {id: GQ-001, role: agent_jane, question: How many?, type: numeric, reference_sql: SELECT COUNT(*) FROM Customer, unit: x}\n",
    );
    await expect(loadQuestions(file)).rejects.toThrow(/unit and tolerance/);
    const dup =
      "- {id: GQ-001, role: agent_jane, question: Why not?, type: unanswerable, reference_sql: SELECT NULL AS x, reason: not in data}\n";
    await writeFile(file, dup + dup);
    await expect(loadQuestions(file)).rejects.toThrow(/duplicate/);
  });

  it("uses the repository files by default", () => {
    expect(QUESTIONS_FILE.endsWith(path.join("evals", "golden", "questions.yaml"))).toBe(true);
  });
});
