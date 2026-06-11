# Creatures List

A non-exhaustive list of archetypal creatures the engine should eventually be able to recreate. Treat this as guidance and a checklist when designing creature systems. Don't focus on specific features, but rather systems that can replicate them and many more in-between.

- Radial body plans
    - Jellyfish
    - Hydra
    - Anemone
    - Sea urchin
    (We can treat it as basically just a mouth with tentacles around it, like a disembodied octopus mouth)

- Simple bilateral invertebrates
    - Earthworm (Basic round worm)
    - Planarian (Basic flat worm, head shapes)

- Mollusks
    - Clam (bivalve bodyplan)
    - Snail (shell, eyestalks, mouth tentacles, gliding locomotion)
    - Nautilus (shell, mouth tentacles)
    - Squid (mouth tentacles, jet, beak, fins)
    - Octopus (mouth tentacles, jet, beak)
    (Mollusks are asymmetrical anatomically though most of them wind up with overall bilaterally symmetric bodies anyway)

- Arthropods
    - Millipede (long body with many repeating segments - flowing serpentine movement?)
    - Lobster (claws, short and long antennae, pereiopods on thorax, swimmerets on abdomen, tail fan)
        - Crab (flat body, sideways-optimized walking)
        - Isopod (shielded back)
        - Scorpion (enlongated tail with stinger)
        - Trilobite (shielded head, many repeating segments)
        - Sea scorpion (shielded back)
            - Horseshoe crab (maximized and fused shielded back)
        - Spider (distinctive abdomen)
        - Insects (distinctive 3-part body)
            - Grasshopper (jumping legs with knees far above the body)
            - Mantis (raptorial claws used for both locomotion and grasping)
            - Beetles (shelled wings)
                - Stag beetle (mandibles)
                - Rhinoceros beetle (horns)
                - Treehopper (horns overlap with plant system)
            - Dragonfly (long tail, 2 wing sets)
            - Butterfly (joined, paired wings, coiling proboscis)
            - Fly
            - Wasp (narrow waist, stinger)

- Vertebrates
    - Lamprey (round mouth shape)
    - Trout (jaws, pectoral fins, pelvic fins, anal fin, posterior dorsal fin/spines, anterior dorsal fin, vertical caudal fin with upper and lower forks)
    - Anglerfish (long teeth, glowing lure)
    - Shark
    - Stingray (flattened body, flaps for locomotion, stinger at end of tail)
    - Coelacanth (convex caudal tail, pelvic fins placed further up the body)
    - Tiktaalik
    - Salamander (basic tetrapod with splayed-out feet)
    - Frog (jumping legs + detect jumping as default method of moving based on body shape)
    - Snake
    - Basilisk lizard (frill, quadruped while walking and bipedal while running)
    - Dimetrodon (dorsal sail)
    - Parasaurolophus (head crest)
    - Pachycephalosaurus (cranial ring of spikes around central dome)
    - Triceratops (frill, horns)
    - Deinonychus (bipedal dinosaur, single large claw)
    - Pterosaur (membrane attached to finger, additional fingers in center of wing)
    - Ankylosaurus (tail club, spiked carapace)
    - Sauropod (long neck, thick legs)
    - Plesiosaur (flippers)
    - Turtle (hardened shell, able to retract head and limbs)
    - Birds (bipedal, arms oriented backwards with membranes)
        - Penguin (full bipedal, fluffy body covering over limbs)
        - Peacock (long tailfeathers)
        - Chicken (crest)
        - Ostrich
        - Eagle (broad wings)
        - Tern (narrow wings)
        - Parrot (zygodactyl)
    - Mouse
    - Rabbit (long ears, high airtime gait)
    - Ungulates (unguligrade feet)
        - Ram (curled horns)
        - Deer (branching antlers)
        - Cow (straight horns)
    - Lion (mane, high airtime gait)
    - Elephant (trunk, very large ears)
    - Anteater (long snout + tongue, long claws)
    - Kangaroo (long plantigrade feet - more efficient to jump than to walk)
    - Platypus (wide bill, webbed feet, flat tail)
    - Gorilla (forelimbs used for both locomotion and grasping)
    - Human (fully bipedal stance, arms to the sides, opposable thumbs) (high priority due to likelihood of use)

Notes
- Creature builder should focus on phenotype and motor function, but build off of genotype when planning evolutionary pathways. No distinct separation between arthropod and vertebrate bodyplans or mechanics.
    Example: Functionally a scorpion tail behaves like and animates like a vertebrate tail, even though the anus is at the end
- Horns and spikes - Variable spiral and branching growth structures
    - can go pretty much anywhere - might be best to make a dedicated skin-growth system mostly unconnected to general body plan and animation (may be related to defenses though)
    - overlaps with plant structure system for complex structures like branching antlers, treehopper hats, etc
    - can save this for later

# Plan: Everything is a Modified Lobster

The modularity of arthropod body plans makes them great as a foundation for building this system, and lobsters have some of the most complex set of limbs available. We'll use them as a foundation.

2 main body segments: Thorax and Abdomen.
Each segment has an arbitrary number of sub-segments.