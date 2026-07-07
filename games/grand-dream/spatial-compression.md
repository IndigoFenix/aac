# Spatial compression concept

The goal is to be able to model real-world scales and planet-sized maps, but depending on intended gameplay, we might use a variety of "compression" methods to keep the gameplay reasonable.

- Simplification at large scales, complexity at small scales: Start with a large grid that creates rivers, mountains, and oceans, but when zooming in, a single "river" tile might actually resolve as a plain covered with many rivers or a canyon that is much smaller than a single large water tile. River tiles represent the amount of water being moved, not the shape of that water.
- Scaling up interesting areas relative to uninteresting ones: Cities with few houses, farmland compressed relative to cities, space between cities shrinks, distance between planets and stars is compressed.
- Biome intensification: In smaller worlds, rivers spread fertility a smaller distance relative to their size, but provide more of it closer to them. Forests and grasslands still exist and have similar relative size, they are just smaller.