# Partner App Integration Guide

How a third-party app runs *inside* the Aivota platform with real functionality —
receiving the student's gaze, pinning choices onto the AAC communication board,
and collaborating with the live AI.

This is the guide you hand a partner. It is intentionally self-contained: a
partner does **not** need access to our source. The integration is a small
`postMessage` contract.

---

## 1. Pick your integration depth

| Depth | What it is | What the app gets | Work for the partner |
|---|---|---|---|
| **Display-only** | Your site is added to the student's permitted-websites list and shown in our in-app browser. | Nothing beyond being visible. The platform can only scroll/click/type it from the outside (eyegaze), and cannot exchange data. | Just host a site. |
| **Bridge app** (this guide) | Your app is embedded as a first-class add-on and speaks our message bridge. | Gaze stream, ability to pin options on the AAC board, a two-way channel with the live AI, lifecycle events, licensing. | Implement the `postMessage` contract below. |

If you want "additional functionality within the platform," you want a **bridge
app**. The rest of this document is about that.

---

## 2. How embedding works

Your app is loaded in a frame the platform controls and points at your URL. All
communication is `window.postMessage` between your app (the child) and the
platform (the parent).

### Hosting: same-origin vs your origin

- **Your own origin (recommended for partners):** you host the app; you give us
  the exact origin (e.g. `https://app.yourcompany.com`). We add it to the embed
  allowlist. **No platform session cookies reach you** — good isolation. Paid
  access is gated with a license token (see §7).
- **Bundled with the platform (same-origin):** only for apps we co-build and
  fully trust; it inherits the platform session. Not the partner path.

### Message envelope

Every bridge message — in both directions — carries a marker so stray
`window.message` events are ignored:

```jsonc
{ "__aivotaGameBridge": true, "type": "<message-type>", /* …fields… */ }
```

- **Ignore** any incoming `message` event whose `data.__aivotaGameBridge !== true`.
- Send **to the parent** with `window.parent.postMessage(msg, PARENT_ORIGIN)`,
  where `PARENT_ORIGIN` is the platform origin (derived from `document.referrer`).
- Only **accept** messages whose `event.origin` is the platform origin.
- If there is no parent (you run standalone), sending is a no-op and no platform
  messages arrive — your app must still work.

---

## 3. Message contract

### Platform → your app

