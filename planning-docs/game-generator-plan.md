# AI Game Generator (Custom Apps)

This is a system that allows an AI to define rules for games, intended to be used as teaching tools.
Teachers will be able to provide a prompt inside the clinician client such as "Design a game for teaching X subject", alongside a curriculum, and the AI will generate the entire game.
This system should be flexible, but it can only produce basic, straightforward games with easily-defined rules, to ensure that they remain bug-free without testing.

Games are associated with institutes and can be assigned to students with a many-to-one relationship.
In the database, they should be stored as "custom apps" (we may use the same system to create apps other than games).
Definitions will be stored as JSON objects.

All games are played on a grid, and have a set of definitions stored as a JSON object.
Tiles are square-shaped. Rooms can be any `[width, height]`. Sidebar buttons live outside the room grid.

It should be possible to test custom apps in the Cliniaacian client, though their primary function is in the AAC.

Creation of the game will require a multi-step process: 
- Collecting student data and initial instructions
- Designing the overall game concept
- Building the object classes
- Creating the rooms

When a game starts, the game's instructions are appended to Gemini's system prompt. They are removed when the game is closed.

## Game Properties
- label
- image
- description
- ai_instructions (tells the AI when to run it)
- turn_based (player and AI take turns. Only needed for games where the AI plays an active part. If not turn based and AI can act, AI is allowed to act at any time.)

## Classes
Classes of entities within the game. All properties are optional except id.
- id (unique string, authored)
- types: An array of strings used to match interaction rules
- image: Reference to an image. Images are generated using the same system as the AAC board.
- image_color: Tints the image.
- tile_color: Color of tile
- label: Text used to identify the object
- ai_instructions (visible to the AI, but not to the player)
- ai_hidden (hides entity from the AI. Use for entities that are not important to gameplay to avoid cluttering prompts.)
- size: Number of grid tiles the object occupies (default is [1,1])
- layer: one of `background`, `entity`, `overlay`. Fixed set — no custom layers. Within a layer, `is_tile` entities draw below non-tile entities.
- hidden: Makes entity invisible
- is_tile: Prevents other tiles from occupying the same cell on the same layer. Tiles are drawn below non-tiles within the same layer.
- char: A single character used to represent the entity in the tile grid display. Must be unique across classes — duplicates are flagged as authoring errors at game-load.
- is_solid: Prevents other solid entities from occupying the same space. (tiles may be solid)
- movable: Allows the entity to be moved by the player by clicking once and moving it, or by clicking and dragging
- drop_rules: where a dragged entity can land. An array of allowed positions. Parameters are class ids only.
    adjacent_to(class_id[])
    same_cell(class_id[])
    inside(class_id[])
    If no drop_rules are defined or valid, the entity cannot be dropped.
    Entities can always be dropped back on their original position.
- counters: A list of variable properties that can be incremented or decremented.
    - id
    - label
    - initial (starting value)
    - min
    - max
    Increments clamp to [min, max]. If reject-on-overflow or overflow signals are desired, the author builds them via interactions with counter conditions.
- can_be_contained: Allows the entity to be contained inside other entities designated as containers. Requires drop_rules with an "inside" to actually be placed inside a container.
- contain_size: The space an entity takes up when contained inside another entity. Defaults to 1.
- max_capacity: The amount of material this entity is able to contain. Sum of contained entities' `contain_size` must not exceed this value. Containers can nest. Clicking a container opens a built-in modal inventory grid — this is engine behavior, not authored.
- states: A list of possible states. Each one has an ID. An entity can have one state active at a time. All objects have a _default state.
    - id
    - override_props: a list of properties changed from the entity default whenever its state changes. Only the following fields may be overridden: `image`, `image_color`, `tile_color`, `label`, `hidden`, `is_solid`, `movable`, `char`. Overriding `size`, `interactions`, `drop_rules`, `states`, `counters`, or `layer` is forbidden.
        - prop
        - value
- interactions: A list of interactions between this entity and others.
    - triggers: An object combining one or more events with optional conditions. All fields AND together.
        - events: Array of one or more event descriptors (at least one required):
            - on_moved: Fires on the moved entity when the player or AI moves it. `other` binds to an entity at the destination matching the `other` condition.
            - on_click: Fires on the topmost clicked entity. `other` binds to anything also at that cell matching the `other` condition.
            - on_ai_trigger(instructions): Allows the AI to manually trigger this action (as long as other conditions are valid). Instructions describe when it should do so.
            - on_signal_received(id): Fires when a signal of this id is emitted anywhere in the room.
        - self: Optional match_spec. This entity must match these properties.
        - other: Optional match_spec. If omitted, the interaction doesn't require a second entity. If specified and no matching entity is found, the trigger fails silently. When multiple candidates match, the topmost one is chosen.
    - effects: Array of effects when conditions are met
        - Effect types are:
            change_state(id)
            change_state_other(id)
            emit_signal(id)
            increment_counter_self(id, amount)
            increment_counter_other(id, amount)
            destroy_self
            destroy_other
            transform_self(id) — transforms this entity into a different class. Resets state to _default and resets all counters to their initial values.
            transform_other(id) — same, for the matched other entity.
            set_room(id or _next) — `_next` advances to the next room in declaration order. Advancing past the last room is an authoring error.
            end_turn — ends whoever's turn it currently is. No-op in non-turn-based games.
            end_player_turn — no-op in non-turn-based games.
            end_ai_turn — no-op in non-turn-based games.
            send_ai_instruction(message) — one-shot instruction injected into the AI's next turn, then discarded. For persistent instructions, use room-level `ai_instructions`.
