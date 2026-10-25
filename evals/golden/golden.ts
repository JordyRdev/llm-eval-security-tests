import Database from "better-sqlite3";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ROLES } from "../../src/auth/roles.ts";
import { buildDatabases } from "../../src/db/build.ts";
import { roleDbPath } from "../../src/db/paths.ts";

export const QUESTIONS_FILE = path.resolve("evals/golden/questions.yaml");
export const EXPECTED_FILE = path.resolve("evals/golden/expected.json");

export const QUESTION_TYPES = ["numeric", "categorical", "unanswerable", "refusal"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

const REFUSAL_REASONS = ["not in data", "outside your role"] as const;

/** One hand-written golden question. The expected answer is not part of it. */
export const QuestionSchema = z
  .object({
    id: z.string().regex(/^GQ-\d{3}$/),
    role: z.enum(ROLES),
    question: z.string().min(5).max(500),
    type: z.enum(QUESTION_TYPES),
    reference_sql: z.string().min(10),
    unit: z.string().optional(),
    tolerance: z.number().min(0).optional(),
    reason: z.enum(REFUSAL_REASONS).optional(),
    tags: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (q.type === "numeric" && (q.unit === undefined || q.tolerance === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: `${q.id}: numeric questions need unit and tolerance`,
      });
    }
    if ((q.type === "unanswerable" || q.type === "refusal") && q.reason === undefined) {
      ctx.addIssue({ code: "custom", message: `${q.id}: ${q.type} questions need a reason` });
    }
  });
export type Question = z.infer<typeof QuestionSchema>;

/** Expected answer as computed from the database by the reference SQL. */
export interface Expected {
  readonly value: number | string | null;
  readonly unit: string | null;
  readonly tolerance: number | null;
  /** Categorical only: the runner-up and both scores, to show the winner is unique. */
  readonly margin?: {
    readonly winner_score: number;
    readonly runner_up: string;
    readonly runner_up_score: number;
  };
}

export interface ExpectedFile {
  readonly source_sha256: string;
  readonly note: string;
  readonly cases: Record<string, Expected>;
}

export interface GoldenCase extends Question {
  readonly expected: Expected;
}

export async function loadQuestions(file = QUESTIONS_FILE): Promise<Question[]> {
  const raw: unknown = parse(await readFile(file, "utf8"));
  const questions = z.array(QuestionSchema).parse(raw);
  const ids = new Set<string>();
  for (const q of questions) {
    if (ids.has(q.id)) throw new Error(`duplicate question id ${q.id}`);
    ids.add(q.id);
  }
  return questions;
}

type Cell = string | number | bigint | null | Buffer;

function runReference(file: string, sql: string): Cell[][] {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).raw(true).all() as Cell[][];
  } finally {
    db.close();
  }
}

function scalar(rows: Cell[][], id: string): number | string | null {
  const cell = rows[0]?.[0];
  if (cell === undefined || cell === null) return null;
  if (typeof cell === "bigint") return Number(cell);
  if (Buffer.isBuffer(cell)) throw new Error(`${id}: reference SQL returned a blob`);
  return cell;
}

/** Runs one reference query and turns its result into the expected answer. */
export function computeExpected(question: Question, dbDir: string): Expected {
  const rows = runReference(roleDbPath(question.role, dbDir), question.reference_sql);
  const { id } = question;
  switch (question.type) {
    case "numeric": {
      const value = scalar(rows, id);
      if (typeof value !== "number")
        throw new Error(`${id}: numeric reference returned ${String(value)}`);
      return { value, unit: question.unit ?? null, tolerance: question.tolerance ?? 0 };
    }
    case "categorical": {
      const [first, second] = rows;
      const winner = first?.[0];
      const score = Number(first?.[1]);
      if (typeof winner !== "string" || !Number.isFinite(score)) {
        throw new Error(`${id}: categorical reference must return (name, score) rows`);
      }
      const runnerUpScore = Number(second?.[1] ?? Number.NEGATIVE_INFINITY);
      if (!(score > runnerUpScore)) {
        throw new Error(`${id}: no unique winner (${winner} ties with ${String(second?.[0])})`);
      }
      return {
        value: winner,
        unit: null,
        tolerance: null,
        margin: {
          winner_score: score,
          runner_up: String(second?.[0] ?? ""),
          runner_up_score: runnerUpScore,
        },
      };
    }
    case "unanswerable":
    case "refusal": {
      // The reference proves absence: no rows, NULL or 0.
      const value = scalar(rows, id);
      if (value !== null && value !== 0) {
        throw new Error(`${id}: expected the reference to prove absence, got ${String(value)}`);
      }
      return { value: null, unit: null, tolerance: null };
    }
  }
}

/** Builds fresh role databases from the pinned file and computes every expected answer. */
export async function buildExpected(questions: readonly Question[]): Promise<ExpectedFile> {
  const dir = await mkdtemp(path.join(tmpdir(), "golden-"));
  try {
    const manifest = await buildDatabases({ outDir: dir });
    const cases: Record<string, Expected> = {};
    for (const q of questions) cases[q.id] = computeExpected(q, dir);
    return {
      source_sha256: manifest.source.sha256,
      note: "Generated by `npm run build:golden` from questions.yaml. Do not edit by hand.",
      cases,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function formatExpected(file: ExpectedFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Questions joined with their generated answers; fails if expected.json is out of date. */
export async function loadGoldenCases(
  questionsFile = QUESTIONS_FILE,
  expectedFile = EXPECTED_FILE,
): Promise<GoldenCase[]> {
  const questions = await loadQuestions(questionsFile);
  const expected = JSON.parse(await readFile(expectedFile, "utf8")) as ExpectedFile;
  return questions.map((q) => {
    const e = expected.cases[q.id];
    if (!e) throw new Error(`${q.id} has no expected answer; run npm run build:golden`);
    return { ...q, expected: e };
  });
}

/** `full` is all 40; `pr` and `fork` are the cases tagged with that name. */
export const SUBSETS = ["full", "pr", "fork"] as const;
export type Subset = (typeof SUBSETS)[number];

export function parseSubset(value: string | undefined): Subset {
  const subset = (value ?? "full").trim().toLowerCase();
  if ((SUBSETS as readonly string[]).includes(subset)) return subset as Subset;
  throw new Error(`Unknown EVAL_SUBSET "${subset}". Use ${SUBSETS.join(", ")}.`);
}

export function selectCases(cases: readonly GoldenCase[], subset: Subset): GoldenCase[] {
  return subset === "full" ? [...cases] : cases.filter((c) => c.tags.includes(subset));
}
