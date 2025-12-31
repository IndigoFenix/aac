// server/app.lambda.ts
// Express app for Lambda - ensures initialization completes

import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pool } from "./db";

const app = express();

// Initialization state
let isReady = false;
let initPromise: Promise<void> | null = null;
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

// Health check - always responds (required for Lambda Adapter)
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
          setTimeout(() => reject(new Error("Initialization timeout")), 25000)
        )
      ]);
    }
    
    if (isReady) {
      return next();
    } else {
      return res.status(503).json({ error: "Service not ready" });
    }
  } catch (error: any) {
    return res.status(503).json({ 
      error: "Service initialization failed", 
      details: error.message 
    });
  }
});

// Request logging
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

    // Step 2: Run migrations
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
      console.error("Request error:", err);
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