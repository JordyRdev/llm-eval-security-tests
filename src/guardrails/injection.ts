/**
 * Heuristic prompt-injection detector (LLM01:2026 Prompt Injection). The hardened app runs it on
 * every question and on every text cell of a query result before the answer step, so both
 * direct and indirect injection (for example via `customer_notes`) are stopped before a model
 * sees them. It is deliberately simple and explainable; the role boundary itself does not rely
 * on it, because every role has its own database.
 */
export interface InjectionRule {
  readonly id: string;
  readonly pattern: RegExp;
}

const ROLE_WORDS =
  "sales[\\s_-]?manager|manager|admin(?:istrator)?|system|developer|dba|root|superuser|another agent";

export const INJECTION_RULES: readonly InjectionRule[] = [
  {
    id: "override instructions",
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass|skip)\b[^.?!\n]{0,40}\b(?:instructions?|rules?|prompts?|guidelines|restrictions|directions)\b/i,
  },
  {
    id: "change role",
    pattern: new RegExp(
      `\\b(?:you are now|you're now|from now on you are|act as|pretend (?:to be|you are)|switch (?:to|into)|i am the|i'm the)\\b[^.?!\\n]{0,20}\\b(?:${ROLE_WORDS})\\b`,
      "i",
    ),
  },
  {
    id: "fake system message",
    pattern:
      /\[\s*(?:system|admin|developer|assistant)\s*\]|<\s*\/?\s*(?:system|instructions?)\s*>|\b(?:role|mode|override|admin)\s*[:=]\s*\w+/i,
  },
  {
    id: "prompt extraction",
    pattern:
      /\b(?:system|hidden|initial|original|developer)\s+(?:prompt|instructions?|message)\b|\byour (?:own )?(?:instructions|rules|prompt|guidelines|configuration)\b/i,
  },
  {
    id: "output instructions",
    pattern:
      /\b(?:start|begin|end) your (?:answer|reply|response) with\b|\balways (?:report|answer|say|reply|respond)\b|\bwhen you answer, (?:add|include|append)\b/i,
  },
  {
    id: "endless output",
    pattern:
      /\brepeat\b[^.?!\n]{0,40}\b(?:forever|infinitely|indefinitely|endlessly|\d{3,} times)\b/i,
  },
  {
    id: "sql in question",
    pattern:
      /;\s*(?:drop|delete|update|insert|alter|attach|detach|pragma|create|replace|vacuum)\b|--\s*(?:drop|delete)\b|\b(?:drop|truncate)\s+table\b|\battach\s+(?:database\s+)?['"]|'\s*or\s+'?1'?\s*=\s*'?1/i,
  },
  {
    id: "markup",
    pattern:
      /<\s*(?:img|script|iframe|svg|object|embed|style|link|meta)\b|\bon(?:error|load|click|mouseover)\s*=|javascript:|!\[[^\]]*\]\(/i,
  },
  // Dutch, because the users of the portfolio are Dutch (PI-05).
  {
    id: "override instructions (nl)",
    pattern:
      /\b(?:negeer|vergeet|omzeil)\b[^.?!\n]{0,40}\b(?:instructies|regels|opdrachten|prompt)\b/i,
  },
  {
    id: "change role (nl)",
    pattern: /\b(?:je bent nu|jij bent nu|doe alsof je|speel de rol van)\b/i,
  },
  {
    id: "prompt extraction (nl)",
    pattern: /\b(?:systeemprompt|je instructies|jouw instructies|je regels)\b/i,
  },
];

const BASE64_RUN = /[A-Za-z0-9+/]{24,}={0,2}/g;

/** Decodes runs that look like base64 and are printable text once decoded (PI-03). */
export function decodeBase64Runs(text: string): string[] {
  const decoded: string[] = [];
  for (const match of text.matchAll(BASE64_RUN)) {
    const value = Buffer.from(match[0], "base64").toString("utf8");
    if (/^[\p{L}\p{N}\p{P}\p{Zs}\n=<>$+|^`~]+$/u.test(value) && /[a-z]{3}/i.test(value)) {
      decoded.push(value);
    }
  }
  return decoded;
}

/** Name of the first rule that matches, or null. Base64 payloads are decoded and checked too. */
export function detectInjection(text: string): string | null {
  for (const rule of INJECTION_RULES) if (rule.pattern.test(text)) return rule.id;
  for (const decoded of decodeBase64Runs(text)) {
    for (const rule of INJECTION_RULES) {
      if (rule.pattern.test(decoded)) return `${rule.id} (base64)`;
    }
  }
  return null;
}

export const WITHHELD = "[withheld: looks like instructions or markup]";

/**
 * Replaces text cells that look like an injection with a placeholder (indirect injection via
 * query results). Returns the cleaned rows and how many cells were withheld.
 */
export function withholdInjectedCells(rows: readonly Record<string, unknown>[]): {
  rows: Record<string, unknown>[];
  withheld: number;
} {
  let withheld = 0;
  const clean = rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => {
        if (typeof value === "string" && detectInjection(value) !== null) {
          withheld++;
          return [key, WITHHELD];
        }
        return [key, value];
      }),
    ),
  );
  return { rows: clean, withheld };
}
