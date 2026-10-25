import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** One line of a `sha256sum`-style manifest. */
export interface ChecksumEntry {
  readonly file: string;
  readonly sha256: string;
}

export type ChecksumResult =
  | { readonly file: string; readonly status: "ok"; readonly sha256: string }
  | {
      readonly file: string;
      readonly status: "mismatch";
      readonly expected: string;
      readonly actual: string;
    }
  | { readonly file: string; readonly status: "missing"; readonly expected: string };

const LINE = /^([0-9a-f]{64}) [ *](.+)$/;

/** Parses the output format of `sha256sum` (`<hash>  <file>` per line). */
export function parseSha256Sums(text: string): ChecksumEntry[] {
  const entries: ChecksumEntry[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = LINE.exec(line);
    if (!match?.[1] || !match[2]) {
      throw new Error(`SHA256SUMS line ${String(index + 1)} is not "<sha256>  <file>": ${line}`);
    }
    const file = match[2];
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
      throw new Error(`SHA256SUMS line ${String(index + 1)} points outside its directory: ${file}`);
    }
    entries.push({ sha256: match[1], file });
  }
  if (entries.length === 0) throw new Error("SHA256SUMS contains no entries");
  return entries;
}

/** Streams a file through SHA-256 and returns the lowercase hex digest. */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/** Verifies every file listed in `<dir>/SHA256SUMS` against its pinned hash. */
export async function verifyChecksums(dir: string): Promise<ChecksumResult[]> {
  const manifest = await readFile(path.join(dir, "SHA256SUMS"), "utf8");
  const results: ChecksumResult[] = [];
  for (const { file, sha256 } of parseSha256Sums(manifest)) {
    let actual: string;
    try {
      actual = await sha256File(path.join(dir, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        results.push({ file, status: "missing", expected: sha256 });
        continue;
      }
      throw error;
    }
    results.push(
      actual === sha256
        ? { file, status: "ok", sha256 }
        : { file, status: "mismatch", expected: sha256, actual },
    );
  }
  return results;
}
