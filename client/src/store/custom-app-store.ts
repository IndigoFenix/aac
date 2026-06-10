// src/store/custom-app-store.ts
//
// Zustand store for the custom app (game) currently being authored or
// previewed. The AI edits the underlying GameDefinition via manageMemory
// (Context_CustomApp); this store is the client-side mirror of that state
// plus DB association.
//
// The granular mutators below (upsertClass, addRoomEntity, etc.) are the
// editor's surface for changes — each one funnels through `mutateDefinition`
// which marks the store dirty so the Save button enables.

import { create } from "zustand";
import type {
  ButtonDef,
  ClassDef,
  GameDefinition,
  RoomDef,
  RoomEntityInstance,
} from "@shared/custom-app-types";
import { applyClassRename } from "@/features/custom-app/helpers";

interface CustomAppMeta {
  id: string;           // DB id
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  updatedAt?: string;
  loadedAt?: string;
}

/** A goal-tree quest game open in the panel (played + AI-edited, not v1-edited). */
export interface QuestGameState {
  appId: string;
  name: string;
  language?: string | null;
  /** GoalTreeGame JSON (kept opaque here; certified server-side). */
  contentPack: unknown;
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
  /** The goal-tree quest game open in the panel, if any. */
  questGame: QuestGameState | null;
  /** True when the quest game has AI edits not yet saved to the server. */
  questDirty: boolean;

  setDefinition: (def: GameDefinition | null, opts?: { markDirty?: boolean }) => void;
  setDbId: (id: string | null) => void;
  markClean: () => void;
  setApps: (apps: CustomAppMeta[]) => void;
  upsertAppMeta: (meta: CustomAppMeta) => void;
  removeAppMeta: (id: string) => void;
  reset: () => void;
  setQuestGame: (game: QuestGameState | null, opts?: { markDirty?: boolean }) => void;
  markQuestClean: () => void;

  // -- Granular editor mutators (all mark dirty)
  mutateDefinition: (updater: (def: GameDefinition) => GameDefinition) => void;
  setAppMeta: (patch: Partial<Pick<GameDefinition,
    "label" | "description" | "aiInstructions" | "iconRef" | "imageKey" |
    "symbolPath" | "turnBased" | "startRoom"
  >>) => void;
  upsertClass: (cls: ClassDef) => void;
  /** Rename a class id; if `cascade` is true, all references are rewritten. */
  renameClass: (oldId: string, newId: string, cascade: boolean) => void;
  deleteClass: (classId: string) => void;
  upsertRoom: (room: RoomDef) => void;
  deleteRoom: (roomId: string) => void;
  addRoomEntity: (roomId: string, entity: RoomEntityInstance) => void;
  updateRoomEntity: (roomId: string, index: number, patch: Partial<RoomEntityInstance>) => void;
  deleteRoomEntity: (roomId: string, index: number) => void;
  upsertButton: (btn: ButtonDef) => void;
  deleteButton: (buttonId: string) => void;
}

function upsertById<T extends { id: string }>(arr: T[], item: T): T[] {
  const i = arr.findIndex((x) => x.id === item.id);
  if (i < 0) return [...arr, item];
  const next = arr.slice();
  next[i] = item;
  return next;
}

