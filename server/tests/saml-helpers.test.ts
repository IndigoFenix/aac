/**
 * Tests for the SAML helper module. We can't test the full flow without a
 * real IdP (which requires real signing certs and signed assertions), so
 * these tests cover what's deterministic: URL helpers, client construction,
 * and profile normalization.
 */

import { describe, it, expect } from "@jest/globals";
import {
  samlAcsPath,
  samlMetadataPath,
  defaultSpEntityId,
  buildSamlClient,
  profileToClaims,
} from "../services/saml-helpers.js";
import type { IdentityProvider } from "../../shared/schema.js";

// Self-signed cert generated for tests only — DO NOT use in prod.
// Generated with: openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=test
const TEST_IDP_CERT = `-----BEGIN CERTIFICATE-----
MIIDFzCCAf+gAwIBAgIUVqDsm5Dx5wqTZJ3iZ3lzYjs1IqkwDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQdGVzdC5leGFtcGxlLmNvbTAeFw0yNjAxMDEwMDAwMDBa
Fw0yNzAxMDEwMDAwMDBaMBsxGTAXBgNVBAMMEHRlc3QuZXhhbXBsZS5jb20wggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDLJ5mxX6jUyqKkX4K3Mh1pJzGY
pxDw9OQ8nL8KPdPlBLtGBpKBR3KQs8wqyJ8X7zG5e3vJZ1aQkqZ8sXkLQp5W7Jx9
sQ8hZ3X3v7cXJv7Z7jKxMcTGqkLnQ8fH3LpV7tNwT3xmBz5Mz8Z3dOzJ3sUxX7H
fY6cF1Nw4P3vXyZ8QqQJ7jNLcMfNz2Hk7RkVJ8s8GqYxWfFJbXyTUxnVxX5Z4YD
F7K3kF5pM8kqXz6Bz7s7vXz3YJwQ7vYxX7mXWxnVxHdYxL3KQz5gZkP3xZ7fXYJW
y8K4F3hQzZjZxV5G3kqJzK7L8kHsVxN4QfVxKdJ6f3Z3Z3kqXNzZxL3YxpFHAgMB
AAGjUzBRMB0GA1UdDgQWBBT4CcjL9zqGqxVWKzKx4vR8s1L3kjAfBgNVHSMEGDAW
gBT4CcjL9zqGqxVWKzKx4vR8s1L3kjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3
DQEBCwUAA4IBAQA7Zc8qvJF8hQm9YqXcL3vHT7FzRrEAYj7XqkLpZX4j8yNXtSjJ
dKyPcMzZX7sHKzJ7vKRz8YQzL3vJZcXxkJ5jVKx7BYp1fLqCZXnPxJzKXcN3vQG7
MgZ7vK8K8vYsqJ7zHkDXz3qXFlpLZ6yMYyxRjV4jKx7sJYwzNZJXz7QkwZcKXxQz
JZkmWQs2zJ7L7zXkYJ8sLkxZ6F3ZtQzKxnKx3JX3Y7YVf8XHJLkwLZRf3qXrV3Kc
W3JzKNnVv5FzMxRzZVF6WK4kJzZxzjQqVXzMJ7L4FhJqKrV8TzRXYzJmXY8kV3YL
1hf2zMxYzKZ5jJzJ7T8VkR3Z4Vz4Y7YFhPxR
-----END CERTIFICATE-----`;

function makeSamlProvider(overrides: Partial<IdentityProvider> = {}): IdentityProvider {
  return {
    id: "test-saml-provider",
    name: "Test SAML",
    protocol: "saml",
    discoveryUrl: null,
    authorizationUrl: null,
    tokenUrl: null,
    userinfoUrl: null,
    clientId: null,
    clientSecret: null,
    scopes: null,
    samlEntityId: "https://test.idp/entity",
    samlSsoUrl: "https://test.idp/sso",
    samlSloUrl: null,
    samlX509Cert: TEST_IDP_CERT,
    samlNameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    samlSignAuthnRequests: false,
    samlWantAssertionsSigned: true,
    samlSpEntityId: null,
    samlSpPrivateKey: null,
    samlSpCertificate: null,
    claimMappings: {},
    instituteIdType: null,
    reverificationDays: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as IdentityProvider;
}

describe("SAML helpers", () => {
  describe("URL helpers", () => {
    it("samlAcsPath includes the provider id", () => {
      expect(samlAcsPath("abc-123")).toBe("/api/identity/saml/acs/abc-123");
    });

    it("samlMetadataPath includes the provider id", () => {
      expect(samlMetadataPath("abc-123")).toBe("/api/identity/saml/metadata/abc-123");
    });

    it("defaultSpEntityId derives a deterministic value from APP_URL", () => {
      const out = defaultSpEntityId("xyz");
      expect(out.endsWith("/api/identity/saml/sp/xyz")).toBe(true);
    });
  });

  describe("buildSamlClient", () => {
    it("constructs without throwing for a valid provider", async () => {
      const provider = makeSamlProvider();
      const client = await buildSamlClient(provider);
      expect(client).toBeDefined();
      expect(client.options.issuer).toBeDefined();
      expect(client.options.entryPoint).toBe("https://test.idp/sso");
    });

    it("rejects non-SAML providers", async () => {
      const provider = makeSamlProvider({ protocol: "oidc" as any });
      await expect(buildSamlClient(provider)).rejects.toThrow(/not SAML/);
    });

    it("rejects when samlSsoUrl is missing", async () => {
      const provider = makeSamlProvider({ samlSsoUrl: null });
      await expect(buildSamlClient(provider)).rejects.toThrow(/samlSsoUrl/);
    });

    it("rejects when samlX509Cert is missing", async () => {
      const provider = makeSamlProvider({ samlX509Cert: null });
      await expect(buildSamlClient(provider)).rejects.toThrow(/samlX509Cert/);
    });

    it("uses samlSpEntityId override when provided", async () => {
      const provider = makeSamlProvider({ samlSpEntityId: "https://us/sp" });
      const client = await buildSamlClient(provider);
      expect(client.options.issuer).toBe("https://us/sp");
    });
  });

  describe("profileToClaims", () => {
    it("includes scalar fields", () => {
      const profile: any = {
        nameID: "user-1",
        email: "u@example.com",
        custom_attr: "x",
      };
      const claims = profileToClaims(profile);
      expect(claims.nameID).toBe("user-1");
      expect(claims.email).toBe("u@example.com");
      expect(claims.custom_attr).toBe("x");
    });

    it("drops function-typed fields (getAssertionXml etc.)", () => {
      const profile: any = {
        nameID: "user-1",
        getAssertionXml: () => "<xml/>",
        getSamlResponseXml: () => "<resp/>",
      };
      const claims = profileToClaims(profile);
      expect(claims.nameID).toBe("user-1");
      expect(claims.getAssertionXml).toBeUndefined();
      expect(claims.getSamlResponseXml).toBeUndefined();
    });
  });
});
