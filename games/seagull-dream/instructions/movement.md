# Ground Movement Behavior

All values should be constants and represent the boundaries of behavior regimes. Never suddenly change speed or behavior.

## On the ground:

Camara is tilted downwards, aiming at different points on the ground move the bird around. The further the camera moves, the faster the bird walks. Acceleration and deceleration are used, with the "target speed" based on how far away the bird is from the aimpoint. While walking, wings are closed and bird body is tilted upwards at an angle, head facing forwards.

Ground movement should take ground angle into account (moving up/down slopes should not be faster). Extremely steep angles act as a wall.

Fastest running speed before takeoff behavior starts = 15kph. Bird body tilts closer to horizontal the faster you go.

### Running takeoff

Camera begins to slowly tilt behind the bird as you move faster while running. Aiming slightly above the ground while walking = bird continues to walk/run and does not try to take off. Slightly above that = wings unfold and begin flapping, accelerating until reaching takeoff speed (30 kph). In airless worlds (surface air pressure is above rocket regime level), wings do not flap, instead rocket burner starts. Physics before takeoff are otherwise the same.

Running takeoff occurs if the aimed point is at a region at the top of the screen. This region is larger the faster the player is moving. If the aimed point is toward the ground, slow down and return to walking behavior once speed is below 15kph threshold.

### Jumping takeoff

A small region at the top of the screen represents the point where takeoff always occurs, even from a standstill or low speeds. When taking off before the running takeoff begins, pause briefly (250ms) as wings unfold and flap once (or rocket starts), then take off at an angle slightly below perpendicular to the angle of the ground.

Friction applies during this animation - do not completely pause ground movement, but slow down.

If takeoff angle would put the bird upside down (due to being on a steep slope), its body should quickly twist around during this animation, so that it is right-side up on takeoff.

### Close to the ground

When close to the ground, flight should cap at 30kph. "close to the ground" should be determined based on surrounding obstacles, not sea level alone. We must account for nearby mountains. This is a special cap unrelated to atmospheric pressure and is intended to prevent crashing rather than representing physical limitations. The further away from obstacles this is, the more this cap raises. This applies regardless of if the player is using atmospheric or rocket flight.

Close-to-ground friction should be applied gradually while slowing down (don't hard-cap speed).

## Landing and crashing

If the player is close enough to an obstacle (same calculation as obstacle slowdown), legs extend (if legs haven't been added to model yet, add them and put in walking animation).

When hitting the ground, calculate energy of collision based on speed and angle, and landing ability based on how close the angle of the bird is to the angle of the ground (feet are extended towards it).

If angle is good and speed is low, bird lands and goes to running-takeoff behavior.
If angle is bad, bird is stunned briefly - flying and movement stop working and physics (gravity and momentum) take over.
If speed is high, bird bounces. At high enough speed, stunning occurs regardless of angle.

When hitting with high speed, collision kicks up dust (use ground color, without grass).

## Water movement

Physics while swimming should be similar to walking, but model sits slightly below the surface and top running speed before takeoff behavior starts is smaller.

To dive, player must angle straight down. Diving takes a short period while animation plays. It is also possible to dive during a takeoff run.

Underwater, player moves at a constant, low speed. There should be a fog effect while the camera is underwater.

Hitting the water at a steep angle automatically transitions into underwater movement.

# Flight

## Core Goals

The core challenge of flight system design is that the player should move fast enough to reach what they are looking at in reasonable timescales, but also not be moving so fast that they fly past it. This is the case whether they are on the ground, in the air, traveling between planets, or traveling between stars.

Since there is no control outside of eyegaze, all of these factors must be handled automatically, based on current movement and environmental factors.

Flying should feel natural, and avoid any sudden starts or stops.

Flying behavior is divided up into different regimes, which gradually shift between each other based on various factors. Remember that planets may have atmospheres of different densities and heights.

### Atmospheric flight

Actual winged flight limit is 300kph

Friction to slow the player down should be applied gently, more strongly if flying upwards, and more gently if diving (high-speed dives are possible). Also allow "swooping" where momentum is carried when turning upward from a dive in dense atmosphere. All effects should respect atmospheric density and local gravity, except flying upwards, which always caps at the desired constant.

Wing flapping speed should slow down and as wing mode falls off and rocket mode turns on (this should happen at the same time that rocket particles appear). In full rocket mode, wings stop flapping.

### Rocket flight

Rocket flight regime is based on air pressure - when air pressure drops below a certain level, winged flight should decrease and rocket flight should start to take over. Rocket flight carries inertia, but friction is applied generously enough to allow steering on the moon. The higher the player is above the surface, the faster the rockets should go, fading into warp speed as the visual angle of the planet decreases. Once the planet can be seen in its entirety, warp drive has fully taken over.

### Wing and Rocket animation

The player always moves toward the selected direction at the calculated speed. Wing and rocket animations are then determined based on how hard they would need to work to achieve that speed against the forces pulling them back. This is calculated based on lift, atmospheric density, and gravity, and is a single factor (flight strain)

So, for example:
- Flying straight up in Earthlike gravity at ground pressure - fast wingbeats (because gravity is pulling down and no lift from forward movement)
- Flying forward in Earthlike gravity at normal pressure - wings spread, no flapping (gliding, lift counters gravity)
- Diving at full speed - wings folded back (gravity assist)
- Flying forward in thin atmosphere or high gravity - flapping

Whenever wing beats would be extremely fast (due to high gravity or thin atmosphere), instead they start to slow down and rocket particles appear. Rocket particles also represent flight strain in the same way that wingbeats do. The further one goes into rocket mode, the more the wings fold back.

## Warp drive
---Still needs adjustment---

# Gravitational Influence and Atmospheres

Planetary orbital speed should respect the game's universal gravitational constant and the mass and distance of the object it orbits.

Treat all bodies, including stars and moons, as though they have an atmosphere. The more massive a body is, the thicker its atmosphere. Treat atmospheres as having a wind that, at the ground, is rotating at the same speed as the planet. The atmosphere becomes more dense as the player descends into it, and they are pulled along with the planet's movement. Essentially, gradually shift from space flight mode to wing-based atmospheric flight the closer one is to the planet and the higher its gravity. This happens higher up and over more gradual periods with larger bodies.

# Adjustable Parameters for Debug Mode

Create a debug menu with multiple collapsable sections.
Put ALL values related to movement into this debug menu. If there are too many, add more submenus.
Also put a readout, also with multiple collapsible sections, displaying ALL values relevant to determining movement regimes.
The debug menu should be accessible by clicking buttons.