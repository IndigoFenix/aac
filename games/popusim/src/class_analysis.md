# PathoGenic - Class Analysis

This document provides a comprehensive analysis of all classes in the `script.js` file, organized by their primary purpose.

## Overview

The file contains **98 classes** spanning approximately 13,700 lines of JavaScript code. The application appears to be a **disease/trait simulation game** with a built-in scenario editor (WorldBuilder).

---

## 1. CORE/UTILITY CLASSES

These are foundational classes used throughout the application.

| Class | Lines | Description |
|-------|-------|-------------|
| `CookieManager` | 416-450 | Static utility class for managing browser cookies (set, get, remove, check) |
| `Random` | 459-475 | Seeded pseudo-random number generator using linear congruential method |
| `Rect` | 801-849 | Rectangle class with position/dimensions, supports point containment, conversion for drag operations |
| `BWObj` | 1097-1579 | **Base class for all game/world objects**. Handles attribute loading/saving, data serialization, editing state, and parent-child relationships |
| `BArray` | 1635-1705 | Array wrapper with additional utilities (contains, add, remove, iterate) |
| `BColor` | 13588-13651 | Color object with RGBA values, supports hex conversion and inheritance |
| `FPS` | 275-307 | Frame rate tracker for game loop timing |
| `Mouse` | 1707-1756 | Mouse state tracker (position, button states, click detection) |

---

## 2. GAME OBJECT CLASSES

These classes represent the core simulation/game entities.

### 2.1 Main Game Structure

| Class | Lines | Description |
|-------|-------|-------------|
| `System` | 1758-2863 | **Main application controller**. Manages UI panels, canvas, world loading, game controls (play/pause/speed), scenario selection, and coordinates all subsystems |
| `World` | 2864-4316 | **Scenario container**. Holds all traits, vectors, resources, sites, events, phases. Manages game state, date/time, color scheme, and orchestrates the simulation |
| `Site` | 7037-7495 | A location/region in the simulation with its own population, local stockpiles, actions, and trait distributions |

### 2.2 Traits & Syndromes

| Class | Lines | Description |
|-------|-------|-------------|
| `Trait` | 9796-10087 | A characteristic/condition that population units can have (e.g., infected, immune, dead). Defines transmission, progression, production/consumption, and modifiers |
| `TraitClass` | 9788-9793 | Grouping mechanism for traits (appears to be minimal implementation) |
| `Syndrome` | 10250-10698 | A **combination of traits** representing a complete state. Calculates combined effects of all traits for transmission, progression, and resource impacts |
| `SubSyndrome` | 8176-8246 | A sub-state within a syndrome, tracking specific trait combinations |
| `CustomTrait` | 7664-7685 | User-defined trait combinations created via the expression builder |

### 2.3 Population Management

| Class | Lines | Description |
|-------|-------|-------------|
| `Population` | 8393-8721 | A group at a site with a specific syndrome. Handles transmission, progression, production/consumption phases |
| `PopBranch` | 8299-8366 | A population branch representing units with specific traits, manages hierarchical population clusters |
| `PopCluster` | 8371-8392 | A cluster within a population branch, splits population by presence/absence of a trait |
| `Cluster` | 8275-8281 | Trait-level cluster definition |
| `SubPop` | 8247-8252 | Sub-population within a Population, linked to a SubSyndrome |
| `PopStockpileLink` | 8254-8260 | Links a population to a stockpile with a value |
| `PopInit` | 7013-7036 | Defines initial population distributions for scenario setup |
| `Unit` | 8722-8795 | Individual tracked unit (for scenarios that track individual entities) |

### 2.4 Transmission & Progression

| Class | Lines | Description |
|-------|-------|-------------|
| `Vector` | 9326-9349 | A transmission method (e.g., air, water, contact). Defines how traits spread |
| `Transmit` | 9413-9524 | Defines how a trait releases vectors to spread to others |
| `Progress` | 9543-9658 | Defines how traits evolve/progress over time in affected units |
| `Seek` | 9370-9412 | Defines targeting behavior for vectors (which traits they seek) |
| `Shed` | 8157-8175 | A released vector packet with amount, targets, and trait effects |
| `SiteTransmit` | 10209-10249 | Site-specific transmission data |
| `PendingTransmission` | 8013-8020 | Queued transmission awaiting processing |

### 2.5 Syndrome Helpers (Runtime Calculation)

| Class | Lines | Description |
|-------|-------|-------------|
| `SynProgress` | 10088-10121 | Syndrome-specific progress calculation data |
| `SynTransmit` | 10122-10164 | Syndrome-specific transmission calculation data |
| `SynImpact` | 10165-10208 | Syndrome-specific resource impact calculation data |

