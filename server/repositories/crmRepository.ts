import {
  crmPotentialCustomers,
  chatSessions,
  type CrmPotentialCustomer,
  type ChatSession,
  type ChatState,
  type ChatMessage,
} from "@shared/schema";
import { db } from "../db";
import { and, asc, count, desc, eq, gte, ilike, isNull, or, sql } from "drizzle-orm";

/**
 * Window after which a returning visitor (matched by ip_hash) gets a fresh
 * session instead of resuming the previous one. Within the window, the most
 * recent open session is reused so the AI's memory of the conversation is
 * continuous; past it, a new session starts.
 */
const SESSION_RESUME_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** Default empty ChatState for new CRM sessions. */
function emptyChatState(): ChatState {
  return {
    history: [],
    conversationSummary: "",
    openedTopics: [],
    memoryState: {
      visible: [],
      page: {},
    },
  };
}

export class CrmRepository {
  // ──────────────────────────────────────────────────────────────────
  // Potential customers
  // ──────────────────────────────────────────────────────────────────

  /**
   * Find an existing customer by ip_hash. Returns the most recent one if there
   * are duplicates (shouldn't happen, but defensive).
   */
  async findCustomerByIpHash(ipHash: string): Promise<CrmPotentialCustomer | undefined> {
    const [row] = await db
      .select()
      .from(crmPotentialCustomers)
      .where(eq(crmPotentialCustomers.ipHash, ipHash))
      .orderBy(desc(crmPotentialCustomers.lastSeenAt))
      .limit(1);
    return row;
  }

  async getCustomerById(id: string): Promise<CrmPotentialCustomer | undefined> {
    const [row] = await db
      .select()
      .from(crmPotentialCustomers)
      .where(eq(crmPotentialCustomers.id, id));
    return row;
  }

  async createCustomer(input: {
    ipHash: string;
    countryCode?: string | null;
    region?: string | null;
  }): Promise<CrmPotentialCustomer> {
    const [row] = await db
      .insert(crmPotentialCustomers)
      .values({
        ipHash: input.ipHash,
        countryCode: input.countryCode ?? null,
        region: input.region ?? null,
      })
      .returning();
    return row;
  }

