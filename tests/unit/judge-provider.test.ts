import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import JudgeProvider, { JUDGE_DEFAULTS } from "../../evals/providers/judge-provider.ts";
import { recordingKey } from "../../src/llm/replay.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "judge-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("judge provider", () => {
  it("defaults to a different model family than the app", () => {
    expect(JUDGE_DEFAULTS.groqModel).toBe("qwen/qwen3.8-27b");
    expect(JUDGE_DEFAULTS.ollamaModel).not.toMatch(/^qwen/);
  });

  it("replays a recorded verdict without a network or a key", async () => {
    const prompt = "Grade this reply.";
    const file = path.join(dir, "judge.json");
    const verdict = JSON.stringify({ reason: "supported", pass: true, score: 1 });
    const key = recordingKey({
      messages: [{ role: "user", content: prompt }],
      json: true,
      maxTokens: JUDGE_DEFAULTS.maxTokens,
    });
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
    await writeFile(file, JSON.stringify({ [key]: { content: verdict, model: "m", usage } }));
    vi.stubEnv("JUDGE_PROVIDER", "replay");
    vi.stubEnv("JUDGE_REPLAY_FILE", file);
    const response = await new JudgeProvider().callApi(prompt);
    expect(response).toEqual({
      output: verdict,
      tokenUsage: { total: 15, prompt: 10, completion: 5 },
    });
  });

  it("returns an error for a verdict that was never recorded", async () => {
    vi.stubEnv("JUDGE_PROVIDER", "replay");
    vi.stubEnv("JUDGE_REPLAY_FILE", path.join(dir, "missing.json"));
    const response = await new JudgeProvider().callApi("Something new");
    expect(response.error).toMatch(/ReplayMissError/);
  });

  it("needs a Groq key when the Groq judge is selected", async () => {
    vi.stubEnv("JUDGE_PROVIDER", "groq");
    vi.stubEnv("GROQ_API_KEY", "");
    const response = await new JudgeProvider().callApi("x");
    expect(response.error).toMatch(/GROQ_API_KEY/);
  });
});