### 2.6 Modifiers

| Class | Lines | Description |
|-------|-------|-------------|
| `Modifier` | 9659-9708 | **Base class for all modifiers**. Modifies rates based on trait presence |
| `TransmitModifier` | 9709-9725 | Modifies transmission rates |
| `ProgressModifier` | 9726-9742 | Modifies progression rates |
| `InfectModifier` | 9743-9759 | Modifies infection susceptibility |
| `ImpactModifier` | 9760-9768 | Modifies general impacts |
| `ProduceModifier` | 9769-9777 | Modifies resource production |
| `ConsumeModifier` | 9778-9787 | Modifies resource consumption |
| `VectorMod` | 9350-9369 | Vector-level modification data |

### 2.7 Resources & Impacts

| Class | Lines | Description |
|-------|-------|-------------|
| `Resource` | 8796-8844 | A trackable resource (e.g., funding, vaccines, hospital beds) |
| `Stockpile` | 8893-9141 | Actual storage of a resource at a site or globally, tracks value and history |
| `Impact` | 9142-9239 | **Base class for resource effects**. Defines production/consumption |
| `ImpactProduce` | 9240-9255 | Resource production impact |
| `ImpactConsume` | 9256-9274 | Resource consumption impact |

### 2.8 Player Actions & Events

| Class | Lines | Description |
|-------|-------|-------------|
| `PlayerAction` | 6494-7007 | User-controllable action (checkbox, slider, number input). Can trigger transmissions and have resource costs |
| `ActionCost` | 9275-9325 | Resource cost/gain for performing an action |
| `Event` | 7496-7576 | Scripted event with conditions and results. Fires when conditions are met |
| `EventCondition` | 7578-7661 | Condition for an event (comparisons between values) |
| `EventResult` | 7731-8012 | Result of an event firing (modify resources, show news, enable/disable actions, victory/defeat) |
| `EventValue` | 8021-8156 | Value component used in event expressions (can reference traits, resources, constants) |
| `Imply` | 9525-9542 | Implication logic for trait relationships |

### 2.9 Tracking & History

| Class | Lines | Description |
|-------|-------|-------------|
| `Tracker` | 5848-5891 | Tracks a value over time for graphing |
| `TrackerCalc` | 5892-5916 | Calculated tracker (formula-based) |
| `TrackableVariable` | 8865-8892 | A variable that can be tracked and displayed |
| `History` | 5917-6177 | Records historical data for a tracker at a site |
| `HistoryReadout` | 6178-6493 | UI element displaying historical data and current values |
| `CustomMetric` | 7687-7710 | User-defined metric using expression builder |
| `CustomMetricInstance` | 7711-7730 | Instance of a custom metric for a specific site |

### 2.10 Organization & Phases

| Class | Lines | Description |
|-------|-------|-------------|
| `Phase` | 4317-4332 | Named phase for ordering events/transmissions |
| `indexedPhase` | 4333-4345 | Phase with index for ordering |
| `GUIGroup` | 8845-8864 | Groups traits/resources/actions in the UI |
| `Filter` | 4346-4383 | Filters for selecting subsets of data |

---

## 3. INTERFACE/UI CLASSES

These classes handle the user interface and visualization.

### 3.1 Main UI Components

| Class | Lines | Description |
|-------|-------|-------------|
| `PanelsGUI` | 4384-4454 | Manages GUI panel layout and visibility |
| `GUIBox` | 4455-4554 | Individual collapsible box in the GUI for grouping elements |
| `NewsBox` | 5739-5796 | News feed panel showing event messages |
| `NewsItem` | 5797-5847 | Individual news message in the feed |
| `Layer` | 5685-5738 | Rendering layer for canvas operations |

### 3.2 Graph & Visualization

| Class | Lines | Description |
|-------|-------|-------------|
| `Graph` | 4555-4854 | **Main graph display**. Shows trait/resource histories over time with zooming and scrolling |
| `Visualizer` | 4855-4929 | Alternative visualization mode (spatial/network view) |
| `GraphScrollbar` | 5669-5684 | Scrollbar for graph navigation (extends CustomScrollbar) |
| `CustomScrollbar` | 5553-5631 | Reusable scrollbar component |
| `CustomScrollbarHandle` | 5632-5668 | Handle element for scrollbar |

### 3.3 Expression Builders

| Class | Lines | Description |
|-------|-------|-------------|
| `Calculator` | 4980-5322 | Calculator/expression builder UI for creating custom metrics |
| `TraitBuilder` | 4930-4979 | UI for building custom trait combinations |
| `Expression` | 5323-5491 | Mathematical expression parser and evaluator |
| `ExpressionValue` | 5492-5552 | Individual value/operation in an expression |

