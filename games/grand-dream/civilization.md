# Civilization Simulator

The goal of this system is to create a detailed civilization simulator that allows shifting between scales and is highly mod-friendly.
Main inspirations:

Spore for its grand vision of "play as an individual creature and scales up to controlling an entire civilization".
- But without clean transitions between "eras" - gameplay shifts naturally as the player's focus expands or constricts.
- The player can accumulate party members as an individual, like a classical RPG adventuring party. These members expand into a tribe as they grow and create buildings, and a tribe becomes a civilization once the population grows to a level that individual tracking becomes unfeasable.
Victoria has a great model for large-scale civilization and economic production. But it doesn't have models for "breakaway" or downscaling.
Dwarf Fortress generates histfigs from pops, which allows it to "zoom". Individual rulers can influence the actions of their civilizations, which makes for great stories. If the player becomes a ruler, they can control that civilization.
- It also contains mechanics for breakaway ideologies by having histfigs be influenced by other civilizations they interact with. Values and personality traits are civilization or species-defined, but individuals may vary from their civilization's norm.
- This breakaway mechanism might not be as accurate as it could be.
Oregon Trail as an additional game mode focusing on traveling from one point to another, teaching resource management within a confined framework.

Mod-friendly: Abstract as many technologies and mechanics as possible. Opt to define objects (specific cultures, government systems, resources, technologies) by what they do, rather than what they are, whenever possible.
The system should be flexible as far as tile shapes are concerned. (World shapes, including flat grids, hex grids, and spherical planets, are intended to be different options.)

I have also packaged an existing system for modeling growth and spread of traits within a civilization (political parties, ideologies, access to technologies, natural disasters, etc.), PopuSim. This system is highly optimized for large numbers and might be handy.

Another thing to look for is to see how much of this system can be made idle-safe (see sandbox-game). Some mechanics will naturally be idle-unsafe, but when possible, let's aim to create a system that also works in idle-safe mode by removing these mechanics, even if it must sacrifice accuracy.