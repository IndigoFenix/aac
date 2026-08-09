# Transactional Email

How the platform sends invites, password resets, MFA recovery, license
invites, consent receipts and provider alerts — and the two rules that broke it
badly enough to be worth writing down.

Code: `server/services/emailService.ts`. DNS: `terraform/dns.tf`.
Tests: `server/tests/email-service.test.ts`.

## Transport

The Resend HTTP API, over HTTPS:443. **Not SMTP** — Render blocks outbound
25/465/587, so SMTP connections silently time out (IPv4) or hit ENETUNREACH
(IPv6). `nodemailer` is still in the dependency tree, but only for the chat
email-agent tool, which sends through *user-supplied* mailbox credentials and
must never touch the platform's own sender (see `chat/tools/email.ts`).

## The two rules

**1. Send from the subdomain, never the apex.**

`aivota.ai`'s MX belongs to Google Workspace. Resend requires an MX on the
sending domain for bounce handling, so the apex can never be verified in
Resend — a From address on it fails every send with `validation_error`.
Transactional mail therefore goes out from `send.aivota.ai`, verified
separately. This also keeps bounce rates on bulk invites from dragging down the
sending reputation of the team's real mailboxes.

**2. The From address must not be a human's mailbox — or an alias of one.**

Gmail resolves a known address against the Workspace directory and renders that
person's profile name, whatever display name we put in the header. So
`cs@aivota.ai` — an alias on a real mailbox — arrives showing its owner's name.
`noreply@send.aivota.ai` is not in the directory, so "Aivota" survives.

## Configuration

| Variable | Value | Notes |
|---|---|---|
| `RESEND_API_KEY` | from the Resend dashboard | absent → service disabled, every send returns `{success:false}` |
| `EMAIL_FROM` | `Aivota <noreply@send.aivota.ai>` | **the only** source of sender identity |
| `EMAIL_REPLY_TO` | `cs@aivota.ai` | defaults to this; the From is unattended |

`EMAIL_FROM` has no fallback chain by design. It used to fall back through
`SMTP_FROM` → `SMTP_USER`, and long after the move off Gmail SMTP those still
held a personal mailbox in every deployed environment — so all transactional
mail went out under one engineer's name, invisibly. The service now warns at
boot if any `SMTP_*` var is still set. Delete them; they are ignored.

Where they live:

- **Render** (current production host) — the dashboard's Environment tab.
- **Lambda** — the `app-secrets` JSON in Secrets Manager. `index.lambda.ts`
  copies *every* key in it to `process.env`, so a stale `SMTP_FROM` there is
  worth removing too.
- **ECS** — injected in `terraform/ecs.tf` from the same secret.

## DNS

Two senders share the domain; each needs its own SPF and DKIM. One DMARC record
at the apex governs both (relaxed alignment is what lets subdomain mail pass for
the organizational domain).

| Name | Type | Value | Who |
|---|---|---|---|
| `aivota.ai` | MX | `1 SMTP.GOOGLE.COM` | Workspace |
| `aivota.ai` | TXT | `v=spf1 include:_spf.google.com ~all` | Workspace |
| `google._domainkey.aivota.ai` | TXT | DKIM key from Google Admin | Workspace |
| `_dmarc.aivota.ai` | TXT | `v=DMARC1; p=none; rua=...; adkim=r; aspf=r` | both |
| `send.aivota.ai` | MX | `10 feedback-smtp.<region>.amazonses.com` | Resend |
| `send.aivota.ai` | TXT | `v=spf1 include:amazonses.com ~all` | Resend |
| `resend._domainkey.send.aivota.ai` | TXT | DKIM key from Resend | Resend |

All of it is Terraform (`terraform/dns.tf`), driven by variables set in **both**
`terraform.tfvars` and `lean.tfvars` — whichever path applies is the one that
publishes the records.

Two gotchas encoded there:

- A Route 53 record set is per `(name, type)`, so `aws_route53_record.spf_apex`
  owns **every** apex TXT. Future domain-verification strings go into its
  `records` list; a second TXT resource would clobber it.
- Route 53 caps one TXT character-string at 255 bytes and a 2048-bit DKIM key
  runs ~410, so the value is split with an embedded `""`. Resolvers concatenate
  the parts back together.

The Google DKIM key is generated once in Google Admin → Apps → Google Workspace
→ Gmail → Authenticate email, then pasted into `google_workspace_dkim_value`.
It is a public key; committing it is fine.

## Adding the Resend domain

1. Resend dashboard → Domains → Add Domain → `send.aivota.ai`.
2. Copy the MX host and the DKIM key into `resend_bounce_mx_host` and
   `resend_dkim_value` in both tfvars files.
3. `terraform apply` — the records appear in Route 53.
4. Back in Resend, hit Verify. Until this passes, every send fails with
   `validation_error`.
5. Set `EMAIL_FROM` in the deployed environment(s).

## Tightening DMARC

Start at `dmarc_policy = "none"` (monitor only). Read the aggregate reports
arriving at `dmarc_rua` until both Workspace and Resend mail passes cleanly,
then move to `quarantine` and finally `reject`. Jumping straight to `reject`
with an unverified sender silently blackholes real mail.

## Debugging a silent failure

`sendEmail` returns `{success, error}` and **several call sites discard it**
(e.g. `licenseService.ts`, `instituteController.ts`), so a broken configuration
shows up as "nobody got the invite" rather than an error. Check the server log
first — the service logs every failure with the Resend error name, and adds an
explicit hint on `validation_error`, the usual culprit.

Quick DNS check from any machine:

```sh
nslookup -type=TXT aivota.ai 8.8.8.8
nslookup -type=TXT resend._domainkey.send.aivota.ai 8.8.8.8
nslookup -type=TXT _dmarc.aivota.ai 8.8.8.8
```
