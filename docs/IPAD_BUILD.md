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
| `scripts/ios-configure.mjs` | Everything we change about the generated project: `Info.plist` keys, the app icon, the localized permission strings, and the Xcode build settings (iPad-only). Idempotent; `--check` verifies without writing. |
| `scripts/ios-permission-strings.mjs` | The camera/mic/local-network prompt text in all 11 languages. iOS renders these before any JS runs, so they cannot live in `client-aac/src/i18n`. |
| `client-aac/.env.ios` | Backend baked into the build. Mirrors `.env.electron`. |
| `.github/workflows/release-aac-ios.yml` | macOS-runner build → TestFlight. |
| `shared/native-update.ts` | The `UpdateStatus` contract shared by both shells. |

`ios/` is **gitignored** — the Xcode project is generated fresh by
`npx cap add ios` on the runner. Everything we customize lives in the two files
above, so the native project stays disposable.

## What `ios-configure.mjs` applies

The generated Xcode project is stock; these are the deltas, all asserted by
`server/tests/ios-configure.test.ts` against the real Capacitor template:

- **Permission strings**, in all 11 UI languages. iOS draws the camera /
  microphone / local-network prompts itself, before any JavaScript runs, and it
  picks the language from the *device's* preferred languages — not from the
  in-app picker. The only mechanism is a `<lang>.lproj/InfoPlist.strings` file
  per language, which means writing the files AND registering them in the Xcode
  project: a `.lproj` no build phase references is silently absent from the
  `.app`, so the localization compiles fine and does nothing.
- **`ITSAppUsesNonExemptEncryption = false`.** The app uses only standard
  HTTPS/TLS, which is exempt — but the declaration is mandatory, and without it
  every App Store Connect upload stops and waits for the export-compliance
  question to be answered by hand.
- **`TARGETED_DEVICE_FAMILY = "2"` (iPad only).** The template default is
  `"1,2"`; submitted that way the store demands iPhone screenshots and a UI
  that works at phone size, and the board is a fixed-layout surface designed
  for a mounted iPad.
- The app icon and the Info.plist keys documented above (orientation,
  full-screen, ATS).

The `project.pbxproj` edits are textual patches against anchors from the
Capacitor template, and every anchor must match **exactly once** — if a future
Capacitor release reshapes the template, the build fails loudly on the runner
rather than quietly shipping an iPhone-sized, English-only app.

## Releasing

You do **not** need a Mac. iOS apps can only be built by Xcode, but the macOS
GitHub runner provides it. The workflow has two targets, via the `distribution`
input.

### Sideloadly (default, no Apple secrets)

The current delivery path. Run **Actions → Build AAC iPad (unsigned) → Run
workflow**. It builds and archives the app unsigned, packages it into
`aivota-aac-ipad-unsigned-v<version>-build<run>.ipa`, and uploads it as a
workflow artifact. **No App Store Connect setup, no secrets, not even a paid
developer account** are required on our side.

With the workflow's `publish` input left on (the default), it ALSO uploads the
`.ipa` and a `latest.json` manifest to `s3://…/aac/ios/` — the same bucket the
Windows auto-updater feeds from, fronted by
`https://updates.aivota.ai/aac/ios/`. That is what the clinician dashboard's
**Downloads** page serves, so clinicians fetch the current build themselves
instead of it being emailed around. Publishing needs the `AWS_ROLE_ARN` secret
(already present for `release-aac.yml`); uncheck `publish` to build without it.
The uploader is `scripts/publish-aac-ios.mjs` — the iOS counterpart to
`publish-aac-release.mjs`. Note there is still **no auto-update**: an `.ipa`
cannot replace itself, so a new version means sideloading again.

