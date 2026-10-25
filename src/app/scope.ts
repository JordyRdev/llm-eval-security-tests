/**
 * Deterministic scope checks of the hardened mode. They decide two refusals without asking the
 * model, because a query can run fine and still give a misleading answer:
 *
 * - a question about another sales agent's data is outside the role, even though the role
 *   database (which has none of it) would return 0;
 * - a total of 0 for a period with no invoices at all means the data does not have it, not that
 *   revenue was $0.00.
 */
import { ROLE_DEFINITIONS, type Role } from "../auth/roles.ts";

export interface YearRange {
  readonly min: number;
  readonly max: number;
}

/** Lowercase, no accents, straight apostrophes. */
function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[\u2018\u2019\u02bc`]/g, "'")
    .toLowerCase();
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Words that, next to an agent's name, show the question is about that agent's book. */
const BOOK_WORDS =
  "customers?|clients?|accounts?|portfolio|book|revenue|sales|invoices?|orders?|purchases?|spend|numbers|data|figures|region";
const SUPPORT_VERBS = "supports?|serves?|handles?|manages?|looks after|takes care of";
const SUPPORT_VERBS_BASE = "support|serve|handle|manage|look after|take care of";

/**
 * The first other agent the question is about, or null. A full name always counts. A first
 * name alone counts when none of the role's own customers has that name; otherwise only in an
 * agent context such as "Margaret's customers", "customers of Margaret" or "agent Margaret".
 */
export function otherAgentMentioned(
  question: string,
  role: Role,
  ownCustomerNames: ReadonlySet<string>,
): string | null {
  const own = ROLE_DEFINITIONS[role];
  if (own.kind !== "agent") return null;
  const text = fold(question);
  for (const def of Object.values(ROLE_DEFINITIONS)) {
    if (def.kind !== "agent" || def.id === role) continue;
    const full = fold(def.displayName);
    const first = full.split(" ")[0] ?? full;
    const word = (w: string) => new RegExp(`(?<![\\p{L}\\p{N}])${w}(?![\\p{L}\\p{N}])`, "u");
    if (word(escape(full)).test(text)) return def.displayName;
    const name = escape(first);
    if (!word(name).test(text)) continue;
    if (!ownCustomerNames.has(first)) return def.displayName;
    const context = [
      `${name}'s?\\s+(?:\\w+\\s+){0,2}(?:${BOOK_WORDS})`,
      `(?:${BOOK_WORDS})\\s+(?:of|for|from|by|handled by|managed by|supported by)\\s+${name}`,
      `(?:agent|rep|colleague)\\s+${name}`,
      `${name}\\s+(?:${SUPPORT_VERBS})`,
      `(?:does|do|did)\\s+${name}\\s+(?:${SUPPORT_VERBS_BASE})`,
    ];
    if (context.some((pattern) => word(pattern).test(text))) return def.displayName;
  }
  return null;
}

/** Four-digit years (1900-2099) written in a text, such as a question or SQL literals. */
export function yearsIn(text: string): number[] {
  return [...text.matchAll(/(?<!\d)(19|20)\d{2}(?!\d)/g)].map((m) => Number(m[0]));
}

function isZeroOrNull(cell: unknown): boolean {
  if (cell === null || cell === 0) return true;
  return typeof cell === "string" && /^\s*0+(?:\.0+)?\s*$/.test(cell);
}

/** One row in which every cell is 0 or NULL: what COUNT, SUM or COALESCE give on no rows. */
export function isEmptyAggregate(rows: readonly Record<string, unknown>[]): boolean {
  return rows.length === 1 && rows.every((row) => Object.values(row).every((v) => isZeroOrNull(v)));
}

/**
 * True when the question (or, when it names no year, the SQL) only asks about years outside the
 * invoice data, and the query found nothing there.
 */
export function emptyPeriodOutsideData(
  question: string,
  sql: string,
  rows: readonly Record<string, unknown>[],
  range: YearRange | null,
): boolean {
  if (range === null || !isEmptyAggregate(rows)) return false;
  const asked = yearsIn(question);
  const years = asked.length > 0 ? asked : yearsIn(sql);
  return years.length > 0 && years.every((y) => y < range.min || y > range.max);
}
