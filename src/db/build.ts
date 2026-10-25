import Database from "better-sqlite3";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MASK,
  MASKED_CUSTOMER_COLUMNS,
  MASKED_EMPLOYEE_COLUMNS,
  ROLE_DEFINITIONS,
  ROLES,
  type Role,
} from "../auth/roles.ts";
import { verifyChecksums } from "../data/checksum.ts";
import { parseCsv } from "./csv.ts";
import { RAW_DIR, SYNTHETIC_DIR, roleDbPath, vulnerableDbPath } from "./paths.ts";

export interface BuildOptions {
  readonly rawDir?: string;
  readonly syntheticDir?: string;
  readonly outDir: string;
}

export interface BuiltDatabase {
  readonly name: Role | "vulnerable";
  readonly file: string;
  readonly tables: string[];
  readonly customers: number;
  readonly invoices: number;
  readonly notes: number;
}

export interface BuildManifest {
  readonly source: { readonly file: string; readonly sha256: string };
  readonly databases: BuiltDatabase[];
}

interface SyntheticData {
  readonly notes: { note_id: number; CustomerId: number; note_text: string }[];
  readonly comp: {
    EmployeeId: number;
    BaseSalary: number;
    Bonus: number;
    Currency: string;
    ReviewNote: string;
  }[];
}

const SOURCE_FILE = "Chinook_Sqlite.sqlite";

async function loadSynthetic(dir: string): Promise<SyntheticData> {
  const notes = parseCsv(await readFile(path.join(dir, "customer_notes.csv"), "utf8")).map((r) => ({
    note_id: toInt(r["note_id"], "note_id"),
    CustomerId: toInt(r["CustomerId"], "CustomerId"),
    note_text: r["note_text"] ?? "",
  }));
  const comp = parseCsv(await readFile(path.join(dir, "employee_comp.csv"), "utf8")).map((r) => ({
    EmployeeId: toInt(r["EmployeeId"], "EmployeeId"),
    BaseSalary: toInt(r["BaseSalary"], "BaseSalary"),
    Bonus: toInt(r["Bonus"], "Bonus"),
    Currency: r["Currency"] ?? "",
    ReviewNote: r["ReviewNote"] ?? "",
  }));
  return { notes, comp };
}

function toInt(value: string | undefined, field: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`Invalid integer for ${field}: ${String(value)}`);
  return n;
}

function copyDatabase(source: string, target: string): Database.Database {
  const src = new Database(source, { readonly: true, fileMustExist: true });
  try {
    src.prepare("VACUUM INTO ?").run(target);
  } finally {
    src.close();
  }
  const db = new Database(target);
  db.pragma("journal_mode = DELETE");
  // Agents' databases drop `Employee`, which `Customer.SupportRepId` still references.
  db.pragma("foreign_keys = OFF");
  return db;
}

function addCustomerNotes(db: Database.Database, notes: SyntheticData["notes"]): void {
  db.exec(`CREATE TABLE customer_notes (
    note_id INTEGER PRIMARY KEY,
    CustomerId INTEGER NOT NULL REFERENCES Customer (CustomerId),
    note_text TEXT NOT NULL
  )`);
  const insert = db.prepare(
    "INSERT INTO customer_notes (note_id, CustomerId, note_text) SELECT @note_id, @CustomerId, @note_text WHERE EXISTS (SELECT 1 FROM Customer WHERE CustomerId = @CustomerId)",
  );
  for (const note of notes) insert.run(note);
}

function addEmployeeComp(db: Database.Database, comp: SyntheticData["comp"]): void {
  db.exec(`CREATE TABLE employee_comp (
    EmployeeId INTEGER PRIMARY KEY REFERENCES Employee (EmployeeId),
    BaseSalary INTEGER NOT NULL,
    Bonus INTEGER NOT NULL,
    Currency TEXT NOT NULL,
    ReviewNote TEXT NOT NULL
  )`);
  const insert = db.prepare(
    "INSERT INTO employee_comp VALUES (@EmployeeId, @BaseSalary, @Bonus, @Currency, @ReviewNote)",
  );
  for (const row of comp) insert.run(row);
}

