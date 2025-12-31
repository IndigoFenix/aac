// server/app.lambda.ts
// Express app for Lambda - based on index.prod.ts but without static file serving
// This is imported AFTER secrets are loaded by index.lambda.ts

import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pool } from "./db";

const app = express();

// Track if app is ready to serve traffic
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

// Health check - only returns healthy when app is fully initialized
app.get('/health', (_req, res) => {
  if (startupError) {
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

async function runMigrations(): Promise<void> {
  const maxRetries = 5;
  const retryDelay = 2000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log(`Running database migrations (attempt ${attempt}/${maxRetries})...`);
      const db = drizzle(pool);
      await migrate(db, { migrationsFolder: "./drizzle" });
      log("Migrations completed successfully!");
      return;
    } catch (error: any) {
      // Check if it's a "already exists" error (table already created)
      if (error.message?.includes("already exists") || 
          error.message?.includes("duplicate key") ||
          error.message?.includes("relation") && error.message?.includes("already exists")) {
        log("Tables already exist, continuing...");
        return;
      }
      
      // Check if it's a connection/lock error
      if (error.message?.includes("lock") || 
          error.message?.includes("concurrent") ||
          error.code === '55P03') {
        log(`Migration locked by another process, retrying in ${retryDelay}ms...`);
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
      console.error("Request error:", err);
    });

    // Lambda doesn't serve static files - CloudFront/S3 handles that
    // Return 404 for unknown routes
    app.use("*", (_req, res) => {
      res.status(404).json({ error: "Not found" });
    });

    const port = process.env.PORT || 8080;
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
    setTimeout(() => {
      process.exit(1);
    }, 30000);
  }
}

// Start the server
startServer();