The tester installs it with **Sideloadly** (<https://sideloadly.io>) on their own
Windows/Mac: it re-signs the `.ipa` with *their* Apple ID and installs over USB.
This is why the `.ipa` can be unsigned — our signature would be stripped and
replaced anyway. The Downloads page carries this whole procedure as a numbered
walkthrough, in all 11 UI languages.

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

### Unlisted App Distribution (the intended destination)

Decided 2026-09-03, once the company existed. The app goes to the App Store
**unlisted**: a direct link, not searchable, not browsable, no storefront
presence — but installable by any Apple ID that has the link, with no Apple
Business Manager enrolment required of the receiving clinic.

It uses the same signed build and the same `release-aac-ios.yml` workflow as
TestFlight; "unlisted" is a property of the App Store listing, requested from
App Store Connect after the app passes a normal App Review, not a different
build.

Why not the alternatives:

- **Public listing** puts a "seizure detection app for children" in front of a
  storefront audience and invites medical-device scrutiny we have no reason to
  invite yet.
- **Custom Apps** (Apple Business/School Manager) look like the natural fit for
  institutional software, but every receiving clinic or school must enrol in
  ABM/ASM itself, which needs *their* D-U-N-S and a verifier with signing
  authority. Fine for a partner the size of AKIM; a wall for a small private
  clinic.
- **Apple Developer Enterprise Program** is for distribution to your own
  employees only. Using it to reach customers gets the account terminated.

Prerequisite either way: **Apple Developer Program enrolment as an
organization**, which needs a company D-U-N-S number (free, ~1–2 weeks, and the
company may already have one — check Apple's lookup before requesting).

### Toolchain pin (runner + Xcode)

App Store Connect rejects an upload built against an SDK below its current
floor, and the rejection arrives *after* the build — so the toolchain is pinned
rather than inherited. Both workflows carry the same two job-level variables:

```yaml
runs-on: macos-15
env:
  XCODE_VERSION: '26'    # major only
  MIN_IOS_SDK: '26.0'
```

The `Pin Xcode and verify the iOS SDK` step runs immediately after checkout —
before `npm ci`, before the web build — so a wrong pin costs seconds. It:

1. prints every `/Applications/Xcode*.app` on the image, so a failure tells you
   what to set the pin to;
2. selects the highest `Xcode_<XCODE_VERSION>*.app` (version-sorted, so 26.10
   beats 26.2) and `sudo xcode-select -s`es it;
3. asserts `xcodebuild -version -sdk iphoneos SDKVersion` ≥ `MIN_IOS_SDK`;
4. records both into the run summary, because App Review cites the SDK a build
   was compiled against and `ios/` is not committed anywhere to check after
   the fact.

**The pin is the major version only.** A full pin (`26.1.0`) would break every
build the week GitHub refreshes the image, for no gain: what App Store Connect
cares about is the SDK generation. What must never happen silently is the
generation *changing*, and the major pin plus the SDK assertion covers that.

**Both workflows must carry the same pin.** The unsigned workflow is the iOS
smoke test; run on a different toolchain it proves nothing about the signed
build, which is the whole reason it exists.

When Apple raises the floor (historically each spring), bump `XCODE_VERSION`
and `MIN_IOS_SDK` together, in both files.

> Not verifiable from Windows: whether `Xcode_26*.app` is actually on the
> `macos-15` image. If it is not, the *unsigned* workflow fails in ~30 seconds
> with the installed list printed — run that one first and set the pin from its
> output. That failure mode is the point: the alternative is a silent SDK
> downgrade discovered at upload.

### Open items before the first submission

Found 2026-09-03 and deliberately NOT changed, because each needs a decision or
a device we do not have:

- **`xcrun altool --upload-app` is deprecated.** It still works; Apple's
  replacement is Transporter / `iTMSTransporter`, or `xcodebuild
  -exportArchive` with `<destination>upload</destination>` in the
  `ExportOptions.plist` (which can reuse the App Store Connect key the workflow
  already writes). The pin step now *checks* `xcrun --find altool` before the
  archive so its removal cannot cost a 40-minute build, but the migration
  itself is still owed. Move before it is withdrawn, not after a release fails.
- **`UIRequiresFullScreen` is on borrowed time — and the SDK pin above is
  likely what runs out the clock.** iPadOS moved toward every app being
  resizable, and the key stops being honoured once an app is built against a
  new enough SDK. Pinning to the iOS 26 SDK is plausibly past that line, so
  **the first build on the new pin must be checked on a device for a resizable
  window**, not assumed full-screen. If it is resizable, that is not a pin
  problem to roll back: the board genuinely cannot be resized out from under a
  student mid-selection, so the fix is a responsive board layout. The plist key
  was always a stay of execution.
- **`NSLocalNetworkUsageDescription` describes eye-tracking hardware the iPad
  build cannot use.** The gaze sidecar is Electron-only (see "What iPad does
  not get"). The key is retained because `capabilities().localhostBridge` is
  true on Capacitor, but before submission confirm something on iPad actually
  reaches `ws://localhost` — App Review asks about permissions the app never
  exercises, and an unused one is worth dropping.
- **A demo account for App Review is mandatory** (guideline 2.1) and must reach
  a *working session*. The last blocker on real hardware was the consent gate
  returning `CONSENT_REQUIRED`; a reviewer who hits that sees a dead app. The
  review account needs a demo student with a completed consent record on
  production, kept alive for as long as the app is listed.
- **App Privacy labels** must match what the app actually transmits: camera
  frames, audio, face/identity biometrics and seizure indicators, for children.
  Get these right on the first submission.

## On-device debugging

A sideloaded iPad has no Safari inspector and no terminal. The AAC client has a
built-in log viewer for this: `client-aac/src/lib/debug-log.ts` captures console
output + global errors + API failures into a ring buffer, and
`components/DebugConsole.tsx` shows it on-device.

Open it with a **4-finger tap anywhere** (or **Ctrl+Shift+D** on desktop). It's
hidden — students never see it. Reproduce the issue, tap **Copy**, and the log
(with device/version/URL context) goes to the clipboard to paste back. It's
mounted at the app root, so it works on the login screen too.

## Gotcha: iPad session cookie is dropped (login bounces back)

Symptom: log in, the institute/student picker flashes for an instant, then it
returns to the login screen.

Cause: the app is served from `capacitor://localhost` and the backend is a
cross-origin https server. The server's session cookie is `SameSite=None`, which
WKWebView treats as a third-party cookie and — under iOS ITP — refuses to store
or send. So `credentials: "include"` carries no cookie and the post-login
`/auth/user` check 401s.

Fix (no server change): on the Capacitor host only, JSON API calls are routed
through **CapacitorHttp** (native HTTP + native cookie store, not subject to
WKWebView's cookie rules) — see `client-aac/src/lib/queryClient.ts` (`apiFetch`).
The web and Electron builds keep normal fetch. CapacitorHttp's *global* fetch
patch is deliberately NOT enabled (it would break fetch streaming); the plugin
is called directly for the API layer only. Any client code that calls the API
via a raw `fetch()` instead of the `queryClient.ts` helpers will still hit the
cookie problem on iPad — route it through `apiRequest`/`fetchWithAuth`.

## Gotcha: the live session WebSocket can't use the cookie either (CONFIRMED)

Symptom: login and the whole HTTP API work, but the AAC sits on "connecting"
(then "sleeping" with the error indicator). The debug console shows, on a loop:

```
[useLiveSession] WebSocket error: { "isTrusted": true }
[useLiveSession] WebSocket closed: code=1006 reason= intentional=false isInitialized=false
```

Cause: the CapacitorHttp fix above put the session cookie in the **native**
(URLSession) cookie store. `new WebSocket(...)` is executed by WKWebView, whose
cookie jar never received that cookie — so the upgrade request arrives with no
cookie at all, `authenticateUpgrade` returns null, and the server answers `401`.
A rejected handshake surfaces to JS only as `error` + close code `1006`, with no
status, which is why this looks like a network fault rather than an auth one.
The cookie is `httpOnly`, so JS cannot copy it across; and even in the WKWebView
jar, ITP would refuse to send a `SameSite=None` cookie cross-site.

Fix: a short-lived **WS ticket**. On the Capacitor host only, the client first
calls `POST /api/aac/live/ws-ticket` (authenticated HTTP, so it *does* carry the
native cookie) and appends the result to the handshake as `?ticket=…`.
`authenticateUpgrade` redeems the ticket, falling through to the normal cookie
path when there isn't one — every other host is untouched.

The ticket is HMAC-signed with a key derived from `SESSION_SECRET`, lives 60
seconds, is single-use, and carries only a user id, so it is safe in a URL and
cannot be exchanged back into a session. It names an identity but does not skip
the user lookup, so a disabled account still cannot connect. See
`server/services/realtime/ws-ticket.ts` and `server/tests/ws-ticket.test.ts`.

Anything else that opens a WebSocket from the iPad shell needs the same
treatment — the cookie will never be there.

## Gotcha: an await before `initialize` can strand the session

Symptom: the socket connects (the server logs `[LiveRelay] New WebSocket
connection`) but then hears nothing until the client disconnects, and the app
sits on "connecting" with no error at all.

Cause: `sendInit` in `useLiveSession.ts` does best-effort enrichment *after*
`ws.onopen` but *before* `wsSend({type:"initialize"})`. Anything there that
never settles means the server holds an open, silent socket forever.

The real instance: `getCurrentGps()`. `Info.plist` carries no location
usage-description key (`scripts/ios-configure.mjs` writes Camera, Microphone and
LocalNetwork only), and in that state iPadOS WKWebView invokes **neither** the
success nor the error callback. The `timeout` option is honoured by the
*platform*, so it never fired either — the promise hung indefinitely.

Fixes, both kept:

- `getCurrentGps` now runs its **own** watchdog timer, so "always settles" is
  our guarantee rather than the platform's (`geolocation.test.ts` covers the
  no-callback case).
- Every await in `sendInit` is time-boxed by `settleWithin`, so no future
  enrichment step can strand the session either.

GPS is **skipped outright on the Capacitor host**: a reading can never succeed
without the plist key, and adding the key would put an OS permission prompt in
front of a student who may not be able to answer it. `startGpsWatch` is a no-op
there too. If iPad location is ever wanted, add
`NSLocationWhenInUseUsageDescription` in `ios-configure.mjs` and drop both
guards together.

**Debugging note:** the on-device console is a bounded ring buffer. A
`console.debug` in a hot effect (the `pressSuggestion` bridge in `home.tsx` was
one) will evict every other line and leave you blind — that is why the first two
logs from this investigation showed nothing but one repeating line.

## Gotcha: Capacitor 8 defaults to SPM, which has no `.xcworkspace`

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
- `scripts/ios-configure.mjs` against the REAL Capacitor template unpacked from
  `node_modules` — Info.plist keys, icon, all 12 `.lproj` files, the pbxproj
  patch (device family, variant group, Resources build phase, no dangling
  object ids), idempotency, and `--check`
  (`npm run test:unit -- ios-configure`).

**Not verified — no Mac, no iPad:**

- `npx cap add ios`, `cap sync`, CocoaPods.
- The entire workflow: `xcodebuild archive`, export, signing, `altool` upload.
- **The toolchain pin** — whether `Xcode_26*.app` exists on `macos-15` at all.
  The selection and SDK-comparison logic was exercised locally against a
  synthetic `/Applications` (highest-version wins, `26.10` > `26.2`, missing
  pin fails legibly under `bash -eo pipefail`), but the image contents cannot
  be. See "Toolchain pin" above.
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
