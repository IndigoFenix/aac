/**
 * Local Backend — No-op implementation of StorageBackend.
 *
 * When externalStorage is null (the default), this backend is used.
 * All methods are no-ops; the `isLocal` flag enables fast short-circuiting
 * in helpers so no external calls are ever made.
 */

import type { StorageBackend, EntityRef, StorageKey } from "../types";

class LocalBackend implements StorageBackend {
  readonly name = "local";
  readonly isLocal = true;

  async get(_ref: EntityRef, _key: StorageKey): Promise<undefined> {
    return undefined;
  }

  async getBatch(_ref: EntityRef, _keys: StorageKey[]): Promise<Map<StorageKey, unknown>> {
    return new Map();
  }

  async put(_ref: EntityRef, _key: StorageKey, _value: unknown): Promise<void> {}

  async putBatch(_ref: EntityRef, _entries: Map<StorageKey, unknown>): Promise<void> {}

  async delete(_ref: EntityRef, _key: StorageKey): Promise<void> {}

  async deleteBatch(_ref: EntityRef, _keys: StorageKey[]): Promise<void> {}
}

export const localBackend = new LocalBackend();
