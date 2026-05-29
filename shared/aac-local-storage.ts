// shared/aac-local-storage.ts
// Types shared between client and server for AAC local storage system.

import type { ChatMessage, ParsedBoardData } from "./schema";

/**
 * Configuration for the client-side local storage system.
 * Sent from server to client on session initialization.
 */
export interface AacLocalStorageConfig {
  /** Whether local (device) storage is enabled */
  localStorageEnabled: boolean;
  /** Whether remote (database) storage is enabled */
  remoteStorageEnabled: boolean;
  /** Base64-encoded 256-bit AES encryption key, or null to store unencrypted (testing) */
  encryptionKey: string | null;
}

/**
 * Snapshot of session state sent from server to client for local persistence.
 * Contains everything needed to rebuild a session if the server restarts.
 */
export interface AacSessionSnapshot {
  /** Unique session identifier */
  sessionId: string;
  /** Student this session belongs to */
  studentId: string;
  /** User/clinician who started the session */
  userId?: string;
  /** Conversation messages (monitor-processed history) */
  messages: ChatMessage[];
  /** Messages not yet processed by monitor */
  pendingMessages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
    timestamp: number;
  }>;
  /** Whether the user has muted the AI (cave click). Mute is user-only — the AI cannot toggle this. */
  muteState: "unmuted" | "muted";
  /** Current response mode */
  responseMode?: "fast" | "analyze";
  /** Current board state */
  currentBoard?: ParsedBoardData | null;
  /** Server-tracked button labels */
  boardButtonLabels: string[];
  /** AI-added buttons on a loaded custom board */
  aiAddedButtonLabels: string[];
  /** Loaded custom board ID */
  loadedBoardId?: string | null;
  /** Current page within loaded board */
  currentPageId?: string | null;
  /** Monitor agent notes (from chatMemory.Student_Notes) */
  monitorNotes?: string;
  /** Built-in apps enabled for this session (id + display name + icon). */
  enabledApps?: Array<{ id: string; name: string; icon: string }>;
  /** Custom apps (clinician-authored games) assigned to this student. */
  availableCustomApps?: Array<{ id: string; name: string; imageUrl?: string | null; description?: string | null }>;
  /** When this snapshot was created (epoch ms) */
  timestamp: number;
}

/**
 * Locally stored session record in IndexedDB.
 * Wraps the snapshot with metadata for cleanup/lookup.
 */
export interface AacLocalSessionRecord {
  /** Primary key: `${studentId}:${sessionId}` */
  key: string;
  studentId: string;
  sessionId: string;
  /** The session snapshot (may be encrypted) */
  snapshot: AacSessionSnapshot;
  /** When this record was last updated */
  updatedAt: number;
  /** When the session was originally created */
  createdAt: number;
}

/**
 * Message: server → client, delivers a session snapshot for local storage.
 * Sent periodically and after key state changes.
 */
export interface WsSessionSnapshotMessage {
  type: "session_snapshot";
  snapshot: AacSessionSnapshot;
  config: AacLocalStorageConfig;
}

/**
 * Message: client → server, sends cached local state on reconnect/init.
 * Server uses this to rebuild session if DB data is missing or stale.
 */
export interface WsLocalStateMessage {
  type: "local_state";
  snapshot: AacSessionSnapshot;
}