/** Keeps only the customers of one agent, their invoices and invoice lines; drops `Employee`. */
function restrictToAgent(db: Database.Database, employeeId: number): void {
  const others = "SELECT CustomerId FROM Customer WHERE SupportRepId IS NOT @employeeId";
  db.prepare(
    `DELETE FROM InvoiceLine WHERE InvoiceId IN (SELECT InvoiceId FROM Invoice WHERE CustomerId IN (${others}))`,
  ).run({ employeeId });
  db.prepare(`DELETE FROM Invoice WHERE CustomerId IN (${others})`).run({ employeeId });
  db.prepare("DELETE FROM Customer WHERE SupportRepId IS NOT @employeeId").run({ employeeId });
  db.exec("DROP TABLE Employee");
}

function maskForManager(db: Database.Database): void {
  const set = (columns: readonly string[]) => columns.map((c) => `${c} = @mask`).join(", ");
  db.prepare(`UPDATE Customer SET ${set(MASKED_CUSTOMER_COLUMNS)}`).run({ mask: MASK });
  db.prepare(`UPDATE Employee SET ${set(MASKED_EMPLOYEE_COLUMNS)}`).run({ mask: MASK });
}

function describe(db: Database.Database, name: BuiltDatabase["name"], file: string): BuiltDatabase {
  const tables = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((t) => t.name);
  const count = (table: string) =>
    db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
  return {
    name,
    file: path.basename(file),
    tables,
    customers: count("Customer"),
    invoices: count("Invoice"),
    notes: count("customer_notes"),
  };
}

function finish(db: Database.Database): void {
  db.exec("VACUUM");
  db.close();
}

/**
 * Verifies the pinned dataset, then builds one read-only database per role plus the
 * deliberately weak `vulnerable` database (everything in one file, roles only in the prompt).
 */
export async function buildDatabases(options: BuildOptions): Promise<BuildManifest> {
  const rawDir = options.rawDir ?? RAW_DIR;
  const syntheticDir = options.syntheticDir ?? SYNTHETIC_DIR;
  const checks = await verifyChecksums(rawDir);
  const failed = checks.filter((c) => c.status !== "ok");
  if (failed.length > 0) {
    throw new Error(`Dataset checksum verification failed: ${JSON.stringify(failed)}`);
  }
  const source = checks.find((c) => c.file === SOURCE_FILE);
  if (source?.status !== "ok") throw new Error(`${SOURCE_FILE} is not listed in SHA256SUMS`);

  const synthetic = await loadSynthetic(syntheticDir);
  await mkdir(options.outDir, { recursive: true });
  const sourcePath = path.join(rawDir, SOURCE_FILE);
  const databases: BuiltDatabase[] = [];

  for (const role of ROLES) {
    const file = roleDbPath(role, options.outDir);
    await rm(file, { force: true });
    const db = copyDatabase(sourcePath, file);
    const definition = ROLE_DEFINITIONS[role];
    db.transaction(() => {
      if (definition.employeeId !== undefined) restrictToAgent(db, definition.employeeId);
      else maskForManager(db);
      addCustomerNotes(db, synthetic.notes);
    })();
    databases.push(describe(db, role, file));
    finish(db);
  }

  const file = vulnerableDbPath(options.outDir);
  await rm(file, { force: true });
  const db = copyDatabase(sourcePath, file);
  db.transaction(() => {
    addCustomerNotes(db, synthetic.notes);
    addEmployeeComp(db, synthetic.comp);
  })();
  databases.push(describe(db, "vulnerable", file));
  finish(db);

  const manifest: BuildManifest = {
    source: { file: SOURCE_FILE, sha256: source.sha256 },
    databases,
  };
  await writeFile(
    path.join(options.outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
