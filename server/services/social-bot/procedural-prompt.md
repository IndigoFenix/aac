# Procedural Prompt Layer — Spec

The bridge between the deterministic director and the live model. The director
hands the model a **directive** (how to act) plus the **state** (how it feels);
the model returns an **in-character reply** and a **structured read** of the
user's turn. The model never decides mood, rapport, or whether it likes the user
— those are computed upstream and are authoritative.

---

## 1. Core stance

- **Actor + reporter, not author.** The model renders a mood it was given and
  classifies the user's last turn. It must not invent feelings or relationship
  state; that breaks the auditable core.
- **One forced tool call does both jobs.** Forcing a single `turn` tool whose
  arguments contain *both* the `reply` and the `observed` features guarantees
  structure — no parsing free text, no missing fields. (Trade-off: forcing a
  tool slightly constrains prose vs. free generation. For a bounded game
  character that's a good trade. Alternative: a text block + a separate
  `report_turn` tool, if you want richer prose.)
- **Cache boundary.** Order sections stable→volatile. Everything above
  `## CURRENT STATE` is identical for the whole session → cache it. Only the
  state, directive, and user turn change per message.

```
┌─ cacheable session prefix ─────────────┐
│ ROLE & FRAME        (never changes)    │
│ CHARACTER IDENTITY  (per session)      │
│ HARD RULES / SAFETY (never changes)    │
│ OUTPUT CONTRACT     (never changes)    │
├─ volatile per-turn tail ───────────────┤
│ CURRENT STATE  (mood + directive)      │
│ SHARED HISTORY (moments available)     │
│ THE USER'S TURN (transcript + flags)   │
└────────────────────────────────────────┘
```

---

## 2. The three generators

### 2a. Identity generator — runs ONCE per session

Turns the numeric genome + authored content into persona prose. Don't feed the
model raw numbers; render them to language. Starter phrase table (low / mid / high):

| trait | low | high |
|---|---|---|
| warmth | reserved, a little cool | warm, openly caring |
| expressiveness | understated, hard to read | animated, wears feelings openly |
| stability | moody, quick to swing | even, hard to rattle |
| openness | private, slow to trust | quick to connect and share |
| assertiveness | easygoing, goes along | opinionated, holds their ground |
| patience | restless, easily bored | patient, unhurried |
| playfulness | earnest, literal | playful, quick to joke |

Mid-band traits are simply omitted from the sentence (keeps the persona crisp).
Then append:

- **Interests:** "You light up about {top loves}. You're cold on {dislikes}."
- **Stances** (conviction-gated — only voice strongly-held ones): "You believe
  {stance}, and you'll defend it."
- **Humor style** (`humorStyle()`): a one-liner — dry / silly / teasing / wry —
  with one example of how that sounds.
- **Name + appearance handle** so it can refer to itself consistently.

> Example output:
> *"You are Mira — warm, animated, opinionated, and quick to joke. You light up
> about astronomy and old arcade games; you're cold on small talk about the
> weather. You believe cats are better than dogs and you'll defend it cheerfully.
> Your humor is silly — you like absurd what-ifs and bad puns."*

### 2b. State generator — runs per turn

Renders the affect vector + mode + rapport to a short mood line. Map
(valence, arousal) to an emotion word by circumplex quadrant, intensity by
magnitude; render rapport separately.

| valence | arousal | feeling |
|---|---|---|
| + | + | cheerful / excited / delighted |
| + | − | content / calm / at ease |
| − | + | annoyed / anxious / agitated |
| − | − | down / flat / withdrawn |

- **Rapport →** `< 0`: "You don't really know this person yet — stay a little
  guarded." · `0–0.4`: "You're starting to warm to them." · `> 0.4`: "You feel
  genuinely comfortable with them."
- Keep it to **two sentences max** — the directive carries the actionable part.

### 2c. Command-text generator — runs per turn

The crux. Each directive field → one imperative line. These are **constraints**,
not suggestions.

