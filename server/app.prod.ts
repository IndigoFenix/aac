// server/app.prod.ts
// Long-lived container server (ECS Fargate / docker). Imported by
// index.prod.ts once the environment is complete.
//
// Unlike app.lambda.ts there is no freeze to work around: the process boots
// once, runs migrations under an advisory lock, then serves HTTP + WebSockets
// from the same http.Server that registerRoutes() attaches them to. Interval
// crons CAN fire here — but only if this file arms them. It calls
// scheduleMaintenanceCrons() below (session sweeper is armed by registerRoutes);
// an earlier version of this comment asserted they "fire normally" while the
// file armed none of them, and no erasure ever completed on ECS.

import express, { type Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pool } from "./db";
import { serveStaticWithLocaleLanding } from "./landing-static";
import {
  applySecurityHeaders,
  applyCorsPolicy,
  applyRequestLogger,
} from "./middleware/security";
import { assertRequiredSecrets, warnOnInsecureProductionConfig } from "./config/env-guards";

const app = express();

// Track if app is ready to serve traffic
let isReady = false;
let startupError: Error | null = null;

// Fail closed if security-critical secrets are missing/insecure in production.
try {
  assertRequiredSecrets();
  warnOnInsecureProductionConfig();
} catch (err) {
  startupError = err as Error;
  console.error((err as Error).message);
}

applySecurityHeaders(app);
applyCorsPolicy(app);
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: false, limit: '100mb' }));

function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}

applyRequestLogger(app);

// Health check - only returns healthy when app is fully initialized
app.get('/health', (_req, res) => {
  if (startupError) {
    // Generic body: the real message is on stderr. Echoing it here would
    // enumerate which secrets are missing to anyone who can reach /health.
    res.status(503).json({
      status: 'error',
      error: 'startup_failed',
      timestamp: new Date().toISOString()
    });
  } else if (!isReady) {
    res.status(503).json({
      status: 'starting',
      timestamp: new Date().toISOString()
    });
  } else {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString()
    });
  }
});

async function runMigrations(): Promise<void> {
  // Use advisory lock to prevent concurrent migrations
  const lockId = 12345; // arbitrary unique number

  try {
    const lockResult = await pool.query('SELECT pg_try_advisory_lock($1)', [lockId]);
    if (!lockResult.rows[0].pg_try_advisory_lock) {
      log("Another instance is running migrations, skipping...");
      return;
    }

    log("Running database migrations...");
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: "./drizzle" });
    log("Migrations completed!");

  } finally {
    await pool.query('SELECT pg_advisory_unlock($1)', [lockId]);
  }
}

