import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createRoom as apiCreateRoom,
  fetchMessages as apiFetchMessages,
  fetchRooms as apiFetchRooms,
  markRoomRead as apiMarkRoomRead,
  sendMessage as apiSendMessage,
  type PersonChatMessageDTO,
  type PersonChatRoomListEntry,
} from "./api";

export type PersonChatMessageStatus = "sending" | "sent" | "failed";

export interface ClientPersonChatMessage extends PersonChatMessageDTO {
  clientId?: string;
  status?: PersonChatMessageStatus;
}
import { usePersonChatSocket } from "./usePersonChatSocket";
import { useAuth } from "@/hooks/useAuth";

const PAGE_SIZE = 50;

interface PersonChatContextValue {
  rooms: PersonChatRoomListEntry[];
  totalUnread: number;
  selfPersonId: string | null;
  activeRoomId: string | null;
  setActiveRoomId: (id: string | null) => void;
  messagesByRoom: Record<string, ClientPersonChatMessage[]>;
  hasMoreByRoom: Record<string, boolean>;
  loadingMoreByRoom: Record<string, boolean>;

  refreshRooms: () => Promise<void>;
  openRoom: (roomId: string) => Promise<void>;
  loadOlder: (roomId: string) => Promise<void>;
  send: (roomId: string, body: string) => Promise<void>;
  markRead: (roomId: string) => Promise<void>;
  createDirect: (instituteId: string, otherPersonId: string) => Promise<string>;
  createGroup: (instituteId: string, participantIds: string[], name: string) => Promise<string>;
}

const PersonChatContext = createContext<PersonChatContextValue | null>(null);