| `type` | Fields | Meaning |
|---|---|---|
| `init` | `locale?`, `studentDisplayName?`, `licenseToken?`, `dwellMs?`, `params?` | First message after your app signals `ready`. Localize, honor `dwellMs` (the student's dwell-select time), apply `params`, and validate `licenseToken` if you require licensing. |
| `gaze` | `x`, `y`, `mode` | Gaze position in **your app's local pixels** (already converted), ~30 Hz. `mode` is `"off" \| "eyegaze" \| "mouse"`. Only sent if we enable gaze forwarding for your app. |
| `expression` | `emotion`, `confidence` | The student's facial expression, when available. |
| `people_present` | `names[]` | People recognized on camera (only forwarded to trusted apps — see §8). |
| `ai_comment` | `text` | The AI's spoken text as it streams — react visually if you like. |
| `ai_state` | `speaking`, `thinking` | The AI's live activity. `speaking` = AI voice is playing; `thinking` = an agent is working. Pushed on change. Use it to duck your audio or show a cue. |
| `ai_emote` | `emote` (`"happy"\|"sad"\|"neutral"`) | The AAC avatar's mood — mirror it on your characters if you want. |
| `ai_response` | `requestId`, `ok`, `text?`, `data?`, `error?` | Correlated reply to an `ai_select` (matched by `requestId`). On success: `ok:true`, `data:{ selectedId, reason? }`. On failure: `ok:false`, `error`. (A free-text `ai_request` is *not* answered here — it comes back as spoken `ai_comment`.) |
| `pause` / `resume` | — | Suspend / resume your app (e.g. student navigated away and back). |
| `board_option_selected` | `id` | The student pressed one of the options you pinned via `set_board_options`. |
| `request_close` | — | The platform is closing your app. |

### Your app → platform

| `type` | Fields | Meaning |
|---|---|---|
| `ready` | `gameId`, `version?` | Send once on load. The platform replies with `init`. |
| `set_board_options` | `options[]`, `prompt?` | Lock the AAC communication board to these choices; the student answers on the *real* board. Re-send to replace; `clear_board_options` to release. Each option: `{ id, label, glyph?, spokenText? }`. |
| `clear_board_options` | — | Release the board back to the AI. |
| `ai_observation` | `surface` (any JSON) | Passive: tell the AI what's happening. Delivered as a `[GAME OBSERVATION]` the AI may weave into conversation. |
| `ai_request` | `prompt`, `requestId?` | Active: ask the AI to respond to the student **now** (a nudge). The reply arrives as a spoken `ai_comment`. Fire sparingly — each one drives the live session (latency + cost). |
| `ai_select` | `requestId`, `options[]`, `instruction?` | Ask the AI to **choose one** of `options` (`{id, label, description?}`) and reply with the chosen id via a correlated `ai_response`. `instruction` steers the pick (e.g. "the student loves dinosaurs"). The returned `selectedId` is guaranteed to be one of the ids you sent. **No license required.** Metered + rate-limited — fire only on real decisions. |
| `player_action` | `action`, `meta?` | Analytics/telemetry hook. |
| `score` / `level_changed` | `value`/`level` | Progress signals. |
| `session_end` | `reason` (`"won"\|"quit"\|"error"`), `summary?` | Your app finished; the platform closes it and the AI can debrief. |
| `request_close` | — | Ask the platform to close you. |

---

## 4. Minimal skeleton (framework-agnostic, no dependency on our repo)

```ts
const TAG = "__aivotaGameBridge";
const PARENT_ORIGIN = (() => {
  try { return new URL(document.referrer).origin; } catch { return "*"; }
})();

function send(msg: Record<string, unknown>) {
  if (window.parent === window) return;                 // standalone: no-op
  window.parent.postMessage({ ...msg, [TAG]: true }, PARENT_ORIGIN);
}

window.addEventListener("message", (e) => {
  if (PARENT_ORIGIN !== "*" && e.origin !== PARENT_ORIGIN) return;
  const m = e.data;
  if (!m || m[TAG] !== true || typeof m.type !== "string") return;

  switch (m.type) {
    case "init":
      applyLocale(m.locale);
      setDwellTime(m.dwellMs);        // honor the student's dwell-select time
      if (needsLicense && !verify(m.licenseToken)) return refuseToStart();
      start(m.params);
      break;
    case "gaze":
      onGaze(m.x, m.y, m.mode);        // YOUR dwell logic — see §5
      break;
    case "board_option_selected":
      onStudentChoice(m.id);
      break;
    case "ai_comment":  showAiSpeech(m.text); break;
    case "ai_state":    setAiBusy(m.speaking, m.thinking); break;
    case "ai_emote":    mirrorMood(m.emote); break;
    case "pause":       pause(); break;
    case "resume":      resume(); break;
    case "request_close": teardown(); break;
  }
});

// On load:
send({ type: "ready", gameId: "your-app-id", version: "1.0.0" });

// Ask the student a question ON THE AAC BOARD:
send({ type: "set_board_options", prompt: "Which animal?", options: [
  { id: "cat", label: "Cat", spokenText: "the cat" },
  { id: "dog", label: "Dog", spokenText: "the dog" },
]});

// Tell / ask the AI:
send({ type: "ai_observation", surface: { event: "level_complete", level: 3 } });
send({ type: "ai_request", prompt: "The student matched every animal — celebrate with them." });

// Have the AI PICK one of a list, then act on the answer (see §6):
const reqId = crypto.randomUUID();
send({ type: "ai_select", requestId: reqId, instruction: "the student loves dinosaurs", options: [
  { id: "b1", label: "Dinosaurs", description: "a picture book about dinosaurs" },
  { id: "b2", label: "The Ocean" },
  { id: "b3", label: "Space Adventure" },
]});
// …handle the reply in the message switch:
//   case "ai_response":
//     if (m.requestId === reqId && m.ok) openBook(m.data.selectedId);  // e.g. "b1"
//     break;
```

---

## 5. Eyegaze is YOUR responsibility (the #1 gotcha)

Many of these students drive everything by **eye gaze with dwell selection**. The
platform's dwell engine **cannot reach inside your frame** — it's a cross-origin
boundary. So:

- Enable gaze forwarding with us, consume the `gaze` events (local pixels), and
  run your own dwell-to-select (a target is chosen when gaze rests on it for
  `dwellMs`), **or**
- Build your UI so the platform can drive it as plain clicks.

Design for gaze: **large targets, generous spacing, dwell feedback (a filling
ring), no reliance on hover/drag/precise pointing.** Honor the `dwellMs` from
`init` so your timing matches the rest of the platform.

---

## 6. Collaborating with the AI

Three complementary channels:

- **`ai_observation` (passive):** stream structured state. The AI *may* react. Use
  for ambient awareness ("student is on level 3", "placed a red block").
- **`ai_request` (active):** ask the AI to respond to the student now. Use at
  meaningful moments (a win, a struggle, a milestone). The reply comes back as a
  spoken **`ai_comment`**.
- **`ai_comment` / `ai_state` / `ai_emote` (inbound):** react to what the AI is
  saying, whether it's busy, and its mood.

**Structured selection (`ai_select` → `ai_response`) is shipped and needs no
license.** Send `ai_select` with your options; the platform (as the trusted,
authenticated host) runs a small, metered, rate-limited model call constrained to
your ids and returns `ai_response { ok, data:{ selectedId, reason } }`, matched by
`requestId`. `selectedId` is always one of the ids you sent. Your `instruction`
supplies the relevance signal, so **no student PHI leaves the platform** — that's
why it's open to unlicensed apps. Use it for "pick the best of these" flows (which
book/level/character to open). Build so a missing/`ok:false` response degrades
gracefully (e.g. fall back to letting the student choose on the board).

