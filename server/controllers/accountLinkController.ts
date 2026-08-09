// server/controllers/accountLinkController.ts
//
// The USER-FACING half of account linking — we are the OAuth AUTHORIZATION
// SERVER (the machine-facing half is server/services/smart-home/account-link-service.ts).
//
// Amazon/Google open these pages inside their own app's webview when a family
// enables our skill/integration. A parent or clinician signs in with the normal
// session cookie, picks which STUDENT the speaker should act for, and the grant
// binds `(provider → studentId)`.
//
//   GET  /authorize   consent page (server-rendered, student picker)
//   POST /authorize   approval → 302 back to redirect_uri with ?code&state
//   POST /token       provider's back-channel: code→tokens, refresh→rotated tokens
//
// NOT MOUNTED HERE. Route mounting for smart-home endpoints is centralized
// (planning-docs/smart-home-actions.md — "provider agents export routers; the
// main session mounts them"). The intended mount is:
//
//     app.use("/api/smart-home/link", accountLinkRouter);
//     ⇒ https://<host>/api/smart-home/link/authorize   (Authorization URI in the console)
//     ⇒ https://<host>/api/smart-home/link/token       (Access Token URI in the console)
//
// TWO THINGS THE MOUNTING SESSION MUST DO:
//  1. Mount BEFORE the `/api` 404 catch-all in server/routes.ts.
//  2. Add the token path to the CSRF skip-list in server/routes.ts — Amazon and
//     Google POST to it from their servers with no Origin/Referer, so
//     `validateCSRF` would 403 it. (`POST /authorize` needs NO exemption: it is
//     a same-origin form submit from the page we rendered.) The skip belongs
//     beside the other machine-to-machine entries:
//         if (req.path === "/api/smart-home/link/token") return next();
//
// PAGES: self-contained inline HTML in the spotifyController style — no client
// bundle, no i18n runtime (these render outside our SPA, inside someone else's
// webview). ENGLISH-ONLY for now; see the i18n note on renderPage().
//
// No auth middleware belongs in front of the router: /authorize does its own
// session check so it can render a sign-in prompt instead of a 401 JSON body,
// and /token authenticates the PROVIDER, not a user.

import express, { type Request, type Response } from "express";
import { instituteRepository } from "../repositories";
import { studentService } from "../services";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  accountLinkClientById,
  exchangeAuthorizationCode,
  issueAuthorizationCode,
  refreshAccountLinkTokens,
  validateAuthorizeRequest,
  type AccountLinkAuthorizeRequest,
  type AccountLinkTokens,
  type SmartHomeProvider,
} from "../services/smart-home/account-link-service";

/** How the ecosystem is named to a parent. Never "provider", never an id. */
const PROVIDER_LABEL: Record<SmartHomeProvider, string> = {
  alexa: "Amazon Alexa",
  google: "Google Home",
};

/** Escape for HTML text and double-quoted attributes. */
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The one page shell. Plain language, no jargon — the reader is a parent in a
 * smart-speaker app, not a developer.
 *
 * i18n FOLLOW-UP: server-rendered pages have no `t()` runtime, and this one is
 * reached from outside our SPA (no language preference in the URL, possibly no
 * session yet). English-only is accepted for the phase-1 framework; when the
 * integrations go live these strings should read the granting user's language
 * from the session, falling back to `Accept-Language`.
 */
function renderPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)}</title>
    <style>
      body { margin: 0; min-height: 100vh; background: #0b1020; color: #e5e7eb; font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; }
      .card { background: #141a33; padding: 28px; border-radius: 14px; width: 100%; max-width: 420px; box-shadow: 0 10px 30px rgba(0,0,0,0.45); }
      h1 { margin: 0 0 8px; font-size: 1.2rem; }
      p { margin: 0 0 14px; color: #a5b0c7; font-size: 0.95rem; line-height: 1.5; }
      ul.students { list-style: none; padding: 0; margin: 0 0 18px; }
      ul.students li { margin: 0 0 8px; }
      label.pick { display: flex; align-items: center; gap: 10px; padding: 12px 14px; background: #1d2544; border: 1px solid #2c3660; border-radius: 10px; cursor: pointer; font-size: 1rem; }
      label.pick:hover { border-color: #6366f1; }
      input[type="radio"] { width: 18px; height: 18px; accent-color: #6366f1; }
      button, a.button { display: block; width: 100%; box-sizing: border-box; margin-top: 8px; padding: 12px; background: #6366f1; color: #fff; border: 0; border-radius: 10px; font-weight: 600; font-size: 1rem; text-align: center; text-decoration: none; cursor: pointer; }
      button:hover, a.button:hover { background: #4f46e5; }
      a.secondary { display: block; margin-top: 12px; text-align: center; color: #93a3c9; font-size: 0.9rem; }
      .notice { background: #3a1d1d; color: #fecaca; padding: 10px 12px; border-radius: 8px; margin-bottom: 14px; font-size: 0.9rem; }
    </style>
  </head>
  <body>
    <main class="card">
${body}
    </main>
  </body>
</html>`;
}

/** A dead end, deliberately: we must NEVER redirect to an unvalidated redirect_uri. */
function renderRefusal(message: string): string {
  return renderPage(
    "Something went wrong",
    `      <h1>We couldn't start the connection</h1>
      <div class="notice">${esc(message)}</div>
      <p>Please close this window and try connecting again from the Alexa or Google Home app.</p>`,
  );
}

/**
 * Hidden fields that carry the validated request through the form POST. They are
 * re-validated server-side on the way back in — the form is user-editable, so
 * this is a convenience, never a trust boundary.
 */
function hiddenFields(request: AccountLinkAuthorizeRequest): string {
  return `      <input type="hidden" name="response_type" value="code" />
      <input type="hidden" name="client_id" value="${esc(request.clientId)}" />
      <input type="hidden" name="redirect_uri" value="${esc(request.redirectUri)}" />
      <input type="hidden" name="state" value="${esc(request.state)}" />`;
}

/** The current session user, or null. Session cookie + passport (server/userAuth.ts). */
function sessionUser(req: Request): { id: string } | null {
  if (typeof req.isAuthenticated === "function" && !req.isAuthenticated()) return null;
  const user = req.user as { id?: string } | undefined;
  return user?.id ? { id: user.id } : null;
}

/**
 * The students this user may pick from — the ACCESS-CONTROLLED path only.
 *
 * `getInstitutesByUserId` is support-mode aware (it returns only the support
 * institute during a support session) and `getStudentsForUserInInstitute`
 * carries the per-user restriction predicates. Querying the students table
 * directly would silently bypass both.
 */
async function accessibleStudents(userId: string): Promise<{ id: string; name: string }[]> {
  const institutes = await instituteRepository.getInstitutesByUserId(userId);
  const byId = new Map<string, string>();
  for (const institute of institutes) {
    const rows = await studentService.getStudentsForUserInInstitute(userId, institute.id);
    for (const { student } of rows) {
      if (!byId.has(student.id)) {
        // getStudentsForUserInInstitute doesn't hydrate externalized fields, so
        // a name can come back null — never render an empty row.
        byId.set(student.id, student.name || student.firstName || "Unnamed student");
      }
    }
  }
  return [...byId.entries()].map(([id, name]) => ({ id, name }));
}

/** `Authorization: Basic base64(client_id:client_secret)` → the pair, or null. */
function basicAuth(header: unknown): { clientId: string; clientSecret: string } | null {
  if (typeof header !== "string") return null;
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  let decoded = "";
  try {
    decoded = Buffer.from(match[1].trim(), "base64").toString("utf8");
  } catch {
    return null;
  }
  const split = decoded.indexOf(":");
  if (split < 0) return null;
  // RFC 6749 §2.3.1 form-encodes the halves before base64.
  const decode = (part: string) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  return {
    clientId: decode(decoded.slice(0, split)),
    clientSecret: decode(decoded.slice(split + 1)),
  };
}

/** Read a urlencoded body field: only a lone string counts. */
function field(body: unknown, name: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" ? value.trim() : "";
}

/** RFC 6749 §5.2 error body. `no-store` is required on every token response. */
function tokenError(res: Response, status: number, error: string, description?: string): Response {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  if (status === 401) res.set("WWW-Authenticate", 'Basic realm="account-link"');
  return res
    .status(status)
    .json(description ? { error, error_description: description } : { error });
}

const router = express.Router();

/**
 * GET /authorize — the consent page.
 *
 * An invalid request dies HERE with a plain 400 page. Redirecting the error back
 * to an unvalidated `redirect_uri` is the classic open redirect, so a request
 * that fails validation never produces a redirect of any kind (RFC 6749 §4.1.2.1).
 */
router.get("/authorize", async (req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  try {
    const request = await validateAuthorizeRequest(
      req.query as Record<string, string | undefined>,
    );
    if (!request) {
      return res
        .status(400)
        .type("html")
        .send(
          renderRefusal(
            "This link is missing information we need, or it wasn't sent by a service we recognise.",
          ),
        );
    }

    const label = PROVIDER_LABEL[request.provider];
    const user = sessionUser(req);
    if (!user) {
      // The clinician login is a SPA route that does not (yet) honour a
      // returnTo — see the report/README note. The link carries one anyway so
      // it works the moment the login page learns to read it, and the
      // "continue" button below makes the flow completable today.
      const returnTo = req.originalUrl;
      const loginUrl = `/login?returnTo=${encodeURIComponent(returnTo)}`;
      return res
        .status(200)
        .type("html")
        .send(
          renderPage(
            `Connect ${label}`,
            `      <h1>Please sign in first</h1>
      <p>To connect ${esc(label)}, sign in to your Aivota account. You'll then choose which student the speaker should work for.</p>
      <a class="button" href="${esc(loginUrl)}" target="_blank" rel="noopener">Sign in to Aivota</a>
      <a class="secondary" href="${esc(returnTo)}">I've signed in — continue</a>`,
          ),
        );
    }

    const students = await accessibleStudents(user.id);
    if (students.length === 0) {
      return res
        .status(200)
        .type("html")
        .send(
          renderPage(
            `Connect ${label}`,
            `      <h1>No students on this account</h1>
      <p>${esc(label)} can only be connected to a student. Ask whoever set up your Aivota account to add you to the student you care for, then try again.</p>`,
          ),
        );
    }

    const options = students
      .map(
        (student, i) =>
          `        <li><label class="pick"><input type="radio" name="student_id" value="${esc(student.id)}"${i === 0 ? " checked" : ""} /> <span>${esc(student.name)}</span></label></li>`,
      )
      .join("\n");

    return res.status(200).type("html").send(
      renderPage(
        `Connect ${label}`,
        `      <h1>Connect ${esc(label)}</h1>
      <p>Choose who this speaker is for. ${esc(label)} will be able to run the home actions set up for that student — nothing else, and no personal information is shared.</p>
      <form method="post" action="${esc(req.originalUrl)}">
${hiddenFields(request)}
      <ul class="students">
${options}
      </ul>
      <button type="submit">Allow</button>
      </form>`,
      ),
    );
  } catch (error: any) {
    console.error("[AccountLink] authorize page error:", error?.message || error);
    return res
      .status(500)
      .type("html")
      .send(renderRefusal("Something went wrong on our side. Please try again in a moment."));
  }
});

/**
 * POST /authorize — the parent pressed Allow.
 *
 * Everything is re-checked from scratch: the session, the OAuth parameters (the
 * hidden fields are user-editable) and the student's accessibility to THIS user.
 * Only then is a code minted and the browser sent back to the provider.
 */
router.post("/authorize", async (req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  try {
    const request = await validateAuthorizeRequest(
      req.body as Record<string, string | undefined>,
    );
    if (!request) {
      return res
        .status(400)
        .type("html")
        .send(renderRefusal("This connection request is no longer valid. Please start again."));
    }

    const user = sessionUser(req);
    if (!user) {
      return res
        .status(401)
        .type("html")
        .send(renderRefusal("Your sign-in expired. Please sign in and start the connection again."));
    }

    const studentId = field(req.body, "student_id");
    if (!studentId) {
      return res
        .status(400)
        .type("html")
        .send(renderRefusal("Please choose a student before continuing."));
    }

    // Two independent gates, both access-controlled: the student must be in the
    // set this user may see, AND the canonical single-student check must pass.
    const students = await accessibleStudents(user.id);
    const permitted = students.some((student) => student.id === studentId);
    const { hasAccess } = await studentService.verifyStudentAccess(studentId, user.id);
    if (!permitted || !hasAccess) {
      return res
        .status(403)
        .type("html")
        .send(renderRefusal("You don't have access to that student."));
    }

    const code = await issueAuthorizationCode({
      ...request,
      studentId,
      grantedByUserId: user.id,
    });

    // redirect_uri came out of the allowlist, so this is a known-safe target.
    const target = new URL(request.redirectUri);
    target.searchParams.set("code", code);
    if (request.state) target.searchParams.set("state", request.state);
    return res.redirect(302, target.toString());
  } catch (error: any) {
    console.error("[AccountLink] approval error:", error?.message || error);
    return res
      .status(500)
      .type("html")
      .send(renderRefusal("Something went wrong on our side. Please try again in a moment."));
  }
});

/**
 * POST /token — the provider's back-channel, `application/x-www-form-urlencoded`.
 *
 * Client credentials may arrive as body params OR HTTP Basic (Alexa uses either
 * depending on how the skill is configured); Basic wins when both are present.
 * The provider is INFERRED from the client id — a caller never gets to say which
 * ecosystem it is.
 */
router.post("/token", async (req: Request, res: Response) => {
  try {
    const basic = basicAuth(req.headers.authorization);
    const clientId = basic?.clientId || field(req.body, "client_id");
    const clientSecret = basic?.clientSecret || field(req.body, "client_secret");
    if (!clientId || !clientSecret) {
      return tokenError(res, 401, "invalid_client", "Client authentication is required.");
    }

    const client = accountLinkClientById(clientId);
    if (!client) {
      return tokenError(res, 401, "invalid_client");
    }

    const grantType = field(req.body, "grant_type");
    let tokens: AccountLinkTokens | null = null;

    if (grantType === "authorization_code") {
      const code = field(req.body, "code");
      const redirectUri = field(req.body, "redirect_uri");
      if (!code || !redirectUri) {
        return tokenError(
          res,
          400,
          "invalid_request",
          "code and redirect_uri are required for grant_type=authorization_code.",
        );
      }
      tokens = await exchangeAuthorizationCode({
        provider: client.provider,
        code,
        clientId,
        clientSecret,
        redirectUri,
      });
    } else if (grantType === "refresh_token") {
      const refreshToken = field(req.body, "refresh_token");
      if (!refreshToken) {
        return tokenError(
          res,
          400,
          "invalid_request",
          "refresh_token is required for grant_type=refresh_token.",
        );
      }
      tokens = await refreshAccountLinkTokens({
        provider: client.provider,
        refreshToken,
        clientId,
        clientSecret,
      });
    } else {
      return tokenError(res, 400, "unsupported_grant_type");
    }

    if (!tokens) {
      // Deliberately undifferentiated: bad secret, spent code, wrong redirect
      // and revoked grant all look the same from outside. `invalid_grant` is
      // what both Amazon and Google expect for "start over".
      return tokenError(res, 400, "invalid_grant");
    }

    res.set("Cache-Control", "no-store");
    res.set("Pragma", "no-cache");
    return res.status(200).json({
      access_token: tokens.accessToken,
      token_type: tokens.tokenType,
      expires_in: tokens.expiresInSeconds ?? ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: tokens.refreshToken,
    });
  } catch (error: any) {
    console.error("[AccountLink] token endpoint error:", error?.message || error);
    return tokenError(res, 500, "server_error");
  }
});

export { router as accountLinkRouter };
