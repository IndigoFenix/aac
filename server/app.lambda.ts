// server/app.lambda.ts
// Express app for Lambda - starts HTTP server immediately, then initializes DB
// This is imported AFTER secrets are loaded by index.lambda.ts

import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pool } from "./db";

const app = express();

// Track initialization state
let isReady = false;
let startupError: Error | null = null;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors({ origin: true, credentials: true }));

function log(message: string, source = "lambda") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const reqPath = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (reqPath.startsWith("/api") || reqPath.startsWith("/auth")) {
      let logLine = `${req.method} ${reqPath} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }
      log(logLine);
    }
  });

  next();
});

// Health check - returns 200 immediately so Lambda Adapter knows we're alive
// The "ready" status indicates if DB is connected and routes are registered
app.get('/health', (_req, res) => {
  if (startupError) {
    res.status(200).json({ 
      status: 'error', 
      error: startupError.message,
      timestamp: new Date().toISOString() 
    });
  } else if (!isReady) {
    res.status(200).json({ 
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
  const maxRetries = 3;
  const retryDelay = 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log(`Running database migrations (attempt ${attempt}/${maxRetries})...`);
      const db = drizzle(pool);
      await migrate(db, { migrationsFolder: "./drizzle" });
      log("Migrations completed successfully!");
      return;
    } catch (error: any) {
      if (error.message?.includes("already exists") || 
          error.message?.includes("duplicate key") ||
          (error.message?.includes("relation") && error.message?.includes("already exists"))) {
        log("Tables already exist, continuing...");
        return;
      }
      
      if (error.message?.includes("lock") || 
          error.message?.includes("concurrent") ||
          error.code === '55P03') {
        log(`Migration locked, retrying in ${retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }

      if (attempt === maxRetries) {
        throw error;
      }

      log(`Migration attempt ${attempt} failed: ${error.message}, retrying...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

async function waitForDatabase(): Promise<void> {
  const maxRetries = 5;
  const retryDelay = 1000;

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

async function initializeApp(): Promise<void> {
  try {
    // Step 1: Wait for database
    await waitForDatabase();

    // Step 2: Run migrations
    await runMigrations();

    // Step 3: Register routes
    log("Registering routes...");
    const { registerRoutes } = await import("./routes");
    await registerRoutes(app);
    log("Routes registered successfully!");

    // Mark as ready
    isReady = true;
    log("Application fully initialized!");

  } catch (error: any) {
    console.error("Initialization failed:", error);
    startupError = error;
  }
}

// Error handler (must be after routes are registered, so we add it dynamically)
function addErrorHandler() {
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    res.status(status).json({ message });
    console.error("Request error:", err);
  });

  // 404 handler for unknown routes
  app.use("*", (_req, res) => {
    if (!isReady) {
      res.status(503).json({ error: "Service starting up" });
    } else {
      res.status(404).json({ error: "Not found" });
    }
  });
}

// START SERVER IMMEDIATELY - then initialize DB in background
const port = process.env.PORT || 8080;
const server = app.listen(Number(port), "0.0.0.0", () => {
  log(`Server listening on port ${port}`);
  
  // Initialize app in background AFTER server is listening
  initializeApp().then(() => {
    addErrorHandler();
  }).catch((error) => {
    console.error("Failed to initialize:", error);
    startupError = error;
    addErrorHandler();
  });
});

export { app, server };