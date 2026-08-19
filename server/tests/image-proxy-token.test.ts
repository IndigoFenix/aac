/**
 * The picture-search image proxy's capability token.
 *
 * This is the only thing standing between "our server fetches a picture a search
 * returned" and "our server fetches whatever anyone asks it to", so the failure
 * cases matter more than the happy path: a forged, expired or truncated token
 * must produce null, never a URL.
 *
 * Pure crypto — no network. Times are injected so nothing sleeps.
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import {
  IMAGE_TOKEN_TTL_MS,
  imageProxyPath,
  isSafeUpstreamHost,
  mintImageToken,
  redeemImageToken,
} from "../services/picture-search/image-proxy-token.js";

const NOW = 1_700_000_000_000;
const URL_OK = "https://images.example.com/a/giraffe.jpg?w=800";

beforeAll(() => {
  // Pin the key so a machine without a configured secret still exercises the
  // real derivation path rather than a different fallback per run.
  process.env.SESSION_SECRET = "test-secret-for-image-proxy";
});

describe("mint → redeem", () => {
  test("round-trips the exact URL", () => {
    const token = mintImageToken(URL_OK, NOW)!;
    expect(token).not.toBeNull();
    expect(redeemImageToken(token, NOW + 1000)).toBe(URL_OK);
  });

  test("survives characters that would break a bare query param", () => {
    const tricky = "https://cdn.example.com/x.jpg?a=1&b=%20+/=#frag";
    const token = mintImageToken(tricky, NOW)!;
    expect(redeemImageToken(token, NOW)).toBe(tricky);
  });

  test("is NOT single-use — the grid and the viewer both fetch it", () => {
    const token = mintImageToken(URL_OK, NOW)!;
    expect(redeemImageToken(token, NOW)).toBe(URL_OK);
    expect(redeemImageToken(token, NOW)).toBe(URL_OK);
  });

  test("refuses to sign what should never be proxied", () => {
    expect(mintImageToken("", NOW)).toBeNull();
    expect(mintImageToken("ftp://example.com/a.jpg", NOW)).toBeNull();
    expect(mintImageToken("javascript:alert(1)", NOW)).toBeNull();
    expect(mintImageToken(`https://example.com/${"a".repeat(2100)}`, NOW)).toBeNull();
  });
});

describe("redeem rejects", () => {
  test("an expired token", () => {
    const token = mintImageToken(URL_OK, NOW)!;
    expect(redeemImageToken(token, NOW + IMAGE_TOKEN_TTL_MS + 1)).toBeNull();
  });

  test("a swapped URL under a valid signature — the whole point", () => {
    const token = mintImageToken(URL_OK, NOW)!;
    const attacker = Buffer.from("http://169.254.169.254/latest/meta-data/", "utf8").toString("base64url");
    expect(redeemImageToken({ ...token, u: attacker }, NOW)).toBeNull();
  });

  test("an extended expiry under the original signature", () => {
    const token = mintImageToken(URL_OK, NOW)!;
    expect(redeemImageToken({ ...token, e: token.e + 86_400_000 }, NOW)).toBeNull();
  });

  test("a tampered, truncated or absent signature", () => {
    const token = mintImageToken(URL_OK, NOW)!;
    expect(redeemImageToken({ ...token, s: token.s.slice(0, -1) }, NOW)).toBeNull();
    expect(redeemImageToken({ ...token, s: `${token.s}x` }, NOW)).toBeNull();
    expect(redeemImageToken({ ...token, s: "" }, NOW)).toBeNull();
  });

  test("malformed or missing parameters", () => {
    expect(redeemImageToken({}, NOW)).toBeNull();
    expect(redeemImageToken({ u: 1, e: 2, s: 3 } as any, NOW)).toBeNull();
    const token = mintImageToken(URL_OK, NOW)!;
    expect(redeemImageToken({ ...token, e: "not-a-number" as any }, NOW)).toBeNull();
  });
});

describe("imageProxyPath", () => {
  test("is server-relative, so the client composes it with its own API base", () => {
    const path = imageProxyPath(URL_OK, NOW)!;
    expect(path.startsWith("/api/aac/picture-search/img?")).toBe(true);
    // An absolute URL here would break the Capacitor and Electron hosts, whose
    // page origin is not the API origin.
    expect(path).not.toMatch(/^https?:/);
  });

  test("the emitted query redeems back to the original URL", () => {
    const path = imageProxyPath(URL_OK, NOW)!;
    const query = Object.fromEntries(new URLSearchParams(path.split("?")[1]));
    expect(redeemImageToken(query, NOW)).toBe(URL_OK);
  });

  test("returns null rather than an unsigned path", () => {
    expect(imageProxyPath("not-a-url", NOW)).toBeNull();
  });
});

describe("isSafeUpstreamHost", () => {
  test("allows ordinary public hosts", () => {
    expect(isSafeUpstreamHost("https://images.example.com/a.jpg")).toBe(true);
    expect(isSafeUpstreamHost("https://8.8.8.8/a.jpg")).toBe(true);
  });

  test("refuses anything pointing back inside our own network", () => {
    for (const url of [
      "http://localhost/a.jpg",
      "http://app.localhost/a.jpg",
      "http://127.0.0.1/a.jpg",
      "http://10.0.3.7/a.jpg",
      "http://192.168.1.5/a.jpg",
      "http://172.16.0.1/a.jpg",
      "http://172.31.255.255/a.jpg",
      "http://169.254.169.254/latest/meta-data/", // cloud metadata
      "http://0.0.0.0/a.jpg",
      "http://[::1]/a.jpg",
      "http://[fd00::1]/a.jpg",
      "http://db.internal/a.jpg",
    ]) {
      expect([url, isSafeUpstreamHost(url)]).toEqual([url, false]);
    }
  });

  test("refuses non-http schemes and unparseable input", () => {
    expect(isSafeUpstreamHost("file:///etc/passwd")).toBe(false);
    expect(isSafeUpstreamHost("gopher://example.com/")).toBe(false);
    expect(isSafeUpstreamHost("nonsense")).toBe(false);
  });

  test("does NOT refuse public ranges that merely look private", () => {
    // 172.32.x is public; a sloppy /12 check would wrongly ban it.
    expect(isSafeUpstreamHost("http://172.32.0.1/a.jpg")).toBe(true);
    expect(isSafeUpstreamHost("http://11.0.0.1/a.jpg")).toBe(true);
    // ...and hostnames that merely start with the IPv6 ULA prefix letters.
    expect(isSafeUpstreamHost("https://fd-cdn.example.com/a.jpg")).toBe(true);
    expect(isSafeUpstreamHost("https://fc2.example.com/a.jpg")).toBe(true);
  });
});
