// server/app.lambda.ts
// Express app for Lambda - imported AFTER secrets are loaded

import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import cors from "cors";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pool } from "./db";

const app = express();
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

// Health check endpoint (before routes to ensure it's fast)
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

export async function startServer() {
  try {
    log("Running database migrations...");
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: "./drizzle" });
    log("Migrations completed!");
  } catch (error: any) {
    if (error.message?.includes("already exists")) {
      log("Tables already exist, skipping migrations");
    } else {
      console.error("Migration error:", error);
      throw error;
    }
  }
    
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    res.status(status).json({ message });
    console.error('Request error:', err);
  });

  // Lambda doesn't serve static files - S3/CloudFront does that
  // Just return 404 for unknown routes
  app.use("*", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  const port = process.env.PORT || 8080;
  server.listen({ port: Number(port), host: "0.0.0.0" }, () => {
    log(`Lambda server listening on port ${port}`);
  });
}
