# Incident-response notification templates

Pre-approved templates for breach / security-incident notifications. Reviewed
by counsel once, reusable forever. The intent is that on the day of an
incident — under GDPR's 72h window, HIPAA's 60-day window, or IL Privacy
Protection Law's ~30-day window — the duty engineer fills in the facts and
sends, without having to draft new wording.

## Files

- `phi-breach.en.md` / `phi-breach.he.md` — student PHI/PII breach
  (medical records, behavioral notes, identifiers). The strongest gate; used
  for IL MoE / IL MoH / HIPAA / GDPR-special-category disclosures.
- `security-breach.en.md` / `security-breach.he.md` — non-PHI security
  incident (e.g. credential exposure, account-takeover blast radius). Used
  when the data exposed is not health/student data per se but still
  triggers a notification duty.
- `vendor-incident.en.md` / `vendor-incident.he.md` — a sub-processor we
  rely on (AWS, Google, ElevenLabs, etc.) reported an incident that
  cascades to our customers. Aivota is the messenger but the underlying
  incident is at the vendor.

## Template syntax

Each file is plain text with `{placeholder}` tokens. The first line of the
body is the email subject (after a `SUBJECT: ` prefix); the rest is the
body. Tokens documented in each template's frontmatter section. Pass
values through `fillIncidentTemplate(...)` in `../incidentTemplateService.ts`.

## Adding a new locale

Drop a new file with the suffix `<type>.<locale>.md`. The service falls back
to English if the requested locale doesn't exist.

## Adding a new template

1. Add the file under this directory.
2. Add the type slug to the `IncidentTemplateType` union in
   `incidentTemplateService.ts`.
3. Add a unit test exercising the new template.
4. Walk a draft past counsel before relying on it in a real incident.

## Review history

- 2026-05-07 — Initial draft (engineering scaffold). NOT YET reviewed by
  legal/compliance counsel. Wording placeholders should be treated as
  starting points until reviewed.