### 3.4 Canvas & Screen Management

| Class | Lines | Description |
|-------|-------|-------------|
| `MobileCanvas` | 10699-10877 | Base canvas class with touch support |
| `ClickableCanvas` | 10878-11130 | Canvas with click/drag handling (extends MobileCanvas) |
| `TranslateCanvas` | 11131-11195 | Canvas with pan/zoom transformation (extends ClickableCanvas) |
| `Screen` | 11196-11327 | Main rendering screen with room/graph display, flash effects, camera follow (extends ClickableCanvas) |

---

## 4. WORLDBUILDER (EDITOR) CLASSES

These classes provide the scenario editing interface.

### 4.1 Main Editor

| Class | Lines | Description |
|-------|-------|-------------|
| `WorldBuilder` | 11336-11482 | **Main editor controller**. Manages editor panels, world/room/layer editing |
| `BWBObjectEditor` | 11807-12154 | Editor panel for a single BWObj (trait, site, event, etc.). Generates input fields from object attributes |

### 4.2 Input Components

| Class | Lines | Description |
|-------|-------|-------------|
| `BWBInput` | 12155-12298 | Base class for editor input fields (text, number, checkbox, etc.) |
| `BWBCoordInput` | 13273-13312 | Coordinate/point input field (extends BWBInput) |
| `BWBCoordsInput` | 13166-13272 | Multi-coordinate input |
| `BWBColorInput` | 13313-13443 | RGBA color picker input |
| `BWBMultiSelect` | 13444-13565 | Multi-selection input for arrays of references |
| `BWBSpecialObject` | 13153-13165 | Special object input handler |

### 4.3 List Components

| Class | Lines | Description |
|-------|-------|-------------|
| `BListItem` | 12299-12386 | Base list item class |
| `BWBObjectList` | 12387-12702 | List of objects in the editor (traits, sites, etc.). Supports add/remove/reorder |
| `BWBObjectListSelector` | 12703-12866 | Dropdown selector for referencing objects (extends BWBObjectList) |
| `BWBObjectListItem` | 12867-13061 | Individual item in an object list (extends BListItem) |
| `BWBEventList` | 13062-13084 | Specialized list for events (extends BWBObjectList) |
| `BWBEventTypeList` | 13085-13114 | List of event types for selection |
| `BWBEventTypeListItem` | 13115-13152 | Individual event type option |
| `oneTag` | 13566-13585 | Single tag element in a tag input |

---

## 5. STUB/PLACEHOLDER CLASSES

These appear to be incomplete or placeholder implementations.

| Class | Lines | Description |
|-------|-------|-------------|
| `BEvent` | 7008 | Empty class (single line) |
| `BFlowchartNode` | 7010-7011 | Empty class (single line) |

---

## Class Hierarchy Summary

```
BWObj (Base for all data objects)
├── System
├── World
├── Site
├── Trait
├── TraitClass
├── Vector
├── Transmit
├── Progress
├── Seek
├── Impact
│   ├── ImpactProduce
│   └── ImpactConsume
├── Resource
├── PlayerAction
├── ActionCost
├── Event
├── EventCondition
├── EventResult
├── EventValue
├── Modifier
│   ├── TransmitModifier
│   ├── ProgressModifier
│   ├── InfectModifier
│   ├── ImpactModifier
│   ├── ProduceModifier
│   └── ConsumeModifier
├── VectorMod
├── Phase
├── GUIGroup
├── PopInit
├── TrackableVariable
├── CustomTrait
├── CustomMetric
└── BColor

MobileCanvas
└── ClickableCanvas
    ├── TranslateCanvas
    └── Screen

CustomScrollbar
└── GraphScrollbar

BWBObjectList
├── BWBObjectListSelector
└── BWBEventList

BListItem
└── BWBObjectListItem

BWBInput
└── BWBCoordInput
```

---

## Recommended Folder Structure for TypeScript Conversion

