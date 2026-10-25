/**
 * Builds data/build/<role>.sqlite for every role plus data/build/vulnerable.sqlite.
 * Usage: tsx scripts/build-db.ts [outDir]
 */
import path from "node:path";
import { buildDatabases } from "../src/db/build.ts";
import { DEFAULT_BUILD_DIR } from "../src/db/paths.ts";

const outDir = path.resolve(process.argv[2] ?? DEFAULT_BUILD_DIR);
const manifest = await buildDatabases({ outDir });

console.log(`Source ${manifest.source.file} (sha256 ${manifest.source.sha256})`);
console.table(
  manifest.databases.map((d) => ({
    database: d.file,
    customers: d.customers,
    invoices: d.invoices,
    notes: d.notes,
    tables: d.tables.length,
  })),
);
console.log(`Wrote ${String(manifest.databases.length)} databases to ${outDir}`);
