# Space Trader

A game about exploring space, collecting resources, avoiding dangers and evaluating trade deals.
Uses eyegaze detection, mouse or touch to direct the ship. (Ship slowly moves toward point, rotating towards the destination.)
Playing field is infinite in all directions, screen follows the ship.

Arrows surrounding the ship show nearby points of interest that are out of range. The closer the point, the nearer the arrows are.

- Hover near asteroids to break them apart over time and collect their resources (no collision)
- Traders want either want a number of rocks, or specific items (shapes), displayed as a thought bubble. Hover near them to make the trade if you have the item they want.
- Some traders have an item and ask for a different item - the player must give them what they want in exchange for what they have. Item they have is stored in a bubble attached to the ship.
- Pirates (red) try to steal your rocks and items. They prioritize the highest-value item you have. Intended as punishment for carrying too many unnecessary items at once.
- Items you are carrying trail behind the ship.

Resources:
- Gray rocks (low-value, accumulate many)
- Blue shapes (mid-value)
- Purple shapes (high-value)
- Yellow star (collect it to win)
- Green Shields (each shield protects you from one pirate attack - when the pirate touches you, the shield pops, and the pirate runs away)

Asteroids are broken down over time, giving you rocks.
Some asteroids have a shape on them, indicating an item is inside - these are collected when the asteroid is destroyed.
High-value items are more rare. At higher difficulties, the only way to find higher value items is to trade for them.

Shapes:
    Circles
    Triangles
    Squares

Evaluation and difficulty levels:
- Simply collect rocks and trade them for the win condition.
- Blue shapes can be found in asteroids or from traders. One trader trades the blue shapes for the win.
- Blue and gold shapes can be found in asteroids, but gold ones are more rare. A trader wants a gold shape for the win.
- Gradually reduce the ability to find shapes in asteroids, forcing the player to trade for them.

