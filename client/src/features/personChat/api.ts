import { apiRequest } from "@/lib/queryClient";

export interface PersonChatRoomDTO {
  id: string;
  instituteId: string;
  name: string | null;
  isDirect: boolean;
  createdBy: string;
  createdAt: string;
  lastMessageAt: string;
}

export interface PersonChatParticipantDTO {
  personId: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
}

export interface PersonChatMessageDTO {
  id: string;
  roomId: string;
  senderPersonId: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

export interface PersonChatRoomListEntry {
  room: PersonChatRoomDTO;
  participants: PersonChatParticipantDTO[];
  lastMessage: PersonChatMessageDTO | null;
  unreadCount: number;
  lastReadAt: string | null;
}

export interface PersonChatContact {
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

export async function fetchContacts(instituteId?: string): Promise<PersonChatContact[]> {
  const qs = instituteId ? `?instituteId=${encodeURIComponent(instituteId)}` : "";
  const res = await apiRequest("GET", `/api/person-chat/contacts${qs}`);
  const data = await jsonOrThrow<{ contacts: PersonChatContact[] }>(res);
  return data.contacts;
}

export async function fetchRooms(): Promise<{ rooms: PersonChatRoomListEntry[]; selfPersonId: string }> {
  const res = await apiRequest("GET", "/api/person-chat/rooms");
  const data = await jsonOrThrow<{ rooms: PersonChatRoomListEntry[]; selfPersonId: string }>(res);
  return { rooms: data.rooms, selfPersonId: data.selfPersonId };
}

export async function createRoom(input: {
  instituteId: string;
  participantIds: string[];
  name?: string | null;
}): Promise<PersonChatRoomDTO> {
  const res = await apiRequest("POST", "/api/person-chat/rooms", input);
  const data = await jsonOrThrow<{ room: PersonChatRoomDTO }>(res);
  return data.room;
}

export async function fetchMessages(
  roomId: string,
  options: { before?: string; limit?: number } = {},
): Promise<PersonChatMessageDTO[]> {
  const params = new URLSearchParams();
  if (options.before) params.set("before", options.before);
  if (options.limit) params.set("limit", String(options.limit));
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await apiRequest("GET", `/api/person-chat/rooms/${roomId}/messages${qs}`);
  const data = await jsonOrThrow<{ messages: PersonChatMessageDTO[] }>(res);
  return data.messages;
}

export async function sendMessage(
  roomId: string,
  body: string,
  clientId?: string,
): Promise<PersonChatMessageDTO> {
  const res = await apiRequest("POST", `/api/person-chat/rooms/${roomId}/messages`, { body, clientId });
  const data = await jsonOrThrow<{ message: PersonChatMessageDTO }>(res);
  return data.message;
}

export async function markRoomRead(roomId: string): Promise<void> {
  await apiRequest("POST", `/api/person-chat/rooms/${roomId}/read`);
}

export async function registerPushToken(token: string, platform: string): Promise<void> {
  await apiRequest("POST", "/api/person-chat/push-register", { token, platform });
}
