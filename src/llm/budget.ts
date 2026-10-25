/**
 * Client-side rate limiter for free-plan LLM APIs. Tracks requests and tokens per minute in a
 * sliding window and per day, waits when the next call would exceed a per-minute limit, and
 * fails fast when a daily limit is used up (waiting a day is never useful in CI).
 */
export interface BudgetLimits {
  readonly rpm?: number;
  readonly tpm?: number;
  readonly rpd?: number;
  readonly tpd?: number;
}

export interface BudgetClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: BudgetClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Groq free plan limits for `openai/gpt-oss-120b` and `qwen/qwen3.8-27b` (checked 25 Oct 2026). */
export const GROQ_FREE_LIMITS: BudgetLimits = { rpm: 30, tpm: 8000, rpd: 1000, tpd: 200_000 };

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

interface Entry {
  readonly at: number;
  tokens: number;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export class TokenBudget {
  private readonly entries: Entry[] = [];

  constructor(
    readonly limits: BudgetLimits,
    private readonly clock: BudgetClock = systemClock,
  ) {}

  /**
   * Waits until a request of `estimatedTokens` fits in the per-minute window, then reserves it.
   * Returns a handle to report the real token usage once the response arrives.
   */
  async reserve(estimatedTokens: number): Promise<{ commit(actualTokens: number): void }> {
    const { tpm, rpm, tpd, rpd } = this.limits;
    if (tpm !== undefined && estimatedTokens > tpm) {
      throw new BudgetExceededError(
        `request needs ~${String(estimatedTokens)} tokens, more than the ${String(tpm)} TPM limit`,
      );
    }
    for (;;) {
      const now = this.clock.now();
      this.prune(now);
      const day = this.entries;
      if (rpd !== undefined && day.length + 1 > rpd) {
        throw new BudgetExceededError(`daily request limit of ${String(rpd)} reached`);
      }
      if (tpd !== undefined && sum(day) + estimatedTokens > tpd) {
        throw new BudgetExceededError(`daily token limit of ${String(tpd)} reached`);
      }
      const minute = day.filter((e) => e.at > now - MINUTE);
      const overRequests = rpm !== undefined && minute.length + 1 > rpm;
      const overTokens = tpm !== undefined && sum(minute) + estimatedTokens > tpm;
      if (!overRequests && !overTokens) break;
      const oldest = minute[0];
      const wait = oldest ? oldest.at + MINUTE - now + 1 : 1000;
      await this.clock.sleep(Math.max(wait, 1));
    }
    const entry: Entry = { at: this.clock.now(), tokens: estimatedTokens };
    this.entries.push(entry);
    return {
      commit(actualTokens: number) {
        entry.tokens = actualTokens;
      },
    };
  }

  usage(): {
    minuteTokens: number;
    minuteRequests: number;
    dayTokens: number;
    dayRequests: number;
  } {
    const now = this.clock.now();
    this.prune(now);
    const minute = this.entries.filter((e) => e.at > now - MINUTE);
    return {
      minuteTokens: sum(minute),
      minuteRequests: minute.length,
      dayTokens: sum(this.entries),
      dayRequests: this.entries.length,
    };
  }

  private prune(now: number): void {
    while (this.entries[0] && this.entries[0].at <= now - DAY) this.entries.shift();
  }
}

function sum(entries: readonly Entry[]): number {
  return entries.reduce((total, e) => total + e.tokens, 0);
}

/** Rough token estimate (about 4 characters per token for English text and SQL). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
