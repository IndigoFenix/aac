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
- Popu

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