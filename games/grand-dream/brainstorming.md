# Grand Dream

The objective is to allow users to create worlds for learning using simple AI prompts.

## Learning Guidance

When converting a curriculum into a game, aim to avoid question-and-answer formats whenever possible. Instead, integrate the knowledge directly into the gameplay.

*Source* - Where, when and how is X found? Allow the player to collect it from there.
*Usage* - What is X used for? An obstacle type should be cleared by using X to do that thing.

Start with items and game elements, then move to story, then move to terrain.

## Conceptual Organization

A game world can be broken up into Sandboxes and Challenges.
Sandboxes are for open exploration.
Challenges are constrained paths that task the player to get from point A to point B.
Either area type can contain any number of nested sub-areas of either type.
Items are tied to the area type they are found or used in.

## Game Elements

### Collectibles
- Found throughout an area
- Can be used to guide exploration
- Can gate an area until the player completes a certain number of challenges
- Default is money
- May also be in the form of crafting material or ammunition

### Keys
- Must be obtained to clear a given obstacle
- May take the form of literal keys, crafting material, tools, or information

### Transport
- Takes player from one point to another directly
- May be train, plane, boat, spaceship, or anything else

### City Building
- Tech trees unlocking new building types
- Global resources
- Spread
- Structures
    - Build cost
    - Build time
    - Move cost
- Zones
- Paths
- Creatures

## Terrain

Terrain is generated based on the story and goals. Use the terrain to restrict the player until they have completed the challenges.

### Spaces

- Areas intended to be explored. Does not force the player in any specific direction.
- May direct the player using paths or visible points of interest.
- Offers freedom

#### Fields
- Default open space

#### Forest
- Constrains movement
- Has paths, but allows leaving them
- May be located by following tree density

#### Seas
- Can only be navigated by water travel

### Bounds

- Contains the player within a portion of the map
- Provides focus

#### Islands
- Can be entered/escaped by swimming or flying
- Bounded by seas

#### Caves
- Can be entered/escaped by finding the opening
- Bounded by walls
- Often found in mountains or holes

#### Holes
- Can be entered/escaped by finding the path
- Bounded by walls

#### Mountains
- Can be entered/escaped by finding the path
- Bounded by chasms
- Tallest mountains can be seen from a distance - ideal destinations within an open space
- Can see other places at a distance from the top. Place other points of interest within view.

### Paths

#### Roads
- Can be traveled on efficiently
- Generally do not force travel

#### Rivers
- Can be traveled on only with water travel, otherwise act as obstacles
- Easier to travel in one direction


# Game Types

- Adventure
- City Builder
- Civilization

- Gathering
- Traveling
- Farming
- Shopkeeper

# Relational Templates

- Sort & Classify (Classify): dwell an item, dwell a bin. Carries an enormous subject range — even/odd/prime, parts of speech, biological taxonomy, chemical groups, recycling/civics, set membership. The single highest density-to-effort template.

- Sequence & Order (Sequence): arrange into correct order. Number lines, alphabetization, historical timelines, story comprehension, the scientific method, musical scales, sorting-algorithm intuition.

- Connect & Map (Connect): two-dwell edges between nodes. Relationships are everywhere, so this is the broadest of all — translation pairs, cause/effect, food webs, circuits, chemical bonds, family trees, grammar agreement, concept maps.

- Flow & Network (Flow): place directional tiles to route resources. Systems thinking, water cycle, electricity, supply/demand, and a sneaky-good intro to programming (conditionals and loops are routing) and to algebra (a flow network is a function machine).

# Game Type Templates

- Cultivate / Farm (the producer anchor): plant, wait, harvest, trade. Teaches time and patience, linear-vs-exponential growth, ecology, probability of yield, basic economics. Slow timers make it eyegaze-perfect.

- Explore / Collect / Quest (the consumer / narrative anchor): gaze-navigate regions, dwell to collect, meet gated challenges. Reading comprehension, map and geography skills, curiosity-driven discovery, inventory categorization. (Navigation and pathfinding fold in here rather than being a separate template — don't split them.)

- Build / Craft / Combine (the transformer): combine components into new things. Combinatorics, chemistry (elements → compounds), language morphology (morphemes → words → sentences), fractions as parts-into-whole, engineering recipes.

- Tend / Balance (signal-driven simulation): keep a system in homeostasis — a creature, an ecosystem, a town, a body. Feedback loops, biology, civics, budgeting. Build this last: it's the one with genuine stability dynamics, i.e. the exact problem the Emergence side is wrestling with (carrying capacity, density-dependent stabilizers, energy-as-Lyapunov). Reuse those lessons rather than rediscovering them.

# Expressive Templates

- Pattern / Rhythm sequencer: a dwell-cell grid. This is your arts coverage — rhythm, melody, scales, visual symmetry — and doubles as math patterns and coding loops. Often the forgotten subject, and a step-sequencer is one of the most eyegaze-native interfaces there is.

- Dialogue / Socratic (LLM-wrapped, dwell-to-choose): branching conversation and open-response validation. This is your SEL, ethics, and language-comprehension coverage, and it's also the narrative wrapper that can frame any of the above. This is where your planned LLM integration (adaptive hinting, response validation) earns its keep.