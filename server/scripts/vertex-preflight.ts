/**
 * Vertex AI auth/policy preflight — surfaces the REAL 403 reason that the
 * Live WebSocket path swallows ("Unexpected server response: 403").
 *
 * Run it FROM THE ENVIRONMENT THAT FAILS (i.e. on Render, not locally) so the
 * request originates from the same egress IP. It uses the exact same env vars
 * as gemini-live-provider.ts, mints a token with google-auth-library, and makes
 * a plain HTTPS REST call to Vertex. Vertex's JSON error body names the cause:
 *   - VPC_SERVICE_CONTROLS  -> perimeter blocking Render's egress IP
 *   - IAM_PERMISSION_DENIED -> SA lacks aiplatform.user (or IAM condition by IP)
 *   - SERVICE_DISABLED      -> Vertex AI API not enabled on the project
 *   - BILLING_DISABLED      -> billing off on the project
 *
 * Usage (on Render shell / one-off job):  npx tsx server/scripts/vertex-preflight.ts
 */

import { GoogleAuth } from "google-auth-library";

export async function runVertexPreflight(): Promise<void> {
  const project = process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "";
  const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

  console.log("=== Vertex preflight ===");
  console.log(`env project=${project} location=${location}`);
  console.log(`GOOGLE_APPLICATION_CREDENTIALS_JSON present=${!!credentialsJson}`);

  // Print THIS environment's public egress IP — the address Google's edge sees
  // and is blocking. Hand this to Render support / use it to confirm a fix.
  try {
    const ipRes = await fetch("https://api.ipify.org?format=json");
    const ip = (await ipRes.json() as { ip?: string }).ip;
    console.log(`>>> EGRESS IP (what Google's edge sees) = ${ip}`);
  } catch {
    console.log(">>> could not determine egress IP (ipify unreachable)");
  }

  let credentials: any;
  if (credentialsJson) {
    try {
      credentials = JSON.parse(credentialsJson);
    } catch (e) {
      console.error("PREFLIGHT FAIL: GOOGLE_APPLICATION_CREDENTIALS_JSON failed to parse:", (e as Error).message);
      return;
    }
    // Identity cross-check: does the SA's own project match the call target?
    console.log(`SA client_email=${credentials.client_email}`);
    console.log(`SA project_id=${credentials.project_id}  (call target project=${project})`);
    if (credentials.project_id && project && credentials.project_id !== project) {
      console.warn(`⚠️  SA project_id !== target project — cross-project call (needs explicit grant).`);
    }
    console.log(`SA private_key_id=${credentials.private_key_id}  (confirm this key is still ACTIVE in IAM)`);
  } else {
    console.log("No inline creds — falling back to ADC (this is what your LOCAL machine likely does).");
  }

  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });

  let token: string | null | undefined;
  try {
    const c = await auth.getClient();
    token = (await c.getAccessToken()).token;
    console.log(`Token acquired OK (len=${token?.length}). Identity authenticates fine.`);
  } catch (e) {
    console.error("PREFLIGHT FAIL: token acquisition FAILED (identity/key problem, not policy):", (e as Error).message);
    return;
  }

  // A regular model :generateContent exercises the same aiplatform permission +
  // the same network/VPC-SC perimeter as the Live WS, but returns a readable body.
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/gemini-2.5-flash:generateContent`;
  console.log(`\nPOST ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ping" }] }] }),
  });
  const body = await res.text();
  console.log(`HTTP ${res.status} ${res.statusText}`);
  const wwwAuth = res.headers.get("www-authenticate");
  if (wwwAuth) console.log(`www-authenticate: ${wwwAuth}`);
  console.log("--- response body ---");
  console.log(body.slice(0, 4000));
  console.log("--- end body ---");

  if (res.status === 403) {
    console.log("\n>>> 403 confirmed from this environment. The body above names the cause:");
    console.log("    'VPC Service Controls' / 'request is prohibited by organization's policy' -> perimeter/IP gate");
    console.log("    'PERMISSION_DENIED' on aiplatform -> IAM (role or IP condition)");
    console.log("    'has not been used'/'SERVICE_DISABLED' -> API not enabled");
    console.log("    'billing' -> billing disabled");
  } else if (res.ok) {
    console.log("\n>>> REST call SUCCEEDED from this environment. General Vertex access is fine here.");
  }

  // Step 2: best-effort Live WebSocket attempt — the actual failing path. REST
  // can pass while the WS is blocked, so this tells us if the gate is
  // Live-specific. The SDK hides the 403 body, so we only get a status here.
  console.log(`\nLive WebSocket attempt (model=gemini-live-2.5-flash-native-audio)...`);
  try {
    const { GoogleGenAI, Modality } = await import("@google/genai");
    const client = new GoogleGenAI({
      vertexai: true, project, location,
      ...(credentials ? { googleAuthOptions: { credentials } } : {}),
    });
    const connectP = client.live.connect({
      model: "gemini-live-2.5-flash-native-audio",
      config: { responseModalities: [Modality.AUDIO] },
      callbacks: { onopen: () => {}, onmessage: () => {}, onerror: () => {}, onclose: () => {} },
    });
    const timeoutP = new Promise((_, rej) => setTimeout(() => rej(new Error("timed out (no onopen) — handshake likely rejected")), 15000));
    const session: any = await Promise.race([connectP, timeoutP]);
    console.log(">>> Live WS OPENED successfully from this environment. (So a 403 in prod is intermittent or config-specific.)");
    try { session?.close?.(); } catch { /* ignore */ }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    console.log(`>>> Live WS FAILED: ${msg}`);
    if (/40[13]/.test(msg)) {
      console.log("    Same 403 as the app. If the REST call above SUCCEEDED, the block is Live-WebSocket-specific");
      console.log("    (different endpoint/handshake), not general Vertex access.");
    }
  }

  // Step 2b: Claude on Vertex (Model Garden). The Monitor and clinician chat
  // default to claude-haiku; ANTHROPIC_USE_VERTEX=1 routes them through the
  // GCP BAA instead of the direct Anthropic API. Unlike Gemini, Claude models
  // must be individually ENABLED in Model Garden per project — until then
  // Vertex answers 404 (model not found) or 429 (no quota). This step makes
  // that state visible at boot instead of at the first real session.
  const claudeVertexOn = process.env.ANTHROPIC_USE_VERTEX === "1" || process.env.ANTHROPIC_USE_VERTEX === "true";
  const claudeRegion = process.env.CLAUDE_VERTEX_REGION || "global";
  // Keep in sync with CLAUDE_MODEL_MAP in shared/llm-options.ts. Each row is
  // one Model Garden entry (they are enabled individually) and is exercised
  // the way the app uses it: Haiku as the Monitor / clinician-chat default,
  // Opus with ADAPTIVE thinking exactly as deepAnalysisService sends it — a
  // 400 here means the thinking parameter, not the enablement.
  const claudeChecks: Array<{ model: string; garden: string; role: string; thinking?: unknown }> = [
    { model: "claude-haiku-4-5@20251001", garden: "Claude Haiku 4.5", role: "Monitor + clinician chat default" },
    { model: "claude-opus-4-8", garden: "Claude Opus 4.8", role: "deep_analysis (adaptive thinking)", thinking: { type: "adaptive" } },
  ];
  console.log(`\nClaude on Vertex (ANTHROPIC_USE_VERTEX=${claudeVertexOn ? "on" : "OFF — prod will use the direct Anthropic API"}, region=${claudeRegion})...`);
  for (const check of claudeChecks) {
    console.log(`  ${check.model} [${check.role}]`);
    try {
      const { AnthropicVertex } = await import("@anthropic-ai/vertex-sdk");
      const claude = new AnthropicVertex({ projectId: project, region: claudeRegion, googleAuth: auth as any });
      const r = await claude.messages.create({
        model: check.model,
        max_tokens: check.thinking ? 256 : 8,
        messages: [{ role: "user", content: "Reply with the single word: pong" }],
        ...(check.thinking ? { thinking: check.thinking as any } : {}),
      });
      const text = r.content.map((c: any) => (c.type === "text" ? c.text : "")).join("").trim();
      const thought = r.content.some((c: any) => c.type === "thinking" || c.type === "redacted_thinking");
      console.log(`>>> ${check.model} OK (reply="${text.slice(0, 40)}"${check.thinking ? `, thinking block=${thought ? "yes" : "none (model chose not to think — fine)"}` : ""}). Model Garden has "${check.garden}" enabled in ${claudeRegion}.`);
    } catch (e: any) {
      const status = e?.status ?? e?.statusCode;
      const msg = e?.message || String(e);
      console.log(`>>> ${check.model} FAILED: HTTP ${status ?? "?"} — ${msg.slice(0, 600)}`);
      if (status === 404) {
        console.log(`    404 -> "${check.garden}" is NOT enabled in Model Garden for this project/region.`);
        console.log(`    Fix: GCP console -> Vertex AI -> Model Garden -> "${check.garden}" -> Enable (accept terms), then retry.`);
        console.log(`    Model Garden lists each point release separately; the IDs in shared/llm-options.ts must match what is enabled.`);
      } else if (status === 403) {
        console.log("    403 -> IAM: the SA needs roles/aiplatform.user on this project (same as Gemini), or a VPC-SC/IP gate is in the way.");
      } else if (status === 429) {
        console.log("    429 -> no quota provisioned for this model in this region. Request quota, or set CLAUDE_VERTEX_REGION to a region that has it.");
      } else if (status === 400 && check.thinking) {
        console.log("    400 -> the request shape is rejected; the message above names the parameter (thinking / max_tokens).");
      }
      if (!claudeVertexOn) {
        console.log("    (Informational only: ANTHROPIC_USE_VERTEX is off, so this failure does not affect prod today.)");
      }
    }
  }

  // Step 3: is the PUBLIC Gemini API (different host: generativelanguage.googleapis.com)
  // reachable from this environment? If Vertex is IP-blocked at Google's edge but
  // this returns 200, routing the live agents to the public API is the fix.
  const apiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_2;
  console.log(`\nPublic Gemini API reachability (host=generativelanguage.googleapis.com, GEMINI_API_KEY present=${!!apiKey})...`);
  if (!apiKey) {
    console.log(">>> No GEMINI_API_KEY set — cannot test the public-API escape hatch.");
  } else {
    try {
      const purl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      const pres = await fetch(purl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ping" }] }] }),
      });
      const ptext = await pres.text();
      console.log(`>>> Public Gemini API: HTTP ${pres.status} ${pres.statusText}`);
      if (pres.ok) {
        console.log("    Public API is REACHABLE from this environment — routing live agents here will unblock them.");
      } else {
        console.log(`    Body: ${ptext.slice(0, 600)}`);
      }
    } catch (e) {
      console.log(`>>> Public Gemini API request errored: ${(e as Error).message}`);
    }
  }
}

// Allow running standalone:  npx tsx server/scripts/vertex-preflight.ts
const isDirectRun = process.argv[1]?.includes("vertex-preflight");
if (isDirectRun) {
  await import("dotenv").then((d) => d.config());
  runVertexPreflight().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