async function waitForDatabase(): Promise<void> {
  const maxRetries = 10;
  const retryDelay = 2000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log(`Checking database connection (attempt ${attempt}/${maxRetries})...`);
      await pool.query('SELECT 1');
      log("Database connection established!");
      return;
    } catch (error: any) {
      if (attempt === maxRetries) {
        throw new Error(`Could not connect to database after ${maxRetries} attempts: ${error.message}`);
      }
      log(`Database not ready, retrying in ${retryDelay}ms...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

async function startServer(): Promise<void> {
  try {
    // Diagnostic: set VERTEX_PREFLIGHT=1 to print the REAL reason Vertex rejects
    // the live agents (the WebSocket path only surfaces a bare "403"). Runs once
    // at boot from THIS environment's egress, then continues normally.
    if (process.env.VERTEX_PREFLIGHT === "1") {
      try {
        const { runVertexPreflight } = await import("./scripts/vertex-preflight");
        await runVertexPreflight();
      } catch (e) {
        console.error("[VertexPreflight] probe error:", (e as Error).message);
      }
    }

    // Step 1: Wait for database to be available
    await waitForDatabase();

    // Step 2: Run migrations
    await runMigrations();

    // Step 3: Small delay to ensure tables are fully committed
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Step 4: Now register routes (which may query the database on init)
    log("Registering routes...");
    const { registerRoutes } = await import("./routes");
    const server = await registerRoutes(app);
    log("Routes registered successfully!");

    // Error handler
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";
      res.status(status).json({ message });
      // Production logs the message + status only — full stack traces would
      // be retained for the lifetime of CloudWatch logs (6 yrs in S3) and
      // can leak file paths / library versions useful to an attacker.
      console.error(`Request error [${status}]: ${message}`);
    });

    // Daily maintenance crons — erasure hard-delete, audit-log retention,
    // consent thresholds, spend alerts, package-link reconcile. ONE call,
    // shared with index.ts; server/tests/maintenance-crons-wiring.test.ts
    // fails if either entrypoint drops it. (This file shipped without any of
    // them until 2026-08-26, so no erasure request ever completed on ECS.)
    const { scheduleMaintenanceCrons } = await import("./services/maintenanceCrons");
    scheduleMaintenanceCrons();

    // Static files (built by Vite). In the AWS deployment the frontends ship
    // to S3 + CloudFront and the image is API-only, so every bundle here is
    // optional; a self-contained image (docker-compose, frontend_via_cloudfront
    // = false) serves whatever it finds.
    const distPath = path.resolve(import.meta.dirname, "public");
    const distPathAac = path.resolve(import.meta.dirname, "public-aac");
    const distPathGames = path.resolve(import.meta.dirname, "public-games");

    // Serve AAC client on /aac path (if built)
    if (fs.existsSync(distPathAac)) {
      log("Serving AAC client on /aac");
      app.use("/aac", express.static(distPathAac));
      // SPA fallback for AAC client
      app.use("/aac/*", (_req, res) => {
        res.sendFile(path.resolve(distPathAac, "index.html"));
      });
    }

    // Serve games on /games path (if built). Gated by license — see games-static.ts.
    if (fs.existsSync(distPathGames)) {
      log("Serving games on /games (license-gated)");
      const { mountGamesStatic } = await import("./games-static");
      mountGamesStatic(app, distPathGames);
    }

    // Serve main client (with prerendered per-locale landing pages)
    if (fs.existsSync(distPath)) {
      serveStaticWithLocaleLanding(app, distPath);
    } else {
      log("No client bundle at dist/public — running API-only (frontend served by CloudFront)");
    }

    // AKIM §18.5 — ECS drains a task with SIGTERM. Flush any half-open
    // processor-disclosure windows before the process goes, so a deploy does
    // not drop a live session's trailing send count. Registered before
    // listening so a task killed during a slow startup is still covered.
    // See services/processorDisclosure.ts.
    const { installDisclosureShutdownFlush } = await import("./services/processorDisclosure");
    installDisclosureShutdownFlush();

    const port = process.env.PORT || 5000;
    server.listen({ port: Number(port), host: "0.0.0.0" }, () => {
      log(`Server listening on port ${port}`);
      // Mark as ready AFTER server is listening
      isReady = true;
      log("Application ready to accept traffic!");
    });

  } catch (error: any) {
    console.error("Startup failed:", error);
    startupError = error;
    // Don't exit immediately - let health checks report the error
    // ECS will eventually kill the container
    setTimeout(() => {
      process.exit(1);
    }, 30000); // Give time for health check to report error
  }
}

// Prevent unhandled errors from crashing the server
// Process-level handlers log name + message only. A rejected value can be a
// Drizzle error carrying the failing row, an SDK error carrying the request
// body (i.e. the prompt), or a fetch error carrying a response — the same
// reasoning as the request-scoped handler above.
function describeFault(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return typeof value === "string" ? value.slice(0, 500) : `non-error value (${typeof value})`;
}

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", describeFault(reason));
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", describeFault(err));
});

// Fail CLOSED. If the secret guard threw, serving traffic would mean running
// on the committed dev-fallback constants: forgeable session cookies and
// decryptable IdP secrets. A task that exits here is exactly what the ECS
// circuit breaker exists to catch.
if (startupError) {
  console.error('Refusing to start: required secrets are missing or insecure.');
  process.exit(1);
}
startServer();
