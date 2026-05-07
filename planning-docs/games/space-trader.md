# Space Trader

A game about exploring space, collecting resources, avoiding dangers and evaluating trade deals.
Uses eyegaze detection, mouse or touch to direct the ship. (Ship slowly moves toward point, rotating towards the destination.)
Playing field is infinite in all directions, screen follows the ship.

Arrows surrounding the ship show nearby points of interest that are out of range. The closer the point, the nearer the arrows are.

- Hover near asteroids to break them apart over time and collect their resources (no collision)
- Traders want either want a number of rocks, or specific items (shapes), displayed as a thought bubble. Hover near them to make the trade if you have the item they want.
- Some traders have an item and ask for a different item - the player must give them what they want in exchange for what they have. Item they have is stored in a bubble attached to the ship.
- Pirates (red) try to steal your rocks and items. They prioritize the highest-value item you have.
- Items you are carrying trail behind the ship.

Resources:
- Gray rocks (low-value, accumulate many)
- Blue shapes (mid-value)
- Gold shapes (high-value)
- Purple Spiral (collect it to win)
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

## Trader animation and rendering
The trader design concept is nice. Show the item they are offering held in their hands (rendered as circles), and just the item they want in the speech bubble. The speech bubble should pop up as the player approaches (the distance should be generous). Their eyes and hands should move around slightly as though they are tilting toward the player.

## Asteroid size
Asteroid size should correspond to the number of rocks that remain.

## Better