# ⚠️ Reminder: invalidate the client when you add/change a `Context_*` field

When the AI mutates data through a memory-schema field, the **server already
tells the client** — but the **client only refreshes the panels you wire up**.
If you add a new `Context_*` collection (or start mutating an existing one) and
forget the client side, the AI's change will save to the DB but the open
clinician panel will show stale data until a manual reload.

## How the signal flows

1. The AI calls a `MemoryDBOperations` op (`add`/`update`/`delete`) on a
   `Context_*` field defined here.
2. `extractContextFromMemoryValues()` in
   `server/services/sessionService.ts` converts every touched `Context_*` field
   into a lowercased flag on the chat `complete` event's `contextData`:
   - `Context_Locations` → `contextData.locations`
   - `Context_Calendar`  → `contextData.calendar`
   - `Context_Students`  → `contextData.students`
   (This is generic — no server change is needed per field.)
3. `handleContextData()` in `client/src/hooks/useChat.tsx` reads that flag and
   calls `queryClient.invalidateQueries(...)` for the React Query keys the
   relevant panel(s) use.

## What to do for a NEW Context field

- [ ] Add the field key to the `ChatResponseActions` interface in
      `client/src/hooks/useChat.tsx` (e.g. `myThing?: any; myThingUpdated?: boolean;`).
      This is also the usual TypeScript compile error that catches a missed wiring.
- [ ] Add a branch in `handleContextData()` that invalidates the query key(s)
      every panel reading that data uses. Use a **prefix** key
      (e.g. `['/api/locations']`) so institute/student-scoped keys like
      `['/api/locations', instituteId]` are matched too.
- [ ] Remember a single change can feed **multiple** panels. Example: editing a
      location must refresh both the Locations panel *and* the Calendar event
      dialog's location picker (both read `/api/locations`); attaching a location
      to an event refreshes the Calendar via `contextData.calendar`.

## Reference example

Locations + calendar wiring lives in `useChat.tsx` (`handleContextData`, the
`contextData.locations` and `contextData.calendar` branches) — copy that shape.

> Note: invalidation is **presence-based**, not diff-based — the flag fires on any
> turn the field was loaded/viewed, not only when it changed. That's the
> established trade-off here; refetches are cheap and only run for mounted panels.
