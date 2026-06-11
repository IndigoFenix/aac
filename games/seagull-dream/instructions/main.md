# Seagull Dream

A 3D open sandbox game, designed for eyegaze (no clicking needed, only mouse movements). Player flies around and explores a vast open universe.

- Everything is based on a seed.
- Whenever possible, when creating objects, use soft transition regimes rather than hard boundaries. Everything should be scalable, to increase the feeling of a "natural" environment.
- Performance on weak hardware is a priority, but we also want the experience to feel good - the aesthetic should be "a real world that just happens to look like a low-poly game". Use fading tricks often to prevent the effect of objects "snapping" into existence.

## Plans - grown by default, configurable specifics

This will be used as the foundation for the 3-D game generator, so while everything evolves from a seed (the default if, for instance, the user wants to create "a forest", "a galaxy", "a city"), they can also construct specific maps and objects for game purposes.
- Emphasis should be placed on functionality over configurability. "It just works, unless the user requests something that logically shouldn't."

## Tuneables and Readouts

All tuneable constants should be added to the debug menus for refinement.