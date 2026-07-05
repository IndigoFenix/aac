# TypeScript Conversion Notes

## Conversion Progress - Updated

### Completed Modules

#### types/ - Constants and Interfaces
- `constants.ts` - All TYPES_*, OP_*, VALUE_*, HIST_TYPE, INCDEC etc. as const objects
- `interfaces.ts` - 25+ interfaces (Point2D, AttrDef, etc.)

#### core/ - Foundation Classes (Chunks 01-03)
- `utils.ts` - ~80 utility functions with proper types
- `Rect.ts` - Rectangle with bounds checking
- `Random.ts` - Seeded PRNG
- `FPS.ts` - Frame rate tracker
- `CookieManager.ts` - Cookie utilities
- `BArray.ts` - Generic array wrapper
- `Mouse.ts` - Mouse/touch state tracker
- `BWObj.ts` - Base class for all game objects
- `BColor.ts` - RGBA color class
- `BGateRef.ts` - Gate reference
- `BSoundEvt.ts` - Sound event

#### game/organization/ - Organization Classes (Chunk 06)
- `Phase.ts` - Named phase for ordering
- `IndexedPhase.ts` - Runtime phase with collections
- `Filter.ts` - Trait-based filtering
- `GUIGroup.ts` - UI grouping

#### game/resources/ - Resource System (Chunk 14)
- `Resource.ts` - Trackable resource definition
- `Stockpile.ts` - Resource storage with consumption
- `Impact.ts` - ImpactProduce, ImpactConsume

#### game/transmission/ - Vector/Transmission System (Chunk 15)
- `Vector.ts` - Vector, Seek, VectorMod classes
- `Transmit.ts` - Trait transmission
- `Progress.ts` - Trait progression
- `Modifier.ts` - All modifier types
- `Imply.ts` - Trait implication helper

#### game/traits/ - Trait System (Chunk 16)
- `Trait.ts` - Core trait class with full combo system

#### game/actions/ - Player Actions (Chunk 10)
- `ActionCost.ts` - Resource cost for actions
- `PlayerAction.ts` - Player-controlled actions
- `PopInit.ts` - Initial population definition

#### game/world/ - World Structure (Chunk 11)
- `Site.ts` - Geographic location with populations

#### game/tracking/ - Data Tracking (Chunks 08-09) **NEW**
- `Tracker.ts` - Links trackable objects to history
- `History.ts` - Historical value storage
- `Expression.ts` - Mathematical expression evaluator

#### game/events/ - Event System (Chunk 12) **NEW**
- `Event.ts` - Triggered events with conditions
- `EventCondition.ts` - Condition evaluation
- `EventValue.ts` - Expression values for events
- `EventResult.ts` - Event result actions

#### game/simulation/ - Runtime Simulation (Chunks 13, 17) **NEW**
- `Shed.ts` - Transmission data bundle
- `SynTransmit.ts` - SynTransmit, SynImpact, SiteTransmit classes
- `SubSyndrome.ts` - Trait state combinations
- `Syndrome.ts` - Combined trait effects
- `Population.ts` - Population, SubPop, Unit classes
- `Cluster.ts` - Hierarchical population organization

#### ui/ — Gameplay GUI rebuild (RETIRED legacy port)
The legacy line-by-line port of `panels/`, `scrollbar/`, `news/`, `graph/`,
`canvas/`, `calculator/`, and `worldbuilder/` was retired in favor of a
Preact app under `src/ui/app/`. See `src/ui/GUI_PLAN.md` for the rebuild's
architecture, decisions, and milestones.

The Calculator and WorldBuilder UIs are not part of the gameplay GUI
rebuild — their data flows through the same SimClient bootstrap and they
will be re-introduced as separate efforts.

#### controller/ - Main Controllers (Chunks 04-05)
- `interfaces.ts` - 50+ interfaces for UI and game objects
- `System.ts` - Main game controller
- `World.ts` - Game world orchestrator

### File Count
- **Total TypeScript Files**: 77
- **All files pass strict type checking**
- **All chunks converted**

## Key Patterns Used

### 1. Property Renaming to Avoid Base Class Conflicts
When a subclass needs its own typed version of a property that conflicts with base class:
```typescript
class Event extends BWObj {
    _eventWorld: EventWorldLike;  // Instead of world: WorldLike
}
```

### 2. Local Forward-Declared Interfaces
Each module declares its own minimal interfaces for dependencies:
```typescript
interface EventWorldLike {
    sites: EventSiteLike[];
    addToPhase(obj: unknown, phase: string): { index: number };
}
```

### 3. Type Casting for Cross-Module Calls
```typescript
await result.trigger(site as unknown as Parameters<typeof result.trigger>[0]);
```

### 4. String-based Constants with Types
```typescript
export const OP = {
    ADD: '+',
    SUBTRACT: '-',
} as const;
export type Operator = typeof OP[keyof typeof OP];
```

## File Structure
```
ts-src/
├── types/
│   ├── constants.ts
│   ├── interfaces.ts
│   └── index.ts
├── core/
│   ├── utils.ts, Rect.ts, Random.ts, FPS.ts, Mouse.ts, BArray.ts
│   ├── CookieManager.ts, BColor.ts, BGateRef.ts, BSoundEvt.ts
│   ├── BWObj.ts
│   └── index.ts
├── game/
│   ├── organization/ (Phase, IndexedPhase, Filter, GUIGroup)
│   ├── resources/ (Resource, Stockpile, Impact)
│   ├── transmission/ (Vector, Transmit, Progress, Modifier, Imply)
│   ├── traits/ (Trait)
│   ├── actions/ (ActionCost, PlayerAction, PopInit)
│   ├── world/ (Site)
│   ├── tracking/ (Tracker, History, Expression)
│   ├── events/ (Event, EventCondition, EventValue, EventResult)
│   ├── simulation/ (Shed, SynTransmit, SubSyndrome, Syndrome, Population, Cluster)
│   └── index.ts
├── ui/
│   ├── panels/ (GUIBox, PanelsGUI)
│   ├── scrollbar/ (CustomScrollbar, GraphScrollbar)
│   ├── news/ (NewsBox, NewsItem)
│   ├── graph/ (Graph, Visualizer)
│   ├── calculator/ (Calculator, TraitBuilder)
│   ├── canvas/ (MobileCanvas, ClickableCanvas, TranslateCanvas, Screen)
│   ├── worldbuilder/ (WorldBuilder, BWBObjectEditor, BWBInput, BWBObjectList, etc.)
│   └── index.ts
├── controller/
│   ├── interfaces.ts
│   ├── System.ts
│   ├── World.ts
│   └── index.ts
└── CONVERSION_NOTES.md
```
