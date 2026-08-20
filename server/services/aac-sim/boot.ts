/**
 * boot.ts — starting a real AAC session with no client (harness design ⓪).
 *
 * Thin glue over `HeadlessSocket`: construct the coordinator exactly as the WS
 * upgrade handler does, send the `initialize` the real client sends, and wait
 * for `initialized`. Everything past that point is the production system.
 *
 * ⚠️ THIS OPENS A REAL, BILLED SESSION on a real student row. It boots the four
 * agents, writes session rows, drains that student's budget meters and leaves
 * whatever the Monitor learns in their memory — by design (harness §9: the sim
 * students ARE ordinary students, and the suite exercises the real consent,
 * budget and logging machinery rather than tiptoeing around it). It is not a
 * jest fixture. Callers are the harness runner and the env-gated sim endpoint.
 */

import { AgentCoordinator } from "../dual-agent/agent-coordinator.js";
import type { ClientMessage } from "../dual-agent/live-relay.js";
import type { User } from "@shared/schema";
import { HeadlessSocket, type OutboundMessage } from "./headless-socket.js";

export interface BootSimOptions {
  studentId: string;
  /** The authenticated user the session runs as — a clinician/caretaker row,
   *  exactly as a real connection would carry. */
  user: User;
  /** Resume an existing session instead of creating one. */
  sessionId?: string;
  /** 'unmuted' = the AI talks TO the child (default); 'muted' = it stays quiet
   *  and helps the child talk to a PERSON. Both are worth scenarios. */
  muteState?: "unmuted" | "muted";
  classroomId?: string;
  /** IANA zone. The session plan reasons about time of day, so a run at a
   *  fixed zone is more reproducible than one that inherits the host's. */
  timezone?: string;
  /** Turns on the coordinator's debug feed — useful for a transcript, and it
   *  costs nothing on the model side. */
  debugMode?: boolean;
  /** How long to wait for `initialized`. Startup does real model work (the
   *  session plan), so this is generously above a normal turn. */
  initTimeoutMs?: number;
  /**
   * Advertise `clientStt`, which unlocks the `speech_text` channel — the
   * server refuses it otherwise (`capable("clientStt")`). Needed only by
   * scenarios that put ANOTHER PERSON in the room, since that is how their
   * speech reaches the session.
   *
   * Honest to claim: a scenario supplies transcripts of speech rather than
   * audio, which is exactly what an on-device-STT client does. Off by default
   * so an ordinary run keeps the server on its own paths.
   */
  clientStt?: boolean;
}

export interface SimSession {
  socket: HeadlessSocket;
  coordinator: AgentCoordinator;
  /** The session id the server assigned, from `initialized`. */
  sessionId: string;
  /** The `initialized` envelope, which carries `clientConfig`. */
  initialized: OutboundMessage;
  /**
   * Tear the session down.
   *
   * Calls `coordinator.cleanup()` DIRECTLY rather than just closing the socket.
   * A socket close on a ready session detaches and keeps the agents warm for a
   * reconnect that a sim run will never make — which is how these runs ended up
   * abandoned and reaped by the sweeper 35 minutes later.
   *
   * Prefer `endSimSession` (./teardown), which also WAITS for the finalization
   * to land; this returns as soon as teardown is requested.
   */
  dispose(): void;
}

/**
 * Boot a session and wait until the server says it is ready.
 *
 * CAPABILITIES ARE DELIBERATELY EMPTY. The real client advertises client-side
 * STT, scene-state classification, pose safety and client-side TTS; a text
 * driver can do none of those. Advertising `clientTts` in particular would have
 * the server dispatch `client_tts` and then WAIT for a `tts_done` ack that a
 * text driver has no honest way to produce, stalling the reply ordering. An
 * empty set makes the server use its own paths, which is what a sim wants:
 * text in, text out.
 */
export async function bootSimSession(opts: BootSimOptions): Promise<SimSession> {
  const {
    studentId,
    user,
    sessionId,
    muteState = "unmuted",
    classroomId,
    timezone = "UTC",
    debugMode = false,
    initTimeoutMs = 120_000,
    clientStt = false,
  } = opts;

  const socket = new HeadlessSocket();
  const coordinator = new AgentCoordinator(socket.asWebSocket(), user);

  const init: ClientMessage = {
    type: "initialize",
    studentId,
    userId: user.id,
    muteState,
    debugMode,
    timezone,
    capabilities: clientStt ? { clientStt: true } : {},
    ...(sessionId ? { sessionId } : {}),
    ...(classroomId ? { classroomId } : {}),
  } as ClientMessage;

  socket.deliver(init);

  // `error` is watched alongside `initialized` so a refused boot (consent gate,
  // missing student, bad licence) fails immediately with the server's own
  // reason instead of burning the whole init timeout on silence.
  const ready = await socket.waitFor(
    (m) => m.type === "initialized" || m.type === "error",
    { timeoutMs: initTimeoutMs },
  );

  if (ready.type === "error") {
    socket.close();
    throw new Error(`[aac-sim] session refused: ${String(ready.data ?? "unknown")}`);
  }

  return {
    socket,
    coordinator,
    sessionId: String(ready.sessionId ?? ""),
    initialized: ready,
    dispose: () => {
      // DROP THE SOCKET AND LET THE COORDINATOR TEAR ITSELF DOWN — the same
      // path production takes when a client disconnects.
      //
      // Do NOT call `cleanup()` directly here. With the socket still OPEN,
      // cleanup closes it itself, the close listener re-enters
      // `handleSocketLoss` (whose guard is `state === "closed"`, while cleanup
      // has only set `"closing"`), and the whole teardown runs a SECOND time —
      // including the final Monitor pass, which then publishes `[SESSION_CLOSED]`
      // twice and pays for two summaries. Production never hits that because by
      // the time it calls cleanup the socket is already closed.
      //
      // Requires `configureSimTeardown()` (./teardown) to have disabled socket
      // adoption, or a ready session DETACHES here instead of closing.
      socket.close();
    },
  };
}
