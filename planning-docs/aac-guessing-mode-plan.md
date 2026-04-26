# AAC Guessing Mode improvements

We have a feature that allows the AI to enter a "guessing mode" to try and figure out what the student is thinking of by asking a series of questions and offering options, like 20 questions but less restrictive.

The problem: Gemini doesn't seem very good at this kind of behavior. It often jumps straight to guessing final answers, and simple prompt engineering doesn't seem to help.
So let's try to create a system to improve it.

This system should NOT override the AI's button creation, it should only guide it. The AI should still be able to use context to improve its guesses. Our goal is to offer suggestions to improve its narrowing-down logic, not to hard-code the entire logic tree.

Broad planning:
- The guessing mode assistant should sit either on the frontend, or as a static system on the backend. I would suggest frontend since it takes processing pressure off the backend and doesn't contain anything that needs to be on the backend.
- When in guessing mode, in addition to creating "final guesses", the AI should also be able to create "suggested" buttons, with predefined keys. These buttons interact with the guessing mode assistant, which uses its internal logic to create more suggestions.
- The guessing mode assistant should store previous selections made during that guessing mode. But we also need to account for mistakes. A fuzzy logic system rather than a hard-coded tree is best.
- We need to be careful with the questions, and not make them rely on knowledge a child wouldn't know. For example, "animal, vegetable or mineral" is a common question in these kind of games, but a child probably won't know what most things are made of.
- Consideration: How deep should the hard-coded logic go? We want a balance - the AI needs suggestions to help it, but its contextual knowledge can do a lot of the heavy lifting once a concept has been sufficiently narrowed down. We don't need to include every concept in the world.
- Consideration: Should we allow the AI to generate suggested buttons in the same way it generates other buttons and flag them with the suggestion key, or should we have it just replace the button definition with a code like "suggestion:big" and have the frontend generate the whole thing based on predefined rules stored on the frontend (this includes translation keys and premade images)? The former lets the AI be more creative, but the latter offers more control over icons and may also save tokens. The answer likely depends on how deep the guessing mode assistant becomes.
- Either way, we should create a system to ensure the AI doesn't provide invalid button keys.

This task will take 3 steps:
1. Come up with the broad mechanics of the system (how does the fuzzy logic work)
2. Design the categories and their rules, informed by step 1
3. Implement the system

We may switch between steps 1 and 2 as we come up with additional ideas.

---

# Design outcome

## Core mechanic: feature-vector narrowing with fuzzy weights

- State lives on the frontend (AAC client). The server remains stateless about guessing mode beyond the existing enter/exit flags.
- Each selection applies a soft multiplicative update to a small set of dimensions. Weights never fully eliminate — "unknown" is always preserved to tolerate misclicks.
- Top-level categories (Things / Actions / People / Places / Feelings / Time) act as a **mode switch**, not a dimension. Each category has its own pool of dimensions.
- Dimensions are held in a **pool with applicability rules**: some are always eligible within a category, some activate only when a prior dimension has a dominant value (e.g. `animal_habitat` applies when `kind=animal` is dominant).
- The frontend assistant suggests the next dimension (highest priority × remaining entropy); the AI is free to override and offer `[GUESS]` buttons at any step.
- "No" and "More" quick-action presses are reused: "No" dismisses the current dimension; "More" flags an expand-same-dimension on the next turn.

## Top-level categories and dimensions

### Things
- `kind` (categorical): animal, food, toy, clothes, tool, vehicle, screen, nature
- `size` (binary): big, small
- `real_or_imagined` (ternary): real_thing, from_a_show_or_game, both
- `where` (categorical): at_home, at_school, outside, somewhere_i_go
- `what_i_do` (categorical): eat, play, wear, use, watch, hold

Sub-dimensions activated by `kind`:
- `kind=animal` → `animal_habitat` (pet_at_home, farm, wild, in_water, flies, from_a_show), `animal_behavior` (cuddly, fast, noisy, slow)
- `kind=food` → `food_when_eaten` (breakfast, lunch, dinner, snack, treat), `food_temp` (hot, cold), `food_taste` (sweet, salty, sour, savory)
- `kind=toy` → `toy_form` (physical, video_game, app, from_a_show), `play_style` (alone, with_someone, both)
- `kind=vehicle` → `vehicle_domain` (land, water, air, space), `real_or_imagined`
- `kind=screen` → `screen_medium` (show, movie, video_game, app, youtube), `screen_subject` (a_character, a_place, a_thing_in_it)
- `kind=clothes` → `clothes_body_part` (top, bottom, feet, hands, head), `clothes_when` (everyday, special, weather)
- `kind=tool` → `tool_purpose` (draw_or_write, eat, clean, fix, help_me_move)
- `kind=nature` → `nature_kind` (plant, weather, water, sky, ground)

### Actions
- `who` (categorical): me, someone_else, together
- `body` (categorical): hands, whole_body, mouth_voice, eyes, still
- `where` (categorical): here, somewhere_i_go, on_screen
- `pace` (binary): active, calm