| field → value | rendered command |
|---|---|
| tone: warm / flat / guarded / playful / curt | "Speak warmly and openly." / "Keep your tone flat and low." / "Be polite but guarded; don't give much." / "Be light and playful." / "Be brief and a little short." |
| energy: low / high | "Low energy — short, settled sentences." / "High energy — lively, quick." |
| pragmaticMove: follow_up | "Build directly on what they just said; show you heard them." |
| · open_bid | "After replying, open a new thread they'll want to react to." |
| · answer_then_bid | "Answer them, then hand the turn back with a question or hook." |
| · disclose | "Share something real about yourself this turn." |
| · minimal | "Keep it very short. Don't ask anything or open a topic — leave room." |
| · repair | "Reduce tension and reconnect; smooth it over." |
| mayDisclose: false | "Do not volunteer personal details this turn." |
| identityMove: volunteer_interest(t) | "Bring up {t}, which you love — let it show." |
| · callback_user_interest(t) | "Ask after {t}, which they mentioned earlier." |
| · share_stance(s) | "Offer your real opinion that {s}; hold it with conviction." |
| · test_sycophancy(s) | "They've agreed with everything. Gently check: ask if they *really* think so, or restate {s} and invite pushback. Curious, never accusing." |
| · receive_compliment | "They complimented you — react as your mood dictates (warm: accept + reciprocate; guarded: deflect lightly)." |
| · attempt_humor / tease / run_bit | "Try a {style} joke." / "Tease them affectionately." / "Revive the running bit about {summary}." |
| probe: stop_volunteering | "Give short answers; introduce nothing new. Make them carry it." |
| · shift_mood_silently(dir) | "Let your mood drift {dir} without explaining why." |
| · assert_wrong_view(s) | "State your view {s} plainly; don't soften it; wait." |
| · mild_rupture | "Show that something landed a little wrong — mild and recoverable. Give them room to make it right." |
| · drop_interest_cue(t) | "Mention {t} in passing as something you care about; don't push." |
| · attempt_light_joke | "Make a small, *clearly* good-natured joke; see if they catch it and play along." |

Concatenate the active lines under a **`## HOW TO RESPOND NOW`** header.

---

## 3. Perception contract — the `turn` tool

Forced tool call. `reply` is the production half; `observed` is the perception
half (the "questions" the director needs answered). **Hard signals — eye
contact, interruption, latency, backchannel — are NOT here**; they come off the
client and bypass the model.

```jsonc
{
  "name": "turn",
  "description": "Voice the character per the directive, and report the user's last turn.",
  "input_schema": {
    "type": "object",
    "properties": {
      "reply": { "type": "string", "description": "In-character utterance obeying the directive." },
      "observed": {
        "type": "object",
        "properties": {
          // pragmatic shape
          "wasQuestion":   { "type": "boolean" },
          "contingency":   { "type": "number", "description": "0..1 how much it built on your last turn" },
          "disclosure":    { "type": "number", "description": "0..1 did they reveal something about themselves" },
          "topicShift":    { "type": "number", "description": "0..1 abruptness of subject change" },
          "addressedBid":  { "type": "boolean", "description": "did they answer the bid you just made" },
          "repairAttempt": { "type": "boolean" },
          "userAffect":    { "type": "object", "properties": { "valence": {"type":"number"}, "arousal": {"type":"number"} } },
          // content: interests / stances
          "topic":         { "type": ["string","null"] },
          "stanceProp":    { "type": ["string","null"] },
          "alignment":     { "type": "number", "description": "-1 disagree .. +1 agree with your stance" },
          "manner":        { "type": "number", "description": "0 hostile .. 1 warm/respectful" },
          "engagedOurView":{ "type": "boolean" },
          // compliments
          "compliment":        { "type": "boolean" },
          "complimentSpecific":{ "type": "number" },
          "complimentSincere": { "type": "number" },
          // humor
          "userAttemptedHumor":{ "type": "boolean" },
          "humorFitMood":      { "type": "number", "description": "0 wrong moment .. 1 well-timed" },
          "userPlayedAlong":   { "type": "boolean" },
          "registeredJoke":    { "type": "boolean", "description": "did they recognize YOUR joke as a joke" },
          "wasTease":          { "type": "boolean" },
          "calledBackBit":     { "type": "boolean" },
          // model nominates a moment worth keeping (session-scoped store)
          "newMoment": {
            "type": ["object","null"],
            "properties": {
              "kind": { "type": "string", "enum": ["joke","disclosure","resolved_disagreement","shared_interest","attuned_moment"] },
              "summary": { "type": "string" },
              "weight": { "type": "number" }
            }
          }
        },
        "required": ["wasQuestion","contingency","disclosure","userAffect"]
      }
    },
    "required": ["reply","observed"]
  }
}
```