export function PersonChatProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [selfPersonId, setSelfPersonId] = useState<string | null>(null);
  const selfPersonIdRef = useRef<string | null>(null);
  selfPersonIdRef.current = selfPersonId;
  const [rooms, setRooms] = useState<PersonChatRoomListEntry[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, ClientPersonChatMessage[]>>({});
  const [hasMoreByRoom, setHasMoreByRoom] = useState<Record<string, boolean>>({});
  const [loadingMoreByRoom, setLoadingMoreByRoom] = useState<Record<string, boolean>>({});
  const activeRoomRef = useRef<string | null>(null);
  activeRoomRef.current = activeRoomId;

  const refreshRooms = useCallback(async () => {
    try {
      const { rooms: list, selfPersonId: self } = await apiFetchRooms();
      setRooms(list);
      if (self) setSelfPersonId(self);
    } catch (err) {
      console.error("[personChat] refreshRooms error:", err);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) refreshRooms();
  }, [isAuthenticated, refreshRooms]);

  const openRoom = useCallback(async (roomId: string) => {
    setActiveRoomId(roomId);
    if (messagesByRoom[roomId]) {
      await apiMarkRoomRead(roomId);
      return;
    }
    try {
      const page = await apiFetchMessages(roomId, { limit: PAGE_SIZE });
      setMessagesByRoom((prev) => ({ ...prev, [roomId]: page.reverse() }));
      setHasMoreByRoom((prev) => ({ ...prev, [roomId]: page.length === PAGE_SIZE }));
      await apiMarkRoomRead(roomId);
    } catch (err) {
      console.error("[personChat] openRoom error:", err);
    }
  }, [messagesByRoom]);

  const loadOlder = useCallback(async (roomId: string) => {
    if (loadingMoreByRoom[roomId]) return;
    const current = messagesByRoom[roomId] ?? [];
    if (current.length === 0) return;
    if (hasMoreByRoom[roomId] === false) return;
    setLoadingMoreByRoom((prev) => ({ ...prev, [roomId]: true }));
    try {
      const oldest = current[0];
      const page = await apiFetchMessages(roomId, { before: oldest.createdAt, limit: PAGE_SIZE });
      setMessagesByRoom((prev) => ({ ...prev, [roomId]: [...page.reverse(), ...current] }));
      setHasMoreByRoom((prev) => ({ ...prev, [roomId]: page.length === PAGE_SIZE }));
    } catch (err) {
      console.error("[personChat] loadOlder error:", err);
    } finally {
      setLoadingMoreByRoom((prev) => ({ ...prev, [roomId]: false }));
    }
  }, [messagesByRoom, hasMoreByRoom, loadingMoreByRoom]);

  const send = useCallback(async (roomId: string, body: string) => {
    const senderPersonId = selfPersonIdRef.current ?? "";
    const clientId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `opt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimistic: ClientPersonChatMessage = {
      id: clientId,
      clientId,
      roomId,
      senderPersonId,
      body,
      createdAt: new Date().toISOString(),
      editedAt: null,
      deletedAt: null,
      status: "sending",
    };
    setMessagesByRoom((prev) => ({
      ...prev,
      [roomId]: [...(prev[roomId] ?? []), optimistic],
    }));

    try {
      const real = await apiSendMessage(roomId, body, clientId);
      setMessagesByRoom((prev) => {
        const list = prev[roomId];
        if (!list) return prev;
        // If the WS event already replaced the optimistic with the real id, drop the optimistic.
        if (list.some((m) => m.id === real.id)) {
          return { ...prev, [roomId]: list.filter((m) => m.clientId !== clientId) };
        }
        return {
          ...prev,
          [roomId]: list.map((m) =>
            m.clientId === clientId ? { ...real, clientId, status: "sent" as const } : m,
          ),
        };
      });
      refreshRooms();
    } catch (err) {
      console.error("[personChat] send error:", err);
      setMessagesByRoom((prev) => {
        const list = prev[roomId];
        if (!list) return prev;
        return {
          ...prev,
          [roomId]: list.map((m) =>
            m.clientId === clientId ? { ...m, status: "failed" as const } : m,
          ),
        };
      });
      throw err;
    }
  }, [refreshRooms]);

  const markRead = useCallback(async (roomId: string) => {
    await apiMarkRoomRead(roomId);
  }, []);

  const createDirect = useCallback(async (instituteId: string, otherPersonId: string) => {
    const room = await apiCreateRoom({ instituteId, participantIds: [otherPersonId] });
    await refreshRooms();
    return room.id;
  }, [refreshRooms]);

  const createGroup = useCallback(async (instituteId: string, participantIds: string[], name: string) => {
    const room = await apiCreateRoom({ instituteId, participantIds, name });
    await refreshRooms();
    return room.id;
  }, [refreshRooms]);

  usePersonChatSocket(
    useCallback(async (event) => {
      if (event.type === "personChat:ready") {
        const self = event.payload?.selfPersonId as string | undefined;
        if (self) setSelfPersonId(self);
      } else if (event.type === "personChat:message") {
        const payload = event.payload as PersonChatMessageDTO & { clientId?: string };
        setMessagesByRoom((prev) => {
          const existing = prev[payload.roomId];
          // Only append if we've opened this room (history loaded)
          if (!existing) return prev;
          // If this echoes our own optimistic message, replace it by clientId.
          if (payload.clientId && existing.some((m) => m.clientId === payload.clientId)) {
            return {
              ...prev,
              [payload.roomId]: existing.map((m) =>
                m.clientId === payload.clientId
                  ? { ...payload, clientId: payload.clientId, status: "sent" as const }
                  : m,
              ),
            };
          }
          if (existing.some((m) => m.id === payload.id)) return prev;
          return { ...prev, [payload.roomId]: [...existing, payload] };
        });
        // If the message is for the currently open room, mark as read.
        if (activeRoomRef.current === payload.roomId) {
          apiMarkRoomRead(payload.roomId).catch(() => {});
        }
        refreshRooms();
      } else if (event.type === "personChat:unread") {
        const { roomId, unreadCount } = event.payload;
        let knownRoom = false;
        setRooms((prev) => {
          knownRoom = prev.some((r) => r.room.id === roomId);
          if (!knownRoom) return prev;
          return prev.map((r) =>
            r.room.id === roomId ? { ...r, unreadCount } : r,
          );
        });
        if (!knownRoom) refreshRooms();
      } else if (event.type === "personChat:roomCreated") {
        refreshRooms();
      }
    }, [refreshRooms]),
    isAuthenticated,
  );

  const totalUnread = useMemo(
    () => rooms.reduce((sum, r) => sum + (r.unreadCount || 0), 0),
    [rooms],
  );

  const value: PersonChatContextValue = {
    rooms,
    totalUnread,
    selfPersonId,
    activeRoomId,
    setActiveRoomId,
    messagesByRoom,
    hasMoreByRoom,
    loadingMoreByRoom,
    refreshRooms,
    openRoom,
    loadOlder,
    send,
    markRead,
    createDirect,
    createGroup,
  };

  return <PersonChatContext.Provider value={value}>{children}</PersonChatContext.Provider>;
}

export function usePersonChat(): PersonChatContextValue {
  const ctx = useContext(PersonChatContext);
  if (!ctx) throw new Error("usePersonChat must be used within PersonChatProvider");
  return ctx;
}
