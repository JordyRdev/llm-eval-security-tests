/**
 * OWASP Top 10 for LLM Applications 2026, the numbering used in this repository.
 *
 * promptfoo's `owasp:llm:NN` shorthand still follows the 2025 list, where several numbers point
 * to a different risk (for example 2025 LLM06 is Excessive Agency, 2026 LLM03). That is why
 * every case carries our own `owasp2026` tag and names explicit promptfoo plugin ids; the
 * `promptfoo2025` column below is only there to translate.
 */
export const OWASP_2026_IDS = [
  "LLM01",
  "LLM02",
  "LLM03",
  "LLM04",
  "LLM05",
  "LLM06",
  "LLM07",
  "LLM08",
  "LLM09",
  "LLM10",
] as const;
export type Owasp2026Id = (typeof OWASP_2026_IDS)[number];

export type Coverage = "runtime" | "partial" | "process" | "not applicable";

export interface OwaspEntry {
  readonly id: Owasp2026Id;
  readonly title: string;
  /** The same risk in promptfoo's 2025-based `owasp:llm:NN` shorthand. */
  readonly promptfoo2025: string;
  readonly coverage: Coverage;
}

export const OWASP_2026: Readonly<Record<Owasp2026Id, OwaspEntry>> = {
  LLM01: {
    id: "LLM01",
    title: "Prompt Injection",
    promptfoo2025: "owasp:llm:01",
    coverage: "runtime",
  },
  LLM02: {
    id: "LLM02",
    title: "Sensitive Information Disclosure",
    promptfoo2025: "owasp:llm:02",
    coverage: "runtime",
  },
  LLM03: {
    id: "LLM03",
    title: "Excessive Agency",
    promptfoo2025: "owasp:llm:06",
    coverage: "runtime",
  },
  LLM04: { id: "LLM04", title: "Supply Chain", promptfoo2025: "owasp:llm:03", coverage: "process" },
  LLM05: {
    id: "LLM05",
    title: "Data and Model Poisoning",
    promptfoo2025: "owasp:llm:04",
    coverage: "partial",
  },
  LLM06: {
    id: "LLM06",
    title: "Unbounded Consumption",
    promptfoo2025: "owasp:llm:10",
    coverage: "runtime",
  },
  LLM07: {
    id: "LLM07",
    title: "Misinformation",
    promptfoo2025: "owasp:llm:09",
    coverage: "runtime",
  },
  LLM08: {
    id: "LLM08",
    title: "Hidden Context Exposure",
    promptfoo2025: "owasp:llm:07 (System Prompt Leakage)",
    coverage: "runtime",
  },
  LLM09: {
    id: "LLM09",
    title: "Vector and Embedding Weaknesses",
    promptfoo2025: "owasp:llm:08",
    coverage: "not applicable",
  },
  LLM10: {
    id: "LLM10",
    title: "Improper Output Handling",
    promptfoo2025: "owasp:llm:05",
    coverage: "runtime",
  },
};
