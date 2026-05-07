/**
 * Tests for the incident-response template fill service.
 * The templates themselves are reviewed by counsel; these tests verify
 * the fill mechanism is structurally sound.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  fillIncidentTemplate,
  getIncidentTemplate,
  clearIncidentTemplateCache,
  type IncidentTemplateType,
  type IncidentTemplateLocale,
} from "../services/incidentTemplateService.js";

describe("incidentTemplateService", () => {
  beforeEach(() => {
    clearIncidentTemplateCache();
  });

  describe("getIncidentTemplate", () => {
    it.each<[IncidentTemplateType, IncidentTemplateLocale]>([
      ["phi-breach", "en"],
      ["phi-breach", "he"],
      ["security-breach", "en"],
      ["security-breach", "he"],
      ["vendor-incident", "en"],
      ["vendor-incident", "he"],
    ])("loads %s.%s template", async (type, locale) => {
      const raw = await getIncidentTemplate(type, locale);
      expect(raw).toMatch(/^SUBJECT:/);
      expect(raw.length).toBeGreaterThan(200);
    });
  });

  describe("fillIncidentTemplate", () => {
    const baseVars = {
      student_name: "Alice Cohen",
      recipient_name: "Mr. Cohen",
      institute_name: "Aleh School",
      incident_summary: "Unauthorized access to a backup snapshot.",
      incident_occurred_at: "2026-05-01 14:30 UTC",
      incident_discovered_at: "2026-05-02 09:00 UTC",
      notification_sent_at: "2026-05-04 16:00 UTC",
      affected_data_categories: "Goal-tracking notes; therapy session logs.",
      access_type: "accessed",
      usage_status: "no evidence of further use",
      remediation_summary: "Snapshot purged; access revoked; rotation enforced.",
      regulator_name: "Israeli Privacy Protection Authority",
      regulator_window: "30 days",
      forensics_provider: "Experis Cyber",
      final_report_eta: "30 days",
      vigilance_window: "60",
      additional_user_actions: "Confirm no unfamiliar devices appear under Account → Sessions.",
      dpo_email: "dpo@aivota.com",
      dpo_phone: "+972-3-555-1234",
      signer_name: "D. Nadel",
      signer_title: "Data Protection Officer",
      signer_postal_address: "Tel Aviv, Israel",
      incident_ref: "2026-0042",
    };

    it("substitutes tokens in subject and body", async () => {
      const out = await fillIncidentTemplate("phi-breach", "en", baseVars);
      expect(out.subject).toContain("Alice Cohen");
      expect(out.text).toContain("Aleh School");
      expect(out.text).toContain("dpo@aivota.com");
      expect(out.locale).toBe("en");
    });

    it("strips the SUBJECT: line from the body", async () => {
      const out = await fillIncidentTemplate("phi-breach", "en", baseVars);
      expect(out.text).not.toMatch(/^SUBJECT:/);
      // The first body line should be the salutation, not a blank line.
      expect(out.text.split("\n")[0]).toMatch(/Dear /);
    });

    it("reports missing tokens without throwing", async () => {
      const partial = { student_name: "Alice", institute_name: "Aleh School" };
      const out = await fillIncidentTemplate("phi-breach", "en", partial);
      expect(out.missingTokens).toContain("recipient_name");
      expect(out.missingTokens).toContain("dpo_email");
      // Unsubstituted token stays as-is so a reviewer notices.
      expect(out.text).toContain("{recipient_name}");
    });

    it("falls back to English when the requested locale is missing", async () => {
      // Cast to bypass the union type for this fallback test.
      const out = await fillIncidentTemplate(
        "phi-breach",
        "fr" as IncidentTemplateLocale,
        baseVars,
      );
      expect(out.locale).toBe("en");
      expect(out.subject).toContain("Alice Cohen");
    });

    it("works for security-breach in Hebrew", async () => {
      const out = await fillIncidentTemplate("security-breach", "he", {
        ...baseVars,
        evidence_of_misuse: "אין",
        security_contact_email: "security@aivota.com",
        security_contact_phone: "+972-3-555-1234",
      });
      expect(out.locale).toBe("he");
      // Hebrew template uses "מה קרה" as the section header
      expect(out.text).toContain("מה קרה");
    });

    it("works for vendor-incident", async () => {
      const out = await fillIncidentTemplate("vendor-incident", "en", {
        ...baseVars,
        vendor_name: "ExampleAI",
        vendor_incident_summary: "Unauthorized access to a logging bucket.",
        vendor_disclosure_to_us: "2026-05-03 08:00 UTC",
        vendor_purpose: "AI inference",
        vendor_remediation_summary: "Bucket rotated; access keys reissued.",
        aivota_response: "Reviewing whether to retain ExampleAI as a sub-processor.",
        recommended_user_actions: "No password changes required.",
        vendor_incident_ref: "EX-2026-99",
      });
      expect(out.subject).toContain("ExampleAI");
      expect(out.missingTokens).toEqual([]);
    });
  });
});