- Always make sure it is possible to complete the final trade if the player seeks out all points of interest (generate traders as puzzles). Evaluate what the player knows (which traders they have encountered), and determine if they are prioritizing high-value items and items that they know they need, or if they are just collecting items and making trades at random.
- The more items the player carries, the more pirates spawn.
- Pirates prioritize high-value items over low-value ones. The more items the player carries, the harder they are to avoid.
- Occasionally generate "bad trades" with traders who trade blue shapes for gold ones, or rocks. Evaluate whether the player takes these bad trades without a clear reason (if they don't know that they are necessary).
- Occasionally generate situations where bad trades are necessary - where the only way to collect the right item is to trade down.
- Shields should not be considered to have an absolute value for evaluations, but examine if the player tends to prioritize them.
- The more expertise the player demonstrates, the harder the game becomes (longer trade sequences, more frequent trade-downs required, more frequent bad trades.)

# Improvements

## Smooth movement of items
Items (rocks and shapes) should not move instantly from position to position, but should be always be rendered as sliding smoothly. To fix this, items should have a previous position that is separate from their real position (the same as they are currently, following the player), and a move timer. Items should be rendered at a position between their previous position and their real position, determined by the current move timer. This position should start slow, be fast in the middle, and slow at the end to simulate acceleration and braking into position. (The acceleration should be faster than the braking.)

Newly collected items should be closer to the ship than old ones - when a new item is collected, each old item should move down one step to make room.

## Trader animation and rendering
The traders should display as simple faces - two circles for eyes, and a mouth.
Add an additional pair of circles to represent hands, and show the item they are offering held in their hands.
The item they want should appear in the speech bubble. The speech bubble should pop up as the player approaches (the distance should be generous).
Their faces and hands should move around slightly as though they are looking toward the player. If the player comes too close without the item they want, they should pull their item toward them protectively, moving their hands closer together.
During a trade, the items should be swapped, then the trader should smile, then disappear with a circular ripple effect.

## Asteroid size
Asteroid size should correspond to the number of rocks that remain.

## Pirate behavior change
Avoidance is difficult with eyegaze controls since the player naturally focuses on the object they're trying to avoid. Instead, let's have the pirates aim to be sneaky, and be driven off by player confrontation.
Each pirate starts with a morale value. If the player ship is facing them, they start to back off (the closer the direction is to their direction, and the closer the player is, the stronger the effect). 
Their direction should adjust to try and circle around and approach the player from behind - if they are aiming for a particular item (trailing behind the player), they should approach it, not the player themselves. 
The longer the player focuses on them, the more their morale drops and the more distance they will try to put between the player and themselves, and when it drops to zero, they flee. The higher the level is, and the more items the player is carrying, the more aggressive and harder to drive off they become.

## "Warp" level transition
Don't make a popup upon getting the star - instead, add a transition cutscene where the star moves over the player, then the player warp-speeds off-screen, the background and all objects fade out, and then a new area fades in as they come in from the other side of the screen. This should also increment the level by 1.

# Improvements 2

- The items trail too far behind the player, and too close together. Try this - create a series of invisible points behind the player, representing the item locations. Each one moves toward the one in front of it if its distance to that point is more than a designated value. The items themselves, when carried by the player, have a point representing their location. When a new item is gained, each item shifts to the next point in the train, and a new point is created at the position of the last one. There should always be one more point than there are items; that way when they are pushed back, the last item in the row can move to a logical position.

Once an item reaches its designated position, it should "lock" to it - the tweening effect only lasts as long as the position switch.

- Warp transition is too fast and jarring - it should slowly accelerate and decelerate, with the star-streaks lengthening, moving, and shortening in the same way.

- The pirate directionality is off, they're moving sideways. Instead of having them move in a set direction, have their direction rotate toward the direction they want to go, and accelerate forward (similar to how the player moves). When they take an item, it should also be visibly dragging behind them. They should always be fast enough to keep the player from crashing into them if they are moving toward them.

## Better radar indicator

To make it clear which objects are indicated by the radar, the radar icons should remain visible even when the object they represent is on-screen, disappearing only when the actual object's distance from the player is almost at the same distance as their radar icon is drawn. The radar indicators should fade in and out as well.

Once a trader has been encountered, the item it has should appear on its radar indicator.

## Better trade sequence spawning rules

### Cluster Spawning

Traders should spawn in clusters. Each cluster contains one star and represents a "puzzle" to get the star.

In early levels, clusters are tighter together. Later on, they are larger, requiring the player to remember where the one they need is.

The border of a cluster is invisible and circular.

Clusters are generated and cleared as a group. They despawn if the player travels too far away and may spawn a little bit outside the player's radar range in the direction they are moving.

Clusters should not overlap, but their borders may be close together.

Traders should not spawn too close together (before spawning, check, and if it's too close, wait a bit and then pick a different location).

If the player loses an item, wait a few seconds and respawn the trader who gave it to them at a new location. Don't clear traders from memory unless their cluster despawns. If the cluster despawned already, the item can be lost without concern.

Traders should prefer to spawn outside of the player's vision, but if they spawn close to the player they should fade in with an inwards-ripple effect.

### Trader generation within a cluster

To generate a puzzle, start with the star trader, then generate other traders, making sure that there is at least one path that lets the player trade up to it. The higher the level is, the longer the trading sequences can be, and the more rare the needed shapes are.

If a trader wants a blue shape or rocks, and is offering a blue shape, they will always accept any purple shape instead. This should be shown as a second speech bubble under the first that appears only if the player does not have the requested item, but does have a purple shape.

Remove the asteroids containing shapes and trade-down traders (all traders are willing to trade down)

Each cluster has a different puzzle type:

Level 0: Just a single star trader who wants rocks
Level 1: The star trader wants a blue shape, all nearby traders have that shape and trade it for rocks. Each cluster only has one shape.
Level 2: The star trader wants a blue shape, all nearby traders have different shapes which they trade for rocks, some have the correct shape.
Level 3: The star trader wants a blue shape, traders with the correct shape want a different shape that can be traded for rocks
4 and up -> The star trader always wants a purple shape, puzzle clusters become more complex. Use a "complexity budget" that increases each level.
- Purple shape traders are always rarer than blue shapes
- Typical trade sequences are rocks -> blue shape -> purple shape -> star. On higher levels, more steps may be needed. (each step increases complexity)
- Sometimes a trader may offer a blue shape in exchange for a shape that isn't in the cluster. The only way to get this shape is to give it a purple shape. Getting this shape may be necessary in order to get the purple shape that the star trader actually wants. (increased complexity)
Example: A cluster has only the following trades: 
    Rocks -> Blue Square
    Blue square -> Purple Circle
    Blue triangle -> Purple Square
    Purple square -> Star
    So a purple circle -> blue triangle trade is necessary
- Traders seeking multiple shapes (increased complexity)

Make sure that a path to the star always exists within a cluster.
There should be multiple traders offering the same trade within a cluster.