- ai_movable: Allows the AI to move this object (it is still restricted by the drop_rules)
- ai_creatable: Allows the AI to create instances of this object. The AI supplies (class_id, position, optional property overrides from the `ai_creatable_properties` whitelist). The engine validates drop_rules; invalid placements are no-ops and the error is fed back to the AI.
- ai_creatable_properties: When the AI creates an object of this class, it may set these defined properties, overriding the defaults.

match_spec (used in `self` and `other` trigger conditions):
    - position: Position relative to this entity. One of:
        - same_cell
        - adjacent (orthogonally adjacent)
        - inside (the matched entity is contained within this one)
        - contains (this entity is contained within the matched one)
    - class_id: Object class id must match
    - states: The object state id must match one of these
    - types: The object types must match at least one of these
    - required_types: The object types must match all of these
    - forbidden_types: The object types must match none of these
    - counter:
        - id
        - op: greater than / less than / equal to / greater than or equal to / less than or equal to
        - value

Note: `self` match_specs cannot specify `position` or `class_id` (they always refer to this entity).

## Buttons
Buttons that appear in the sidebar.
- label
- image: Reference to an image. Images are generated using the same system as the AAC board.
- image_color: Color of image.
- button_color: Color of button.
- effects: Array of effects. Buttons may use any effect type from the Classes effect list, plus:
    create_entity(class_id, position, optional property overrides)
- enabled_by_default

## Rooms
All gameplay takes place in a Room, which exists on a grid.
Rooms can be of any size
- id
- label
- ai_instructions (visible to the AI, but not to the player)
- size ([width, height])
- default_tile: A single character. Fills any cell in the `tiles` string where the character doesn't match a class's `char`.
- tiles: An optional string that uses newlines and characters to construct the room as a text-based image. Makes it easier for the AI to visualize the room layout and can be used to store room data efficiently. Only entities with a `char` can be placed here. Dimensions of the string must match `size`. Each character maps to the unique class with that `char`.
- entities: An array of entities spawned in the room when it loads. Entities are defined with a class id and position, and in addition can either have a state set, or have any of its overridable properties set (per the `override_props` whitelist), or have per-instance initial counter values set.
- buttons: An array of buttons enabled in this room. Buttons that are enabled by default may be omitted.

## Signals
Signals are room-scoped. A signal emitted in one room is not received by entities in another room.

## AI Integration
The game can interact with the AI as the player plays it. All actions taken by the player are sent to the AI, which can respond accordingly. The AI can speak at any time; ai_instructions should tell it how it should behave.

AI sees, at all times:
- Game-level `ai_instructions`
- Current room's `ai_instructions`

AI sees contextually:
- Class-level `ai_instructions` — only for classes with instances in the current room.
- Interaction-level `ai_instructions` — only when the interaction is being considered (e.g. the AI is evaluating whether to trigger it).

### AI Action Plumbing
- `on_ai_trigger`: The engine exposes a tool call that returns the list of valid (class_id, instance_id) targets. The AI picks one.
- `ai_creatable`: Tool call accepts (class_id, position, property_overrides). Engine validates drop_rules and the overrides whitelist.

## Evaluation Order

1. An event fires — player click, drag-drop move, signal emission, AI tool call, or button press.
2. The engine collects all interactions on the affected entity (or entities, for signals) whose `events` list includes this event.
3. For each candidate interaction, the engine evaluates the `self` conditions, then resolves `other` (topmost matching entity wins).
4. If all conditions pass, effects execute in declaration order.
5. If multiple interactions match on one entity, all fire, in declaration order.
6. Effects that emit signals, change state, or transform entities may cascade. Cascade depth is capped at 32 to prevent infinite loops; exceeding the cap aborts the cascade and logs an authoring error.
7. Turn resolution (turn-based games): player action → all resulting effects resolve fully → if any `end_turn` or `end_player_turn` effect fired during resolution, turn switches to AI → AI acts → `end_turn`/`end_ai_turn` returns control to player.
