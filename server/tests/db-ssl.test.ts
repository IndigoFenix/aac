// Pins how runtime Postgres connections negotiate TLS.
//
// The point of this file: production must VERIFY the RDS server certificate
// (AKIM appendix §4.1), while local Postgres and the Render-hosted staging
// environment must keep working. A regression here is silent — the connection
// still succeeds, it just stops being authenticated — so the assertions below
// are about the shape of the config, not about connectivity.

import { resolveDbSsl, __resetCaBundleCache } from "../db-ssl";

const RDS_URL =
  "postgres://user:pw@aivota-prod.abc123.il-central-1.rds.amazonaws.com:5432/aivota";
const RENDER_URL = "postgres://user:pw@dpg-something.oregon-postgres.render.com/aivota";
const LOCAL_URL = "postgres://postgres:postgres@localhost:5432/aivota?sslmode=disable";

beforeEach(() => {
  __resetCaBundleCache();
});

describe("resolveDbSsl", () => {
  it("verifies the certificate for an RDS host using the shipped CA bundle", () => {
    // rds-ca-bundle.pem sits at the repo root, which is jest's cwd.
    const ssl = resolveDbSsl(RDS_URL);

    expect(ssl).not.toBe(false);
    if (ssl === false) throw new Error("unreachable");
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(typeof ssl.ca).toBe("string");
    expect(String(ssl.ca)).toContain("BEGIN CERTIFICATE");
  });

  it("does not apply the AWS bundle to a non-RDS host", () => {
    // The bundle only chains RDS certificates; handing it to Render's Postgres
    // would fail the handshake and take staging down on boot.
    expect(resolveDbSsl(RENDER_URL)).toEqual({ rejectUnauthorized: false });
  });

  it("disables TLS when the URL asks for sslmode=disable", () => {
    expect(resolveDbSsl(LOCAL_URL)).toBe(false);
  });

  it("honours sslmode=disable even on an RDS-looking host", () => {
    expect(resolveDbSsl(`${RDS_URL}?sslmode=disable`)).toBe(false);
  });

  it("falls back to an encrypted-but-unverified connection with no URL", () => {
    expect(resolveDbSsl(undefined)).toEqual({ rejectUnauthorized: false });
  });

  it("does not throw on a malformed URL", () => {
    expect(resolveDbSsl("not-a-url")).toEqual({ rejectUnauthorized: false });
  });

  it("ships the GLOBAL bundle, which covers the region we actually deploy to", () => {
    // The file used to hold only the us-east-2 roots. Production RDS is in
    // il-central-1, so verification against a regional bundle would fail the
    // handshake and take the service down at boot. Anyone refreshing this file
    // must take the global bundle, not a regional one.
    const ssl = resolveDbSsl(RDS_URL);
    if (ssl === false) throw new Error("unreachable");
    const ca = String(ssl.ca);

    // Subject CNs live in the DER; a substring scan over the decoded bundle is
    // enough to prove the regional roots are present.
    const decoded = ca
      .split(/-----END CERTIFICATE-----/)
      .map((block) => {
        const body = block.replace(/-----BEGIN CERTIFICATE-----/, "").replace(/\s/g, "");
        return body ? Buffer.from(body, "base64").toString("latin1") : "";
      })
      .join("");

    expect(decoded).toContain("il-central-1");
  });
});
