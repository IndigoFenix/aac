/**
 * anthropic-client.ts
 *
 * Returns the Anthropic client used by every Claude call in the server. Two
 * backends are supported and selected via env:
 *
 *   ANTHROPIC_USE_VERTEX=1  → Vertex AI backend (AnthropicVertex)
 *   (default)               → direct Anthropic API (Anthropic)
 *
 * We default to the direct API because Vertex requires per-project Model Garden
 * enablement for each Claude model and can return 404/RESOURCE_EXHAUSTED until
 * that's provisioned. The Vertex path stays wired so it can be flipped on once
 * the Google Cloud side is sorted out.
 *
 * Both clients share the same `messages.create` / `messages.stream` surface,
 * so consumer code (claude-chat.ts, claude-structured.ts, deepAnalysisService.ts)
 * doesn't care which is active.
 *
 * Auth:
 *   - Direct  : ANTHROPIC_API_KEY
 *   - Vertex  : GOOGLE_APPLICATION_CREDENTIALS_JSON (inline service-account)
 *               + GOOGLE_CLOUD_PROJECT_ID
 *               + CLAUDE_VERTEX_REGION (optional, default "global")
 */

import Anthropic from "@anthropic-ai/sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { GoogleAuth } from "google-auth-library";

export type AnthropicClient = Anthropic | AnthropicVertex;

export function isUsingVertex(): boolean {
  const v = process.env.ANTHROPIC_USE_VERTEX;
  return v === "1" || v === "true";
}

let cached: AnthropicClient | null = null;
let cachedMode: "vertex" | "direct" | null = null;

export function getAnthropicClient(): AnthropicClient {
  const mode: "vertex" | "direct" = isUsingVertex() ? "vertex" : "direct";
  if (cached && cachedMode === mode) return cached;

  if (mode === "vertex") {
    const projectId =
      process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) {
      throw new Error(
        "Anthropic (Vertex) misconfigured: set GOOGLE_CLOUD_PROJECT_ID in env.",
      );
    }
    const region = process.env.CLAUDE_VERTEX_REGION || "global";

    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    const googleAuth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      ...(credentialsJson ? { credentials: JSON.parse(credentialsJson) } : {}),
    });

    cached = new AnthropicVertex({
      projectId,
      region,
      // Cast: AnthropicVertex bundles its own google-auth-library, structurally
      // identical to ours but nominally distinct due to the dual install.
      googleAuth: googleAuth as any,
    });
  } else {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "Anthropic (direct) misconfigured: set ANTHROPIC_API_KEY in env, " +
        "or set ANTHROPIC_USE_VERTEX=1 to use Vertex AI.",
      );
    }
    cached = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  cachedMode = mode;
  return cached;
}