export const useCustomAppStore = create<CustomAppState>((set) => ({
  definition: null,
  dbId: null,
  isDirty: false,
  apps: [],
  questGame: null,
  questDirty: false,

  setDefinition: (def, opts) =>
    set((s) => ({
      definition: def,
      isDirty: opts?.markDirty ?? (def !== null && def !== s.definition),
    })),

  setDbId: (id) => set({ dbId: id }),

  markClean: () => set({ isDirty: false }),

  setQuestGame: (game, opts) =>
    set({ questGame: game, questDirty: game !== null && (opts?.markDirty ?? false) }),

  markQuestClean: () => set({ questDirty: false }),

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

  reset: () =>
    set({ definition: null, dbId: null, isDirty: false, questGame: null, questDirty: false }),

  // -------------------------------------------------------------- mutators

  mutateDefinition: (updater) =>
    set((s) => {
      if (!s.definition) return {};
      return { definition: updater(s.definition), isDirty: true };
    }),

  setAppMeta: (patch) =>
    set((s) => {
      if (!s.definition) return {};
      return { definition: { ...s.definition, ...patch }, isDirty: true };
    }),

  upsertClass: (cls) =>
    set((s) => {
      if (!s.definition) return {};
      return {
        definition: { ...s.definition, classes: upsertById(s.definition.classes, cls) },
        isDirty: true,
      };
    }),

  renameClass: (oldId, newId, cascade) =>
    set((s) => {
      if (!s.definition || oldId === newId) return {};
      if (cascade) {
        return { definition: applyClassRename(s.definition, oldId, newId), isDirty: true };
      }
      // Non-cascading rename: only the class's own id changes. References stay
      // pointing at the now-missing oldId (the validator will surface this).
      const classes = s.definition.classes.map((c) =>
        c.id === oldId ? { ...c, id: newId } : c,
      );
      return { definition: { ...s.definition, classes }, isDirty: true };
    }),

  deleteClass: (classId) =>
    set((s) => {
      if (!s.definition) return {};
      return {
        definition: {
          ...s.definition,
          classes: s.definition.classes.filter((c) => c.id !== classId),
        },
        isDirty: true,
      };
    }),

  upsertRoom: (room) =>
    set((s) => {
      if (!s.definition) return {};
      return {
        definition: { ...s.definition, rooms: upsertById(s.definition.rooms, room) },
        isDirty: true,
      };
    }),

  deleteRoom: (roomId) =>
    set((s) => {
      if (!s.definition) return {};
      const rooms = s.definition.rooms.filter((r) => r.id !== roomId);
      // Keep startRoom valid if we just deleted it.
      const startRoom =
        s.definition.startRoom === roomId
          ? rooms[0]?.id ?? s.definition.startRoom
          : s.definition.startRoom;
      return { definition: { ...s.definition, rooms, startRoom }, isDirty: true };
    }),

  addRoomEntity: (roomId, entity) =>
    set((s) => {
      if (!s.definition) return {};
      const rooms = s.definition.rooms.map((r) =>
        r.id === roomId
          ? { ...r, entities: [...(r.entities ?? []), entity] }
          : r,
      );
      return { definition: { ...s.definition, rooms }, isDirty: true };
    }),

  updateRoomEntity: (roomId, index, patch) =>
    set((s) => {
      if (!s.definition) return {};
      const rooms = s.definition.rooms.map((r) => {
        if (r.id !== roomId) return r;
        const list = (r.entities ?? []).slice();
        if (!list[index]) return r;
        list[index] = { ...list[index], ...patch };
        return { ...r, entities: list };
      });
      return { definition: { ...s.definition, rooms }, isDirty: true };
    }),

  deleteRoomEntity: (roomId, index) =>
    set((s) => {
      if (!s.definition) return {};
      const rooms = s.definition.rooms.map((r) => {
        if (r.id !== roomId) return r;
        const list = (r.entities ?? []).slice();
        list.splice(index, 1);
        return { ...r, entities: list };
      });
      return { definition: { ...s.definition, rooms }, isDirty: true };
    }),

  upsertButton: (btn) =>
    set((s) => {
      if (!s.definition) return {};
      return {
        definition: { ...s.definition, buttons: upsertById(s.definition.buttons, btn) },
        isDirty: true,
      };
    }),

  deleteButton: (buttonId) =>
    set((s) => {
      if (!s.definition) return {};
      return {
        definition: {
          ...s.definition,
          buttons: s.definition.buttons.filter((b) => b.id !== buttonId),
        },
        isDirty: true,
      };
    }),
}));