Broader open-ended AI queries (free-form generation, "is this drawing a cat?")
are **not** exposed to third parties — that surface needs per-partner cost/PHI/
safety review. `ai_select` is deliberately the narrow, safe slice.

---

## 7. Licensing

The `licenseToken` on `init` is a short-lived signed token the platform mints
once it verifies the student's license. Licensed apps should refuse to start
without a valid token. **The minting endpoint is not built yet** — if your app is
paid/licensed, flag it early so we can prioritize that work; unlicensed apps can
ignore the field.

---

## 8. Compliance & privacy (read before you build)

These are children with special needs, under HIPAA / ministry-of-education
constraints. **Any student data you receive is a data-sharing surface.**

- We forward the **minimum** by default: `studentDisplayName` (a display name, not
  an identity), and behavioral signals (`gaze`, `expression`). We enable each
  optional signal (`gaze` forwarding, `people_present`) only when your app
  genuinely needs it.
- `people_present` (recognized identities) is **only** shared with trusted,
  agreement-covered partners.
- A signed data-processing agreement and a review against our
  ministry-of-education principles are required before any PII flows.
- On your side: don't persist student data beyond what the feature needs, don't
  send it to third parties, and be ready to support deletion.

---

## 9. What you submit to get registered

Give us:

1. **App id** (stable slug), **name**, **icon** (emoji or asset).
2. **AI-facing description** — one paragraph the AI reads to decide *when* to open
   your app. This is a prompt; be precise about the trigger ("open when the
   student wants to practice counting").
3. **Hosted URL** and **exact origin**.
4. **Startup params** (optional): a JSON Schema. The platform's resolver fills
   these at open time and passes them on `init.params`.
5. Which signals you need: `gaze`? `expression`? `people_present`?
6. Whether it's **licensed**.
7. Data-processing agreement + compliance review (see §8).

### What we do on our end

1. Add your app to the registry (`server/services/dual-agent/app-registry.ts`).
2. Render it as an embedded bridge app, with your origin on the allowlist and
   `gaze` forwarding on if requested.
3. Enable it per-student (clinician toggles it in AAC settings).
4. Wire startup-param resolution and, when applicable, license minting.

---

## 10. Checklist

- [ ] App loads standalone (no parent) without crashing.
- [ ] Sends `ready` on load; handles `init` (locale, `dwellMs`, `params`, license).
- [ ] Eyegaze: consumes `gaze` and runs its own dwell, or is plain-click driven;
      large targets, dwell feedback.
- [ ] Uses `set_board_options` for choices that should happen on the AAC board.
- [ ] Talks to the AI via `ai_observation` / `ai_request`; reacts to `ai_comment` /
      `ai_state` / `ai_emote`.
- [ ] Handles `pause`/`resume`/`request_close`; emits `session_end`.
- [ ] Ignores non-bridge messages; checks `event.origin`.
- [ ] Compliance: minimal data use, agreement in place.
