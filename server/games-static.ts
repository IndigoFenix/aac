// Static-asset gating + serving for the /games/ namespace.
//
// Anyone with an Aivota license (currently checked via `aacEnabled`) can play
// the games. Unauthenticated users are redirected to a self-contained login
// page at /games/_login that POSTs to the existing /auth/login endpoint.
//
// Wired into the Express app from `server/index.prod.ts`. The Lambda entry
// (`server/app.lambda.ts`) does not serve static assets at all; if/when games
// need to be served through the Lambda path, this same gate will be added there.

import express, { type Request, type Response, type NextFunction, type Express } from "express";
import path from "node:path";
import fs from "node:fs";

const GATED_PERMISSION = "aacEnabled" as const;

function safeReturnTo(req: Request): string {
  // Only allow same-origin paths under /games/. Any other value is replaced
  // with the games index. Prevents open-redirect via the returnTo param.
  const raw = req.originalUrl || "/games/";
  if (!raw.startsWith("/games/")) return "/games/";
  if (raw.startsWith("/games/_login")) return "/games/";
  return raw;
}

function renderLoginPage(returnTo: string, error?: string): string {
  const safeReturn = JSON.stringify(returnTo); // safe to embed in JS
  const errorBlock = error
    ? `<div class="error">${error.replace(/[<>&]/g, "")}</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign in — Aivota Games</title>
    <style>
      body { margin: 0; min-height: 100vh; background: #050816; color: #e5e7eb; font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; }
      .card { background: #0c0a26; padding: 32px; border-radius: 12px; width: 320px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
      h1 { margin: 0 0 8px; font-size: 1.25rem; }
      p.lead { margin: 0 0 20px; color: #94a3b8; font-size: 0.9rem; }
      label { display: block; font-size: 0.85rem; margin: 12px 0 4px; }
      input { width: 100%; box-sizing: border-box; padding: 8px 10px; background: #1e293b; border: 1px solid #334155; color: inherit; border-radius: 6px; font-size: 0.95rem; }
      button { margin-top: 20px; width: 100%; padding: 10px; background: #6366f1; color: white; border: 0; border-radius: 8px; font-weight: 600; cursor: pointer; }
      button:hover { background: #4f46e5; }
      button:disabled { opacity: 0.5; cursor: not-allowed; }
      .error { background: #7f1d1d; color: #fecaca; padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; font-size: 0.85rem; }
    </style>
  </head>
  <body>
    <form class="card" id="f" autocomplete="on">
      <h1>Aivota Games</h1>
      <p class="lead">Sign in to play. Any active Aivota license works.</p>
      ${errorBlock}
      <label for="username">Email</label>
      <input id="username" name="username" type="email" required autocomplete="username" />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required autocomplete="current-password" />
      <button id="b" type="submit">Sign in</button>
    </form>
    <script>
      const RETURN_TO = ${safeReturn};
      const form = document.getElementById('f');
      const button = document.getElementById('b');
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        button.disabled = true;
        const fd = new FormData(form);
        try {
          const res = await fetch('/auth/login', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: fd.get('username'),
              password: fd.get('password'),
            }),
          });
          if (res.ok) {
            window.location.replace(RETURN_TO);
            return;
          }
          const data = await res.json().catch(() => ({}));
          showError(data.message || 'Login failed.');
        } catch (e) {
          showError('Network error.');
        } finally {
          button.disabled = false;
        }
      });
      function showError(msg) {
        let el = document.querySelector('.error');
        if (!el) {
          el = document.createElement('div');
          el.className = 'error';
          form.insertBefore(el, form.children[2]);
        }
        el.textContent = msg;
      }
    </script>
  </body>
</html>`;
}

export function mountGamesStatic(app: Express, distPathGames: string): void {
  if (!fs.existsSync(distPathGames)) {
    // Nothing to serve — leave the namespace unmounted so 404s fall through.
    return;
  }

  // Games are built to be EMBEDDED by our clients (clinician preview, AAC
  // player, Electron). The global frameguard sends X-Frame-Options:
  // SAMEORIGIN, which blocks the standalone vite dev clients (different
  // origin). Replace it on this namespace with an explicit CSP ancestor
  // allowlist: same-origin + the Electron app:// origin, plus localhost dev
  // servers outside production. frame-ancestors takes precedence over
  // X-Frame-Options in browsers that support both.
  const devAncestors =
    process.env.NODE_ENV === "production"
      ? ""
      : " http://localhost:* http://127.0.0.1:*";
  app.use("/games", (_req: Request, res: Response, next: NextFunction) => {
    res.removeHeader("X-Frame-Options");
    res.setHeader(
      "Content-Security-Policy",
      `frame-ancestors 'self' app:${devAncestors}`,
    );
    next();
  });

  // Login page (always reachable, no auth required).
  app.get("/games/_login", (req: Request, res: Response) => {
    const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : "/games/";
    const safe = returnTo.startsWith("/games/") && !returnTo.startsWith("/games/_login")
      ? returnTo
      : "/games/";
    res.set("Cache-Control", "no-store");
    res.type("html").send(renderLoginPage(safe));
  });

  // Auth gate for everything else under /games/.
  const gate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.path.startsWith("/_login")) return next();

    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
      const returnTo = encodeURIComponent(safeReturnTo(req));
      res.redirect(`/games/_login?returnTo=${returnTo}`);
      return;
    }

    const user = req.user as { id: string; isSystemAdmin?: boolean };
    if (user.isSystemAdmin) return next();

    try {
      const { licenseService } = await import("./services/licenseService");
      const granted = await licenseService.userHasPermission(
        user.id,
        GATED_PERMISSION,
        Boolean(user.isSystemAdmin),
      );
      if (!granted) {
        res.status(403).type("html").send(
          `<!DOCTYPE html><html><body style="font-family:system-ui;background:#050816;color:#e5e7eb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
          <div style="text-align:center"><h1>License required</h1><p>Your account doesn't have an active Aivota license.</p></div>
          </body></html>`,
        );
        return;
      }
      next();
    } catch (err) {
      console.error("[games gate] license check failed:", err);
      res.status(500).send("Server error");
    }
  };

  app.use("/games", gate, express.static(distPathGames, { fallthrough: true }));

  // SPA fallback for game subpaths (e.g. /games/space-trader/some-deep-link).
  app.use("/games/:gameName/*", gate, (req: Request, res: Response, next: NextFunction) => {
    const indexPath = path.resolve(distPathGames, req.params.gameName, "index.html");
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      next();
    }
  });
}
