import type { IncomingMessage, Server } from "http";
import type { Socket } from "net";
import { WebSocketServer, WebSocket } from "ws";
import type { User } from "@shared/schema";
import type { ClientRealtimeCommand } from "@shared/realtime-events";
import { authenticateUpgrade } from "./ws-auth";
import { subscribe, unsubscribe, removeSocket, registerUserSocket } from "./room-registry";

export interface AuthenticatedSocket extends WebSocket {
  userId: string;
}

export interface RealtimeHandler {
  path: string;
  // Called once per new authenticated connection. Handler may subscribe the
  // socket to initial topics (e.g. user:${id} + all their room topics).
  onConnect: (socket: AuthenticatedSocket, user: User) => void | Promise<void>;
  // Optional — additional command types beyond subscribe/unsubscribe/ping.
  onCommand?: (socket: AuthenticatedSocket, user: User, message: unknown) => void | Promise<void>;
}

const handlers: Map<string, RealtimeHandler> = new Map();
let wss: WebSocketServer | null = null;
let httpServer: Server | null = null;

export function registerRealtimeHandler(handler: RealtimeHandler): void {
  handlers.set(handler.path, handler);
}

export function setupRealtimeServer(server: Server): void {
  if (wss) return; // idempotent
  wss = new WebSocketServer({ noServer: true });
  httpServer = server;

  server.on("upgrade", async (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const handler = handlers.get(url.pathname);
    if (!handler) return; // other paths (e.g. /ws/live) handled by their own upgrade listeners

    const user = await authenticateUpgrade(req);
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss!.handleUpgrade(req, socket, head, async (ws) => {
      const authed = ws as AuthenticatedSocket;
      authed.userId = user.id;
      registerUserSocket(user.id, ws);

      ws.on("message", async (data) => {
        let parsed: ClientRealtimeCommand | Record<string, unknown>;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (parsed && typeof parsed === "object" && "type" in parsed) {
          const cmd = parsed as ClientRealtimeCommand;
          if (cmd.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
          // Subscribe/unsubscribe are client-controlled but server validates
          // topic access via handler.onCommand if needed.
          if (cmd.type === "subscribe" && typeof cmd.topic === "string") {
            subscribe(ws, cmd.topic);
            return;
          }
          if (cmd.type === "unsubscribe" && typeof cmd.topic === "string") {
            unsubscribe(ws, cmd.topic);
            return;
          }
          if (handler.onCommand) await handler.onCommand(authed, user, parsed);
        }
      });

      ws.on("close", () => removeSocket(ws));
      ws.on("error", () => removeSocket(ws));

      try {
        await handler.onConnect(authed, user);
      } catch (err) {
        console.error(`[realtime] onConnect error for ${url.pathname}:`, err);
      }
    });
  });

  console.log("[realtime] WebSocket server ready (path-based routing)");
}

export function getHttpServer(): Server | null {
  return httpServer;
}
