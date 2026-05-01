# AAC Sleep System

The purpose of this system is to avoid wasting tokens when not needed by having the AI adjust its engagement level.
This system is *COMPLETELY SEPARATE* from the Assist Mode / Interactive Mode / Silent Mode behavior (Silent mode just means the AI will not speak, it is still equally engaged).

## Engagement Signals

Browser-based "Engagement Hints" operate client-side (no token use — may be enabled at all times):

- Motion detection (low signal) (higher signal for movement in new parts of the screen)
- Noise detection (low signal) (higher signal for sharp changes in noise)
- Face detection (high signal) (Moving faces, close-up faces, and faces looking at the device have highest signal)
- Voice detection (high signal)
- If voice detection matches mouth movement of a detected face that is facing the screen, very high signal *(v2 — expensive cross-check, defer)*
- Mouse movement / eyegaze movement (high signal)
- Button presses (very high signal)
- Clicking or eyegaze-triggering the avatar (maximum signal, **always wakes up** — bypasses all thresholds and dampening)

### Goals

- Ignore background ambience and motion when determining presence of user
- Ignore pictures of faces or sleeping people when determining presence of user
- Remain attentive if the user is actively interacting with the device
- Remain attentive if user moves away from device but is still engaged with it (i.e. demonstrating physical activities)
- Remain attentive if user is having a conversation with the device, even if they are not visible
- Wake up if someone shouts to get the device's attention, even if they are not visible
- Wake up if someone is staring at the device, even if they are not making sound

### Engagement Score

Signals are combined into a continuous engagement score in `[0, 1]` using a **weighted sum with exponential decay**. Each signal contributes its weight when active; decay drives the score toward 0 in the absence of signal. Sustained signals (a face staring at the screen for several seconds) accumulate; transient ones (a single noise burst) decay quickly. Weights and decay constants are tunable.

**Implementation note:** the existing `CameraAttentivenessContext` will be **extended** rather than replaced — it already implements the motion-detection pathway with its own state machine. Rename `isAwake` to a state enum, fold in the remaining signal sources, and have it produce the single fused engagement score that drives the state machine below. This avoids running two parallel state machines.

## State Machine

Sleep behavior is handled by a state machine. **Hibernation is the default at startup** — sessions auto-end when the live connection drops, so no special teardown is needed; the next page load begins in Hibernation.

### Hibernation: No session
- Default startup state. Also entered when the AI calls `end_session`, or when the live connection is lost.
- Do not collect audio or image data. No session is open; no token cost.
- Wake triggers (any one):
  - Avatar tap or eyegaze-on-avatar
  - AAC button press
  - Sustained client-side face presence (~1.5 s of a face looking at the screen) — cheap because no LLM is involved until the session opens

### Waking: Session starting
- Transient state used for avatar display while a new session is initializing.
- No engagement-driven behavior here.

### Asleep: User is not present, but might return — maintain session
- Triggered by AI function call (`sleep`), or automatically when the engagement score in Resting falls below `SLEEP_THRESHOLD`.
- Collect audio and image data into a short local buffer (~5 s rolling) but **do not send to the AI**. Older buffer contents are dumped.
- **Wake transition (client-decides):** when the engagement score exceeds `WAKEUP_THRESHOLD`, the client transitions to Awake unilaterally and **bundles the recent buffered context into the first wake message** so the AI sees what actually triggered the wake. The AI may immediately call `report_false_wake` if it judges the wake was a misfire.

### Resting: User is not engaged
- Triggered when in Awake and the engagement score drops below `REST_THRESHOLD`.
- Resting is **graduated**: as the score continues to drop within Resting, more data channels are throttled or disabled. The motion-based image capture system stays active throughout, so the system is never fully blind to movement even when scheduled heartbeats are off.
- Prompts the AI to call `sleep` if the user is not present but may return soon, or `end_session` if the session is over.
- Return to Awake if the engagement score rises above `ENGAGED_THRESHOLD` (lower than `WAKEUP_THRESHOLD` — Resting is "warmer" than Asleep, easier to re-engage).
- Drop to Asleep if the score falls below `SLEEP_THRESHOLD`.

### Awake: Fully engaged with the user
- Full data flow. Standard behavior, no special restrictions.
- Drop to Resting when the score falls below `REST_THRESHOLD`.

## Thresholds

Hysteresis-gated to prevent flapping. Default values are placeholders pending tuning.

| Threshold | Default | Transition |
|---|---|---|
| `REST_THRESHOLD` | 0.30 | Awake → Resting |
| `ENGAGED_THRESHOLD` | 0.45 | Resting → Awake |
| `SLEEP_THRESHOLD` | 0.15 | Resting → Asleep |
| `WAKEUP_THRESHOLD` | 0.65 | Asleep → Awake |

Invariant: `SLEEP_THRESHOLD < REST_THRESHOLD < ENGAGED_THRESHOLD < WAKEUP_THRESHOLD`.

## Per-State Data Flow

| State | Frame heartbeat | Heartbeat audio | PCM mic | Frame grid |
|---|---|---|---|---|
| Awake (≥ ~0.45) | 15 s | 3 s | continuous | 4×4 |
| Resting-light (0.30–0.45) | 30 s | off | continuous | 4×4 |
| Resting-deep (0.15–0.30) | off | — | VAD-gated | 3×3 on motion only |
| Asleep (< 0.15) | off | — | off | buffered locally, sent only on wake |
| Hibernation | — | — | — | no session |

The Resting tiers are determined by the current engagement score within the Resting state — a continuous gradient, described here as two reference buckets for clarity. Tier boundaries and the data-channel schedule are tunable.

## AI Tools

- **`sleep()`** — transition to Asleep (user is not present but may return).
- **`end_session()`** — transition to Hibernation (session is over).
- **`report_false_wake(reason: string)`** — dampen wake thresholds when a wake turns out to have been a misfire (see below).

## False-Wake Dampening

When the AI is woken from Asleep (or re-engaged from Resting) and judges the trigger was bogus — background TV, an unrelated adult talking, a passing pet — it can call `report_false_wake(reason)` instead of replying.

Behavior:
- The client increments `WAKEUP_THRESHOLD` and `ENGAGED_THRESHOLD` by a small step (proportional to current values).
- Thresholds **auto-decay** back to baseline over ~10 minutes. The AI is not expected to lower them manually.
- **Always-wake signals bypass the elevated threshold** — avatar tap, eyegaze-on-avatar, AAC button press always engage immediately. The user can always force-engage.
- The `reason` string is logged and may later feed memory (e.g. "this session frequently sees background TV audio") for longer-term tuning.

**v1:** global threshold bump (all signals dampened equally).
**v2** (only if logs show false-wake clustering): per-signal-channel dampening — e.g. dampen the audio-derived signal weight specifically when noise is the recurring false trigger.

# When using apps
Certain apps may override normal engagement behavior, if they don't require direct AI interaction.

# Avatar Display

Adjust the avatar display to make this distinction more intuitive. Use axolotl-cave, axolotl-cave-rest, axolotl-cave-sleep when in Silent Mode. axolotl-rest has been added to account for resting mode, continue to use emotional states and sleep accordingly when not in Silent Mode. No visual difference between Assist Mode and Interactive Mode.

Use "rest" sprites while starting a new session (we will create new images later, so separate this from actual resting state).
