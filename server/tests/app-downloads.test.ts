// server/tests/app-downloads.test.ts
//
// The Downloads panel is only as good as its manifest reading: if the parser
// drifts from what electron-builder (or publish-aac-ios.mjs) actually writes,
// the clinician sees "no build published" for a build that exists, or a
// download link pointing at a filename that isn't there.
//
// Pure logic — no DB, no network (fetch is stubbed). Lives outside
// integration/ so `npm run test:unit` picks it up.

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  parseWindowsManifest,
  parseIosManifest,
  getAppDownloads,
  resolveDownloadTarget,
  clearAppDownloadCache,
} from "../services/appDownloadService";

// A verbatim copy of a real release/latest.yml (v1.0.16).
const REAL_LATEST_YML = `version: 1.0.16
files:
  - url: Aivota AAC Setup 1.0.16.exe
    sha512: Ze6oAXhiQofhEKEB/XE6CYYThe0rqs3lvH4tA7f+LPTh1+WR/coO/FI29KWu98+8NH6blXvZRoIDNdSwQ7xO9Q==
    size: 209333599
path: Aivota AAC Setup 1.0.16.exe
sha512: Ze6oAXhiQofhEKEB/XE6CYYThe0rqs3lvH4tA7f+LPTh1+WR/coO/FI29KWu98+8NH6blXvZRoIDNdSwQ7xO9Q==
releaseDate: '2026-07-26T17:50:20.433Z'
`;

const REAL_IOS_JSON = JSON.stringify({
  version: "1.0.16",
  build: "142",
  path: "aivota-aac-ipad-unsigned-v1.0.16-build142.ipa",
  size: 48123904,
  releaseDate: "2026-07-26T18:02:11.001Z",
  signed: false,
});

describe("parseWindowsManifest", () => {
  it("reads version, payload name, size and date from a real latest.yml", () => {
    const build = parseWindowsManifest(REAL_LATEST_YML);
    expect(build).toEqual({
      version: "1.0.16",
      fileName: "Aivota AAC Setup 1.0.16.exe",
      sizeBytes: 209333599,
      releaseDate: "2026-07-26T17:50:20.433Z",
    });
  });

  it("takes the payload name from `path`, not from files[0]", () => {
    // release/ accumulates installers across builds; publish-aac-release.mjs
    // uploads the one `path` names. The reader must agree with the publisher.
    const stale = REAL_LATEST_YML.replace(
      "path: Aivota AAC Setup 1.0.16.exe",
      "path: Aivota AAC Setup 1.0.17.exe",
    );
    expect(parseWindowsManifest(stale)?.fileName).toBe("Aivota AAC Setup 1.0.17.exe");
  });

  it("survives a manifest with no size for the payload", () => {
    const noSize = `version: 2.0.0\npath: Aivota AAC Setup 2.0.0.exe\n`;
    expect(parseWindowsManifest(noSize)).toEqual({
      version: "2.0.0",
      fileName: "Aivota AAC Setup 2.0.0.exe",
      sizeBytes: null,
      releaseDate: null,
    });
  });

  it("returns null for junk rather than inventing a build", () => {
    expect(parseWindowsManifest("")).toBeNull();
    expect(parseWindowsManifest("<html>403 Forbidden</html>")).toBeNull();
    expect(parseWindowsManifest("version: 1.0.0\n")).toBeNull(); // no path
  });
});

describe("parseIosManifest", () => {
  it("reads the manifest publish-aac-ios.mjs writes", () => {
    expect(parseIosManifest(REAL_IOS_JSON)).toEqual({
      version: "1.0.16",
      fileName: "aivota-aac-ipad-unsigned-v1.0.16-build142.ipa",
      sizeBytes: 48123904,
      releaseDate: "2026-07-26T18:02:11.001Z",
    });
  });

  it("returns null for junk or an incomplete manifest", () => {
    expect(parseIosManifest("not json")).toBeNull();
    expect(parseIosManifest("[]")).toBeNull();
    expect(parseIosManifest(JSON.stringify({ version: "1.0.0" }))).toBeNull(); // no path
  });
});

describe("getAppDownloads", () => {
  const realFetch = global.fetch;

  /** Stub fetch with a per-URL responder. */
  function stubFeed(responder: (url: string) => { ok: boolean; status?: number; body?: string }) {
    global.fetch = jest.fn(async (input: any) => {
      const url = String(input);
      const r = responder(url);
      return {
        ok: r.ok,
        status: r.status ?? (r.ok ? 200 : 404),
        text: async () => r.body ?? "",
      } as Response;
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    clearAppDownloadCache();
  });

  afterEach(() => {
    global.fetch = realFetch;
    clearAppDownloadCache();
  });

  it("reports both platforms with a CDN url and a stable url", async () => {
    stubFeed((url) =>
      url.endsWith("latest.yml")
        ? { ok: true, body: REAL_LATEST_YML }
        : { ok: true, body: REAL_IOS_JSON },
    );

    const res = await getAppDownloads();

    expect(res.windows.available).toBe(true);
    expect(res.windows.version).toBe("1.0.16");
    expect(res.windows.sizeBytes).toBe(209333599);
    // Spaces in the installer name MUST be encoded or the link 404s.
    expect(res.windows.downloadUrl).toBe(
      "https://updates.aivota.ai/aac/win/Aivota%20AAC%20Setup%201.0.16.exe",
    );
    expect(res.windows.stableUrl).toBe("/api/app-downloads/windows");

    expect(res.ios.available).toBe(true);
    expect(res.ios.version).toBe("1.0.16");
    expect(res.ios.downloadUrl).toBe(
      "https://updates.aivota.ai/aac/ios/aivota-aac-ipad-unsigned-v1.0.16-build142.ipa",
    );
    expect(res.ios.stableUrl).toBe("/api/app-downloads/ios");
  });

  it("marks a platform unavailable — rather than failing the whole panel — when its feed is empty", async () => {
    // The realistic state before the first iOS publish: the bucket returns 403
    // for a missing key behind OAC.
    stubFeed((url) =>
      url.endsWith("latest.yml")
        ? { ok: true, body: REAL_LATEST_YML }
        : { ok: false, status: 403 },
    );

    const res = await getAppDownloads();
    expect(res.windows.available).toBe(true);
    expect(res.ios).toMatchObject({
      available: false,
      version: null,
      downloadUrl: null,
      stableUrl: "/api/app-downloads/ios",
    });
  });

  it("survives a network failure without throwing", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("ENOTFOUND updates.aivota.ai");
    }) as unknown as typeof fetch;

    const res = await getAppDownloads();
    expect(res.windows.available).toBe(false);
    expect(res.ios.available).toBe(false);
  });

  it("memoizes a successful manifest instead of re-fetching per request", async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => REAL_LATEST_YML,
    })) as unknown as typeof fetch;
    global.fetch = fetchMock;

    await resolveDownloadTarget("windows");
    await resolveDownloadTarget("windows");
    await resolveDownloadTarget("windows");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolveDownloadTarget returns null when nothing is published", async () => {
    stubFeed(() => ({ ok: false, status: 404 }));
    expect(await resolveDownloadTarget("ios")).toBeNull();
  });
});
