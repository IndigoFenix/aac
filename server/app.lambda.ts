// server/app.lambda.ts
// Express app for Lambda - ensures initialization completes

import express, { type Request, Response, NextFunction } from "express";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pool } from "./db";
import {
  applySecurityHeaders,
  applyCorsPolicy,
} from "./middleware/security";

const app = express();

// Initialization state
let isReady = false;
let initPromise: Promise<void> | null = null;
let startupError: Error | null = null;

applySecurityHeaders(app);
applyCorsPolicy(app);
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: false, limit: '100mb' }));

function log(message: string, source = "lambda") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}

// Health check - always responds (required for Lambda Adapter)
// During startup, waits up to 14s to keep Lambda unfrozen so the DB connection can complete.
// Without this, Lambda freezes between invocations, pausing the TCP/TLS handshake.
app.get('/health', async (_req, res) => {
  if (!isReady && !startupError && initPromise) {
    await Promise.race([
      initPromise,
      new Promise(resolve => setTimeout(resolve, 14000))
    ]);
  }

  if (startupError) {
    // A 503 here lets the Lambda Web Adapter / load balancer detect the
    // bad container and replace it instead of treating us as healthy.
    res.status(503).json({
      status: 'error',
      error: startupError.message,
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

// Middleware: Wait for initialization on ALL non-health requests
app.use(async (req, res, next) => {
  if (req.path === '/health') {
    return next();
  }
  
  // If already ready, continue
  if (isReady) {
    return next();
  }
  
  // If there was a startup error, return 503
  if (startupError) {
    log(`503 ${req.method} ${req.path} - startup error: ${startupError.message}`);
    return res.status(503).json({
      error: "Service failed to start",
      details: startupError.message
    });
  }

  // Wait for initialization to complete (with timeout)
  try {
    if (initPromise) {
      await Promise.race([
        initPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Initialization timeout")), 55000)
        )
      ]);
    }

    if (isReady) {
      return next();
    } else {
      log(`503 ${req.method} ${req.path} - service not ready after init`);
      return res.status(503).json({ error: "Service not ready" });
    }
  } catch (error: any) {
    log(`503 ${req.method} ${req.path} - init failed: ${error.message}`);
    return res.status(503).json({
      error: "Service initialization failed",
      details: error.message
    });
  }
});

// Request logging — does NOT capture response bodies (PHI safety).
app.use((req, res, next) => {
  if (!req.path.startsWith("/api") && !req.path.startsWith("/auth")) {
    return next();
  }
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    log(`${req.method} ${req.path} ${res.statusCode} in ${duration}ms`);
  });
  next();
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
      log(`Database error: ${error.message}`);
      if (attempt === maxRetries) {
        throw new Error(`Could not connect to database after ${maxRetries} attempts: ${error.message}`);
      }
      log(`Database not ready, retrying in ${retryDelay}ms...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

async function initializeApp(): Promise<void> {
  if (isReady) return;
  
  log("Starting initialization...");
  
  try {
    // Step 1: Wait for database
    await waitForDatabase();

    // Step 2: Run migrations on every cold start
    // Advisory lock prevents concurrent runs, and drizzle only applies pending migrations
    await runMigrations();

    // Step 3: Register routes
    log("Registering routes...");
    const { registerRoutes } = await import("./routes");
    await registerRoutes(app);
    log("Routes registered successfully!");

    // Add error handlers AFTER routes
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";
      res.status(status).json({ message });
      // Log message + status only; full stack traces persist 6yr in S3 logs
      // and leak file paths / library versions to anyone with audit-log access.
      console.error(`Request error [${status}]: ${message}`);
    });

    app.use("*", (_req, res) => {
      res.status(404).json({ error: "Not found" });
    });

    isReady = true;
    log("Application fully initialized!");

  } catch (error: any) {
    console.error("Initialization failed:", error);
    startupError = error;
    throw error;
  }
}

// Start server immediately for Lambda Adapter
const port = process.env.PORT || 8080;
app.listen(Number(port), "0.0.0.0", () => {
  log(`Server listening on port ${port}`);
  
  // Start initialization and store the promise
  initPromise = initializeApp().catch((error) => {
    console.error("Background init failed:", error);
    startupError = error;
  });
});