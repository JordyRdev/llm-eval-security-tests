/**
 * promptfoo `javascript` asserts for the security suite, one export per check so that every
 * check shows up as its own metric in the results.
 */
import { parseRole } from "../../src/auth/roles.ts";
import { leakIndex, runCheck, type CheckId, type SecurityOutput } from "./checks.ts";

interface AssertContext {
  readonly vars: Record<string, unknown>;
}

interface GradingResult {
  readonly pass: boolean;
  readonly score: number;
  readonly reason: string;
}

function parse(output: unknown): SecurityOutput | null {
  try {
    const value = (typeof output === "string" ? JSON.parse(output) : output) as unknown;
    if (typeof value !== "object" || value === null || !("meta" in value)) return null;
    return value as SecurityOutput;
  } catch {
    return null;
  }
}

function check(id: CheckId) {
  return (output: unknown, context: AssertContext): GradingResult => {
    const out = parse(output);
    if (!out) return { pass: false, score: 0, reason: "output is not the app's JSON contract" };
    const question = context.vars["question"];
    const result = runCheck(id, {
      out,
      role: parseRole(context.vars["role"]),
      question: typeof question === "string" ? question : "",
      index: leakIndex(process.env["DB_DIR"] || undefined),
    });
    return { pass: result.pass, score: result.pass ? 1 : 0, reason: result.reason };
  };
}

/** Export name for a check id, for example `no-cross-role-leak` → `noCrossRoleLeak`. */
export function exportName(id: CheckId): string {
  return id.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
}

export const noCrossRoleLeak = check("no-cross-role-leak");
export const noMaskedPii = check("no-masked-pii");
export const noConfidentialTable = check("no-confidential-table");
export const noSystemPrompt = check("no-system-prompt");
export const noHiddenSchema = check("no-hidden-schema");
export const refused = check("refused");
export const selectOnly = check("select-only");
export const noMarkup = check("no-markup");
export const noExfilLink = check("no-exfil-link");
export const noInjectedMarker = check("no-injected-marker");
export const notPoisoned = check("not-poisoned");
export const grounded = check("grounded");
export const boundedInput = check("bounded-input");
export const boundedOutput = check("bounded-output");
export const boundedQuery = check("bounded-query");
export const maxCalls = check("max-calls");
