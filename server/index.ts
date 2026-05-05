import 'dotenv/config';
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import fs from "fs";
import path from "path";
import cors from "cors";
import { serveStaticWithLocaleLanding } from "./landing-static";

const app = express();
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: false, limit: '100mb' }));
app.use(
  cors({
    origin: ["http://localhost:5173", "http://localhost:5174", "app://aac"],
    credentials: true,
  }),
);

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

      if (logLine.length > 200) {
        logLine = logLine.slice(0, 199) + "…";
      }

      log(logLine);
    }
  });

  next();
});

// Health check endpoint
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    res.status(status).json({ message });
    console.error("Request error:", err);
  });

  // Start the daily minor-threshold check. No-op in tests; deferred 30s
  // after boot for the first run.
  const { scheduleMinorThresholdCheck } = await import("./services/consent/consentThresholdCron");
  scheduleMinorThresholdCheck();

  // DEVELOPMENT: Use Vite dev server
  if (process.env.NODE_ENV === "development") {
    // Mount the gated games handler BEFORE the Vite catch-all so /games/*
    // doesn't fall through to client/index.html (which would render the main
    // client — or, if the user hits localhost:5174, render the AAC inside
    // itself). The handler only mounts when dist/public-games exists, so you
    // need to run `npm run build:games` once to populate it.
    const distPathGames = path.resolve(import.meta.dirname, "..", "dist", "public-games");
    if (fs.existsSync(distPathGames)) {
      const { mountGamesStatic } = await import("./games-static");
      mountGamesStatic(app, distPathGames);
    } else {
      // No build yet — at least keep /games/* from being captured by the SPA
      // fallback so the user gets a clear signal instead of a confusing nest.
      app.use("/games", (_req, res) => {
        res.status(503).type("text/plain").send(
          "/games/ is not available — run `npm run build:games` to populate dist/public-games.",
        );
      });
    }

    // Dynamic import keeps vite out of production bundle
    const { setupVite } = await import("./vite");
    await setupVite(app, server);
  }
  // PRODUCTION: Serve static files directly
  else {
    const distPath = path.resolve(import.meta.dirname, "public");

    if (!fs.existsSync(distPath)) {
      throw new Error(`Could not find the build directory: ${distPath}`);
    }

    serveStaticWithLocaleLanding(app, distPath);
  }

  const port = 5000;
  server.listen({ port, host: "0.0.0.0" }, () => {
    log(`serving on port ${port}`);
  });

  // Resume any deep analyses that were interrupted by a prior server restart.
  import("./services/deepAnalysisService").then(({ resumeStalledAnalyses }) => {
    resumeStalledAnalyses().catch(err => log(`resumeStalledAnalyses error: ${err?.message || err}`));
  }).catch(() => {});
})();