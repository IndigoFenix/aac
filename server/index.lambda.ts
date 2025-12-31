import express, { type Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import cors from "cors";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const app = express();

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

// Health check
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

// =============================================================================
// Load Secrets from AWS Secrets Manager
// =============================================================================
async function loadSecrets(): Promise<void> {
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION || "il-central-1" });
  
  const environment = process.env.ENVIRONMENT || "prod";
  const secretIds = [
    `cliniaccian-${environment}/database`,
    `cliniaccian-${environment}/app-secrets`
  ];

  for (const secretId of secretIds) {
    try {
      log(`Loading secrets from ${secretId}...`);
      const command = new GetSecretValueCommand({ SecretId: secretId });
      const response = await client.send(command);
      
      if (response.SecretString) {
        const secrets = JSON.parse(response.SecretString);
        for (const [key, value] of Object.entries(secrets)) {
          if (typeof value === 'string') {
            process.env[key] = value;
          }
        }
      }
    } catch (error: any) {
      log(`Failed to load secret ${secretId}: ${error.message}`);
      throw error;
    }
  }
  
  log("Secrets loaded successfully!");
}

// =============================================================================
// Database and Migrations
// =============================================================================
async function runMigrations(): Promise<void> {
  const maxRetries = 3;
  const retryDelay = 2000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log(`Running database migrations (attempt ${attempt}/${maxRetries})...`);
      
      // Dynamic import after secrets are loaded
      const { drizzle } = await import("drizzle-orm/node-postgres");
      const { migrate } = await import("drizzle-orm/node-postgres/migrator");
      const { pool } = await import("./db");
      
      const db = drizzle(pool);
      await migrate(db, { migrationsFolder: "./drizzle" });
      log("Migrations completed!");
      return;
    } catch (error: any) {
      if (error.message?.includes("already exists")) {
        log("Tables already exist, continuing...");
        return;
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

  // Dynamic import after secrets are loaded
  const { pool } = await import("./db");

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log(`Checking database connection (attempt ${attempt}/${maxRetries})...`);
      await pool.query('SELECT 1');
      log("Database connection established!");
      return;
    } catch (error: any) {
      if (attempt === maxRetries) {
        throw new Error(`Could not connect to database: ${error.message}`);
      }
      log(`Database not ready, retrying in ${retryDelay}ms...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

// =============================================================================
// Start Server
// =============================================================================
async function startServer(): Promise<void> {
  try {
    // Step 1: Load secrets from Secrets Manager
    await loadSecrets();

    // Step 2: Wait for database
    await waitForDatabase();

    // Step 3: Run migrations
    await runMigrations();

    // Step 4: Small delay for tables to be ready
    await new Promise(resolve => setTimeout(resolve, 500));

    // Step 5: Register routes
    log("Registering routes...");
    const { registerRoutes } = await import("./routes");
    const server = await registerRoutes(app);
    log("Routes registered!");

    // Error handler
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";
      res.status(status).json({ message });
      console.error("Request error:", err);
    });

    // Note: In Lambda mode, we don't serve static files
    // Frontend is served from S3/CloudFront
    // Only API endpoints are handled by Lambda

    const port = process.env.PORT || 8080;
    server.listen({ port: Number(port), host: "0.0.0.0" }, () => {
      log(`Server listening on port ${port}`);
      isReady = true;
      log("Application ready!");
    });

  } catch (error: any) {
    console.error("Startup failed:", error);
    startupError = error;
    // In Lambda, we still want to be able to report the error
    setTimeout(() => {
      process.exit(1);
    }, 10000);
  }
}

startServer();
