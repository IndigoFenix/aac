import 'dotenv/config';
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import fs from "fs";
import path from "path";
import { serveStaticWithLocaleLanding } from "./landing-static";
import {
  applySecurityHeaders,
  applyCorsPolicy,
  applyRequestLogger,
} from "./middleware/security";

const app = express();
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

  // Start the daily activity-log retention prune. Per-institute retention
  // comes from the regime registry; orphan rows use the strictest known
  // window. No-op in tests; deferred 60s after boot.
  const { scheduleActivityLogRetention } = await import("./services/activityLogRetentionCron");
  scheduleActivityLogRetention();

  // Start the daily right-to-erasure sweep. Hard-deletes students whose
  // 30-day cancellation window has elapsed. No-op in tests; deferred 90s
  // after boot to stagger from the retention cron above.
  const { scheduleStudentErasureSweep } = await import("./services/studentErasureCron");
  scheduleStudentErasureSweep();

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