Sub-dimensions:
- `where=on_screen` → `screen_content` (game, video, app)

### People
- `relationship` (categorical): family, friend, helper, new_person
- `presence` (binary): here_now, not_here
- Once relationship + presence narrow enough, assistant transitions to face-contact buttons directly, bypassing further fuzzy narrowing.

### Places
- `inside_outside` (binary): inside, outside
- `distance` (categorical): at_home, short_trip, long_trip, somewhere_i_go
- `activity` (categorical): eat_there, play_there, learn_there, rest_there, shop_there, get_help

Sub-dimensions:
- `distance=at_home` → `home_room` (kitchen, bedroom, bathroom, living_room)
- `distance=at_school` (school is folded into short_trip/at_home depending on student) → `school_area` (classroom, playground, lunchroom)

### Feelings
- `valence` (ternary): good, bad, mixed
- `source` (binary, optional / suggested only): body_feeling, heart_feeling
- `intensity` (binary): strong, small
- `focus` (binary): about_something, just_a_mood

### Time
Flat presentation, no fuzzy narrowing: now, earlier_today, yesterday, long_ago, soon, later, bedtime, mealtime, school_time.

## Memory-driven dimensions

At session init, the frontend receives a list of the student's known special interests from the monitor agent's memory (e.g. `["pokemon","trains","bluey"]`). For each interest, a high-priority dimension is dynamically registered (e.g. `is_it_a_pokemon` with values `yes_pokemon`, `not_pokemon`, applicable inside `things`). The AI generates the actual per-item guess buttons from its contextual knowledge once the interest branch is confirmed — hardcoded tree remains shallow (scaffolding only, not content).

## Data structures

```ts
type DimensionType = "categorical" | "binary" | "ternary";
type GuessingCategory = "things" | "actions" | "people" | "places" | "feelings" | "time";

interface DimensionState {
  weights: Record<string, number>;    // value → weight, always includes "unknown"
  dismissed?: boolean;                  // user pressed "No" while this dim was being asked
  lastPressedTurn?: number;
}

interface GuessingModeState {
  category: GuessingCategory | null;
  dimensions: Record<string, DimensionState>;
  history: Array<{ turn: number; key: string }>;
  specialInterests: string[];
  turnCount: number;
}

interface DimensionDef {
  id: string;
  category: GuessingCategory;
  type: DimensionType;
  values: string[];
  priority: number;                              // higher = asked sooner
  applicableWhen?: (s: GuessingModeState) => boolean;
}
```

## Update semantics

On press of `suggestion:<dim>:<value>`:
- **categorical**: pressed value × 2.0, other values × 0.7, `unknown` unchanged.
- **binary**: pressed × 2.0, opposite × 0.5, `unknown` unchanged.
- **ternary**: pressed × 2.0, others × 0.7, `unknown` unchanged.

`unknown` never decays, which is what preserves mistake tolerance — a conflicting later press relaxes an earlier belief rather than fighting it to elimination.

On `No` during a suggestion board: mark the current suggested dimension `dismissed = true`. It won't be suggested again this session.

On `More` during a suggestion board: flag the next injection to tell the AI to expand values in the same dimension.

## Next-dimension selection

```
candidates = dimensions in current category
           where not dismissed
           where applicableWhen(state) is true (if present)
           where dimension is not already confident

score = priority * (1 - normalizedEntropy)
next  = candidates sorted by score desc, take first
```

`isConfident(dim)` = dominant weight > 2× next highest AND > 1.5× `unknown`. Tune after testing.

Readiness for final guesses: `readyForGuesses = true` when ≥ 2 confident dimensions OR ≥ 5 total presses. Surfaced in the injection; AI decides whether to actually guess.

## `[GUESSING STATE]` injection format

Sent as a context injection before each suggestion-board rebuild. ~150 tokens.

```
[GUESSING STATE]
Category: things
Known: kind=animal (strong), size=big (moderate)
Unknown: real_or_imagined, animal_habitat, what_i_do, where
Suggested next dimension: animal_habitat
  Offer these suggestion keys as buttons:
    suggestion:animal_habitat:pet_at_home
    suggestion:animal_habitat:farm
    suggestion:animal_habitat:wild
    suggestion:animal_habitat:in_water
    suggestion:animal_habitat:flies
    suggestion:animal_habitat:from_a_show
Ready for guesses: no (still broad)
Student's known interests: dinosaurs, trains
Presses so far: 2 — kind:animal, size:big

You may also offer [GUESS] buttons at any time, or pick a different dimension if you have a reason to.
```

## Button format and parsing

