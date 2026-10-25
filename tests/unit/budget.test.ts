import { describe, expect, it } from "vitest";
import {
  BudgetExceededError,
  GROQ_FREE_LIMITS,
  TokenBudget,
  estimateTokens,
  type BudgetClock,
} from "../../src/llm/budget.ts";

/** A clock that only moves when the budget sleeps. */
function fakeClock(start = 0): BudgetClock & { slept: number[] } {
  let now = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: (ms) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
}

describe("TokenBudget", () => {
  it("lets requests through without waiting while under the limits", async () => {
    const clock = fakeClock();
    const budget = new TokenBudget(GROQ_FREE_LIMITS, clock);
    for (let i = 0; i < 5; i++) (await budget.reserve(1000)).commit(900);
    expect(clock.slept).toEqual([]);
    expect(budget.usage()).toEqual({
      minuteTokens: 4500,
      minuteRequests: 5,
      dayTokens: 4500,
      dayRequests: 5,
    });
  });

  it("waits for the sliding window when the per-minute token limit would be exceeded", async () => {
    const clock = fakeClock();
    const budget = new TokenBudget({ tpm: 8000 }, clock);
    await budget.reserve(5000);
    await budget.reserve(5000);
    expect(clock.slept).toHaveLength(1);
    expect(clock.now()).toBeGreaterThan(60_000);
  });

  it("waits when the per-minute request limit is reached", async () => {
    const clock = fakeClock();
    const budget = new TokenBudget({ rpm: 2 }, clock);
    await budget.reserve(1);
    await budget.reserve(1);
    await budget.reserve(1);
    expect(clock.slept.length).toBeGreaterThan(0);
  });

  it("uses the real token count reported on commit", async () => {
    const clock = fakeClock();
    const budget = new TokenBudget({ tpm: 8000 }, clock);
    (await budget.reserve(7000)).commit(500);
    await budget.reserve(7000);
    expect(clock.slept).toEqual([]);
  });

  it("fails fast on daily limits and on requests larger than the TPM limit", async () => {
    const budget = new TokenBudget({ rpd: 2, tpd: 1000, tpm: 600 }, fakeClock());
    await expect(budget.reserve(601)).rejects.toBeInstanceOf(BudgetExceededError);
    await budget.reserve(400);
    await budget.reserve(400);
    await expect(budget.reserve(1)).rejects.toThrow(/daily request limit/);
    const tokens = new TokenBudget({ tpd: 1000 }, fakeClock());
    await tokens.reserve(900);
    await expect(tokens.reserve(200)).rejects.toThrow(/daily token limit/);
  });

  it("estimates about four characters per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("abcdefghi")).toBe(3);
  });
});
