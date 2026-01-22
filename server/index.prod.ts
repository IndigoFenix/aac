import 'dotenv/config';
import express, { type Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
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

function log(message: string, source = "express") {
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
    if (reqPath.startsWith("/api")) {
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

    // Serve static files (built by Vite)
    const distPath = path.resolve(import.meta.dirname, "public");
    const distPathAac = path.resolve(import.meta.dirname, "public-aac");

    if (!fs.existsSync(distPath)) {
      throw new Error(`Build directory not found: ${distPath}`);
    }

    // Serve AAC client on /aac path (if built)
    if (fs.existsSync(distPathAac)) {
      log("Serving AAC client on /aac");
      app.use("/aac", express.static(distPathAac));
      // SPA fallback for AAC client
      app.use("/aac/*", (_req, res) => {
        res.sendFile(path.resolve(distPathAac, "index.html"));
      });
    }

    // Serve main client
    app.use(express.static(distPath));

    // SPA fallback for main client
    app.use("*", (_req, res) => {
      res.sendFile(path.resolve(distPath, "index.html"));
    });

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

// Start the server
startServer();