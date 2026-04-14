# User Chat — Implementation Plan

Real-time in-app chat between clinicians who share an institute. Supports 1:1 and multi-user rooms. Persistent history with lazy-loaded pagination. Text only for v1. In-app badge + message display; push-notification endpoint stubbed until mobile app exists.

## Decisions

- **Scope**: Clinician↔clinician only (users table). Students (AAC) excluded.
- **Rooms**: Both 1:1 and group, unified under `userChatRooms` (1:1 is a 2-participant room with `isDirect=true`).
- **Storage**: Private schema (`shared/schema-private.ts`), persistent, paginated on scroll-up.
- **Transport**: WebSocket on new path `/ws/user-chat`, separate from `/ws/live`.
- **Realtime primitives**: Extracted to `server/services/realtime/` so future student-activity monitoring can reuse them.
- **Access predicate**: Two users share an institute = inner join on `instituteUsers` by `instituteId`. Enforced on every send/read/fetch.
- **Auth**: Reuse Passport session cookie; WS upgrade validates session (unlike current `/ws/live`).
- **Push notifications**: Endpoint stub only; sender is no-op until mobile app exists.

## Naming

- Tables: `userChatRooms`, `userChatRoomParticipants`, `userChats`, `userChatPushTokens`
- Client feature folder: `client/src/features/userChat/`
- WS path: `/ws/user-chat`
- Push endpoint: `POST /api/user-chat/push-register`

## Phase 1 — Schema & migration

1. Add to `shared/schema-private.ts`:
   - `userChatRooms` — `id`, `instituteId` (FK, scope predicate), `name` (nullable; null for 1:1), `isDirect` (bool), `createdBy`, `createdAt`, `lastMessageAt` (indexed).
   - `userChatRoomParticipants` — `roomId`, `userId`, `joinedAt`, `lastReadAt`, `leftAt` (nullable). Unique `(roomId, userId)`.
   - `userChats` — `id`, `roomId`, `senderId`, `body`, `createdAt` (indexed), `editedAt`, `deletedAt`.
   - `userChatPushTokens` — `userId`, `token`, `platform`, `createdAt`.
2. `npm run db:generate` → review SQL → `npm run db:migrate`.

## Phase 2 — Generic realtime primitives (`server/services/realtime/`)

3. `ws-auth.ts` — session-cookie auth on HTTP upgrade using Passport's session store.
4. `room-registry.ts` — subscription registry: `subscribe(userId, topic, socket)`, `publish(topic, event)`, `unsubscribe`.
5. `realtime-server.ts` — attaches to existing HTTP server, routes by path (`/ws/user-chat` now; `/ws/student-activity` later).
6. Typed event envelope in `shared/realtime-events.ts`.

## Phase 3 — Server: repositories & services

7. `server/repositories/userChatRepository.ts` — CRUD + paginated message fetch (cursor on `createdAt`), unread counts per room for a user.
8. `server/services/userChat/userChatService.ts` — create room (1:1 dedup), send message, mark read, add/remove participant. All ops enforce same-institute check.
9. `server/services/userChat/pushNotifier.ts` — stub interface; logs only.

## Phase 4 — Server: HTTP endpoints (`server/controllers/userChatController.ts`)

10. `GET /api/user-chat/contacts` — users sharing any institute with me.
11. `GET /api/user-chat/rooms` — my rooms + unread counts + last message preview.
12. `POST /api/user-chat/rooms` — create room (`participantIds[]`, optional `name`).
13. `GET /api/user-chat/rooms/:id/messages?before=<cursor>&limit=50` — paginated history.
14. `POST /api/user-chat/rooms/:id/messages` — send (also broadcasts via realtime).
15. `POST /api/user-chat/rooms/:id/read` — update `lastReadAt`.
16. `POST /api/user-chat/push-register` — stub.
17. Wire routes in `server/routes.ts` with `requireAuth()`.

## Phase 5 — Server: WS event wiring

18. On `sendMessage` → persist → `publish(room:${id}, {type: "message", ...})`.
19. On `markRead` → `publish(user:${id}, {type: "unreadUpdate", roomId})`.
20. On connect → auto-subscribe user to `user:${userId}` + each `room:${id}` they belong to.

## Phase 6 — Clinician client: data layer

21. `client/src/features/userChat/api.ts` — `apiRequest` wrappers.
22. `client/src/features/userChat/useUserChatSocket.ts` — WS connect, reconnect, event dispatch.
23. `client/src/features/userChat/UserChatContext.tsx` — rooms list, active room messages, unread counts, send/markRead actions. React Query for history pagination.

## Phase 7 — Clinician client: UI

24. `UserChatPanel.tsx` — collapsible sidebar/drawer with room list.
25. `UserChatRoomView.tsx` — message list (reverse-scroll, lazy load older via intersection observer), composer, mark-read on view.
26. `NewChatModal.tsx` — contact picker (institute-scoped) + optional group name.
27. `UnreadBadge.tsx` — header badge + per-room count.
28. Mount panel in `client/src/App.tsx` behind auth.

## Phase 8 — i18n

29. Add keys to `client/src/i18n/en.ts` and `he.ts` (identical lines).
30. Run `scripts/validate-i18n.ts`.

## Phase 9 — Testing & polish

31. Manual test matrix: 1:1 create+dedup, group create, cross-institute denial, offline→online catch-up on reconnect, pagination, unread counts, read receipts clearing badge.
32. Confirm no regressions to `/ws/live` (AAC).

## Deferred

- Push notification delivery (endpoint exists; sender is no-op).
- Attachments, voice, typing indicators, edit/delete UI.
- AAC client participation.
- Student-activity monitor (will reuse Phase 2 primitives).
