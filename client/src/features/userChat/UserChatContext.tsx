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
  type UserChatMessageDTO,
  type UserChatRoomListEntry,
} from "./api";
import { useUserChatSocket } from "./useUserChatSocket";
import { useAuth } from "@/hooks/useAuth";

const PAGE_SIZE = 50;

interface UserChatContextValue {
  rooms: UserChatRoomListEntry[];
  totalUnread: number;
  activeRoomId: string | null;
  setActiveRoomId: (id: string | null) => void;
  messagesByRoom: Record<string, UserChatMessageDTO[]>;
  hasMoreByRoom: Record<string, boolean>;
  loadingMoreByRoom: Record<string, boolean>;

  refreshRooms: () => Promise<void>;
  openRoom: (roomId: string) => Promise<void>;
  loadOlder: (roomId: string) => Promise<void>;
  send: (roomId: string, body: string) => Promise<void>;
  markRead: (roomId: string) => Promise<void>;
  createDirect: (instituteId: string, otherUserId: string) => Promise<string>;
  createGroup: (instituteId: string, participantIds: string[], name: string) => Promise<string>;
}

const UserChatContext = createContext<UserChatContextValue | null>(null);

export function UserChatProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [rooms, setRooms] = useState<UserChatRoomListEntry[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, UserChatMessageDTO[]>>({});
  const [hasMoreByRoom, setHasMoreByRoom] = useState<Record<string, boolean>>({});
  const [loadingMoreByRoom, setLoadingMoreByRoom] = useState<Record<string, boolean>>({});
  const activeRoomRef = useRef<string | null>(null);
  activeRoomRef.current = activeRoomId;

  const refreshRooms = useCallback(async () => {
    try {
      const list = await apiFetchRooms();
      setRooms(list);
    } catch (err) {
      console.error("[userChat] refreshRooms error:", err);
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
      console.error("[userChat] openRoom error:", err);
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
      console.error("[userChat] loadOlder error:", err);
    } finally {
      setLoadingMoreByRoom((prev) => ({ ...prev, [roomId]: false }));
    }
  }, [messagesByRoom, hasMoreByRoom, loadingMoreByRoom]);

  const send = useCallback(async (roomId: string, body: string) => {
    const msg = await apiSendMessage(roomId, body);
    setMessagesByRoom((prev) => ({
      ...prev,
      [roomId]: [...(prev[roomId] ?? []), msg],
    }));
    // Room ordering/lastMessage refresh
    refreshRooms();
  }, [refreshRooms]);

  const markRead = useCallback(async (roomId: string) => {
    await apiMarkRoomRead(roomId);
  }, []);

  const createDirect = useCallback(async (instituteId: string, otherUserId: string) => {
    const room = await apiCreateRoom({ instituteId, participantIds: [otherUserId] });
    await refreshRooms();
    return room.id;
  }, [refreshRooms]);

  const createGroup = useCallback(async (instituteId: string, participantIds: string[], name: string) => {
    const room = await apiCreateRoom({ instituteId, participantIds, name });
    await refreshRooms();
    return room.id;
  }, [refreshRooms]);

  useUserChatSocket(
    useCallback(async (event) => {
      if (event.type === "userChat:message") {
        const payload = event.payload as UserChatMessageDTO;
        setMessagesByRoom((prev) => {
          const existing = prev[payload.roomId];
          // Only append if we've opened this room (history loaded)
          if (!existing) return prev;
          if (existing.some((m) => m.id === payload.id)) return prev;
          return { ...prev, [payload.roomId]: [...existing, payload] };
        });
        // If the message is for the currently open room, mark as read.
        if (activeRoomRef.current === payload.roomId) {
          apiMarkRoomRead(payload.roomId).catch(() => {});
        }
        refreshRooms();
      } else if (event.type === "userChat:unread") {
        // Update unread count for that room in our room list.
        setRooms((prev) =>
          prev.map((r) =>
            r.room.id === event.payload.roomId
              ? { ...r, unreadCount: event.payload.unreadCount }
              : r,
          ),
        );
      }
    }, [refreshRooms]),
    isAuthenticated,
  );

  const totalUnread = useMemo(
    () => rooms.reduce((sum, r) => sum + (r.unreadCount || 0), 0),
    [rooms],
  );

  const value: UserChatContextValue = {
    rooms,
    totalUnread,
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

  return <UserChatContext.Provider value={value}>{children}</UserChatContext.Provider>;
}

export function useUserChat(): UserChatContextValue {
  const ctx = useContext(UserChatContext);
  if (!ctx) throw new Error("useUserChat must be used within UserChatProvider");
  return ctx;
}