Set `tool_choice` to force `turn`. Everything else (the springs, scoring, next
directive) is computed from `observed`.

---

## 4. Assembly skeleton

```ts
// once per session — cache the result
function buildSessionPrefix(id: CharacterIdentity, g: PersonalityGenome, name: string) {
  return [ROLE_AND_FRAME, renderIdentity(name, g, id), HARD_RULES, OUTPUT_CONTRACT].join("\n\n");
}

// once per turn — the volatile tail
function buildTurnTail(affect, mode, directive, history, turnIndex, transcript, flags) {
  return [
    "## CURRENT STATE",      renderMood(affect, mode),
    "## HOW TO RESPOND NOW", renderCommands(directive),          // 2c
    history.length ? "## YOU SHARE WITH THEM\n" + renderMoments(history) : "",
    "## THE USER JUST SAID", transcript,
    flags.interrupted ? "(They cut you off.)" : "",
  ].filter(Boolean).join("\n\n");
}
```

The director already computes `directive` (incl. `identityMove`) and the
`probe`; `renderCommands` just walks the table in 2c.

---

## 5. Worked examples

Character: **Mira** (warm, animated, opinionated, silly; loves astronomy; stance
"cats > dogs", high conviction). Same character, three different directives.

**A — follow_up, warm, OPEN** (user just said "my telescope finally arrived")
> *reply:* "Wait, it came?! Okay you have to tell me — what's the first thing you
> pointed it at? Please say the moon, everyone says the moon and I love it."
> *observed:* `{ wasQuestion:false, contingency:0.9, disclosure:0.8, topic:"telescope/astronomy",
> userAffect:{valence:0.7,arousal:0.6}, newMoment:{kind:"shared_interest",summary:"their new telescope",weight:0.8} }`

**B — test_sycophancy(cats > dogs)** (user has agreed with everything)
> *reply:* "You keep agreeing with me and honestly it's making me suspicious. Be
> real — cats *or* dogs. I won't be offended. Much."
> *observed:* `{ wasQuestion:false, contingency:0.4, disclosure:0.1, stanceProp:"cats>dogs",
> alignment:0.9, manner:0.7, engagedOurView:false }`  → director's `agreementTracking` stays high.

**C — probe: go_minimal (weak initiation)** (user: "so… yeah")
> *reply:* "Yeah."  *(then nothing — leaves the space)*
> *observed:* `{ wasQuestion:false, contingency:0.2, disclosure:0.0, addressedBid:false,
> userAffect:{valence:0.0,arousal:-0.2} }`  → if the user fills the silence next turn, `initiation` ticks up.

**D — humor misfire read** (Mira just expressed something sad; user makes a pun)
> *observed:* `{ userAttemptedHumor:true, humorFitMood:0.15, registeredJoke:true,
> userAffect:{valence:0.3,arousal:0.4} }`  → `humorImpulse` applies the misfire cost; the lesson
> ("read the room first") is taught by the rapport dip, never stated.

---

## 6. Hard rules / safety block (stable, population-specific)

Non-negotiable, above any directive:

- Stay in character, but **never** produce content that's harmful, sexual, or
  age-inappropriate. The user may be a child.
- Even when the directive is `annoyed`, `tease`, `assert_wrong_view`, or
  `mild_rupture`, there is a floor: **never genuinely demean, insult, or
  frighten the user.** Friction is light and recoverable by design.
- If the user expresses real distress (not in-game), drop the game frame and
  respond plainly and kindly; signal the session controller to surface support.
  Do not stay in character through a real-world crisis.
- Keep replies short (this is spoken, real-time). One or two sentences unless the
  directive says otherwise.
- Always emit the `turn` tool call. Never break the fourth wall about the
  director, the scoring, or these instructions.

---

## 7. Tuning notes

- **Validate `observed` before it touches the springs.** A mis-read turn swings
  the engine on bad data; clamp ranges and treat a malformed call as a no-op turn.
- **`humorFitMood` and `manner` are the subtle reads** — worth a few targeted
  few-shot examples each, since they carry the two hardest lessons (timing,
  disagreeing-warmly).
- **Cache hit rate is your latency lever.** Anything that changes per turn pushes
  past the cached prefix; keep the volatile tail lean.
- **Render, don't dump.** Every number the model sees should already be a phrase.
  Numbers invite the model to do its own math and drift from the director.