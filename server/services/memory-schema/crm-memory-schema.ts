/**
 * crm-memory-schema.ts
 *
 * Memory field definitions for Customer_* fields, backed by
 * crm_potential_customers.chat_memory (JSONB).
 *
 * Mirrors the user-memory-schema pattern: each field provides read/write/etc.
 * ops that resolve crmPotentialCustomerId from the DBOperationContext.
 *
 * The CRM agent has no outbound tools (no email/web/spawn) — its only writeable
 * surface is this memory. PII collected here (name, email, organization) is
 * deleted on customer deletion via cascade in the repository layer.
 */

import { db } from "../../db";
import { eq } from "drizzle-orm";
import { crmPotentialCustomers } from "@shared/schema";
import {
  type AgentMemoryFieldWithDB,
  type DBOperationContext,
} from "../chat/memory-types";

// ============================================================================
// HELPERS — read/write a single field inside crm_potential_customers.chat_memory
// ============================================================================

async function getCustomerMemoryField(
  ctx: DBOperationContext,
  fieldId: string,
): Promise<any> {
  const customerId = ctx.all.crmPotentialCustomerId;
  if (!customerId) {
    console.warn(`[crm-memory-schema] No crmPotentialCustomerId in context for ${fieldId}`);
    return undefined;
  }

  const [row] = await db
    .select({ chatMemory: crmPotentialCustomers.chatMemory })
    .from(crmPotentialCustomers)
    .where(eq(crmPotentialCustomers.id, customerId));

  if (!row) {
    console.warn(`[crm-memory-schema] Customer not found: ${customerId}`);
    return undefined;
  }

  const memory = (row.chatMemory as Record<string, any>) || {};
  return memory[fieldId];
}

async function setCustomerMemoryField(
  ctx: DBOperationContext,
  fieldId: string,
  value: any,
): Promise<any> {
  const customerId = ctx.all.crmPotentialCustomerId;
  if (!customerId) {
    throw new Error(`Cannot write to ${fieldId}: no crmPotentialCustomerId in context`);
  }

  const [row] = await db
    .select({ chatMemory: crmPotentialCustomers.chatMemory })
    .from(crmPotentialCustomers)
    .where(eq(crmPotentialCustomers.id, customerId));

  if (!row) {
    throw new Error(`Customer not found: ${customerId}`);
  }

  const current = (row.chatMemory as Record<string, any>) || {};
  const updated = { ...current, [fieldId]: value };

  await db
    .update(crmPotentialCustomers)
    .set({ chatMemory: updated, updatedAt: new Date() })
    .where(eq(crmPotentialCustomers.id, customerId));

  return value;
}

async function deleteCustomerMemoryField(
  ctx: DBOperationContext,
  fieldId: string,
): Promise<void> {
  const customerId = ctx.all.crmPotentialCustomerId;
  if (!customerId) {
    throw new Error(`Cannot delete ${fieldId}: no crmPotentialCustomerId in context`);
  }

  const [row] = await db
    .select({ chatMemory: crmPotentialCustomers.chatMemory })
    .from(crmPotentialCustomers)
    .where(eq(crmPotentialCustomers.id, customerId));

  if (!row) return;

  const current = (row.chatMemory as Record<string, any>) || {};
  if (!(fieldId in current)) return;

  const next = { ...current };
  delete next[fieldId];

  await db
    .update(crmPotentialCustomers)
    .set({ chatMemory: next, updatedAt: new Date() })
    .where(eq(crmPotentialCustomers.id, customerId));
}

// ============================================================================
// PRIMITIVE FIELDS
// ============================================================================

export const CUSTOMER_FIRST_NAME_FIELD: AgentMemoryFieldWithDB = {
  id: "Customer_FirstName",
  type: "string",
  title: "First Name",
  description: "The visitor's first name.",
  opened: true,
  db: {
    read: (ctx) => getCustomerMemoryField(ctx, "Customer_FirstName"),
    write: (ctx, value) => setCustomerMemoryField(ctx, "Customer_FirstName", value),
  },
};

