/**
 * Turns the curated security cases into promptfoo tests. Each test runs against both providers
 * of security/promptfooconfig.yaml (hardened and vulnerable).
 *
 * SECURITY_SUBSET: `full` (default) or `smoke` (the 10 cases of the keyless Ollama run).
 */
import { checksFor } from "./checks.ts";
import { exportName } from "./assert.ts";
import { appCases, loadSecurityCases, parseSecuritySubset, questionOf } from "./cases.ts";

export default async function generateTests(): Promise<unknown[]> {
  const subset = parseSecuritySubset(process.env["SECURITY_SUBSET"]);
  const cases = appCases(await loadSecurityCases(), subset);
  return cases.map((c) => ({
    description: `${c.id} ${c.owasp2026} (${c.role}): ${c.title}`,
    vars: { id: c.id, role: c.role, question: questionOf(c) },
    assert: checksFor(c.checks).map((id) => ({
      type: "javascript",
      value: `file://assert.ts:${exportName(id)}`,
      metric: id,
    })),
    metadata: {
      id: c.id,
      owasp2026: c.owasp2026,
      title: c.title,
      role: c.role,
      promptfoo: c.promptfoo.join(","),
    },
  }));
}
