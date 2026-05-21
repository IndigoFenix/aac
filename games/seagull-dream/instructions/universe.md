# Universe Generator

The game should generate galaxies, stars, and planets based on real science. (The universe will contain an infinite number of galaxies, but we won't be generating them in any particular structure).

The game uses a scale model - meters are meters.

## Generator rules

Systems should account for factors like age, metallicity, and frequency of nearby supernovas ("galactic habitable zone"), based on their position in the galaxy. When a system generates, it should know things like its age and mass, determine the size and color of the star, then generate types of planets and their distances according to expected rules of stable planetary orbits. Planets should be generated based on temperature, presence of gas, and available elements.

## Core principle for celestial body generation - Phase transitions, not discrete

A gas giant is just a rocky planet with a thick atmosphere. A star is just a gas giant big enough to initiate nuclear fusion. Instead of having discrete classes, we want everything to represent a phase transition between various regimes.

We also want to use real physics to accurately simulate realistic solar systems. The rule when generating objects is to start with a nebula of particular properties, and then simulate its evolution until the present. All random values should come from the seed.

Some body properties to keep in mind:
- Mass
- Radius
- Temperature (based on distance to star + greenhouse gases)
- Tectonic activity (based on mass, metals, age and proximity to nearby bodies)
- Magnetosphere
- Presence of liquid water (based on ices + temperature)
- Wind (based on temperature and water presence)
- Glaciation level
- Mountain height and distribution (based on mass, age, metals, water, wind)
- Atmospheric density at different heights (based on chemistry + mass + tectonic activity (account for venus-likes with high sulfur))
- Atmospheric color (for planets, based on chemistry)
- Ground color (for planets, based on chemistry, account for sulfur, rusting, hydrocarbons, etc.)
- Banding (for planets with thick atmospheres - add zones and belts based on rotation speed and size)
- Aurorae (related to magnetosphere)
- Luminosity + Star Color (for stars)
- Cloud altitude, shape and color
- Nearby supernovas (sterilize life planets)
- Life presence (based on temperature, water, atmosphere, and tectonic activity, influence atmospheric properties)

The home system has a static template. In order to test whether the physics are accurate, check them against the real solar system - the solar system is an example of something that should be able to form using the rules we devise.