- AI emits suggestion buttons as bare keys with no pipes: `suggestion:<dim>:<value>`.
- `parseBoardButtons` in `server/services/dual-agent/interactive-agent.ts` gains a branch: if a segment matches `suggestion:<dim>:<value>`, mark `buttonType: "suggestion"` with attached `{ dimension, value }`.
- Frontend renders suggestion buttons from a `SUGGESTION_REGISTRY` keyed by `<dim>:<value>` — label (t-key), icon, image_key, sentence all frontend-owned.
- `[GUESS]` buttons remain free-form (existing mechanism).
- Invalid suggestion keys: logged + skipped silently on frontend. Open question whether to echo a `[SYSTEM]` correction back to the AI.

## Entry / exit

- **Entry**: existing `[GUESSING MODE]` path at `server/services/dual-agent/live-relay.ts:847`. Client creates a fresh `GuessingModeState`, fetches special-interests list from monitor memory, injects initial `[GUESSING STATE]` with `category: null` so the AI offers top-level category buttons (`suggestion:category:things` etc).
- **Category select**: `suggestion:category:<value>` press sets `state.category`, triggers new injection.
- **Exit**: `[GUESS]` confirmed OR `rebuild_board` contains no `[GUESS]` and no `suggestion:*` entries (broadening of the existing exit check at `live-relay.ts:1697`).

## File layout (planned)

- `client-aac/src/services/guessing-mode/state.ts` — `GuessingModeState`, `applyPress`, `suggestNextDimension`, `buildStateInjection`
- `client-aac/src/services/guessing-mode/dimensions.ts` — `DIMENSIONS` registry
- `client-aac/src/services/guessing-mode/suggestion-registry.ts` — per-key label (t-key), icon, image_key, sentence
- `client-aac/src/contexts/DualAgentContext.tsx` — owns the state instance, pushes `guessing_state` WS messages on change
- `server/services/dual-agent/live-relay.ts` — relays `guessing_state` messages as `[GUESSING STATE]` context injection, broadens exit check
- `server/services/dual-agent/interactive-agent.ts` — parser branch for `suggestion:*` keys
- `server/services/memory-schema/aac-memory-schema.ts` — simplified guessing-mode prompt section (delegates narrowing to the state injection)

## Open items deferred to implementation

1. Weight decay over time (per-turn drift toward 1.0) — left out; revisit if needed.
2. Whether `suggestion:category:*` or a separate `category:*` prefix for top-level category buttons. Leaning toward `suggestion:category:*` for parser consistency.
3. Confidence threshold constants to tune after testing.
4. Whether to surface invalid-key ignores back to the AI as a `[SYSTEM]` correction.
5. Translation keys — deferred to implementation pass; all suggestion labels need entries across 11 i18n files.

# RETHINKING SUGGESTIONS:

Let's think in terms of more abstraction, and nesting existing branching structures together into subquestions. A guess doesn't have to be the FINAL answer - it can be the answer to a subquestion.

For example, "thinking of a place" can be just the place - but the same system that lets us find a place can also be used to find things like "where is this object found", and "thinking of an action" can also be used to find "what does this animal do". 

In addition, certain qualities, like "real or imaginary" or "toy" are very broad and can help the AI narrow down a final answer, but their impact on category suggestion is relatively minimal, because real and imaginary things have a lot in common, and a toy can be almost anything.

Feelings are interesting here, because one can feel a certain way about an action or thing - or they may be thinking about the thing having a feeling.

Universal:

For things:
    Size: Compared to hand/Compared to body (compared to finger / compared to house)
        Smaller - Same size - Bigger
    Color
    Sensory attributes:
        hard soft
        wet dry
        hairy
        sticky
        bumpy
        smooth
        sharp
        sandy
        mushy
        liquid
        gas
        hot / warm / cold
    Where is it found?
        At home
            In the bedroom
            In the kitchen
            In the living room
            In the bathroom
            In the closet
            ...
        At school
        In the city
        Outside in nature (natural_places)
            In Water
            In Sky
            In Plains/Grass
            In Forest/Jungle
            In Mountains
            In Desert
            In Snow
            Underground
        Somewhere far away
    Where do you know about it?
        Seen it in real life
        On a screen
        In a book

    For food/drink:
        Taste: sweet / salty / sour / plain
        Temperature: hot / warm / cold
        Texture: crunchy / soft / liquid

    body_parts
        Head
        Chest/Heart
        Belly
        Arm
        Legs
        Eye
        Nose
        Mouth
        Ear

    For clothes:
        Where is it worn?
            body_parts
    
    Feeling
        Happy
        Sad
        Angry
        Afraid
        Hurt
            -> Where does it hurt?
            body_parts
            -> How much?
            pain_scale
    
    For animals:
        Where does it live
            At home
            On a farm
            In the city
            In the zoo
            ...natural_places
        How does it feel
            Furry
            Feathers
            Scales
            Shell
            Skin
        What does it eat
            Meat
            Plants
            Fish
            Bugs
            Many things

For actions:
    fast or slow?
    alone or with others?
    inside or outside?
    fun or work?
    do you use a tool to do it? (If yes -> Identify tool)