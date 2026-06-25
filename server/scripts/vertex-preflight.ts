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
}

// Allow running standalone:  npx tsx server/scripts/vertex-preflight.ts
const isDirectRun = process.argv[1]?.includes("vertex-preflight");
if (isDirectRun) {
  await import("dotenv").then((d) => d.config());
  runVertexPreflight().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
