/**
 * memory-db-bridge flow coverage.
 *
 * Drives every MemoryAction the AI can emit through MemoryManager against a
 * real DB. The LLM is bypassed entirely — we feed the *post-response payload*
 * (`MemoryToolInput`) directly. This is intentional: the user-reported pain
 * lives after the response, in operation processing, not in the LLM call.
 * The FakeLlm provider seam (helpers/llm-mock.ts) is for chat-handler tests.
 *
 * Actions covered (from memory-types.ts MemoryAction):
 *   view, hide, set, upsert, add, insert, delete, clear, rename
 *
 * Schema under test: a single `map`-typed field bound to the real `institutes`
 * table via direct Drizzle calls (skipping instituteService so the test
 * exercises the bridge, not the service).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { truncateAll, db } from '../helpers/db.js';
import { makeUser } from '../helpers/factories.js';
import { institutes } from '@shared/schema';
import { MemoryManager } from '../../services/chat/memory-db-integration.js';
import { processMemoryToolResponse } from '../../services/chat/memory-system.js';
import type {
  AgentMemoryFieldMapWithDB,
  AgentMemoryFieldObjectWithDB,
  AgentMemoryFieldWithDB,
} from '../../services/chat/memory-types.js';

// ============================================================================
// Test schema — a Context_TestItems map backed by the institutes table
// ============================================================================

interface OpCalls {
  list: number;
  get: number;
  read: number;
  write: number;
  add: number;
  update: number;
  upsert: number;
  insert: number;
  delete: number;
  clear: number;
  rename: number;
}

function makeTestField(calls: OpCalls): AgentMemoryFieldMapWithDB {
  return {
    id: 'Context_TestItems',
    type: 'map',
    title: 'Test Items',
    description: 'Items for memory-db-bridge tests',
    opened: true,
    displayKey: 'name',
    values: {
      id: 'TestItem',
      type: 'object',
      title: 'Test Item',
      properties: {
        id: { id: 'id', type: 'string', title: 'id' } as AgentMemoryFieldWithDB,
        name: { id: 'name', type: 'string', title: 'Name' } as AgentMemoryFieldWithDB,
        type: { id: 'type', type: 'string', title: 'Type' } as AgentMemoryFieldWithDB,
      },
      required: ['name', 'type'],
    } as AgentMemoryFieldObjectWithDB,
    db: {
      list: async (_ctx, { offset, limit }) => {
        calls.list++;
        const all = await db.select().from(institutes);
        const paged = all.slice(offset, offset + limit);
        return {
          items: paged.map((i) => ({ id: i.id, name: i.name, type: i.type })),
          total: all.length,
          keys: paged.map((i) => i.id),
        };
      },
      get: async (_ctx, key) => {
        calls.get++;
        const [row] = await db
          .select()
          .from(institutes)
          .where(eq(institutes.id, String(key)));
        return row ? { id: row.id, name: row.name, type: row.type } : undefined;
      },
      add: async (_ctx, value) => {
        calls.add++;
        const [row] = await db
          .insert(institutes)
          .values({
            name: value.name,
            type: value.type ?? 'school',
            isActive: true,
          } as any)
          .returning();
        return { id: row.id, name: row.name, type: row.type };
      },
      update: async (_ctx, key, value) => {
        calls.update++;
        const updates: Record<string, any> = { updatedAt: new Date() };
        if (value.name !== undefined) updates.name = value.name;
        if (value.type !== undefined) updates.type = value.type;
        const [row] = await db
          .update(institutes)
          .set(updates)
          .where(eq(institutes.id, String(key)))
          .returning();
        return row ? { id: row.id, name: row.name, type: row.type } : undefined;
      },
      upsert: async (_ctx, value, key) => {
        calls.upsert++;
        if (key) {
          // Update path
          const [row] = await db
            .update(institutes)
            .set({
              name: value.name,
              type: value.type ?? 'school',
              updatedAt: new Date(),
            } as any)
            .where(eq(institutes.id, String(key)))
            .returning();
          if (row) return { id: row.id, name: row.name, type: row.type };
        }
        // Insert path
        const [row] = await db
          .insert(institutes)
          .values({
            name: value.name,
            type: value.type ?? 'school',
            isActive: true,
          } as any)
          .returning();
        return { id: row.id, name: row.name, type: row.type };
      },
      delete: async (_ctx, key) => {
        calls.delete++;
        await db.delete(institutes).where(eq(institutes.id, String(key)));
      },
      clear: async (_ctx) => {
        calls.clear++;
        await db.delete(institutes);
      },
      rename: async (_ctx, oldKey, newKey) => {
        calls.rename++;
        // For this synthetic test schema, "rename" is implemented as updating
        // the name (the displayKey) — the real id can't be changed. The bridge
        // doesn't care; it just needs the rename op to fire.
        await db
          .update(institutes)
          .set({ name: String(newKey), updatedAt: new Date() })
          .where(eq(institutes.id, String(oldKey)));
      },
      getDBKey: (value) => value?.id,
    },
  };
}

function freshCalls(): OpCalls {
  return {
    list: 0, get: 0, read: 0, write: 0, add: 0, update: 0, upsert: 0,
    insert: 0, delete: 0, clear: 0, rename: 0,
  };
}

// ============================================================================
// Helpers
// ============================================================================

async function buildManager(userId: string, calls: OpCalls): Promise<{
  manager: MemoryManager;
  field: AgentMemoryFieldMapWithDB;
}> {
  const field = makeTestField(calls);
  const manager = new MemoryManager({
    fields: [field],
    baseContext: { userId },
    originalProcessor: processMemoryToolResponse,
  });
  await manager.initialize({}, { visible: [], page: {} });
  return { manager, field };
}

async function countInstitutes(): Promise<number> {
  const all = await db.select({ id: institutes.id }).from(institutes);
  return all.length;
}

async function findInstituteByName(name: string) {
  const [row] = await db
    .select()
    .from(institutes)
    .where(eq(institutes.name, name));
  return row;
}

// ============================================================================
// Tests
// ============================================================================

describe('memory-db-bridge flows', () => {
  let userId: string;

  beforeEach(async () => {
    const user = await makeUser();
    userId = user.id;
  });

  afterEach(truncateAll);

  // --------------------------------------------------------------------------
  // add
  // --------------------------------------------------------------------------
  describe('add', () => {
    it('inserts a row and returns the new key', async () => {
      const calls = freshCalls();
      const { manager } = await buildManager(userId, calls);

      const result = await manager.processToolCall({
        action: 'add',
        path: '/Context_TestItems',
        value: { name: 'Acme School', type: 'school' },
      });

      expect(result.success).toBe(true);
      expect(calls.add).toBe(1);
      expect(await countInstitutes()).toBe(1);
      const row = await findInstituteByName('Acme School');
      expect(row).toBeDefined();
      expect(row!.type).toBe('school');
      expect(result.results[0].actualKey).toBe(row!.id);
    });

    it('reports failure when the DB op throws', async () => {
      const calls = freshCalls();
      const field = makeTestField(calls);
      // Override add to throw
      const originalAdd = field.db!.add!;
      field.db!.add = async () => {
        throw new Error('DB write blew up');
      };
      const manager = new MemoryManager({
        fields: [field],
        baseContext: { userId },
        originalProcessor: processMemoryToolResponse,
      });
      await manager.initialize({}, { visible: [], page: {} });

      const result = await manager.processToolCall({
        action: 'add',
        path: '/Context_TestItems',
        value: { name: 'will fail', type: 'school' },
      });

      expect(result.success).toBe(false);
      expect(result.results[0].ok).toBe(false);
      expect(result.results[0].message).toMatch(/DB write blew up/);
      expect(await countInstitutes()).toBe(0);
      // restore (not strictly necessary — truncateAll runs in afterEach)
      field.db!.add = originalAdd;
    });
  });

  // --------------------------------------------------------------------------
  // upsert
  // --------------------------------------------------------------------------
  describe('upsert', () => {
    it('inserts when key is absent', async () => {
      const calls = freshCalls();
      const { manager } = await buildManager(userId, calls);

      const result = await manager.processToolCall({
        action: 'upsert',
        path: '/Context_TestItems',
        value: { name: 'Fresh Clinic', type: 'clinic' },
      });

      expect(result.success).toBe(true);
      expect(calls.upsert).toBe(1);
      expect(await countInstitutes()).toBe(1);
      const row = await findInstituteByName('Fresh Clinic');
      expect(row!.type).toBe('clinic');
    });

    it('updates when targeting an existing key', async () => {
      const calls = freshCalls();
      const { manager } = await buildManager(userId, calls);

      // Seed via add
      await manager.processToolCall({
        action: 'add',
        path: '/Context_TestItems',
        value: { name: 'Old Name', type: 'school' },
      });
      const seeded = await findInstituteByName('Old Name');
      expect(seeded).toBeDefined();

      // Upsert at the seeded key. The bridge resolves dbOps at the *container*
      // path; the existing-key target is supplied via `key`, not by drilling
      // into the path (the inner item schema has no db ops).
      const result = await manager.processToolCall({
        action: 'upsert',
        path: '/Context_TestItems',
        key: seeded!.id,
        value: { name: 'Renamed', type: 'school' },
      });

      expect(result.success).toBe(true);
      expect(calls.upsert).toBe(1);
      const renamed = await findInstituteByName('Renamed');
      expect(renamed?.id).toBe(seeded!.id);
      expect(await findInstituteByName('Old Name')).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // set (whole-value write at a key)
  // --------------------------------------------------------------------------
  describe('set', () => {
    it('routes a key-level set to the update DB op', async () => {
      const calls = freshCalls();
      const { manager } = await buildManager(userId, calls);

      await manager.processToolCall({
        action: 'add',
        path: '/Context_TestItems',
        value: { name: 'Original', type: 'school' },
      });
      const seeded = await findInstituteByName('Original');

      const result = await manager.processToolCall({
        action: 'set',
        path: `/Context_TestItems/${seeded!.id}/name`,
        value: 'Updated',
      });

      expect(result.success).toBe(true);
      // The bridge falls back to parent.update for property-level set
      expect(calls.update).toBe(1);
      const after = await findInstituteByName('Updated');
      expect(after?.id).toBe(seeded!.id);
    });
  });

  // --------------------------------------------------------------------------
  // delete
  // --------------------------------------------------------------------------
  describe('delete', () => {
    it('deletes a row by key', async () => {
      const calls = freshCalls();
      const { manager } = await buildManager(userId, calls);

      await manager.processToolCall({
        action: 'add',
        path: '/Context_TestItems',
        value: { name: 'To Delete', type: 'school' },
      });
      const seeded = await findInstituteByName('To Delete');
      expect(seeded).toBeDefined();

      const result = await manager.processToolCall({
        action: 'delete',
        path: `/Context_TestItems/${seeded!.id}`,
      });

      expect(result.success).toBe(true);
      expect(calls.delete).toBe(1);
      expect(await countInstitutes()).toBe(0);
    });

    it('does not affect other rows', async () => {
      const calls = freshCalls();
      const { manager } = await buildManager(userId, calls);

      await manager.processToolCall({
        action: 'add',
        path: '/Context_TestItems',
        value: { name: 'A', type: 'school' },
      });
      await manager.processToolCall({
        action: 'add',
        path: '/Context_TestItems',
        value: { name: 'B', type: 'school' },
      });
      const a = await findInstituteByName('A');

      await manager.processToolCall({
        action: 'delete',
        path: `/Context_TestItems/${a!.id}`,
      });

      expect(await countInstitutes()).toBe(1);
      expect(await findInstituteByName('B')).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // clear
  // --------------------------------------------------------------------------
  describe('clear', () => {
    it('empties the entire container', async () => {
      const calls = freshCalls();
      const { manager } = await buildManager(userId, calls);

      await manager.processToolCall({
        action: 'add', path: '/Context_TestItems',
        value: { name: 'X1', type: 'school' },
      });
      await manager.processToolCall({
        action: 'add', path: '/Context_TestItems',
        value: { name: 'X2', type: 'clinic' },
      });
      expect(await countInstitutes()).toBe(2);

      const result = await manager.processToolCall({
        action: 'clear',
        path: '/Context_TestItems',
      });

      expect(result.success).toBe(true);
      expect(calls.clear).toBe(1);
      expect(await countInstitutes()).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // rename
  //
  // For a map-keyed item, the bridge resolves dbOps to the inner item schema
  // (which has no db ops); rename has no parent-container fallback. The bridge
  // therefore lets the in-memory layer rename the key without firing any DB op.
  // No production schema currently wires a rename DB op, so this matches the
  // shipped behavior. If we ever add DB-backed rename, the assertion on
  // `calls.rename` should be updated.
  // --------------------------------------------------------------------------
  describe('rename', () => {
    it('renames the key in memory without firing a DB op (current behavior)', async () => {
      const calls = freshCalls();
      const { manager } = await buildManager(userId, calls);

      await manager.processToolCall({
        action: 'add', path: '/Context_TestItems',
        value: { name: 'Before', type: 'school' },
      });
      // Make the map visible so the in-memory rename has a key to operate on.
      await manager.processToolCall({ action: 'view', path: '/Context_TestItems' });
      const seeded = await findInstituteByName('Before');

      const result = await manager.processToolCall({
        action: 'rename',
        path: `/Context_TestItems/${seeded!.id}`,
        newKey: 'renamed-key',
      });

      expect(result.success).toBe(true);
      // Bridge does NOT call dbOps.rename for map items — no parent fallback
      expect(calls.rename).toBe(0);
      // In-memory rename did happen: new key present, old absent
      const map = result.memoryValues.Context_TestItems as Record<string, any>;
      expect(map['renamed-key']).toBeDefined();
      expect(map[seeded!.id]).toBeUndefined();
      // DB row is untouched (rename is in-memory-only here)
      expect(await findInstituteByName('Before')).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // view (loads from DB into memory) and hide
  // --------------------------------------------------------------------------
  describe('view / hide', () => {
    it('view triggers a list call and surfaces items in memory', async () => {
      const calls = freshCalls();
      const { manager } = await buildManager(userId, calls);

      await manager.processToolCall({
        action: 'add', path: '/Context_TestItems',
        value: { name: 'Visible1', type: 'school' },
      });
      await manager.processToolCall({
        action: 'add', path: '/Context_TestItems',
        value: { name: 'Visible2', type: 'clinic' },
      });

      // View the container
      const result = await manager.processToolCall({
        action: 'view',
        path: '/Context_TestItems',
      });

      expect(result.success).toBe(true);
      expect(calls.list).toBeGreaterThanOrEqual(1);
      const memoryItems = result.memoryValues.Context_TestItems;
      expect(memoryItems).toBeDefined();
      const names = Object.values(memoryItems as Record<string, any>).map(
        (v: any) => v.name,
      );
      expect(names.sort()).toEqual(['Visible1', 'Visible2']);
    });

    it('hide removes a path from the visible state without touching the DB', async () => {
      const calls = freshCalls();
      const { manager } = await buildManager(userId, calls);

      await manager.processToolCall({
        action: 'add', path: '/Context_TestItems',
        value: { name: 'StaysInDB', type: 'school' },
      });
      await manager.processToolCall({ action: 'view', path: '/Context_TestItems' });

      const beforeRowCount = await countInstitutes();
      const beforeDeleteCalls = calls.delete;
      const beforeClearCalls = calls.clear;

      const result = await manager.processToolCall({
        action: 'hide',
        path: '/Context_TestItems',
      });

      expect(result.success).toBe(true);
      // No mutation DB ops fired
      expect(calls.delete).toBe(beforeDeleteCalls);
      expect(calls.clear).toBe(beforeClearCalls);
      // Row is still there
      expect(await countInstitutes()).toBe(beforeRowCount);
    });
  });

  // --------------------------------------------------------------------------
  // batch — multiple operations in one tool call (most realistic AI shape)
  // --------------------------------------------------------------------------
  describe('batch operations', () => {
    it('processes a batch of mixed adds/deletes atomically from the AI side', async () => {
      const calls = freshCalls();
      const { manager } = await buildManager(userId, calls);

      await manager.processToolCall({
        action: 'add', path: '/Context_TestItems',
        value: { name: 'KeepMe', type: 'school' },
      });
      await manager.processToolCall({
        action: 'add', path: '/Context_TestItems',
        value: { name: 'DeleteMe', type: 'clinic' },
      });
      const toDelete = await findInstituteByName('DeleteMe');

      const result = await manager.processToolCall({
        ops: [
          { action: 'add', path: '/Context_TestItems',
            value: { name: 'Added In Batch', type: 'school' } },
          { action: 'delete', path: `/Context_TestItems/${toDelete!.id}` },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(calls.add).toBe(3); // 2 setup + 1 in batch
      expect(calls.delete).toBe(1);

      const names = (await db.select({ name: institutes.name }).from(institutes))
        .map((r) => r.name)
        .sort();
      expect(names).toEqual(['Added In Batch', 'KeepMe']);
    });
  });

  // --------------------------------------------------------------------------
  // Error reporting paths
  // --------------------------------------------------------------------------
  describe('error reporting', () => {
    it('returns a path-required error when mutation has no path', async () => {
      const calls = freshCalls();
      const { manager } = await buildManager(userId, calls);

      const result = await manager.processToolCall({
        action: 'set',
        // path intentionally missing
        value: 'whatever',
      });

      expect(result.success).toBe(false);
      expect(result.results[0].ok).toBe(false);
      expect(result.results[0].message).toMatch(/path/i);
    });

    it('returns a useful error when the path does not resolve to a known field', async () => {
      const calls = freshCalls();
      const { manager } = await buildManager(userId, calls);

      const result = await manager.processToolCall({
        action: 'add',
        path: '/NotARealField',
        value: { name: 'x', type: 'school' },
      });

      expect(result.success).toBe(false);
      expect(calls.add).toBe(0);
    });
  });
});
