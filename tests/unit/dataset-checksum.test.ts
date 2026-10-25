import { execFile } from "node:child_process";
import { copyFile, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSha256Sums, verifyChecksums } from "../../src/data/checksum.ts";

const RAW_DIR = path.resolve("data/raw");
const DB_FILE = "Chinook_Sqlite.sqlite";
// Chinook v1.4.5 release asset, https://github.com/lerocha/chinook-database
const PINNED_SHA256 = "bdf635be69850bd3be09c9a2dbeef7ddfb80036bd3ef3381383cd03b61e4a61a";

const run = promisify(execFile);

describe("parseSha256Sums", () => {
  it("reads sha256sum text and binary mode lines", () => {
    const hash = "a".repeat(64);
    expect(parseSha256Sums(`${hash}  one.db\n${hash} *two.db\n\n# comment\n`)).toEqual([
      { sha256: hash, file: "one.db" },
      { sha256: hash, file: "two.db" },
    ]);
  });

  it("rejects malformed lines, empty manifests and paths outside the directory", () => {
    expect(() => parseSha256Sums("not-a-hash  file.db")).toThrow(/line 1/);
    expect(() => parseSha256Sums("\n# only a comment\n")).toThrow(/no entries/);
    expect(() => parseSha256Sums(`${"b".repeat(64)}  ../secret.db`)).toThrow(/outside/);
  });
});

describe("pinned Chinook dataset", () => {
  it("is listed in SHA256SUMS with the hash of the v1.4.5 release", async () => {
    const results = await verifyChecksums(RAW_DIR);
    expect(results).toContainEqual({ file: DB_FILE, status: "ok", sha256: PINNED_SHA256 });
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });
});

describe("checksum verification on a modified copy", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "chinook-"));
    await copyFile(path.join(RAW_DIR, DB_FILE), path.join(dir, DB_FILE));
    await copyFile(path.join(RAW_DIR, "SHA256SUMS"), path.join(dir, "SHA256SUMS"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("passes on an unmodified copy", async () => {
    const [result] = await verifyChecksums(dir);
    expect(result?.status).toBe("ok");
  });

  it("detects a single flipped byte", async () => {
    const handle = await open(path.join(dir, DB_FILE), "r+");
    try {
      const byte = Buffer.alloc(1);
      await handle.read(byte, 0, 1, 4096);
      byte[0] = (byte[0] ?? 0) ^ 0xff;
      await handle.write(byte, 0, 1, 4096);
    } finally {
      await handle.close();
    }
    const [result] = await verifyChecksums(dir);
    expect(result).toMatchObject({ file: DB_FILE, status: "mismatch", expected: PINNED_SHA256 });
  });

  it("detects a replaced file", async () => {
    await writeFile(path.join(dir, DB_FILE), "not the Chinook database");
    const [result] = await verifyChecksums(dir);
    expect(result?.status).toBe("mismatch");
  });

  it("detects a missing file", async () => {
    await rm(path.join(dir, DB_FILE));
    const [result] = await verifyChecksums(dir);
    expect(result?.status).toBe("missing");
  });

  it("makes the verify script exit with code 1", async () => {
    await writeFile(path.join(dir, DB_FILE), "tampered");
    await expect(
      run(process.execPath, ["--import", "tsx", "scripts/verify-dataset.ts", dir]),
    ).rejects.toMatchObject({ code: 1 });
    const ok = await run(process.execPath, ["--import", "tsx", "scripts/verify-dataset.ts"]);
    expect(ok.stdout).toContain("match their pinned SHA-256");
  });
});
