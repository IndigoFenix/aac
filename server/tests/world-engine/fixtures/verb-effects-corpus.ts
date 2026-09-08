// THE BYTE-IDENTITY CORPUS for `compileAction` (intent-compile.ts).
//
// Built for the semantic-engine round's migration steps 1-2: the 22-arm per-verb
// switch in `compileBareAction` became an ORDERED DATA TABLE (verb-effects.ts).
// A port like that is only honest if it is *measured*, so this module builds a
// large, DETERMINISTIC corpus of (frame × binder) cases, the golden script
// (`scripts/dev/verb-effects-golden.ts`) runs the compiler over it and freezes
// the answers in `verb-effects-golden.json`, and `verb-effects.test.ts` replays
// the fixture against whatever the compiler is today.
//
// It is a pure module (no fs, no Date, no randomness) so the generator and the
// test build the SAME case list — the `corpusSignature` pins that they do.
//
// Case sources:
//   A. the predicate sweep      — every directive verb × 10 objects × 2 bound
//                                 shapes × 16 binders (both binder families ×
//                                 8 settings of the 7 optional predicates)
//   B. the endpoint sweep       — every directive verb × 6 objects × 12 bound /
//                                 relation shapes × 4 binders
//   C. targeted slices          — phase "stop", quantity, negation, the colour
//                                 modifier strip, company/joint, `use` stations
//   D. the shipped test corpus  — every glyph-sentence literal harvested from
//                                 the nine intent suites, parsed for real by
//                                 `parseSentence` under two classifier contexts

