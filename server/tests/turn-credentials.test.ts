// Unit tests for TURN credential minting (coturn time-limited shared-secret).
import { createHmac } from "crypto";
import { buildIceConfig, turnConfigured } from "../services/call/turnCredentials";

const FIXED_NOW = 1_700_000_000_000; // fixed clock so expiry is deterministic

describe("buildIceConfig", () => {
  it("returns STUN-only when TURN is not configured", () => {
    const { iceServers } = buildIceConfig("user-1", {}, FIXED_NOW);
    expect(iceServers).toHaveLength(1);
    expect(iceServers[0].urls).toEqual([
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
    ]);
    expect(iceServers[0].username).toBeUndefined();
  });

  it("honors a custom STUN_URLS list", () => {
    const { iceServers } = buildIceConfig("u", { STUN_URLS: "stun:a:1, stun:b:2" }, FIXED_NOW);
    expect(iceServers[0].urls).toEqual(["stun:a:1", "stun:b:2"]);
  });

  it("does not add TURN when only TURN_URLS is set (no secret)", () => {
    const { iceServers } = buildIceConfig("u", { TURN_URLS: "turn:t:3478" }, FIXED_NOW);
    expect(iceServers).toHaveLength(1); // STUN only
  });

  it("adds TURN with a verifiable HMAC credential when configured", () => {
    const env = {
      TURN_URLS: "turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp",
      TURN_SECRET: "shhh-secret",
      TURN_TTL: "3600",
    };
    const { iceServers } = buildIceConfig("person-42", env, FIXED_NOW);
    expect(iceServers).toHaveLength(2);
    const turn = iceServers[1];
    expect(turn.urls).toEqual([
      "turn:turn.example.com:3478?transport=udp",
      "turn:turn.example.com:3478?transport=tcp",
    ]);

    // username = "<expiry>:<label>"; expiry = now/1000 + ttl.
    const expectedExpiry = Math.floor(FIXED_NOW / 1000) + 3600;
    expect(turn.username).toBe(`${expectedExpiry}:person-42`);

    // credential = base64(HMAC-SHA1(secret, username)) — coturn recomputes this.
    const expected = createHmac("sha1", "shhh-secret").update(turn.username!).digest("base64");
    expect(turn.credential).toBe(expected);
  });

  it("defaults the TTL to one hour when TURN_TTL is absent or invalid", () => {
    const base = { TURN_URLS: "turn:t:3478", TURN_SECRET: "s" };
    const expiryOf = (env: Record<string, string>) => {
      const u = buildIceConfig("u", env, FIXED_NOW).iceServers[1].username!;
      return Number(u.split(":")[0]);
    };
    const want = Math.floor(FIXED_NOW / 1000) + 3600;
    expect(expiryOf(base)).toBe(want);
    expect(expiryOf({ ...base, TURN_TTL: "0" })).toBe(want);
    expect(expiryOf({ ...base, TURN_TTL: "notanumber" })).toBe(want);
    // ...but a valid override is respected.
    expect(expiryOf({ ...base, TURN_TTL: "120" })).toBe(Math.floor(FIXED_NOW / 1000) + 120);
  });

  it("sanitizes the label so it can't break the username's ':' separator", () => {
    const env = { TURN_URLS: "turn:t:3478", TURN_SECRET: "s" };
    const u = buildIceConfig("evil:label with spaces", env, FIXED_NOW).iceServers[1].username!;
    // Exactly one ':' (the expiry separator); the label is stripped of unsafe chars.
    expect(u.split(":")).toHaveLength(2);
    expect(u.endsWith(":evillabelwithspaces")).toBe(true);
  });

  it("falls back to an 'anon' label when none is given", () => {
    const env = { TURN_URLS: "turn:t:3478", TURN_SECRET: "s" };
    const u = buildIceConfig("", env, FIXED_NOW).iceServers[1].username!;
    expect(u.endsWith(":anon")).toBe(true);
  });
});

describe("turnConfigured", () => {
  it("is false unless both TURN_URLS and TURN_SECRET are present", () => {
    expect(turnConfigured({})).toBe(false);
    expect(turnConfigured({ TURN_URLS: "turn:t:3478" })).toBe(false);
    expect(turnConfigured({ TURN_SECRET: "s" })).toBe(false);
    expect(turnConfigured({ TURN_URLS: "turn:t:3478", TURN_SECRET: "s" })).toBe(true);
  });
});
