/**
 * Roles of the "ask your data" chat. Access is enforced in the data: every role gets its own
 * read-only SQLite file that only contains the rows and columns it may see (see src/db/build.ts).
 */
export const ROLES = ["agent_jane", "agent_margaret", "agent_steve", "sales_manager"] as const;

export type Role = (typeof ROLES)[number];

export interface RoleDefinition {
  readonly id: Role;
  readonly kind: "agent" | "manager";
  readonly displayName: string;
  /** Chinook `Employee.EmployeeId` of the sales support agent (`Customer.SupportRepId`). */
  readonly employeeId?: number;
}

export const ROLE_DEFINITIONS: Readonly<Record<Role, RoleDefinition>> = {
  agent_jane: { id: "agent_jane", kind: "agent", displayName: "Jane Peacock", employeeId: 3 },
  agent_margaret: {
    id: "agent_margaret",
    kind: "agent",
    displayName: "Margaret Park",
    employeeId: 4,
  },
  agent_steve: { id: "agent_steve", kind: "agent", displayName: "Steve Johnson", employeeId: 5 },
  sales_manager: { id: "sales_manager", kind: "manager", displayName: "Sales manager" },
};

/** Customer columns that the sales manager sees masked. */
export const MASKED_CUSTOMER_COLUMNS = ["Address", "PostalCode", "Phone", "Fax", "Email"] as const;

/** Employee columns that are masked for the sales manager. */
export const MASKED_EMPLOYEE_COLUMNS = [
  "BirthDate",
  "Address",
  "PostalCode",
  "Phone",
  "Fax",
  "Email",
] as const;

export const MASK = "[masked]";

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function parseRole(value: unknown): Role {
  if (!isRole(value)) {
    throw new Error(`Unknown role: ${JSON.stringify(value)}. Expected one of ${ROLES.join(", ")}`);
  }
  return value;
}
