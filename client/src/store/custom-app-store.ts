// src/store/custom-app-store.ts
//
// Zustand store for the custom app (game) currently being authored or
// previewed. The AI edits the underlying GameDefinition via manageMemory
// (Context_CustomApp); this store is the client-side mirror of that state
// plus DB association.

import { create } from "zustand";
import type { GameDefinition } from "@shared/custom-app-types";

interface CustomAppMeta {
  id: string;           // DB id
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  updatedAt?: string;
  loadedAt?: string;
}

interface CustomAppState {
  /** The definition currently open in the editor (may be unsaved). */
  definition: GameDefinition | null;
  /** DB id of the open app, if it has been persisted. */
  dbId: string | null;
  /** True when the in-memory definition differs from what's on the server. */
  isDirty: boolean;
  /** Cached list of the user's apps (metadata only). */
  apps: CustomAppMeta[];

  setDefinition: (def: GameDefinition | null, opts?: { markDirty?: boolean }) => void;
  setDbId: (id: string | null) => void;
  markClean: () => void;
  setApps: (apps: CustomAppMeta[]) => void;
  upsertAppMeta: (meta: CustomAppMeta) => void;
  removeAppMeta: (id: string) => void;
  reset: () => void;
}

export const useCustomAppStore = create<CustomAppState>((set) => ({
  definition: null,
  dbId: null,
  isDirty: false,
  apps: [],

  setDefinition: (def, opts) =>
    set((s) => ({
      definition: def,
      isDirty: opts?.markDirty ?? (def !== null && def !== s.definition),
    })),

  setDbId: (id) => set({ dbId: id }),

  markClean: () => set({ isDirty: false }),

  setApps: (apps) => set({ apps }),

  upsertAppMeta: (meta) =>
    set((s) => {
      const idx = s.apps.findIndex((a) => a.id === meta.id);
      const next = [...s.apps];
      if (idx >= 0) next[idx] = meta;
      else next.unshift(meta);
      return { apps: next };
    }),

  removeAppMeta: (id) => set((s) => ({ apps: s.apps.filter((a) => a.id !== id) })),

  reset: () => set({ definition: null, dbId: null, isDirty: false }),
}));
