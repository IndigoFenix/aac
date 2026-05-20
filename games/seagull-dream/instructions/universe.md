# Universe Generator

The game should generate galaxies, stars, and planets based on real science. (The universe will contain an infinite number of galaxies, but we won't be generating them in any particular structure).

The game uses a scale model - meters are meters.

## Generator rules

Systems should account for factors like age, metallicity, and frequency of nearby supernovas ("galactic habitable zone"), based on their position in the galaxy. When a system generates, it should know things like its age and mass, determine the size and color of the star, then generate types of planets and their distances according to expected rules of stable planetary orbits. Planets should be generated based on temperature, presence of gas, and available elements.

## Core principle for celestial body generation - Phase transitions, not discrete

A gas giant is just a rocky planet with a thick atmosphere. A star is just a gas giant big enough to initiate nuclear fusion. Instead of having discrete classes, we want everything to represent a phase transition between various regimes.

Some body properties to keep in mind:
- Mass
- Radius
- Atmospheric density at different heights
- Atmospheric color
- Cloud altitude, shape and color
- Mountain height and distribution
- Luminosity + Star Color (for stars)
- Ground color (for planets)