export const CUSTOMER_LAST_NAME_FIELD: AgentMemoryFieldWithDB = {
  id: "Customer_LastName",
  type: "string",
  title: "Last Name",
  description: "The visitor's last name.",
  opened: true,
  db: {
    read: (ctx) => getCustomerMemoryField(ctx, "Customer_LastName"),
    write: (ctx, value) => setCustomerMemoryField(ctx, "Customer_LastName", value),
  },
};

export const CUSTOMER_EMAIL_FIELD: AgentMemoryFieldWithDB = {
  id: "Customer_Email",
  type: "string",
  title: "Email",
  description: "The visitor's email address.",
  format: "email",
  opened: true,
  db: {
    read: (ctx) => getCustomerMemoryField(ctx, "Customer_Email"),
    write: (ctx, value) => setCustomerMemoryField(ctx, "Customer_Email", value),
  },
};

export const CUSTOMER_ORGANIZATION_FIELD: AgentMemoryFieldWithDB = {
  id: "Customer_Organization",
  type: "string",
  title: "Organization",
  description: "School district, clinic, or organization the visitor represents.",
  opened: true,
  db: {
    read: (ctx) => getCustomerMemoryField(ctx, "Customer_Organization"),
    write: (ctx, value) => setCustomerMemoryField(ctx, "Customer_Organization", value),
  },
};

export const CUSTOMER_ROLE_FIELD: AgentMemoryFieldWithDB = {
  id: "Customer_Role",
  type: "string",
  title: "Role",
  description: "The visitor's role (e.g. SLP, school administrator, parent, researcher).",
  opened: true,
  db: {
    read: (ctx) => getCustomerMemoryField(ctx, "Customer_Role"),
    write: (ctx, value) => setCustomerMemoryField(ctx, "Customer_Role", value),
  },
};

// ============================================================================
// SCRATCHPAD — single free-form string the AI updates as the conversation
// progresses (pain points, populations served, commitments worth recording).
// Replaces the earlier Customer_Notes array; a single string is simpler for
// the model to reason about and avoids array-shaped tool-call ambiguity.
// ============================================================================

/** Hard ceiling on the scratchpad length. Past this we truncate from the
 *  front so the most recent context survives. Set generously — a cooperative
 *  agent will never hit it. */
const CUSTOMER_SCRATCHPAD_MAX_CHARS = 4000;

function trimScratchpad(input: string): string {
  const s = String(input ?? "");
  if (s.length <= CUSTOMER_SCRATCHPAD_MAX_CHARS) return s;
  // Drop oldest content — newer notes are more relevant for follow-up.
  return s.slice(s.length - CUSTOMER_SCRATCHPAD_MAX_CHARS);
}

export const CUSTOMER_SCRATCHPAD_FIELD: AgentMemoryFieldWithDB = {
  id: "Customer_Scratchpad",
  type: "string",
  title: "Scratchpad",
  description:
    "Free-form notes you keep about the visitor across the conversation: " +
    "pain points, the populations they serve, what they're hoping to solve, " +
    "any commitments, or other context useful for follow-up. Update the " +
    "value as new information appears (set the full string, not just an addition).",
  opened: true,
  db: {
    read: (ctx) => getCustomerMemoryField(ctx, "Customer_Scratchpad"),
    write: async (ctx, value) => {
      const trimmed = trimScratchpad(value as string);
      await setCustomerMemoryField(ctx, "Customer_Scratchpad", trimmed);
      return trimmed;
    },
  },
};

// ============================================================================
// EXPORTS
// ============================================================================

export const CRM_MEMORY_FIELDS: AgentMemoryFieldWithDB[] = [
  CUSTOMER_FIRST_NAME_FIELD,
  CUSTOMER_LAST_NAME_FIELD,
  CUSTOMER_EMAIL_FIELD,
  CUSTOMER_ORGANIZATION_FIELD,
  CUSTOMER_ROLE_FIELD,
  CUSTOMER_SCRATCHPAD_FIELD,
];

export function getCrmMemoryFields(): AgentMemoryFieldWithDB[] {
  return CRM_MEMORY_FIELDS;
}

// Test-only: exposed for unit tests that exercise the read/write helpers
// without going through the framework.
export const __test = {
  getCustomerMemoryField,
  setCustomerMemoryField,
  deleteCustomerMemoryField,
  trimScratchpad,
  CUSTOMER_SCRATCHPAD_MAX_CHARS,
};
