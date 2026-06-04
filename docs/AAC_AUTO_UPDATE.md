# AAC Client Auto-Update

The Aivota AAC desktop client (Electron + NSIS) uses
[`electron-updater`](https://www.electron.build/auto-update) to fetch new
versions in the background and apply them on next restart. End users
don't have to download anything manually; once a release is published,
every running client picks it up within a few hours.

## How it works at runtime

1. On launch, `electron/auto-update.ts` calls
   `autoUpdater.checkForUpdates()`.
2. The updater fetches `latest.yml` from the URL configured in
   `electron-builder.yml`'s `publish:` block (default:
   `https://updates.aivota.com/aac/win/`).
3. If `latest.yml`'s `version` is newer than `app.getVersion()`, the
   updater downloads the new installer (and its `.blockmap` for
   differential delta when available) into the user's app-data folder.
4. The downloaded build is verified against the SHA-512 in the manifest,
   then **applied on next app quit** (or immediately if the renderer
   calls `electronAPI.update.installNow()`).
5. While the app stays open, the updater re-polls every 4 hours so a
   long-running session catches a freshly-published build without
   needing a manual relaunch.

In dev (when `app.isPackaged === false`) auto-update is disabled; the
unpacked client is the source of truth.

## Renderer integration

The preload exposes a small API for the UI to react to update events:

```ts
window.electronAPI?.update?.onStatus((status) => {
  // status: { kind: "checking" | "available" | "downloading" | "downloaded" | ... }
});

await window.electronAPI?.update?.check();        // manual recheck
await window.electronAPI?.update?.installNow();   // "Restart now" button
```

Status events:

| kind | When | Useful for |
|---|---|---|
| `checking` | Polling `latest.yml` | spinner |
| `available` | Newer version found, download starting | "Updating in the background…" toast |
| `downloading` | Download in flight, includes `percent` + `bytesPerSecond` | progress bar |
| `downloaded` | Installer is on disk, ready to apply | "Restart to update" prompt |
| `not-available` | Already on latest | (no UI needed) |
| `error` | Network / checksum / disk failure | diagnostics surface |

No client UI is wired today — the updater operates silently. Add a
status toast to `DualAgentConversationBox` (or wherever) when ready.

## Publishing a new release

```bash
# 1. Bump the version (also creates a git tag).
npm version patch          # 1.0.0 → 1.0.1
# or: npm version minor / npm version major

# 2. Build the packaged installer + manifest into release/.
npm run release:aac:build

# 3. Upload to the update bucket (S3).
#    Requires AWS credentials in the environment (the standard AWS SDK
#    credential chain — env vars, ~/.aws/credentials, or an IAM role).
AAC_UPDATE_BUCKET=aivota-updates \
AAC_UPDATE_PREFIX=aac/win/      \
AAC_UPDATE_REGION=us-east-1     \
  npm run release:aac:publish

# (Steps 2+3 in one command:)
AAC_UPDATE_BUCKET=aivota-updates npm run release:aac
```

Installed clients see the new build at their next poll (≤ 4 hours), or
when they next launch the app.

### Dry-run

```bash
AAC_UPDATE_DRY_RUN=1 npm run release:aac:publish
```

Logs what would be uploaded without sending anything. Useful for the
first publish to sanity-check the artifact names.

## S3 bucket setup (one-time)

The bucket holds three files per release plus the manifest. Recommended
layout:

```
aivota-updates/
  aac/win/
    Aivota AAC Setup 1.0.1.exe
    Aivota AAC Setup 1.0.1.exe.blockmap
    latest.yml                          ← polled by every client
```

Bucket policy must allow public-read on the `aac/win/` prefix (or you
can serve through CloudFront with a Cloudfront-managed origin policy —
recommended for latency + bandwidth cost). HTTPS is required: the
updater rejects insecure update URLs by default.

`latest.yml`'s `Cache-Control` is set to `no-cache` by the publisher
script so a client polling right after a publish doesn't wait for CDN
TTL. The installer + blockmap are cached for 1 hour (override via
`AAC_UPDATE_CACHE`).

## Channels (future)

`electron-builder.yml` currently publishes to a single `latest` channel.
For staged rollouts:

- Publish a `beta` build with `electron-builder --win --publish never -c.publish.channel=beta`.
- Update the renderer to call `electronAPI.update.setChannel("beta")`
  (not wired today — would need an extra IPC + `autoUpdater.channel =`).
- Beta builds land at `latest-beta.yml`; stable clients ignore them.

## Code signing (recommended before broad rollout)

Without a code signature, Windows SmartScreen shows a scary warning
the first time anyone runs the installer. Auto-updates still work, but
the user-perceived friction is high.

To sign:

1. Buy an OV or EV Authenticode certificate (~$200–500/yr from Sectigo,
   DigiCert, etc.).
2. In `electron-builder.yml`, add under `win:`:
   ```yaml
   certificateFile: path/to/cert.pfx
   certificatePassword: ${env.WIN_CSC_KEY_PASSWORD}
   signtoolOptions:
     signingHashAlgorithms: ["sha256"]
   ```
3. Set `WIN_CSC_LINK` (path to .pfx) and `WIN_CSC_KEY_PASSWORD` in the
   release environment.

EV certs build SmartScreen reputation immediately; OV certs accumulate
it after enough downloads.

## Troubleshooting

| Symptom | Where to look |
|---|---|
| "Update failed" toast on every launch | `%APPDATA%\Aivota AAC\logs\main.log` — full electron-updater stack trace |
| Updater says "not available" even though `latest.yml` is newer | Manifest's `version` may not match the installer filename — re-run `npm version` + rebuild |
| 403 fetching `latest.yml` | Bucket policy / CloudFront origin not allowing public-read on the prefix |
| Update downloads but never installs | NSIS perMachine vs perUser mismatch — confirm `nsis.perMachine: false` matches the installer's actual scope |
| First-launch SmartScreen block | No code signature; see "Code signing" above |

## Files

- `electron/auto-update.ts` — the wiring (events, IPC, recheck timer)
- `electron/preload.ts` — `electronAPI.update.*` bridge to the renderer
- `electron-builder.yml` `publish:` block — update URL + channel
- `scripts/publish-aac-release.mjs` — upload script (S3)
- `package.json` scripts — `release:aac:build`, `release:aac:publish`, `release:aac`
