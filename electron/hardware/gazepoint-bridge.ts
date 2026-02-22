import net from "net";
import { WebSocketServer, WebSocket } from "ws";

/**
 * Gazepoint Open Gaze API bridge.
 *
 * Connects to Gazepoint Control via TCP (127.0.0.1:4242),
 * enables gaze data streaming, parses XML records,
 * and re-broadcasts as JSON over a local WebSocket server (port 4243).
 *
 * The JSON format matches what our WebSocketBridgeProvider parsers expect:
 *   { x: 0-1, y: 0-1, confidence: 0-1, timestamp: number, leftPupil: mm, rightPupil: mm }
 */

const GAZEPOINT_HOST = "127.0.0.1";
const GAZEPOINT_TCP_PORT = 4242;
const WS_PORT = 4243;

export class GazepointBridge {
  private tcpClient: net.Socket | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private buffer = "";
  private destroyed = false;

  async start(): Promise<void> {
    this.destroyed = false;

    // Start WebSocket server for renderer clients
    this.wss = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });
    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
    });

    // Connect to Gazepoint Control
    await this.connectTCP();
  }

  stop(): void {
    this.destroyed = true;

    if (this.tcpClient) {
      this.tcpClient.destroy();
      this.tcpClient = null;
    }

    for (const ws of this.clients) {
      ws.close();
    }
    this.clients.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  private connectTCP(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.tcpClient = net.createConnection(
        { host: GAZEPOINT_HOST, port: GAZEPOINT_TCP_PORT },
        () => {
          console.log("[Gazepoint] Connected to Gazepoint Control");
          this.sendEnableCommands();
          resolve();
        },
      );

      this.tcpClient.setEncoding("utf8");
      this.tcpClient.on("data", (data: string) => this.handleData(data));

      this.tcpClient.on("error", (err) => {
        console.error("[Gazepoint] TCP error:", err.message);
        reject(err);
      });

      this.tcpClient.on("close", () => {
        console.log("[Gazepoint] TCP connection closed");
        if (!this.destroyed) {
          // Auto-reconnect after 3s
          setTimeout(() => {
            if (!this.destroyed) this.connectTCP().catch(() => {});
          }, 3000);
        }
      });
    });
  }

  private sendEnableCommands(): void {
    const commands = [
      '<SET ID="ENABLE_SEND_POG_FIX" STATE="1" />\r\n',
      '<SET ID="ENABLE_SEND_PUPIL_LEFT" STATE="1" />\r\n',
      '<SET ID="ENABLE_SEND_PUPIL_RIGHT" STATE="1" />\r\n',
      '<SET ID="ENABLE_SEND_DATA" STATE="1" />\r\n',
    ];
    for (const cmd of commands) {
      this.tcpClient?.write(cmd);
    }
  }

  private handleData(data: string): void {
    this.buffer += data;

    // Process complete XML records (each ends with />)
    let endIdx: number;
    while ((endIdx = this.buffer.indexOf("/>")) !== -1) {
      const record = this.buffer.slice(0, endIdx + 2).trim();
      this.buffer = this.buffer.slice(endIdx + 2);

      if (record.startsWith("<REC")) {
        this.parseAndBroadcast(record);
      }
    }
  }

  private parseAndBroadcast(record: string): void {
    // Parse XML attributes from <REC FPOGX="0.52" FPOGY="0.41" ... />
    const attrs: Record<string, string> = {};
    const regex = /(\w+)="([^"]*)"/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(record)) !== null) {
      attrs[match[1]] = match[2];
    }

    const x = parseFloat(attrs["FPOGX"]);
    const y = parseFloat(attrs["FPOGY"]);

    if (isNaN(x) || isNaN(y)) return;

    // FPOGV: fixation POG valid flag (1 = valid)
    const valid = attrs["FPOGV"] === "1";
    // FPOGD: fixation duration in seconds
    const duration = parseFloat(attrs["FPOGD"]) || 0;

    const gazeData = {
      x,
      y,
      confidence: valid ? 0.9 : 0.3,
      timestamp: Date.now(),
      leftPupil: parseFloat(attrs["LPMM"]) || undefined,
      rightPupil: parseFloat(attrs["RPMM"]) || undefined,
      fixationDuration: duration,
    };

    const json = JSON.stringify(gazeData);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }
  }
}
