# Transactional Email

How the platform sends invites, password resets, MFA recovery, license
invites, consent receipts and provider alerts.

Code: `server/services/emailService.ts` · Infra: `terraform/ses.tf` +
`terraform/dns.tf` · Tests: `server/tests/email-service.test.ts`

## Architecture

Two senders, one domain:

- **Google Workspace** — the humans' mailboxes (`opher@`, `daniel@`, `cs@`).
  Owns the apex MX. Authenticated by apex SPF + `google._domainkey` DKIM.
- **Amazon SES** — everything the app sends, as `noreply@aivota.ai`. No API
  key: the Lambda/ECS role carries `ses:SendEmail` (locally the SDK uses
  `AWS_PROFILE`). Lives in il-central-1 with the rest of the stack; nothing
  runs anywhere else.

One DMARC record at the apex governs both.

History, so nobody resurrects the leftovers: v1 was nodemailer over Gmail SMTP
authenticating as `opher@aivota.ai` — which is why all platform mail appeared
to come from him. v2 (May 2026) was Resend, chosen for a former non-AWS host
that blocked SMTP egress; its domain was never verified, so nothing sent at
all. Both transports are gone. `nodemailer` remains in the tree only for the
chat email-agent tool, which sends through *user-supplied* mailbox credentials
and must never touch the platform sender (`chat/tools/email.ts`).

## The sender-identity rules

1. **`EMAIL_FROM` is the only source of sender identity.** The old
   `EMAIL_FROM → SMTP_FROM → SMTP_USER` fallback chain is deleted and
   test-pinned; it's how a stale Gmail credential became the platform's From
   address for months. The service warns at boot if `SMTP_*`/`RESEND_*` vars
   linger.
2. **The From address must not be a human's mailbox or a Workspace alias of
   one.** Gmail resolves known addresses against the Workspace directory and
   shows the owner's profile name, overriding our display name — `cs@aivota.ai`
   is an alias on a real mailbox and renders as its owner. `noreply@` is in
   nobody's directory, so "Aivota" survives.
3. **Every send carries a Reply-To** (`EMAIL_REPLY_TO`, default
   `cs@aivota.ai`), because the From is unattended.

## Configuration

| Variable | Default | Set where |
|---|---|---|
| `EMAIL_FROM` | `Aivota <noreply@aivota.ai>` | Terraform `email_from` → Lambda env / ECS env |
| `EMAIL_REPLY_TO` | `cs@aivota.ai` | Terraform `email_reply_to` |

(The SES client uses the runtime's own `AWS_REGION`; `SES_REGION` exists only
as an override.)

None are secrets. **Lambda caveat:** `index.lambda.ts` copies every key of the
app-secrets JSON into `process.env` *after* the Lambda env vars, so a stale
`EMAIL_FROM`/`SMTP_*` key in that secret overrides Terraform — delete them
from the secret.

## DNS (all Terraform-managed)

| Name | Type | Value | Owner |
|---|---|---|---|
| `aivota.ai` | MX | `1 SMTP.GOOGLE.COM` | Workspace |
| `aivota.ai` | TXT | `v=spf1 include:_spf.google.com ~all` | Workspace |
| `google._domainkey` | TXT | key from Google Admin (`google_workspace_dkim_value`) | Workspace |
| `_dmarc` | TXT | `v=DMARC1; p=…; rua=…; adkim=r; aspf=r` | both |
| `<token>._domainkey` ×3 | CNAME | `<token>.dkim.amazonses.com` (auto) | SES |
| `send.aivota.ai` | MX | `10 feedback-smtp.il-central-1.amazonses.com` | SES |
| `send.aivota.ai` | TXT | `v=spf1 include:amazonses.com ~all` | SES |

`send.aivota.ai` is SES's **custom MAIL FROM** (Return-Path) domain — where
SPF is checked and bounces land. The visible From stays on the apex; SES
verifies via DKIM alone, so Google keeping the apex MX is not a conflict.

Gotchas encoded in the terraform:

- A Route 53 record set is per `(name, type)`: `aws_route53_record.spf_apex`
  owns **every** apex TXT. Future verification strings go in its `records`
  list — a second TXT resource would clobber it.
- The Google DKIM key (~410 chars) exceeds Route 53's 255-byte string limit,
  so it's split with an embedded `""`; resolvers rejoin it.
- The SES DKIM records use `count = 3` (static) because Easy DKIM always
  returns exactly 3 tokens and a computed count would fail to plan.

## Go-live checklist

1. `terraform apply` — creates the SES identity, all DNS records, and the IAM
   grants. SES verifies itself once the DKIM CNAMEs resolve (minutes);
   dashboard: AWS console → SES (il-central-1) → Identities.
2. **Request production access** — the one manual step. New SES accounts are
   sandboxed: sends only reach *verified* addresses, everything else is
   rejected with `MessageRejected`. AWS console → SES (il-central-1) → Account
   dashboard → Request production access (state transactional volume; approval
   is typically < 24h). Meanwhile you can test by verifying your own address
   as an identity.
3. Delete `SMTP_*`, `RESEND_API_KEY`, `EMAIL_FROM` keys from the app-secrets
   JSON in Secrets Manager (see Lambda caveat above).
4. Revoke the old Gmail app password (it sat in `.env` as `SMTP_PASS`).
5. Create the `dmarc@aivota.ai` **group** (Google Admin → Directory → Groups;
   free, no license) and set **"Who can post" → "Anyone on the internet"** —
   reports come from Google/Microsoft/Yahoo, and an internal-only group
   rejects them all.

## Tightening DMARC

Start at `dmarc_policy = "none"` (monitor only). Read the aggregate reports
until both Workspace and SES pass cleanly, then `quarantine`, then `reject`.
Jumping straight to `reject` with a misconfigured sender silently blackholes
real mail. Reports are gzipped XML — `dmarc_rua` is a list, so add a digest
service alongside the group if reading them raw gets old.

## Debugging a silent failure

`sendEmail` returns `{success, error}` and **several call sites discard it**
(`licenseService.ts`, `instituteController.ts`), so a broken configuration
looks like "nobody got the invite". Check the server log — every failure is
logged with the SES error name:

- `MessageRejected` "Email address is not verified" → identity not verified
  yet, or the account is sandboxed and the *recipient* isn't verified.
- `AccessDenied` / `CredentialsProviderError` → role missing `ses:SendEmail`,
  or no AWS creds locally.

```sh
nslookup -type=TXT _dmarc.aivota.ai 8.8.8.8
nslookup -type=MX  send.aivota.ai   8.8.8.8
```
