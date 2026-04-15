import { apiRequest } from "@/lib/queryClient";

export interface UserChatRoomDTO {
  id: string;
  instituteId: string;
  name: string | null;
  isDirect: boolean;
  createdBy: string;
  createdAt: string;
  lastMessageAt: string;
}

export interface UserChatParticipantDTO {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
}

export interface UserChatMessageDTO {
  id: string;
  roomId: string;
  senderId: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

export interface UserChatRoomListEntry {
  room: UserChatRoomDTO;
  participants: UserChatParticipantDTO[];
  lastMessage: UserChatMessageDTO | null;
  unreadCount: number;
  lastReadAt: string | null;
}

export interface UserChatContact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  instituteIds: string[];
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (!data?.success) throw new Error(data?.message || "Request failed");
  return data as T;
}

export async function fetchContacts(instituteId?: string): Promise<UserChatContact[]> {
  const qs = instituteId ? `?instituteId=${encodeURIComponent(instituteId)}` : "";
  const res = await apiRequest("GET", `/api/user-chat/contacts${qs}`);
  const data = await jsonOrThrow<{ contacts: UserChatContact[] }>(res);
  return data.contacts;
}

export async function fetchRooms(): Promise<UserChatRoomListEntry[]> {
  const res = await apiRequest("GET", "/api/user-chat/rooms");
  const data = await jsonOrThrow<{ rooms: UserChatRoomListEntry[] }>(res);
  return data.rooms;
}

export async function createRoom(input: {
  instituteId: string;
  participantIds: string[];
  name?: string | null;
}): Promise<UserChatRoomDTO> {
  const res = await apiRequest("POST", "/api/user-chat/rooms", input);
  const data = await jsonOrThrow<{ room: UserChatRoomDTO }>(res);
  return data.room;
}

export async function fetchMessages(
  roomId: string,
  options: { before?: string; limit?: number } = {},
): Promise<UserChatMessageDTO[]> {
  const params = new URLSearchParams();
  if (options.before) params.set("before", options.before);
  if (options.limit) params.set("limit", String(options.limit));
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await apiRequest("GET", `/api/user-chat/rooms/${roomId}/messages${qs}`);
  const data = await jsonOrThrow<{ messages: UserChatMessageDTO[] }>(res);
  return data.messages;
}

export async function sendMessage(
  roomId: string,
  body: string,
  clientId?: string,
): Promise<UserChatMessageDTO> {
  const res = await apiRequest("POST", `/api/user-chat/rooms/${roomId}/messages`, { body, clientId });
  const data = await jsonOrThrow<{ message: UserChatMessageDTO }>(res);
  return data.message;
}

export async function markRoomRead(roomId: string): Promise<void> {
  await apiRequest("POST", `/api/user-chat/rooms/${roomId}/read`);
}

export async function registerPushToken(token: string, platform: string): Promise<void> {
  await apiRequest("POST", "/api/user-chat/push-register", { token, platform });
}
