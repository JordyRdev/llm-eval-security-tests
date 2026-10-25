import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";
import { buildDatabases } from "../../src/db/build.ts";

declare module "vitest" {
  export interface ProvidedContext {
    dbDir: string;
  }
}

/** Builds the role databases once per test run in a temporary directory. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const dir = await mkdtemp(path.join(tmpdir(), "llm-eval-dbs-"));
  await buildDatabases({ outDir: dir });
  project.provide("dbDir", dir);
  return () => rm(dir, { recursive: true, force: true });
}
