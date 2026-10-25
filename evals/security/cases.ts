/**
 * Curated security cases, one folder per OWASP 2026 id (`evals/security/llm01/cases.yaml` …).
 * A case runs one question through the real app, in the hardened and in the vulnerable mode,
 * and lists the checks that must hold. Leak checks run on every case anyway (see checks.ts).
 * Cases of kind `unit` are covered by a unit test instead and are only listed for the mapping.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ROLES } from "../../src/auth/roles.ts";
import { CONTROL_CHECKS } from "./checks.ts";
import { OWASP_2026_IDS } from "./owasp.ts";

export const SECURITY_DIR = path.resolve("evals/security");

const Base = z.object({
  id: z.string().regex(/^[A-Z]{2}-\d{2}$/),
  title: z.string().min(1),
  /** promptfoo plugin or strategy ids that cover the same attack (red-team generation). */
  promptfoo: z.array(z.string()).default([]),
});

const AppCaseSchema = Base.extend({
  kind: z.literal("app").default("app"),
  role: z.enum(ROLES),
  question: z.string().min(1),
  /** Repeats the question this many times (UC-01: a 10K-character question). */
  repeat: z.number().int().min(2).max(1000).optional(),
  checks: z.array(z.enum(CONTROL_CHECKS)).default([]),
  /** Part of the 10-case Ollama smoke subset that runs for forks. */
  smoke: z.boolean().default(false),
}).strict();

const UnitCaseSchema = Base.extend({
  kind: z.literal("unit"),
  test: z.string().min(1),
}).strict();

const CaseSchema = z.union([UnitCaseSchema, AppCaseSchema]);

const FileSchema = z
  .object({
    owasp2026: z.enum(OWASP_2026_IDS),
    note: z.string().optional(),
    cases: z.array(CaseSchema).default([]),
  })
  .strict();

export type AppCase = z.infer<typeof AppCaseSchema> & { readonly owasp2026: string };
export type UnitCase = z.infer<typeof UnitCaseSchema> & { readonly owasp2026: string };
export type SecurityCase = AppCase | UnitCase;

export function questionOf(c: AppCase): string {
  return c.repeat === undefined ? c.question : Array(c.repeat).fill(c.question).join(" ");
}

export async function loadSecurityCases(dir = SECURITY_DIR): Promise<SecurityCase[]> {
  const folders = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^llm\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort();
  const cases: SecurityCase[] = [];
  for (const folder of folders) {
    const file = path.join(dir, folder, "cases.yaml");
    const parsed = FileSchema.parse(parse(await readFile(file, "utf8")));
    if (parsed.owasp2026.toLowerCase() !== folder) {
      throw new Error(`${file}: owasp2026 ${parsed.owasp2026} does not match the folder`);
    }
    for (const c of parsed.cases) cases.push({ ...c, owasp2026: parsed.owasp2026 });
  }
  const ids = cases.map((c) => c.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) throw new Error(`Duplicate security case ids: ${dupes.join(", ")}`);
  return cases;
}

export const SECURITY_SUBSETS = ["full", "smoke"] as const;
export type SecuritySubset = (typeof SECURITY_SUBSETS)[number];

export function parseSecuritySubset(value: string | undefined): SecuritySubset {
  const subset = (value ?? "full").trim() || "full";
  if ((SECURITY_SUBSETS as readonly string[]).includes(subset)) return subset as SecuritySubset;
  throw new Error(`Unknown SECURITY_SUBSET "${subset}". Use ${SECURITY_SUBSETS.join(" or ")}.`);
}

export function appCases(cases: readonly SecurityCase[], subset: SecuritySubset): AppCase[] {
  return cases.filter((c): c is AppCase => c.kind === "app" && (subset === "full" || c.smoke));
}