```
src/
├── core/
│   ├── BWObj.ts
│   ├── Random.ts
│   ├── Rect.ts
│   ├── BArray.ts
│   ├── BColor.ts
│   ├── Mouse.ts
│   └── utils.ts (helper functions)
├── game/
│   ├── System.ts
│   ├── World.ts
│   ├── Site.ts
│   ├── traits/
│   │   ├── Trait.ts
│   │   ├── TraitClass.ts
│   │   ├── Syndrome.ts
│   │   ├── SubSyndrome.ts
│   │   └── CustomTrait.ts
│   ├── population/
│   │   ├── Population.ts
│   │   ├── PopBranch.ts
│   │   ├── PopCluster.ts
│   │   ├── Cluster.ts
│   │   ├── SubPop.ts
│   │   ├── PopInit.ts
│   │   └── Unit.ts
│   ├── transmission/
│   │   ├── Vector.ts
│   │   ├── Transmit.ts
│   │   ├── Progress.ts
│   │   ├── Seek.ts
│   │   ├── Shed.ts
│   │   ├── SynTransmit.ts
│   │   ├── SynProgress.ts
│   │   └── SynImpact.ts
│   ├── modifiers/
│   │   ├── Modifier.ts
│   │   ├── TransmitModifier.ts
│   │   ├── ProgressModifier.ts
│   │   ├── InfectModifier.ts
│   │   ├── ImpactModifier.ts
│   │   ├── ProduceModifier.ts
│   │   └── ConsumeModifier.ts
│   ├── resources/
│   │   ├── Resource.ts
│   │   ├── Stockpile.ts
│   │   ├── Impact.ts
│   │   ├── ImpactProduce.ts
│   │   └── ImpactConsume.ts
│   ├── actions/
│   │   ├── PlayerAction.ts
│   │   └── ActionCost.ts
│   ├── events/
│   │   ├── Event.ts
│   │   ├── EventCondition.ts
│   │   ├── EventResult.ts
│   │   └── EventValue.ts
│   ├── tracking/
│   │   ├── Tracker.ts
│   │   ├── TrackerCalc.ts
│   │   ├── TrackableVariable.ts
│   │   ├── History.ts
│   │   ├── HistoryReadout.ts
│   │   └── CustomMetric.ts
│   └── organization/
│       ├── Phase.ts
│       ├── GUIGroup.ts
│       └── Filter.ts
├── ui/
│   ├── panels/
│   │   ├── PanelsGUI.ts
│   │   ├── GUIBox.ts
│   │   ├── NewsBox.ts
│   │   └── NewsItem.ts
│   ├── graph/
│   │   ├── Graph.ts
│   │   ├── Visualizer.ts
│   │   ├── GraphScrollbar.ts
│   │   ├── CustomScrollbar.ts
│   │   └── CustomScrollbarHandle.ts
│   ├── canvas/
│   │   ├── MobileCanvas.ts
│   │   ├── ClickableCanvas.ts
│   │   ├── TranslateCanvas.ts
│   │   ├── Screen.ts
│   │   └── Layer.ts
│   └── expression/
│       ├── Calculator.ts
│       ├── TraitBuilder.ts
│       ├── Expression.ts
│       └── ExpressionValue.ts
├── worldbuilder/
│   ├── WorldBuilder.ts
│   ├── BWBObjectEditor.ts
│   ├── inputs/
│   │   ├── BWBInput.ts
│   │   ├── BWBCoordInput.ts
│   │   ├── BWBCoordsInput.ts
│   │   ├── BWBColorInput.ts
│   │   ├── BWBMultiSelect.ts
│   │   └── BWBSpecialObject.ts
│   └── lists/
│       ├── BListItem.ts
│       ├── BWBObjectList.ts
│       ├── BWBObjectListSelector.ts
│       ├── BWBObjectListItem.ts
│       ├── BWBEventList.ts
│       ├── BWBEventTypeList.ts
│       ├── BWBEventTypeListItem.ts
│       └── oneTag.ts
├── types/
│   ├── constants.ts (TYPES_*, OP_*, etc.)
│   ├── interfaces.ts
│   └── enums.ts
└── index.ts
```

---

## Key Dependencies Between Classes

1. **BWObj** is the foundation - almost everything extends or uses it
2. **System** is the main orchestrator - creates World, manages UI
3. **World** contains all game data - traits, sites, resources, events
4. **Syndrome** is computed from **Trait** combinations at runtime
5. **Population** uses **Syndrome** to calculate effects
6. **Site** contains multiple **Population** instances
7. **Graph** visualizes **History** data from **Tracker** objects
8. **WorldBuilder** creates **BWBObjectEditor** instances for each **BWObj**

---

## Notes for Conversion

1. **Global variables** to extract: `cUtil`, `KEY_CODES`, `KEY_STATUS`, `MOUSE_STATUS`, various constants
2. **Helper functions** scattered throughout should be organized into utility modules
3. **Event listeners** use a custom `bindListener`/`removeListeners` pattern
4. **DOM manipulation** uses custom `appendElement`, `addClass`, `removeClass` helpers
5. **Async/await** is used in several places (World.start, Site.initPopulation, etc.)
6. **Canvas rendering** follows a Layer-based architecture