  async touchLastSeen(id: string): Promise<void> {
    await db
      .update(crmPotentialCustomers)
      .set({ lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(crmPotentialCustomers.id, id));
  }

  async setBlocked(id: string, blocked: boolean): Promise<void> {
    await db
      .update(crmPotentialCustomers)
      .set({ isBlocked: blocked, updatedAt: new Date() })
      .where(eq(crmPotentialCustomers.id, id));
  }

  /**
   * Sum credits used today across all CRM sessions for this customer.
   * Used to enforce the per-customer daily credits cap.
   */
  async getCreditsUsedToday(customerId: string): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const rows = await db
      .select({ creditsUsed: chatSessions.creditsUsed })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.crmPotentialCustomerId, customerId),
          gte(chatSessions.createdAt, startOfDay),
          isNull(chatSessions.deletedAt),
        ),
      );

    return rows.reduce((sum, r) => sum + (r.creditsUsed ?? 0), 0);
  }

  // ──────────────────────────────────────────────────────────────────
  // CRM sessions (rows in chat_sessions with crm_potential_customer_id set)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Find the most recent open CRM session for a customer that's still within
   * the resume window. Returns undefined to signal "start a new session".
   */
  async findResumableSession(customerId: string): Promise<ChatSession | undefined> {
    const cutoff = new Date(Date.now() - SESSION_RESUME_WINDOW_MS);

    const [row] = await db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.crmPotentialCustomerId, customerId),
          eq(chatSessions.status, "open"),
          gte(chatSessions.lastUpdate, cutoff),
          isNull(chatSessions.deletedAt),
        ),
      )
      .orderBy(desc(chatSessions.lastUpdate))
      .limit(1);

    return row;
  }

  async getSessionById(sessionId: string): Promise<ChatSession | undefined> {
    const [row] = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId));
    return row;
  }

  async createSession(customerId: string): Promise<ChatSession> {
    const [row] = await db
      .insert(chatSessions)
      .values({
        crmPotentialCustomerId: customerId,
        chatMode: "crm",
        state: emptyChatState(),
        log: [],
        last: [],
      })
      .returning();
    return row;
  }

  async updateSessionState(
    sessionId: string,
    patch: { state?: ChatState; log?: ChatMessage[]; last?: ChatMessage[] },
  ): Promise<void> {
    const update: Record<string, any> = {
      lastUpdate: new Date(),
      updatedAt: new Date(),
    };
    if (patch.state !== undefined) update.state = patch.state;
    if (patch.log !== undefined) update.log = patch.log;
    if (patch.last !== undefined) update.last = patch.last;

    await db.update(chatSessions).set(update).where(eq(chatSessions.id, sessionId));
  }

  // Credit charging moved to the shared ledger (server/services/credit-ledger.ts),
  // which writes creditsUsed + cost_breakdown atomically.

  // ──────────────────────────────────────────────────────────────────
  // Admin
  // ──────────────────────────────────────────────────────────────────

  /**
   * Paginated list of customers for the admin viewer. Filters by country,
   * blocked-flag, and substring-search on memory fields (email, names,
   * organization). Ordered by last-seen descending so active leads surface
   * first.
   */
  async listCustomersAdmin(opts: {
    limit: number;
    offset: number;
    country?: string;
    blocked?: boolean;
    search?: string;
  }): Promise<CrmPotentialCustomer[]> {
    const conditions = [] as any[];
    if (opts.country) {
      conditions.push(eq(crmPotentialCustomers.countryCode, opts.country.toUpperCase()));
    }
    if (typeof opts.blocked === "boolean") {
      conditions.push(eq(crmPotentialCustomers.isBlocked, opts.blocked));
    }
    if (opts.search && opts.search.trim().length > 0) {
      // chat_memory is jsonb; cast to text for substring search across all stored
      // Customer_* fields (name, email, org, role, notes). Cheap and good enough
      // for the volumes a sales chat will ever produce.
      conditions.push(ilike(sql`${crmPotentialCustomers.chatMemory}::text`, `%${opts.search}%`));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    return await db
      .select()
      .from(crmPotentialCustomers)
      .where(where)
      .orderBy(desc(crmPotentialCustomers.lastSeenAt))
      .limit(opts.limit)
      .offset(opts.offset);
  }

  async listCustomersAdminCount(opts: {
    country?: string;
    blocked?: boolean;
    search?: string;
  }): Promise<number> {
    const conditions = [] as any[];
    if (opts.country) {
      conditions.push(eq(crmPotentialCustomers.countryCode, opts.country.toUpperCase()));
    }
    if (typeof opts.blocked === "boolean") {
      conditions.push(eq(crmPotentialCustomers.isBlocked, opts.blocked));
    }
    if (opts.search && opts.search.trim().length > 0) {
      conditions.push(ilike(sql`${crmPotentialCustomers.chatMemory}::text`, `%${opts.search}%`));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [row] = await db
      .select({ total: count() })
      .from(crmPotentialCustomers)
      .where(where);
    return row?.total ?? 0;
  }

  async listSessionsForCustomer(customerId: string): Promise<ChatSession[]> {
    return await db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.crmPotentialCustomerId, customerId),
          isNull(chatSessions.deletedAt),
        ),
      )
      .orderBy(desc(chatSessions.lastUpdate));
  }

  /**
   * Update mutable customer fields. Memory edits are applied as a partial merge
   * onto chat_memory; pass an explicit `null` (or empty string) inside `memory`
   * to clear a key.
   */
  async updateCustomer(
    id: string,
    patch: { isBlocked?: boolean; memory?: Record<string, any> },
  ): Promise<CrmPotentialCustomer | undefined> {
    const update: Record<string, any> = { updatedAt: new Date() };
    if (typeof patch.isBlocked === "boolean") update.isBlocked = patch.isBlocked;

    if (patch.memory) {
      const current = await this.getCustomerById(id);
      if (!current) return undefined;
      const merged = { ...((current.chatMemory as Record<string, any>) ?? {}) };
      for (const [key, value] of Object.entries(patch.memory)) {
        if (value === null || value === "") {
          delete merged[key];
        } else {
          merged[key] = value;
        }
      }
      update.chatMemory = merged;
    }

    const [row] = await db
      .update(crmPotentialCustomers)
      .set(update)
      .where(eq(crmPotentialCustomers.id, id))
      .returning();
    return row;
  }

  /**
   * Hard-delete the customer and all their sessions. We don't soft-delete
   * here — these are anonymous lead records and the spec requires "delete
   * them" outright. Sessions are removed because they only ever belong to
   * one CRM customer (no cross-references to authenticated users).
   */
  async deleteCustomer(id: string): Promise<void> {
    await db
      .delete(chatSessions)
      .where(eq(chatSessions.crmPotentialCustomerId, id));
    await db
      .delete(crmPotentialCustomers)
      .where(eq(crmPotentialCustomers.id, id));
  }
}

export const crmRepository = new CrmRepository();
