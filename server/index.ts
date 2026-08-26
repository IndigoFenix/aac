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

  // Daily maintenance crons (consent thresholds, activity-log retention,
  // right-to-erasure sweep, spend alerts, package-link reconcile). ONE call
  // shared with app.prod.ts — see services/maintenanceCrons.ts for why.
  const { scheduleMaintenanceCrons } = await import("./services/maintenanceCrons");
  scheduleMaintenanceCrons();

  const isDevelopment = process.env.NODE_ENV === "development";

  // DEVELOPMENT: bring up the Vite dev server, but do NOT make the API wait
  // for it. Booting Vite (config load, plugin graph, dependency
  // re-optimization) is by far the slowest step in a dev boot, and none of
  // it is needed to answer an API call. So we register a gate here, start
  // listening below, and mount Vite's middleware when it is ready.
  //
  // The gate sits AFTER the API routes, so API requests are served the
  // moment the port is open. Only requests that would fall through to Vite
  // (the client HTML, /src/*, /games/*) wait on it — and they wait rather
  // than 404, which is what a browser opened during boot needs.
  let viteReady: Promise<void> | null = null;
  if (isDevelopment) {
    app.use((_req, _res, next) => {
      if (!viteReady) return next();
      viteReady.then(() => next(), () => next());
    });
  }
  // PRODUCTION: Serve static files directly
  else {
    const distPath = path.resolve(import.meta.dirname, "public");

    if (!fs.existsSync(distPath)) {
      throw new Error(`Could not find the build directory: ${distPath}`);
    }

    serveStaticWithLocaleLanding(app, distPath);
  }

  // Matches server/app.prod.ts: PORT wins, 5000 is the default.
  const port = Number(process.env.PORT) || 5000;
  server.listen({ port, host: "0.0.0.0" }, () => {
    log(`serving on port ${port}`);
  });

  if (isDevelopment) {
    viteReady = (async () => {
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
    })();
    const viteStart = Date.now();
    viteReady.then(
      () => log(`vite dev server ready (${Date.now() - viteStart}ms)`),
      (err) => log(`vite dev server FAILED to start: ${err?.message || err}`),
    );
  }

  // Resume any deep analyses that were interrupted by a prior server restart.
  import("./services/deepAnalysisService").then(({ resumeStalledAnalyses }) => {
    resumeStalledAnalyses().catch(err => log(`resumeStalledAnalyses error: ${err?.message || err}`));
  }).catch(() => {});
})();