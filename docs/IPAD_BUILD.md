# iPad (iPadOS) build

The AAC client ships to iPad as a **Capacitor** app: the same Vite bundle the
Windows Electron app packages, running in a WKWebView inside a native wrapper.

## Why not Electron

Electron cannot target iPadOS and never will. Apple forbids third-party
JavaScript engines and JIT, and Electron additionally needs Chromium, Node and
child processes. Capacitor is the closest architectural analogue: the web
bundle is unchanged, and native access goes through a plugin bridge instead of
the Electron preload.

## Host capability layer

Feature code must never ask "am I in Electron?". It asks what the host can do:

```ts
import { capabilities } from "@/lib/platform";
if (capabilities().gazeSidecar) { /* ... */ }
```

`client-aac/src/lib/platform/` owns this. `bridge.ts` is the only file in
`client-aac` permitted to touch `window.electronAPI`. Adding a host means adding
one row to the matrix in `detect.ts` and fixing the resulting type errors.

| Capability | electron | capacitor | web |
|---|---|---|---|
| `gazeSidecar` | ✅ | ❌ | ❌ |
| `drivableWebview` | ✅ | ❌ | ❌ |
| `nativeVersion` | ✅ | ✅ | ❌ |
| `selfUpdate` | ✅ | ✅ | ❌ |
| `localhostBridge` | ✅ | ✅ | ❌ |

### What iPad does not get

- **Eye tracking.** The DLL-based sidecar spawns a native child process, which
  iPadOS forbids outright. iPad is touch-only for v1. ARKit face tracking could
  feed the existing dwell engine later, as a native plugin — not a sidecar.
- **The drivable in-app browser.** WKWebView has no `<webview>` tag, so
  `BrowserApp` falls back to the iframe path with the same cross-origin limits
  as the web build.

## Files

| File | Role |
|---|---|
| `capacitor.config.ts` | The iOS shell config. Counterpart to `electron-builder.yml`. |
| `scripts/ios-configure.mjs` | Patches the generated `Info.plist` (permissions, orientation, ATS). Idempotent; `--check` verifies without writing. |
| `client-aac/.env.ios` | Backend baked into the build. Mirrors `.env.electron`. |
| `.github/workflows/release-aac-ios.yml` | macOS-runner build → TestFlight. |
| `shared/native-update.ts` | The `UpdateStatus` contract shared by both shells. |

`ios/` is **gitignored** — the Xcode project is generated fresh by
`npx cap add ios` on the runner. Everything we customize lives in the two files
above, so the native project stays disposable.

## Releasing

You do **not** need a Mac. iOS apps can only be built by Xcode, but the macOS
GitHub runner provides it. The workflow has two targets, via the `distribution`
input.

### Sideloadly (default, no Apple secrets)

The current delivery path. Run **Actions → Release AAC iPad → Run workflow**
with `distribution = sideloadly-unsigned`. It builds and archives the app
unsigned, packages it into `AivotaAAC-unsigned.ipa`, and uploads it as a
workflow artifact. **No App Store Connect setup, no secrets, not even a paid
developer account** are required on our side.

Send that `.ipa` to the tester. They install it with **Sideloadly**
(<https://sideloadly.io>) on their own Windows/Mac: it re-signs the `.ipa` with
*their* Apple ID and installs over USB. This is why the `.ipa` can be unsigned —
our signature would be stripped and replaced anyway.

Tester-side caveats:

- A **free** Apple ID works, but the app stops launching after **7 days** and
  must be re-installed (a paid developer Apple ID lasts a year).
- After the first install, on the iPad: **Settings → General → VPN & Device
  Management → Trust** the developer profile, or the app won't open.
- "Updating" = you produce a newer `.ipa` and they sideload it again.

### TestFlight (signed, for later)

Once the app is proven and you want managed beta distribution instead of
per-device Sideloadly installs:

1. Create the app record in App Store Connect with bundle id `com.aivota.aac`.
2. Add the four repository secrets listed in the workflow header
   (`APPLE_TEAM_ID`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`,
   `APP_STORE_CONNECT_KEY_P8`).
3. Run the workflow with `distribution = testflight-signed`.

The tester installs Apple's **TestFlight** app, then installs the build through
it. Internal testers (your App Store Connect team) get builds immediately;
external testers need a one-time Beta App Review, usually under 48 hours.

### Gotcha: Capacitor 8 defaults to SPM, which has no `.xcworkspace`

`cap add ios` in Capacitor 8 defaults to **Swift Package Manager**, whose
template ships no `App.xcworkspace` and no Podfile — archiving with
`-workspace App.xcworkspace` then fails with *"App.xcworkspace does not
exist."* The workflow forces the CocoaPods template with
`npx cap add ios --packagemanager CocoaPods` and asserts the workspace exists
before archiving. If you ever regenerate the project by hand, use the same flag.

## Updates

Windows auto-updates by replacing the NSIS installer from an S3 feed
(`release-aac.yml`). **Apple does not permit that**, so iPad binary updates go
through TestFlight / the App Store.

Apple *does* permit swapping the interpreted web bundle, which is what
`@capgo/capacitor-updater` does, and that covers most of our releases — the AAC
architecture deliberately keeps logic on the server with the client as a
display engine.

**OTA is scaffolded but switched OFF** (`autoUpdate: false` in
`capacitor.config.ts`, and `capacitorProvider()` in
`client-aac/src/lib/platform/update.ts` returns `null`). An updater that
misbehaves can strand the app on a broken bundle, and recovering that needs
physical access to the device. Turn it on only after the shell is confirmed
working on a real iPad.

Both mechanisms report through the same `UpdateStatus` union, so the UI never
branches on host.

## Status — what is and isn't verified

Verified on Windows:

- The capability layer and its 13 tests (`npm run test:client`).
- Backend resolution for `capacitor://`, with tests. This was a real bug: the
  packaged-app check keyed on `protocol === "app:"`, so an iPad build would
  have resolved its backend to `capacitor://localhost` and every API call would
  have failed.
- CORS for `capacitor://localhost`, with tests (`npm test -- cors-policy`).
- `npm run ios:build` produces a relative-base bundle with the backend baked in.
- `scripts/ios-configure.mjs` against a Capacitor-template `Info.plist`,
  including idempotency and preservation of template keys.

**Not verified — no Mac, no iPad:**

- `npx cap add ios`, `cap sync`, CocoaPods.
- The entire workflow: `xcodebuild archive`, export, signing, `altool` upload.
- Whether the app actually runs, and whether camera/microphone/audio behave in
  WKWebView.

Expect several CI iterations before the first green build. The first build
should be checked by someone technical before it reaches a student.

## Known issues to look at

`dist/public-aac/index.html` loads two external resources: a Font Awesome CDN
stylesheet and, more oddly, `https://replit.com/public/js/replit-dev-banner.js`.
The Replit banner looks like leftover scaffolding and should probably be removed
from `client-aac/index.html` — it is a third-party script in a production build
that handles student data.
