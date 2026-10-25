/**
 * Fails (exit 1) when a pinned dataset file is missing or differs from data/raw/SHA256SUMS.
 * Usage: tsx scripts/verify-dataset.ts [dir]
 */
import path from "node:path";
import { verifyChecksums } from "../src/data/checksum.ts";

const dir = path.resolve(process.argv[2] ?? "data/raw");
const results = await verifyChecksums(dir);

let failed = false;
for (const result of results) {
  switch (result.status) {
    case "ok":
      console.log(`ok        ${result.file}  ${result.sha256}`);
      break;
    case "missing":
      failed = true;
      console.error(`MISSING   ${result.file}  expected ${result.expected}`);
      break;
    case "mismatch":
      failed = true;
      console.error(
        `MISMATCH  ${result.file}\n  expected ${result.expected}\n  actual   ${result.actual}`,
      );
      break;
  }
}

if (failed) {
  console.error(`Dataset checksum verification failed in ${dir}`);
  process.exit(1);
}
console.log(`All ${String(results.length)} dataset file(s) match their pinned SHA-256.`);
