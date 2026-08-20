// server/services/providers/vertex-config.ts
//
// ONE definition of "are we talking to Gemini through Vertex, and how".
//
// Why this exists (2026-08-20): the Live provider had a Vertex branch and the
// HTTP chat provider did not. So the Speaker and Observer ran on the paid GCP
// project while the Board Manager quietly ran on the free AI Studio key — and
// the day that key hit its daily cap, every board rebuild started returning
// RESOURCE_EXHAUSTED while the Speaker kept talking. The symptom ("no
// navigation") looked nothing like the cause, because the two agents did not
// appear to share anything that could run out.
//
// Both providers now ask this module the same question, so they cannot drift
// onto different billing paths again.

/** Client options for the Google GenAI SDK when Vertex is in play. */
export interface VertexClientOptions {
  vertexai: true;
  project: string;
  location: string;
  googleAuthOptions?: { credentials: Record<string, unknown> };
}

/**
 * Vertex options when a GCP project is configured, else `null` (use the API
 * key). The project is the precondition the Live path has always relied on:
 * without it the SDK is constructed with `project: ""` and every call fails,
 * so treating "no project" as "not Vertex" is what the code already meant.
 *
 * Credentials come from `GOOGLE_APPLICATION_CREDENTIALS_JSON` when present,
 * otherwise from ADC (a credentials FILE or `gcloud auth`) — which is how a
 * developer machine authenticates and why this must not require the inline
 * JSON.
 */
export function vertexClientOptions(): VertexClientOptions | null {
  const project = process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "";
  if (!project) return null;

  const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

  let credentials: Record<string, unknown> | undefined;
  if (credentialsJson) {
    try {
      credentials = JSON.parse(credentialsJson);
    } catch {
      // A malformed blob must not silently fall back to the free key — that is
      // exactly the quiet downgrade this module exists to prevent. Say so, then
      // let ADC try.
      console.error(
        "[vertex-config] GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON — falling back to ADC.",
      );
    }
  }

  return {
    vertexai: true,
    project,
    location,
    ...(credentials ? { googleAuthOptions: { credentials } } : {}),
  };
}

/** True when Vertex is configured. Sugar for readability at call sites. */
export function vertexConfigured(): boolean {
  return vertexClientOptions() !== null;
}
