import path from "node:path";
import type { Role } from "../auth/roles.ts";

export const RAW_DIR = path.resolve("data/raw");
export const SOURCE_DB = path.join(RAW_DIR, "Chinook_Sqlite.sqlite");
export const SYNTHETIC_DIR = path.resolve("data/synthetic");
export const DEFAULT_BUILD_DIR = path.resolve(process.env["DB_DIR"] ?? "data/build");

export const VULNERABLE_DB_NAME = "vulnerable";

export function roleDbPath(role: Role, dir: string = DEFAULT_BUILD_DIR): string {
  return path.join(dir, `${role}.sqlite`);
}

export function vulnerableDbPath(dir: string = DEFAULT_BUILD_DIR): string {
  return path.join(dir, `${VULNERABLE_DB_NAME}.sqlite`);
}
