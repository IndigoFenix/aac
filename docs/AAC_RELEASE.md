# AAC Desktop Releases (dev / staging / prod)

The AAC desktop app ships in three environments. They are the **same app** — the
only differences are which server they connect to and how they install/update.

| Env | Backend it connects to | Install identity | Update feed | Published? |
|---|---|---|---|---|
| **dev** | `http://localhost:5000` (your machine) | Aivota AAC Dev · `com.aivota.aac.dev` | (local only) | No |
| **staging** | `https://aivota-staging-us.onrender.com` | Aivota AAC Staging · `com.aivota.aac.staging` | `updates.aivota.ai/aac-staging/win/` | Yes |
| **prod** | `https://aivota-demo-us.onrender.com` | Aivota AAC · `com.aivota.aac` | `updates.aivota.ai/aac/win/` | Yes |

Because each environment has a distinct **product name + appId + package name**,
the three installs sit side-by-side on one machine with **isolated settings and
login** and each auto-updates only from its own feed. Note: Electron keys
`userData` / logs / the updater-cache dir off the package **`name`**
(`app.getName()`), NOT the product name — so isolation comes from overriding the
package name per env (`extraMetadata.name` → `aivota-aac` / `aivota-aac-staging` /
`aivota-aac-dev`), not from `productName` alone. **Dev builds have auto-update
disabled** (localhost backend, no feed). All three present the same `app://aac`
origin to their server, so the CORS allowlist needs no per-env change.

The single source of truth for these values is
[`scripts/aac-release-config.mjs`](../scripts/aac-release-config.mjs). Change a
URL or identity there, not in the scripts.

## Build / release commands

One orchestrator drives everything: `scripts/release-aac.mjs`.

```bash
# Dev: build an installer that talks to YOUR local server (localhost:5000).
# Not published — install it locally to test the packaged app end-to-end.
npm run release:aac:dev

# Staging: build + publish to the staging update feed.
npm run release:aac:staging

# Production: build + publish to the production feed.
npm run release:aac:prod         # (or the legacy `npm run release:aac`)

# Dry run (build + log the S3 upload without sending):
node scripts/release-aac.mjs staging --publish --dry-run
```

The orchestrator: builds the client + Electron main with the env's backend baked
in as `VITE_API_URL` (which the packaged app reads — see
`client-aac/src/lib/api-base.ts`), assembles the gaze sidecar, packages the NSIS
installer (overriding app identity + update feed for dev/staging; prod uses
`electron-builder.yml` as-is), and — with `--publish` — uploads the installer,
block-map, and `latest.yml` to the env's S3 prefix.

### Publishing requires AWS env vars

`publish-aac-release.mjs` needs `AAC_UPDATE_BUCKET` (and honors
`AAC_UPDATE_REGION`, `AAC_UPDATE_DRY_RUN`). `AAC_UPDATE_PREFIX` is filled from the
env config automatically. Credentials use the standard AWS chain. Locally you can
put these in the repo-root `.env`.

## Where clinicians get the installer

The clinician dashboard has a **Downloads** page (AAC section in the sidebar,
`client/src/features/DownloadsPanel.tsx`) that offers both the Windows installer
and the iPad `.ipa`, with install instructions. It reads
`GET /api/app-downloads`, which resolves the feeds' manifests server-side
(`server/services/appDownloadService.ts`).

Nothing extra is needed at release time — publishing to the feed is what makes
the new version appear there. The server reads the feed at
`https://updates.aivota.ai/aac/` (override with `AAC_DOWNLOAD_FEED_BASE` to
point a non-prod server at a different prefix) and memoizes each manifest for
five minutes, so a fresh publish shows up within that window.

The iPad `.ipa` publishes separately — see [`IPAD_BUILD.md`](./IPAD_BUILD.md).

## Starting with the device

A dedicated AAC machine can bring the board up on its own. The switch is
per-student, in the clinician panel: **AAC Settings → Device → "Start when the
device starts"** (`aac_settings.launch_on_boot`).

How it works: the setting is stored per student, but the thing it controls is
per-DEVICE. The desktop shell mirrors it into the Windows login item every time
it loads a profile (`client-aac/src/hooks/useLaunchOnBoot.ts` →
`auto-launch:set` → `app.setLoginItemSettings` in `electron/main.ts`), so a
machine ends up holding the choice of whoever last used it. On a dedicated
device — what this is for — that is exactly right.

**Provisioning a device that must come up unattended.** A login item runs at
Windows **sign-in**, not at power-on, so a machine that stops at the lock screen
starts the app only once someone signs in. For a device that has to reach the
board with nobody at the keyboard, also set its Windows account to sign in
automatically (`netplwiz`, or Sysinternals Autologon). That is a step on the
device; an app may not do it to a machine, so the settings panel says so rather
than pretending otherwise.

Two consequences of the per-env identity above: each install registers its OWN
login item (a staging and a prod build on one machine both autostart, and both
are separate entries), and the entry names an executable PATH — which is why the
shell rewrites it on every profile load, so an entry left behind by an install
at a different location repairs itself.

Not available on iPad: iPadOS has no autostart at any privilege level. An iPad
that is only ever the AAC app is Guided Access or an MDM single-app-mode
profile, configured on the iPad.

## CI

- **Production** — [`release-aac.yml`](../.github/workflows/release-aac.yml).
  Triggered by pushing a version tag (`npm version patch && git push --follow-tags`).
- **Staging** — [`release-aac-staging.yml`](../.github/workflows/release-aac-staging.yml).
  Manual `workflow_dispatch` (with an optional dry-run input). Publishes to the
  same update bucket as prod under the `aac-staging/win/` prefix.
- **Dev** — no CI (a localhost-backed build only makes sense on the developer's
  own machine). Run `npm run release:aac:dev` locally.

## Notes

- `client-aac/.env.electron` (tracked) sets `VITE_API_URL` to the demo backend —
  the fallback for a bare `npm run electron:build`. The orchestrator overrides it
  per environment via a process env var (Vite gives an actual env var priority
  over `.env` files).
- `client-aac/.env` (gitignored) is your local dev override for
  `npm run client-aac:dev`; it does not affect release builds in CI.
- Windows-only: NSIS + the gaze sidecar (32-bit `node.exe`, koffi win32
  prebuilds) require a Windows runner/box.
