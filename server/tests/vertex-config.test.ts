// Which Google endpoint the Gemini agents talk to, and the two silent
// downgrades that made it invisible.
//
// 2026-08-20: the Live provider had a Vertex branch and the HTTP chat provider
// did not, so the Speaker and Observer ran on the paid GCP project while the
// Board Manager sat on the free AI Studio key. The day that key hit its daily
// cap, every board rebuild returned RESOURCE_EXHAUSTED — no navigation, no new
// boards — while the Speaker kept talking normally. Nothing in the symptom
// pointed at billing, because the two agents did not appear to share anything
// that could run out.
//
// These are the invariants that keep that from recurring.

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { vertexClientOptions, vertexConfigured } from "../services/providers/vertex-config.js";

const KEYS = [
  "GOOGLE_CLOUD_PROJECT_ID",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS_JSON",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("vertexClientOptions", () => {
  test("no project configured → null, meaning 'use the API key'", () => {
    expect(vertexClientOptions()).toBeNull();
    expect(vertexConfigured()).toBe(false);
  });

  test("a project is the whole precondition", () => {
    process.env.GOOGLE_CLOUD_PROJECT_ID = "aivota-prod";
    const opts = vertexClientOptions();
    expect(opts).toMatchObject({ vertexai: true, project: "aivota-prod" });
    expect(vertexConfigured()).toBe(true);
  });

  test("accepts the older GOOGLE_CLOUD_PROJECT spelling", () => {
    process.env.GOOGLE_CLOUD_PROJECT = "aivota-prod";
    expect(vertexClientOptions()?.project).toBe("aivota-prod");
  });

  test("defaults the region rather than sending an empty one", () => {
    process.env.GOOGLE_CLOUD_PROJECT_ID = "p";
    expect(vertexClientOptions()?.location).toBe("us-central1");
    process.env.GOOGLE_CLOUD_LOCATION = "europe-west4";
    expect(vertexClientOptions()?.location).toBe("europe-west4");
  });

  test("passes inline service-account credentials through", () => {
    process.env.GOOGLE_CLOUD_PROJECT_ID = "p";
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({ client_email: "a@b.c" });
    expect(vertexClientOptions()?.googleAuthOptions?.credentials).toEqual({ client_email: "a@b.c" });
  });

  test("malformed credentials still yield Vertex, falling through to ADC", () => {
    // The alternative — returning null — is the silent downgrade to the free
    // key. Better to attempt Vertex and fail loudly than to succeed cheaply on
    // a quota that runs out mid-session.
    process.env.GOOGLE_CLOUD_PROJECT_ID = "p";
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = "{not json";
    const opts = vertexClientOptions();
    expect(opts?.vertexai).toBe(true);
    expect(opts?.googleAuthOptions).toBeUndefined();
  });

  test("omits credentials entirely when none are set, so ADC applies", () => {
    // A developer machine authenticates with `gcloud auth`; requiring the
    // inline JSON would break local dev.
    process.env.GOOGLE_CLOUD_PROJECT_ID = "p";
    expect(vertexClientOptions()?.googleAuthOptions).toBeUndefined();
  });
});
