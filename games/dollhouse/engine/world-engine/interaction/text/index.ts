// shared/world-engine/interaction/text/index.ts
//
// THE TEXT-MODE PROJECTION, public surface. Everything here is pure over a
// `WorldState` + a `RenderIntent` + the presenter pushes a host made — no React,
// no DOM, no games-bridge. The boot (shared/world-engine/headless/) and the CLI
// (scripts/world-text.ts) import from this barrel and nothing deeper.
//
// Design: planning-docs/games/world-engine/text-mode.md.

export * from "./types.js";
export { renderEcho, renderComment, renderEvent, renderEvents, renderFrame } from "./render.js";
export { parseCommand, joinTarget, TEXT_COMMANDS } from "./parse.js";
export {
  diffBubbles,
  speakerOf,
  EMPTY_BUBBLES,
  type BubbleMark,
  type BubbleSnapshot,
  type BubbleDiff,
  type DiffBubblesOpts,
} from "./speech.js";
export {
  boardEvents,
  closeBoardEvent,
  chromeOf,
  findBoardOption,
  findChrome,
  textBoardOptions,
  type BoardEventOpts,
} from "./board.js";
export {
  visibleSubjects,
  inViewSet,
  spaceOf,
  bandOf,
  speciesHead,
  speciesWord,
  objectHead,
  carriedBy,
  cardinalFrom,
  wordFor,
  indefiniteArticle,
  buildingsWithOpenDoor,
  PLACE_HEAD,
  POINT_ATTRIBUTION_R,
  type VisibilityOpts,
} from "./visibility.js";
export {
  createSceneIndex,
  slug,
  type SceneIndex,
  type SceneIndexDeps,
  type SceneResolution,
} from "./scene-index.js";
export {
  summarizeScene,
  summarizePlaces,
  isNotablePlace,
  rankOf,
  RANK_CONVERSATION,
  RANK_WATCHED,
  RANK_KNOWN,
  RANK_DISTINCT,
  RANK_OCCUPIED,
  RANK_ADJACENT,
  RANK_CROWD,
  type SceneGroup,
  type SceneSummary,
  type SummarizeOpts,
  type PlaceGroup,
  type PlaceSummary,
  type SummarizePlacesOpts,
} from "./summarize.js";
export { createTextModeSession } from "./session.js";
