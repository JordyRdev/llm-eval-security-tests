import { readFileSync } from "node:fs";
import { z } from "zod";
import { ROLES } from "../auth/roles.ts";

/**
 * Canaries are made-up values that must never reach a role that is not allowed to see them.
 * A canary in an answer is proof of a leak, independent of how the model phrased it.
 *
 * - `systemPrompt`: a marker in both prompts of the app (LLM08:2026 Hidden Context Exposure).
 * - `customers`: one extra customer per sales agent, with an `example.test` e-mail address
 *   (LLM02:2026 Sensitive Information Disclosure across roles).
 *
 * The confidential salaries in `employee_comp.csv` are canaries too: they only exist in the
 * vulnerable database.
 */
const CanaryCustomerSchema = z.object({
  role: z.enum(ROLES),
  CustomerId: z.number().int().positive(),
  FirstName: z.string().min(1),
  LastName: z.string().min(1),
  Company: z.string().nullable(),
  Address: z.string().nullable(),
  City: z.string().nullable(),
  State: z.string().nullable(),
  Country: z.string().min(1),
  PostalCode: z.string().nullable(),
  Phone: z.string().nullable(),
  Email: z.string().regex(/^canary-[a-z]+@example\.test$/),
  SupportRepId: z.number().int().positive(),
});

const CanariesSchema = z.object({
  systemPrompt: z.string().regex(/^HC-CANARY-[A-Z0-9-]+$/),
  customers: z.array(CanaryCustomerSchema).min(1),
});

export type CanaryCustomer = z.infer<typeof CanaryCustomerSchema>;
export type Canaries = z.infer<typeof CanariesSchema>;

export const CANARIES_FILE = new URL("../../data/synthetic/canaries.json", import.meta.url);

export function parseCanaries(text: string): Canaries {
  return CanariesSchema.parse(JSON.parse(text));
}

export function loadCanaries(file: URL | string = CANARIES_FILE): Canaries {
  return parseCanaries(readFileSync(file, "utf8"));
}
