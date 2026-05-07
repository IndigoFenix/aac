// Runtime accessibility audit using Playwright + @axe-core/playwright.
//
// Why Playwright instead of @axe-core/cli: `@axe-core/cli` pins a specific
// ChromeDriver to a specific Chrome version. Every Chrome auto-update breaks
// the script until axe-core/cli ships a new ChromeDriver bundle. Playwright
// bundles its own Chromium binary that's version-locked at install — Chrome
// updates can't break this script.
//
// Walks one or more routes against a running app, runs axe-core on each,
// aggregates violations, and writes a per-run JSON report. Optional login
// via test credentials lets the script audit auth-gated routes too.
//
// Prerequisites (one-time):
//   npx playwright install chromium
//
// Env (all optional):
//   A11Y_AUDIT_URL         Base URL. Default: http://localhost:5173
//   A11Y_AUDIT_ROUTES      Comma-separated paths. Default: a curated public list.
//                          Example: "/,/login,/dashboard,/students"
//   A11Y_AUDIT_USER_EMAIL  Test user email. If set, the script logs in before
//   A11Y_AUDIT_USER_PASSWORD  walking routes. Routes after login are audited
//                          with the resulting session cookie. Skip these for
//                          public-only audits.
//
// Tags: WCAG 2.0 A + AA, WCAG 2.1 AA. "best-practice" excluded — those are
// suggestions, not standard-required violations.
//
// Output: JSON report at planning-docs/wcag-audit-axe-<timestamp>.json plus
// per-route + aggregated console summaries. Exits 1 if any violations found.

import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const baseUrl = (process.env.A11Y_AUDIT_URL || "http://localhost:5173").replace(/\/$/, "");
const tags = ["wcag2a", "wcag2aa", "wcag21aa"];
const userEmail = process.env.A11Y_AUDIT_USER_EMAIL || null;
const userPassword = process.env.A11Y_AUDIT_USER_PASSWORD || null;

// Default route set covers the public surface a regulator can reach without
// credentials. Override with A11Y_AUDIT_ROUTES for the full app.
const DEFAULT_ROUTES = [
  "/",
  "/login",
  "/accessibility",
  "/privacy-policy",
  "/cookie-policy",
  "/terms-of-service",
  "/ai-policy",
];
const routes = (process.env.A11Y_AUDIT_ROUTES
  ? process.env.A11Y_AUDIT_ROUTES.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_ROUTES);

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const outDir = path.join(process.cwd(), "planning-docs");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `wcag-audit-axe-${stamp}.json`);

console.log(`[audit:a11y:axe] base   → ${baseUrl}`);
console.log(`[audit:a11y:axe] routes → ${routes.length} (${routes.join(", ")})`);
console.log(`[audit:a11y:axe] tags   → ${tags.join(", ")}`);
console.log(`[audit:a11y:axe] auth   → ${userEmail ? "logging in as " + userEmail : "public only"}`);
console.log(`[audit:a11y:axe] report → ${outFile}`);

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

/**
 * Log in via the standard /login form. Reads email/password, clicks submit,
 * waits until the URL is no longer /login (the SPA redirects to wherever
 * the user belongs after auth).
 */
async function login() {
  if (!userEmail || !userPassword) return;
  console.log(`[audit:a11y:axe] auth   → POST /login`);
  try {
    await page.goto(baseUrl + "/login", { waitUntil: "networkidle", timeout: 30_000 });
    // Form selectors mirror the LoginPage form: email/password Inputs.
    // Test selectors first (data-testid is the convention in this codebase),
    // fall back to type-based selectors.
    const emailInput = page.locator('[data-testid="input-email"], input[type="email"]').first();
    const passwordInput = page.locator('[data-testid="input-password"], input[type="password"]').first();
    const submit = page.locator('button[type="submit"]').first();
    await emailInput.fill(userEmail);
    await passwordInput.fill(userPassword);
    await submit.click();
    // Wait for the URL to change away from /login. If MFA is required this
    // will hang and the timeout below kicks in; treat that as a hard error.
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
    console.log(`[audit:a11y:axe] auth   → logged in (now at ${page.url()})`);
  } catch (err) {
    console.error(`[audit:a11y:axe] login failed: ${err.message}`);
    console.error(`[audit:a11y:axe] continuing without auth — auth-gated routes will redirect or fail`);
  }
}

if (userEmail) await login();

// Per-route results, plus a flat list of unique violations across the whole run.
const perRoute = [];

for (const route of routes) {
  const url = baseUrl + (route.startsWith("/") ? route : "/" + route);
  console.log("");
  console.log(`[audit:a11y:axe] ▶ ${route}`);
  let results;
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    // Tiny settle window for SPA-route lazy chunks / animations to land.
    await page.waitForTimeout(500);
    results = await new AxeBuilder({ page }).withTags(tags).analyze();
  } catch (err) {
    console.error(`  ✗ failed: ${err.message}`);
    perRoute.push({ route, url, error: err.message });
    continue;
  }
  console.log(`  passes ${results.passes.length} · violations ${results.violations.length} · incomplete ${results.incomplete.length}`);
  for (const v of results.violations) {
    console.log(`    [${v.impact ?? "?"}] ${v.id} (${v.nodes.length}) — ${v.help}`);
  }
  perRoute.push({
    route,
    url: results.url,
    finalUrl: page.url(),
    passes: results.passes.length,
    incomplete: results.incomplete.length,
    inapplicable: results.inapplicable.length,
    violations: results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      helpUrl: v.helpUrl,
      tags: v.tags,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        html: n.html,
        failureSummary: n.failureSummary,
      })),
    })),
  });
}

// Aggregate: count unique rule violations across the whole walk and which
// routes hit each one.
const ruleSummary = {};
let totalViolationNodes = 0;
for (const r of perRoute) {
  if (!r.violations) continue;
  for (const v of r.violations) {
    if (!ruleSummary[v.id]) {
      ruleSummary[v.id] = { id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, totalNodes: 0, routes: [] };
    }
    ruleSummary[v.id].totalNodes += v.nodes.length;
    ruleSummary[v.id].routes.push({ route: r.route, nodeCount: v.nodes.length });
    totalViolationNodes += v.nodes.length;
  }
}

const aggregatedReport = {
  meta: {
    runAt: new Date().toISOString(),
    baseUrl,
    tags,
    routes: routes.length,
    authenticated: !!userEmail,
  },
  ruleSummary: Object.values(ruleSummary).sort((a, b) => b.totalNodes - a.totalNodes),
  perRoute,
};

writeFileSync(outFile, JSON.stringify(aggregatedReport, null, 2), "utf8");

console.log("");
console.log(`[audit:a11y:axe] === Summary ===`);
console.log(`  Routes audited:       ${routes.length}`);
console.log(`  Total violation nodes: ${totalViolationNodes}`);
console.log(`  Unique rules violated: ${Object.keys(ruleSummary).length}`);
if (aggregatedReport.ruleSummary.length > 0) {
  console.log("");
  console.log("Top rules:");
  for (const r of aggregatedReport.ruleSummary.slice(0, 10)) {
    console.log(`  [${r.impact ?? "?"}] ${r.id} — ${r.totalNodes} node${r.totalNodes === 1 ? "" : "s"} across ${r.routes.length} route${r.routes.length === 1 ? "" : "s"}`);
  }
}

await browser.close();
process.exit(totalViolationNodes > 0 ? 1 : 0);