import type { ItemRef, PlaceRef } from "@shared/world-engine/interaction/behavior/rules.js";
import type { IntentBinder } from "@shared/world-engine/interaction/intent/intent-compile.js";
import { defaultBinder } from "@shared/world-engine/interaction/intent/intent-compile.js";
import type { IntentFrame, ParseContext, Ref } from "@shared/world-engine/interaction/intent/parse-intent.js";
import { LEXICON, parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";

// ---------------------------------------------------------------------------
// Canonical serialisation — the comparison currency
// ---------------------------------------------------------------------------

/**
 * A stable string for any compiler output. Keys are SORTED (so key order can
 * never make a false diff) and a key whose value is `undefined` is KEPT and
 * marked — `{kind:"stay", place:undefined}` and `{kind:"stay"}` are different
 * strings here, because the port must reproduce even that.
 */
export function canonical(v: unknown): string {
  if (v === undefined) return "<undefined>";
  if (v === null) return "null";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

/** FNV-1a over a string — a dependency-free drift detector for the case list. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// The world the fake binders know
// ---------------------------------------------------------------------------

const CREATURE_WORDS = new Set(["mara", "bear", "dog", "pip", "child", "farmer"]);
const PLACE_WORDS = new Set([
  "kitchen", "house", "home", "yard", "box", "town", "school", "bin",
  "bedroom", "table", "tree", "shop", "farm",
]);
const HOME_WORDS = new Set(["home"]);

const PLAYER = "child";
const LISTENER = "bear";

/** The seven OPTIONAL binder predicates, in the order the compiler consults them. */
const PREDS = [
  "isCompanion", "isFurniture", "isContainer", "isClothing", "isDevice", "isStructure", "isFeature",
] as const;
type PredName = (typeof PREDS)[number];

/** How a predicate setting answers each of the seven — `null` = the method is ABSENT. */
type PredSetting = Partial<Record<PredName, boolean | null>> | null;

const PRED_SETTINGS: Record<string, PredSetting> = {
  // every optional method absent — the "legacy binder" the compiler documents
  absent: null,
  allFalse: { isCompanion: false, isFurniture: false, isContainer: false, isClothing: false, isDevice: false, isStructure: false, isFeature: false },
  allTrue: { isCompanion: true, isFurniture: true, isContainer: true, isClothing: true, isDevice: true, isStructure: true, isFeature: true },
  device: { isCompanion: false, isFurniture: false, isContainer: false, isClothing: false, isDevice: true, isStructure: false, isFeature: false },
  furnStruct: { isCompanion: false, isFurniture: true, isContainer: false, isClothing: false, isDevice: false, isStructure: true, isFeature: false },
  contCloth: { isCompanion: false, isFurniture: false, isContainer: true, isClothing: true, isDevice: false, isStructure: false, isFeature: false },
  featComp: { isCompanion: true, isFurniture: false, isContainer: false, isClothing: false, isDevice: false, isStructure: false, isFeature: true },
  // `isContainer` is the one predicate with a THREE-valued contract (true /
  // false / null = "assume container"), and put-drop tests it with `=== false`
  // while open-shut tests it for truth — so `null` needs its own setting.
  contNull: { isCompanion: false, isFurniture: false, isContainer: null, isClothing: false, isDevice: false, isStructure: false, isFeature: false },
};

function applyPreds(b: IntentBinder, setting: PredSetting): IntentBinder {
  if (!setting) return b;
  for (const p of PREDS) {
    const v = setting[p];
    if (v === undefined) continue;
    if (p === "isContainer") b.isContainer = () => v as boolean | null;
    else (b as unknown as Record<string, unknown>)[p] = () => v as boolean;
  }
  return b;
}

/** The KIND-BLIND family: every named noun binds as creature AND item AND place. */
function kindBlind(): IntentBinder {
  return defaultBinder({ player: PLAYER, listener: LISTENER, homeSymbols: HOME_WORDS });
}

/** The CLASSIFIER-BACKED family: the three channels are DISJOINT (§3.3). */
function classified(): IntentBinder {
  const base = defaultBinder({ player: PLAYER, listener: LISTENER, homeSymbols: HOME_WORDS });
  return {
    ...base,
    creature(ref?: Ref) {
      if (!ref) return null;
      if (ref.kind === "player") return PLAYER;
      if (ref.kind === "listener") return LISTENER;
      if (ref.kind === "entity") return CREATURE_WORDS.has(ref.symbol) ? ref.symbol : null;
      return null;
    },
    item(ref?: Ref): ItemRef | null {
      if (!ref || ref.kind !== "entity") return null;
      if (CREATURE_WORDS.has(ref.symbol) || PLACE_WORDS.has(ref.symbol)) return null;
      return { match: { kind: ref.symbol, ...(ref.modifiers.length ? { descriptors: ref.modifiers } : {}) } };
    },
    place(ref?: Ref): PlaceRef | null {
      if (!ref) return null;
      if (ref.kind === "player") return { kind: "creature", id: PLAYER };
      if (ref.kind === "listener") return { kind: "creature", id: LISTENER };
      if (ref.kind !== "entity") return null;
      if (HOME_WORDS.has(ref.symbol)) return { kind: "home" };
      return PLACE_WORDS.has(ref.symbol) ? { kind: "named", id: ref.symbol } : null;
    },
  };
}

const FAMILIES: Record<string, () => IntentBinder> = { blind: kindBlind, class: classified };

/** Every binder the corpus uses, keyed `<family>/<predicate setting>`. */
export const BINDERS: Record<string, IntentBinder> = (() => {
  const out: Record<string, IntentBinder> = {};
  for (const [fk, make] of Object.entries(FAMILIES)) {
    for (const [pk, setting] of Object.entries(PRED_SETTINGS)) {
      out[`${fk}/${pk}`] = applyPreds(make(), setting);
    }
  }
  return out;
})();

const ALL_BINDER_KEYS = Object.keys(BINDERS);
/** The four-binder short list sweeps B/C/D use (both families, absent + allTrue). */
const CORE_BINDER_KEYS = ["blind/absent", "blind/allTrue", "class/absent", "class/allTrue"];

// ---------------------------------------------------------------------------
// Frame construction
// ---------------------------------------------------------------------------

export interface CorpusCase {
  /** Stable, human-readable case id (also the drift signature's input). */
  id: string;
  frame: IntentFrame;
  /** Key into `BINDERS`. */
  binder: string;
}

const ent = (symbol: string, modifiers: string[] = []): Ref => ({ kind: "entity", symbol, modifiers });

/** Every DIRECTIVE verb the parser's LEXICON declares — the compiler's whole input alphabet. */
export const DIRECTIVE_VERBS: string[] = Object.entries(LEXICON)
  .filter(([, lex]) => (lex as { cat: string; directive?: boolean }).cat === "verb" && (lex as { directive?: boolean }).directive === true)
  .map(([word]) => word)
  .sort();

/** Objects the predicate sweep tries — one per binder channel plus the tie-breakers. */
const SWEEP_A_OBJECTS: Array<[string, Ref | undefined]> = [
  ["none", undefined],
  ["ball", ent("ball")],
  ["mara", ent("mara")],
  ["kitchen", ent("kitchen")],
  ["food", ent("food")],
  ["oven", ent("oven")],
  ["bed", ent("bed")],
  ["shirt", ent("shirt")],
  ["house", ent("house")],
  ["home", ent("home")],
];

const SWEEP_B_OBJECTS: Array<[string, Ref | undefined]> = [
  ["none", undefined],
  ["ball", ent("ball")],
  ["mara", ent("mara")],
  ["kitchen", ent("kitchen")],
  ["food", ent("food")],
  ["bed", ent("bed")],
];

/** A bound/relation shape — what the parser would have left on the frame. */
interface BoundShape {
  key: string;
  patch: Partial<IntentFrame>;
}

const marked = (relation: string, ref: Ref): Partial<IntentFrame> => ({
  target: ref,
  relation,
  bound: [{ relation, ref }],
});

const BOUND_SHAPES: BoundShape[] = [
  { key: "bare", patch: {} },
  { key: "to-mara", patch: marked("to", ent("mara")) },
  { key: "to-box", patch: marked("to", ent("box")) },
  { key: "from-box", patch: marked("from", ent("box")) },
  { key: "for-mara", patch: marked("for", ent("mara")) },
  { key: "for-house", patch: marked("for", ent("house")) },
  { key: "with-mara", patch: marked("with", ent("mara")) },
  { key: "in-box", patch: marked("in", ent("box")) },
  { key: "on-table", patch: marked("on", ent("table")) },
  { key: "near-tree", patch: marked("near", ent("tree")) },
  // RELATION WITHOUT `bound` — the compiler's `boundRef` fallback arm, which
  // `trade`'s local shadow deliberately does NOT have.
  { key: "rel-to-mara", patch: { target: ent("mara"), relation: "to" } },
  { key: "rel-from-box", patch: { target: ent("box"), relation: "from" } },
];

/** The two shapes sweep A needs (it is spending its budget on binders instead). */
const SWEEP_A_BOUNDS = BOUND_SHAPES.filter((b) => b.key === "bare" || b.key === "to-mara");

function frameOf(verb: string, object: Ref | undefined, patch: Partial<IntentFrame>, extra?: Partial<IntentFrame>): IntentFrame {
  return {
    kind: "command",
    verb,
    ...(object ? { object } : {}),
    ...patch,
    ...extra,
    modifiers: extra?.modifiers ?? [],
    raw: [verb],
  };
}

// ---------------------------------------------------------------------------
// D. the shipped test corpus — glyph sentences harvested from the nine suites
// ---------------------------------------------------------------------------

/**
 * Every glyph-sentence-shaped string literal in `symbol-game-intent-compile`,
 * `-transfer-endpoints`, `-group-activity`, `-carry-verbs`, `-trade-directive`,
 * `-area-directive`, `acquisition-beneficiary`, `rest-goal-speech` and
 * `show-item`. Harvested mechanically (a few non-sentences ride along — they
 * parse to something harmless and are corpus cases like any other).
 */
export const TEST_SENTENCES: string[] = [
  "1", "1 + wood + for + 1 + food", "2", "2 + wood + for + 3 + food", "3",
  "3 + wood + for + 2 + food", "__player__", "all", "apple", "apple7", "area",
  "area + farm", "area + farm + here", "area + here", "area + house + there",
  "at", "avatar", "b1", "b2", "ball", "ball.material_wood", "ball1", "basket",
  "bear", "because", "bed", "beside", "big", "box", "build", "build + ball",
  "build + house", "carry", "carry + ball", "carry + ball + box",
  "carry + ball + to + box", "carry + wood + to + house", "carry + wood + to + yard",
  "chair", "child",
];

/** Sentences whose harvest continues (kept as a second block only for readability). */
const TEST_SENTENCES_2: string[] = [
  "city", "clothes", "color", "color + shirt", "cook", "cook + food", "cup",
  "dog", "doll", "drink", "drink + water", "drop", "drop + ball",
  "drop + ball + in + box", "eat", "eat + apple", "eat + together",
  "eat + with + mara", "empty", "empty + box", "empty + kitchen", "farm",
  "farmers", "fetch", "fight", "fight + tree", "fill", "fill + cup", "food",
  "get", "get + apple", "get + apple + for + mara", "get + apple + from + box",
  "get + apple + from + box + for + mara", "get + ball", "get + ball + for + house",
  "get + wood", "get + wood + for + house", "give", "give + apple",
  "give + apple + to + mara", "give + ball", "give + ball + to + dog",
  "give + wood + to + city", "go", "go + home", "go + kitchen", "go + mara",
  "go + school", "grape_vine", "help", "help + mara", "here", "home", "house",
  "hug", "hug + mara", "i_me", "juice", "kitchen", "make", "make + ball",
  "make + food", "make + house", "mara", "milk", "night", "no", "none", "oven",
  "pick_up", "pick_up + ball", "pip", "plants", "play", "play + together",
  "play + with + mara", "put", "put + apple + in + box", "put + ball + near + tree",
  "put + chair + near + table", "rest", "rest + bed", "return", "return + school",
  "run", "run + home", "school", "share", "share + apple", "share + apple + with + mara",
  "shirt", "show", "show + ball", "show + ball + to + mara", "show + mara",
  "shut", "shut + window", "sit", "sit + chair", "sleep", "sleep + bed",
  "sleep + in + bed", "sleep + with + mara", "stay", "stay + here", "stop",
  "stop + eat", "stop + water", "table", "take", "take + ball", "take + ball + from + dog",
  "take + ball + to + dog", "talk", "talk + mara", "there", "throw", "throw + ball",
  "throw + ball + to + box", "throw + sock", "tidy", "tidy + room", "town",
  "trade", "trade + wood", "trade + wood + for + food", "trade + wood + for + food + with + city",
  "trade + wood + to + city", "trade + wood + with + city", "tree", "two",
  "wait", "wash", "wash + clothes", "wash + cup", "wash + house", "water",
  "we", "we + eat", "we + play", "wear", "wear + shirt", "window", "wood",
  "yard", "you",
];

const PARSE_CONTEXTS: Array<[string, ParseContext]> = [
  ["plain", {}],
  [
    "classified",
    {
      classifyEntity: (symbol: string) =>
        CREATURE_WORDS.has(symbol) ? "creature" : PLACE_WORDS.has(symbol) ? "place" : "item",
    },
  ],
];

function safeParse(sentence: string, ctx: ParseContext): IntentFrame {
  try {
    return parseSentence(sentence, ctx);
  } catch {
    return { kind: "unclear", modifiers: [], raw: [sentence] };
  }
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

export function buildCorpus(): CorpusCase[] {
  const cases: CorpusCase[] = [];
  const push = (id: string, frame: IntentFrame, binder: string): void => {
    cases.push({ id, frame, binder });
  };

  // ---- A. the predicate sweep -------------------------------------------
  for (const v of DIRECTIVE_VERBS) {
    for (const [ok, obj] of SWEEP_A_OBJECTS) {
      for (const b of SWEEP_A_BOUNDS) {
        for (const bk of ALL_BINDER_KEYS) {
          push(`A|${v}|${ok}|${b.key}|${bk}`, frameOf(v, obj, b.patch), bk);
        }
      }
    }
  }

  // ---- B. the endpoint sweep --------------------------------------------
  for (const v of DIRECTIVE_VERBS) {
    for (const [ok, obj] of SWEEP_B_OBJECTS) {
      for (const b of BOUND_SHAPES) {
        for (const bk of CORE_BINDER_KEYS) {
          push(`B|${v}|${ok}|${b.key}|${bk}`, frameOf(v, obj, b.patch), bk);
        }
      }
    }
  }

  // ---- C1. phase "stop" — the universal pre-table intercept --------------
  for (const v of DIRECTIVE_VERBS) {
    for (const [ok, obj] of [["none", undefined], ["ball", ent("ball")]] as Array<[string, Ref | undefined]>) {
      for (const bk of ["blind/allTrue", "class/absent"]) {
        push(`C1|${v}|${ok}|${bk}`, frameOf(v, obj, {}, { phase: "stop" }), bk);
      }
    }
  }

  // ---- C2. quantity — `quantityCap` + `area`'s "none" --------------------
  for (const v of DIRECTIVE_VERBS) {
    for (const q of ["two", "three", "many", "more", "one", "none"]) {
      for (const [ok, obj] of [["none", undefined], ["house", ent("house")], ["farm", ent("farm")]] as Array<[string, Ref | undefined]>) {
        for (const bk of ["blind/absent", "blind/furnStruct"]) {
          push(`C2|${v}|${q}|${ok}|${bk}`, frameOf(v, obj, {}, { quantity: q }), bk);
        }
      }
    }
  }

  // ---- C3. negation ------------------------------------------------------
  for (const v of DIRECTIVE_VERBS) {
    for (const [ok, obj] of [["none", undefined], ["farm", ent("farm")]] as Array<[string, Ref | undefined]>) {
      for (const bk of ["blind/absent", "class/allTrue"]) {
        push(`C3|${v}|${ok}|${bk}`, frameOf(v, obj, {}, { negated: true }), bk);
      }
    }
  }

  // ---- C4. the colour strip ---------------------------------------------
  const COLOUR_OBJECTS: Array<[string, Ref | undefined]> = [
    ["none", undefined],
    ["shirt", ent("shirt")],
    ["shirt.red", ent("shirt", ["color_red"])],
    ["shirt.big.blue", ent("shirt", ["big", "color_blue"])],
    ["mara.red", ent("mara", ["color_red"])],
  ];
  for (const v of ["color", "make", "put", "wash"]) {
    for (const [ok, obj] of COLOUR_OBJECTS) {
      for (const mods of [[], ["color_green"], ["big"]]) {
        for (const bk of CORE_BINDER_KEYS) {
          push(`C4|${v}|${ok}|${mods.join("_") || "none"}|${bk}`, frameOf(v, obj, {}, { modifiers: mods }), bk);
        }
      }
    }
  }

  // ---- C5. company — the `with` marker, `we`, `together` -----------------
  const COMPANY: Array<[string, Partial<IntentFrame>]> = [
    ["solo", {}],
    ["joint", { joint: true }],
    ["weSubject", { subject: { kind: "companions" } }],
    ["withMara", marked("with", ent("mara")) as Partial<IntentFrame>],
    ["withBox", marked("with", ent("box")) as Partial<IntentFrame>],
    ["relWithMara", { target: ent("mara"), relation: "with" }],
  ];
  for (const v of ["eat", "drink", "play", "talk", "sit", "sleep", "rest", "wash", "tidy", "wear", "go", "get"]) {
    for (const [ck, patch] of COMPANY) {
      for (const [ok, obj] of [["none", undefined], ["bed", ent("bed")], ["apple", ent("apple")]] as Array<[string, Ref | undefined]>) {
        for (const bk of ALL_BINDER_KEYS) {
          push(`C5|${v}|${ck}|${ok}|${bk}`, frameOf(v, obj, patch), bk);
        }
      }
    }
  }

  // ---- C6. `use` — the station rewrite + recursion -----------------------
  const STATION_WORDS = [
    "oven", "bed", "chair", "table", "bath", "sink", "toilet", "box", "workbench",
    "tub", "wardrobe", "ball", "mara", "kitchen",
  ];
  for (const w of STATION_WORDS) {
    for (const b of BOUND_SHAPES) {
      for (const bk of CORE_BINDER_KEYS) {
        push(`C6|use|${w}|${b.key}|${bk}`, frameOf("use", ent(w), b.patch), bk);
      }
    }
  }

  // ---- C7. deixis + unresolved refs on every channel ---------------------
  const DEIXIS: Array<[string, Ref]> = [
    ["player", { kind: "player" }],
    ["listener", { kind: "listener" }],
    ["companions", { kind: "companions" }],
    ["group", { kind: "group", role: "farmers" }],
    ["gazeEntity", { kind: "gaze", of: "entity" }],
    ["gazePoint", { kind: "gaze", of: "point" }],
    ["unresolved", { kind: "unresolved", symbol: "widget" }],
  ];
  for (const v of DIRECTIVE_VERBS) {
    for (const [dk, ref] of DEIXIS) {
      for (const bk of ["blind/absent", "class/allTrue"]) {
        push(`C7|${v}|${dk}|${bk}`, frameOf(v, ref, {}), bk);
      }
    }
  }

  // ---- D. the shipped test corpus, parsed for real -----------------------
  const sentences = [...TEST_SENTENCES, ...TEST_SENTENCES_2];
  for (const s of sentences) {
    for (const [ck, ctx] of PARSE_CONTEXTS) {
      const frame = safeParse(s, ctx);
      for (const bk of CORE_BINDER_KEYS) {
        push(`D|${s}|${ck}|${bk}`, frame, bk);
      }
    }
  }

  return cases;
}

/** A drift detector over the CASE LIST (not the answers): if this moves, the fixture is stale. */
export function corpusSignature(cases: CorpusCase[]): string {
  let acc = `${cases.length}`;
  for (const c of cases) acc = fnv1a(`${acc}|${c.id}|${c.binder}|${canonical(c.frame)}`);
  return `${cases.length}:${acc}`;
}

/**
 * The frozen answers. 44k cases collapse to a few hundred DISTINCT compiler
 * outputs, so the file stores the dictionary once and an index per case — a
 * 2 MB literal array becomes ~250 KB with no loss.
 */
export interface GoldenFixture {
  corpusSize: number;
  signature: string;
  /**
   * THE FILE'S OWN HEADER — JSON cannot carry a comment, and a golden fixture
   * that cannot say why it reads the way it does is just a wall of answers.
   * Line 1 is the recording; every line after it is a DELIBERATE RE-BASELINE
   * (date · ruling · how many cases moved), written by the generator
   * (`scripts/dev/verb-effects-golden.ts`, `FIXTURE_NOTE`). A re-record that
   * does not extend this list is an accident, not a decision.
   */
  note?: string[];
  /** The distinct `canonical(compileAction(...))` strings, first-seen order. */
  dict: string[];
  /** One index into `dict` per case, in case order. */
  index: number[];
}

/** `fixture.index` → the canonical output strings, one per case. */
export function goldenOutputs(fixture: GoldenFixture): string[] {
  return fixture.index.map((i) => {
    const s = fixture.dict[i];
    if (s === undefined) throw new Error(`golden fixture: dict index ${i} out of range`);
    return s;
  });
}
