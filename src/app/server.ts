import { serve } from "@hono/node-server";
import { transform } from "esbuild";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ROLES, ROLE_DEFINITIONS, isRole } from "../auth/roles.ts";
import { createProvider } from "../llm/provider.ts";
import { ChatEngine } from "./chat.ts";
import { AskRequestSchema, parseAppMode } from "./contract.ts";

const WEB_DIR = new URL("../../web/", import.meta.url);

async function loadClientScript(): Promise<string> {
  const source = await readFile(new URL("app.ts", WEB_DIR), "utf8");
  const { code } = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
  return code;
}

/** Builds the HTTP app. Exported separately from `main` so tests can call it in-process. */
export function createApp(engine: ChatEngine): Hono {
  const app = new Hono();
  let clientScript: Promise<string> | undefined;

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    }),
  );

  app.get("/", async (c) => c.html(await readFile(new URL("index.html", WEB_DIR), "utf8")));
  app.get("/styles.css", async (c) => {
    c.header("Content-Type", "text/css; charset=utf-8");
    return c.body(await readFile(new URL("styles.css", WEB_DIR), "utf8"));
  });
  app.get("/app.js", async (c) => {
    clientScript ??= loadClientScript();
    c.header("Content-Type", "text/javascript; charset=utf-8");
    return c.body(await clientScript);
  });

  app.get("/api/health", (c) => c.json({ ok: true, mode: engine.mode }));
  app.get("/api/roles", (c) =>
    c.json(ROLES.map((id) => ({ id, name: ROLE_DEFINITIONS[id].displayName }))),
  );

  app.post("/api/ask", bodyLimit({ maxSize: 32 * 1024 }), async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = AskRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "body must be { role, question }" }, 400);
    if (!isRole(parsed.data.role)) return c.json({ error: "unknown role" }, 400);
    try {
      return c.json(await engine.ask(parsed.data.role, parsed.data.question));
    } catch (error) {
      console.error("ask failed:", error);
      return c.json({ error: "the language model is not available, try again later" }, 502);
    }
  });

  return app;
}

async function main(): Promise<void> {
  const mode = parseAppMode(process.env["APP_MODE"]);
  const provider = await createProvider();
  const engine = new ChatEngine({ provider, mode });
  const port = Number(process.env["PORT"] ?? 3000);
  const hostname = process.env["HOST"] ?? "127.0.0.1";
  const server = serve({ fetch: createApp(engine).fetch, port, hostname }, (info) => {
    console.log(
      `ask-your-data on http://${hostname}:${String(info.port)} (provider ${provider.name}, model ${provider.model}, mode ${mode})`,
    );
  });
  const shutdown = () => {
    engine.close();
    server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
