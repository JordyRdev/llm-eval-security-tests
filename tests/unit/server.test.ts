import { afterAll, describe, expect, inject, it } from "vitest";
import { ChatEngine } from "../../src/app/chat.ts";
import { createApp } from "../../src/app/server.ts";
import { ScriptedProvider, answer, sql } from "../helpers/scripted-provider.ts";

const provider = new ScriptedProvider([]);
const engine = new ChatEngine({ provider, dbDir: inject("dbDir") });
const app = createApp(engine);

afterAll(() => {
  engine.close();
});

function ask(body: unknown) {
  return app.request("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("HTTP API", () => {
  it("serves the page with a strict content security policy", async () => {
    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('data-testid="ask-form"');
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves the compiled client script and styles", async () => {
    const script = await app.request("/app.js");
    expect(script.headers.get("content-type")).toContain("javascript");
    const code = await script.text();
    expect(code).toContain("/api/ask");
    expect(code).not.toContain("innerHTML");
    expect((await app.request("/styles.css")).headers.get("content-type")).toContain("text/css");
  });

  it("lists the roles and reports health", async () => {
    const roles = (await (await app.request("/api/roles")).json()) as { id: string }[];
    expect(roles.map((r) => r.id)).toEqual([
      "agent_jane",
      "agent_margaret",
      "agent_steve",
      "sales_manager",
    ]);
    expect(await (await app.request("/api/health")).json()).toEqual({ ok: true, mode: "hardened" });
  });

  it("answers a question", async () => {
    const scripted = new ScriptedProvider([
      sql("SELECT COUNT(*) AS n FROM Customer"),
      answer("You have 19 customers.", 19, "customers"),
    ]);
    const local = new ChatEngine({ provider: scripted, dbDir: inject("dbDir") });
    try {
      const response = await createApp(local).request("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "agent_steve", question: "How many customers?" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        value: 19,
        refused: false,
        rows_used: [{ n: 19 }],
      });
    } finally {
      local.close();
    }
  });

  it("rejects malformed bodies and unknown roles", async () => {
    expect((await ask("not json")).status).toBe(400);
    expect((await ask({ question: "hi" })).status).toBe(400);
    expect((await ask({ role: "admin", question: "hi" })).status).toBe(400);
    expect((await ask({ role: "agent_jane", question: "x".repeat(40_000) })).status).toBe(413);
  });

  it("returns 502 when the model is unavailable", async () => {
    const response = await ask({ role: "agent_jane", question: "How many customers?" });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "the language model is not available, try again later",
    });
  });
});
