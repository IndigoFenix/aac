// client/src/components/syntAACx/glyph-builder.tsx
//
// THE CLINICIAN'S "EDIT VISUAL" BUILDER — the HOST, not the chrome.
//
// A clinician composes a board button's visual (a glyph string like
// "i_me+want+💧") here. The chrome it draws — the two measured sidebar columns,
// the modifier band and its five picker rows, the 9×2 grid with its bracketed
// paging, every leaf button — is `@client-shared/builder`, the SAME chrome the
// student's SentenceConstructorBoard draws; the press LAWS are
// `@shared/glyph-builder-ops`, the same ones the student's presses go through.
// That is the whole point of the rework: the two builders produce the same
// output, so one owner draws them and each client injects what differs (i18n,
// its Glyph wrapper, its icon-path resolver, its people sources) through
// `BuilderDepsProvider`. Before it, the two had already drifted — a room word
// stored as a bare emoji, a descriptor pushed BESIDE its head instead of onto
// it, and a whole different vocabulary taxonomy.
//
// What is host-side here, and deliberately NOT in the shared chrome:
//   - a DRAFT. Every press used to write straight through to the button; the
//     modal covers the canvas anyway, so nothing was gained and Cancel was
//     impossible. Done commits, Cancel / Esc / overlay discard.
//   - the IMAGES tab (the student's uploaded custom symbols, an upload form,
//     and a recent-emoji strip) — content the student's board has no business
//     offering.
//   - TENSE toggles ⏪ ⏩ beside ? and ! — stored-glyph authoring wants tense;
//     the child's board deliberately does not expose it.
//   - the ADVANCED glyph-text line. Clinicians paste AI-produced glyphs;
//     nothing else in the app offers that.
//
// What is AAC-only and therefore absent: guessing / Word Finder, the AI strips,
// the call mirror (`data-mirror-id`), the recency memory, and engine `play()` —
// there is no world to execute a composed sentence in from here.
//
// LAZY: `button-inspector` mounts this behind `React.lazy`, so the board editor
// page does not carry the engine surfacer until the dialog is opened.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { apiRequest, apiUrl } from "@/lib/queryClient";
import { useLanguage } from "@/contexts/LanguageContext";
import { useStudentLabel } from "@/hooks/useStudentLabel";
import { Glyph } from "@/components/Glyph";
import {
  defaultImageResolver,
  resolveIconPath,
  registerStudentFace,
} from "@/lib/glyph-images";
import { GlyphCompositor } from "@shared/glyph-compositor.tsx";
import {
  addModifier,
  applyRelationalModifier,
  clearSlot,
  JOINS,
  MAX_SLOTS,
  parseGlyph,
  removeModifier,
  replaceSlot,
  resolveActiveSlot,
  serializeGlyph,
  setToneTags,
  type ParsedGlyph,
  type ToneTag,
} from "@shared/glyph-compositor";
import {
  applyExclusiveModifier,
  applyModifierPress,
  autoComposeSlot,
  canonicalizeForEngine,
  cycleQualityPole,
  pushSlotWithJoin,
  resolveSlotItem,
  slotKeyForSelection,
} from "@shared/glyph-builder-ops";
import {
  colorModifiersFor,
  defaultModeChip,
  emotionModifiersFor,
  gaugeModifiersFor,
  getVocabularyItem,
  listByModeChip,
  listConnectors,
  modifiersFor,
  MODE_CHIPS,
  qualityPairsFor,
  type GlyphCategory,
  type VocabularyItem,
} from "@shared/glyph-registry";
import { resolveEmoji } from "@shared/emoji-registry";
import type { BuilderSurface, BuilderWord } from "@shared/games-bridge";
import {
  ActionButton,
  BuilderDepsProvider,
  BuilderGrid,
  BuilderGridEmpty,
  BuilderSidebar,
  CONTACTS_CHIP_ICON,
  ENGINE_CONTACTS_CHIP,
  EngineWordButton,
  GridButton,
  ImageTile,
  ModifierBand,
  PersonButton,
  pageBuilderGrid,
  sidebarCapacity,
  sidebarPage,
  tabKeyActivate,
  ToneToggle,
  contactChipGlyphs,
  mergeContactTiles,
  orderDirectoryPeople,
  type BuilderRenderDeps,
  type BuilderSidebarEntry,
  type ContactTile,
} from "@client-shared/builder";
import {
  BUILDER_SURFACE_CAPACITY,
  createLocalBuilderBackend,
} from "@client-shared/game/engine-builder";

// ─────────────────────────────────────────────────────────────────────────────
// Constants — the AAC board's own, so the two builders show the same board.
// ─────────────────────────────────────────────────────────────────────────────

/** Legacy registry taxonomy — the FALLBACK when the engine surfacer answers
 *  with nothing, never an override (see SentenceConstructorBoard). */
const TABS: readonly GlyphCategory[] = ["chat", "who", "do", "what", "where", "when"] as const;
const TAB_ICON: Record<GlyphCategory, string> = {
  chat: "💬", who: "👤", do: "🤲", what: "📦", where: "📍", when: "🕐",
};
const CHIP_ICON: Record<string, string> = {
  all: "🔠", people: "👥", animals: "🐾", photos: "📷",
  common: "⭐", hands: "🤲", sensory: "👁️", body: "🧍", social: "💬",
  mental: "💭", relation: "🔁",
  food: "🍎", drink: "🥤", toys: "🧸", clothes: "👕", things: "📦",
  places: "🏠", body_parts: "🖐️", ideas: "💡",
  rooms: "🚪", spatial: "📍",
  quick: "⚡", days: "📅", "time-of-day": "🌅", clock: "🕐",
  routine: "🔁", frequency: "📊",
};

/** Engine category-tab icons (the engine's own fixed ladder); an unknown id —
 *  a game's custom tab — gets 🔤. */
const ENGINE_TAB_ICON: Record<string, string> = {
  things: "📦", person: "👤", verb: "🤲", attribute: "🎨", quantity: "🔢",
  relation: "🔗", question: "❓", connective: "➕", social: "💬",
};
const ENGINE_ALL_TAB_ICON = "⭐";
/** Cap on engine modifier-rail buttons so the band never overflows. */
const ENGINE_MODIFIERS_SHOWN = 5;
/** Registry modifier rail page size. */
const MODIFIERS_PER_PAGE = 5;

/** Icon per SENTENCE-TYPE chip kind. Controls, not words — a plain pictogram,
 *  never a glyph, so they can never be mistaken for sentence content. */
const TYPE_CHIP_ICON: Record<string, string> = {
  request: "🙋", ask: "❓", state: "💬", command: "🤲", rule: "📏", greet: "👋",
};
const TYPE_CHIP_FALLBACK_ICON = "🗨️";

/** The clinician-only Images tab, pinned LAST in the tab column. */
const IMAGES_TAB = "__images";
type ImagesChip = "images" | "upload" | "emoji";
const IMAGES_CHIPS: readonly ImagesChip[] = ["images", "upload", "emoji"];
const IMAGES_CHIP_ICON: Record<ImagesChip, string> = {
  images: "🖼️", upload: "⬆️", emoji: "😀",
};

/** Recent-emoji strip, persisted per browser. */
const RECENT_EMOJI_KEY = "syntaacx_recent_emoji";
const RECENT_EMOJI_CAP = 18;

/** A stable empty list for "no join can be armed right now" — a fresh `[]`
 *  every render would re-run the band's memoised children for nothing. */
const EMPTY_JOIN_OPTIONS: VocabularyItem[] = [];
const EMPTY_MODIFIERS: BuilderWord[] = [];

/**
 * The engine's descriptor axes include words the glyph renderer cannot yet draw
 * as APPLIED modifiers — a key with no `modifier` facet applies invisibly, and a
 * key neither registry knows falls all the way to a meaningless "•" badge. Both
 * read as broken, so they are filtered out of the 🎮 rail until the compositor
 * learns to draw them (the same gate the student's board applies; flip the flag
 * in both places together).
 */
const SHOW_UNRENDERABLE_ENGINE_MODIFIERS = false as boolean;
function engineModifierRenders(key: string): boolean {
  const item = getVocabularyItem(key);
  if (item) return !!item.modifier;
  return !!resolveEmoji(key);
}

/** A custom symbol as `/api/custom-symbols/available/:studentId` returns it.
 *  The endpoint has historically answered as a bare array, `{symbols}` or
 *  `{contacts}`; all three are still tolerated below. */
interface CustomSymbol {
  id: string;
  key: string | null;
  description?: string | null;
}

/** One row of `/api/aac/students/:id/people-directory`. */
interface DirectoryPerson {
  id: string;
  type: "student" | "user" | "contact";
  name: string;
  relationship?: string;
  hasPhoto: boolean;
}

function loadRecentEmoji(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_EMOJI_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((e) => typeof e === "string").slice(0, RECENT_EMOJI_CAP) : [];
  } catch {
    return [];
  }
}

function saveRecentEmoji(list: string[]): void {
  try {
    localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(list.slice(0, RECENT_EMOJI_CAP)));
  } catch {
    /* private mode / quota — the strip is a convenience, never a requirement */
  }
}

export interface GlyphBuilderProps {
  value: string | undefined;
  onChange: (glyph: string) => void;
  studentId: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The dialog shell. The body is a child so that closing UNMOUNTS the draft —
 * re-opening always starts from the button's committed glyph, never from the
 * discarded edits of the last visit.
 */
export function GlyphBuilder(props: GlyphBuilderProps) {
  const { t, isRTL } = useLanguage();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        // Near-full-screen: this is a BOARD, not a form. `p-0`/`gap-0` because
        // the builder owns its own padding, and the dialog's own ✕ is hidden
        // ([&>button]:hidden) — it would land on top of the action row, which
        // carries its own Cancel; Esc and the overlay still close.
        className="max-w-[96vw] w-[96vw] h-[92vh] max-h-[92vh] p-0 gap-0 overflow-hidden flex flex-col [&>button]:hidden"
        dir={isRTL ? "rtl" : "ltr"}
        data-testid="glyph-builder-dialog"
      >
        {/* Radix requires a title for the dialog's accessible name; the visible
            chrome is the builder itself, so it is screen-reader only. */}
        <DialogTitle className="sr-only">{t("button.gbTitle")}</DialogTitle>
        <GlyphBuilderBody
          value={props.value}
          onChange={props.onChange}
          studentId={props.studentId}
          onClose={() => props.onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function GlyphBuilderBody(props: {
  value: string | undefined;
  onChange: (glyph: string) => void;
  studentId: string | undefined;
  onClose: () => void;
}) {
  const { value, onChange, studentId, onClose } = props;
  const { t, isRTL, language } = useLanguage();
  const { ts } = useStudentLabel();

  // ── The draft ─────────────────────────────────────────────────────────────
  const [draft, setDraft] = useState<ParsedGlyph>(() => parseGlyph(value ?? ""));
  const [activeSlot, setActiveSlot] = useState<number | null>(null);
  const [pendingJoin, setPendingJoin] = useState<string | null>(null);

  const serialized = useMemo(() => serializeGlyph(draft), [draft]);
  // THE ENGINE'S view of the same draft. A slot may store a bare emoji
  // (slotKeyForSelection stores 💧 for `water`) and the surfacer only knows
  // registry keys — canonicalizeForEngine spells those heads back out. The RAW
  // `serialized` above stays the value committed and shown in the advanced box.
  const canonicalSerialized = useMemo(() => canonicalizeForEngine(draft), [draft]);
  // Modifiers land on the EXPLICIT selection when there is one, else on the
  // most-recently-placed slot — the same rule the student's board follows, so
  // "banana, then hot" describes the banana on both.
  const effectiveActiveSlot = useMemo(
    () => resolveActiveSlot(draft, activeSlot),
    [draft, activeSlot],
  );

  const commit = useCallback(() => {
    onChange(draft.slots.length === 0 ? "" : serializeGlyph(draft));
    onClose();
  }, [draft, onChange, onClose]);

  // ── Vocabulary: the ENGINE taxonomy, with the registry as the fallback ────
  // Same local backend the student's out-of-game board uses, so a clinician
  // authoring a button sees the board the child will be offered.
  const engineBuilder = useMemo(() => createLocalBuilderBackend({ locale: language }), [language]);
  const [engineSurface, setEngineSurface] = useState<BuilderSurface | null>(null);
  const [engineCategories, setEngineCategories] = useState<string[] | null>(null);
  const engineSeqRef = useRef(0);

  const [engineCategory, setEngineCategory] = useState<string | null>(null);
  const [engineChip, setEngineChip] = useState<string | null>(null);
  const [engineSeedKind, setEngineSeedKind] = useState<string | null>(null);
  const [engineTabPage, setEngineTabPage] = useState(0);
  const [engineChipPage, setEngineChipPage] = useState(0);

  // Registry fallback selection.
  const [activeTab, setActiveTab] = useState<GlyphCategory>("who");
  const [modeChip, setModeChip] = useState<string>(defaultModeChip("who"));
  const [chipPage, setChipPage] = useState(0);

  // Clinician-only Images tab.
  const [imagesTab, setImagesTab] = useState(false);
  const [imagesChip, setImagesChip] = useState<ImagesChip>("images");

  const [gridPage, setGridPage] = useState(0);
  const [modifierPage, setModifierPage] = useState(0);

  // THE MEASURED COLUMN: both sidebars are siblings in the body's `flex h-full`
  // row, so one observer answers for both and the HOST pages against it.
  const [sidebarHeight, setSidebarHeight] = useState(0);
  const handleSidebarMeasure = useCallback((h: number) => {
    setSidebarHeight((prev) => (Math.abs(prev - h) < 1 ? prev : h));
  }, []);
  const sidebarSlots = sidebarCapacity(sidebarHeight);

  /** The engine's [contacts] chip on the person tab — the one grid the engine
   *  cannot fully answer, because the child's own directory is platform data.
   *  Its ENGINE half arrives as ordinary surface buttons; the host merges the
   *  people directory in. */
  const engineContacts = engineCategory === "person" && engineChip === ENGINE_CONTACTS_CHIP;

  // Debounced surface request per composition change. A null answer (error)
  // clears the surface and the whole builder falls back to the registry — it
  // never hangs on the engine.
  useEffect(() => {
    const seq = ++engineSeqRef.current;
    // The selection goes straight through — tab as `category`, chip as `group`.
    // [contacts] used to be a HOST chip that secretly asked for the "things"
    // tab so it could sift persons out of the noun library, which is how pages
    // of animals ended up in front of the child's family; it is an engine group
    // now and needs no twist.
    const category = engineCategory ?? undefined;
    const group = engineChip ?? undefined;
    const timer = setTimeout(() => {
      void engineBuilder
        .requestSurface(canonicalSerialized, category, group, {
          capacity: BUILDER_SURFACE_CAPACITY,
          ...(engineSeedKind ? { seedKind: engineSeedKind } : {}),
        })
        .then((surface) => {
          if (engineSeqRef.current !== seq) return; // stale answer
          setEngineSurface(surface);
          if (surface?.categories?.length) setEngineCategories(surface.categories);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [engineBuilder, engineCategory, engineChip, engineSeedKind, canonicalSerialized]);

  const engineUiActive = engineSurface != null;

  // A game may re-advertise its category set; drop a selection it no longer serves.
  useEffect(() => {
    if (engineCategory && engineCategories && !engineCategories.includes(engineCategory)) {
      setEngineCategory(null);
      setEngineChip(null);
    }
  }, [engineCategories, engineCategory]);

  // ── Sidebar paging ────────────────────────────────────────────────────────
  // The Images tab is pinned and costs a column slot, exactly as the "all" tab
  // and the pager do.
  const engineTabPageView = useMemo(
    () => sidebarPage(engineCategories ?? [], 2, engineTabPage, sidebarSlots),
    [engineCategories, engineTabPage, sidebarSlots],
  );
  const visibleEngineTabs = engineTabPageView.items;
  const engineTabsNeedMore = engineTabPageView.needsMore;

  const engineGroupChips = useMemo(
    () => (engineUiActive ? engineSurface?.groups ?? [] : []),
    [engineUiActive, engineSurface],
  );
  // Only the pinned "all" chip is fixed now — [contacts] is one of the engine's
  // own group chips.
  const engineChipsFixed = 1;
  const engineChipPageView = useMemo(
    () => sidebarPage(engineGroupChips, engineChipsFixed, engineChipPage, sidebarSlots),
    [engineGroupChips, engineChipsFixed, engineChipPage, sidebarSlots],
  );
  const visibleEngineChips = engineChipPageView.items;
  const engineChipsNeedMore = engineChipPageView.needsMore;

  const registryChips = useMemo(
    () =>
      MODE_CHIPS[activeTab].map((chip) => {
        const key = `construction.chips.${chip}`;
        const translated = t(key);
        return { key: chip, label: translated === key ? chip : translated };
      }),
    [activeTab, t],
  );
  const registryChipPageView = useMemo(
    () => sidebarPage(registryChips, 0, chipPage, sidebarSlots),
    [registryChips, chipPage, sidebarSlots],
  );
  const visibleRegistryChips = registryChipPageView.items;
  const registryChipsNeedMore = registryChipPageView.needsMore;

  // ── The people directory (People → [contacts]) ───────────────────────────
  // The SAME endpoint the student's board reads, so the clinician picks from
  // the list the child will see. Faces are registered with the glyph resolver
  // so `face:<id>` draws the photo in the strip AND in the inspector preview
  // once Done has committed it.
  const [people, setPeople] = useState<DirectoryPerson[]>([]);
  useEffect(() => {
    if (!studentId) {
      setPeople([]);
      return;
    }
    let cancelled = false;
    apiRequest("GET", `/api/aac/students/${studentId}/people-directory`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const list: DirectoryPerson[] = Array.isArray(data) ? data : data?.people ?? [];
        setPeople(list);
        for (const p of list) {
          if (p?.id && p.hasPhoto) {
            registerStudentFace(p.id, apiUrl(`/api/aac/students/${studentId}/people/${p.id}/photo`));
          }
        }
      })
      .catch(() => {
        /* the builder still works without the directory — people just aren't
           offered; apiRequest has already surfaced the failure */
      });
    return () => { cancelled = true; };
  }, [studentId]);

  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const getPersonName = useCallback(
    (personId: string) => peopleById.get(personId)?.name ?? null,
    [peopleById],
  );
  const getFaceImage = useCallback(
    (personId: string) => {
      const person = peopleById.get(personId);
      if (!person?.hasPhoto || !studentId) return null;
      return apiUrl(`/api/aac/students/${studentId}/people/${personId}/photo`);
    },
    [peopleById, studentId],
  );

  // THE ORDERING LAW LIVES IN client-shared, because the student's builder
  // shows this same list and the two must not drift. A clinician has no camera,
  // so nothing is ever "present" here and the list is alphabetical.
  const orderedPeople = useMemo(() => orderDirectoryPeople(people), [people]);
  /** The [contacts] chip's own face: the first few real contacts who have a
   *  stored photo, as `face:<id>` glyphs the GlyphTriad draws. */
  const contactFaceGlyphs = useMemo(() => contactChipGlyphs(people), [people]);

  // The engine's OWN half of [contacts]: the surface for group=individuals IS
  // that cluster, so the buttons need no sifting. Out of game the cluster is
  // empty by construction (the spec holds no contacts) and the grid is the
  // directory alone.
  const engineIndividualWords = useMemo(
    () => (engineContacts && engineSurface ? engineSurface.buttons : []),
    [engineContacts, engineSurface],
  );
  type ContactCell = ContactTile<DirectoryPerson, BuilderWord>;
  const contactTiles = useMemo<ContactCell[]>(
    () =>
      mergeContactTiles<DirectoryPerson, BuilderWord>({
        people: orderedPeople,
        engine: engineIndividualWords,
      }),
    [engineIndividualWords, orderedPeople],
  );

  // ── The clinician's own images ────────────────────────────────────────────
  const [symbols, setSymbols] = useState<CustomSymbol[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadFailed, setUploadFailed] = useState(false);
  // Marks an upload as depicting an identifiable person. Person images may be
  // used inside an organization but never in a public package, and their image
  // bytes are access-gated rather than served to any caller.
  // See planning-docs/aac-packages-plan.md §3.
  const [personImage, setPersonImage] = useState(false);

  const loadSymbols = useCallback(() => {
    if (!studentId) {
      setSymbols([]);
      return;
    }
    apiRequest("GET", `/api/custom-symbols/available/${studentId}`)
      .then((r) => r.json())
      // The endpoint has answered as a bare array, `{symbols}` and `{contacts}`
      // across its life; all three are still accepted.
      .then((d) => setSymbols(Array.isArray(d) ? d : d?.symbols ?? d?.contacts ?? []))
      .catch(() => {});
  }, [studentId]);
  useEffect(() => { loadSymbols(); }, [loadSymbols]);

  // Recent emoji — a per-browser convenience, never shared state.
  const [emojiInput, setEmojiInput] = useState("");
  const [recentEmoji, setRecentEmoji] = useState<string[]>(loadRecentEmoji);

  // ── Presses ───────────────────────────────────────────────────────────────
  /**
   * THE ONE INSERTION PATH, routed exactly as the student's board routes it:
   * an explicit selection is REPLACED; otherwise a descriptor composes ONTO the
   * head it describes (`autoComposeSlot`) unless a join is armed — an armed
   * join is an explicit "a new word, linked" and wins; otherwise the key is
   * pushed as a new slot carrying the pending join.
   *
   * `composeKey` is the key the auto-compose rule is tested against (a
   * MODIFIER is stored under its registry key, never the emoji a head would
   * store) — omitted for content the registry knows nothing about.
   */
  const insertKey = useCallback(
    (key: string, composeKey?: string) => {
      setDraft((g) => {
        if (activeSlot != null && activeSlot < g.slots.length) {
          return replaceSlot(g, activeSlot, key);
        }
        if (composeKey && pendingJoin == null) {
          const compose = autoComposeSlot(g, composeKey);
          if (compose != null) return addModifier(g, compose, composeKey);
        }
        return pushSlotWithJoin(g, key, pendingJoin);
      });
      setActiveSlot(null);
      setPendingJoin(null);
    },
    [activeSlot, pendingJoin],
  );

  const handleGridPress = useCallback(
    (item: VocabularyItem) => {
      insertKey(slotKeyForSelection(item), item.key);
      setEngineSeedKind(null);
    },
    [insertKey],
  );

  const handleEngineWordPress = useCallback(
    (word: BuilderWord) => {
      insertKey(word.key, word.key);
      // Back to the DEFAULT view: after any selection the builder shows the
      // engine's ranked surface for the new partial sentence, never a lingering
      // category/group filter — and the sentence-type seed goes with it.
      setEngineCategory(null);
      setEngineChip(null);
      setEngineSeedKind(null);
    },
    [insertKey],
  );

  const handlePersonPress = useCallback(
    (personId: string) => {
      insertKey(`face:${personId}`);
      setEngineCategory(null);
      setEngineChip(null);
      setEngineSeedKind(null);
    },
    [insertKey],
  );

  const handleSymbolPress = useCallback((id: string) => insertKey(`symbol:${id}`), [insertKey]);

  const handleEmojiPress = useCallback(
    (emoji: string) => {
      const trimmed = emoji.trim();
      if (!trimmed) return;
      insertKey(trimmed);
      setRecentEmoji((prev) => {
        const next = [trimmed, ...prev.filter((e) => e !== trimmed)].slice(0, RECENT_EMOJI_CAP);
        saveRecentEmoji(next);
        return next;
      });
    },
    [insertKey],
  );

  const handleSlotPress = useCallback((idx: number | null) => {
    if (idx == null) return;
    setActiveSlot((cur) => (cur === idx ? null : idx));
  }, []);

  const handleClearSelected = useCallback(() => {
    if (activeSlot == null) return;
    setDraft((g) => clearSlot(g, activeSlot));
    setActiveSlot(null);
  }, [activeSlot]);

  const handleBackspace = useCallback(() => {
    setDraft((g) => (g.slots.length === 0 ? g : clearSlot(g, g.slots.length - 1)));
  }, []);

  /** Tone. `?`/`!` are the student's pair; ⏪/⏩ are the clinician's tense
   *  extra, and the two tense poles exclude each other (the compositor draws
   *  ONE tense badge — "past and future" is not a thing to draw). */
  const toggleTone = useCallback((tag: ToneTag) => {
    setDraft((g) => {
      const has = g.toneTags.includes(tag);
      const opposite: ToneTag | null = tag === "past" ? "future" : tag === "future" ? "past" : null;
      const kept = g.toneTags.filter((x) => x !== tag && (opposite == null || x !== opposite));
      return setToneTags(g, has ? kept : [...kept, tag]);
    });
  }, []);

  // ── Modifier band state ───────────────────────────────────────────────────
  const activeItem = useMemo(() => {
    if (effectiveActiveSlot == null) return undefined;
    const slot = draft.slots[effectiveActiveSlot];
    // resolveSlotItem, not getVocabularyItem: a slot may store an emoji.
    return slot ? resolveSlotItem(slot.key) : undefined;
  }, [draft, effectiveActiveSlot]);

  const activeModifierKeys = useMemo(() => {
    if (effectiveActiveSlot == null) return new Set<string>();
    return new Set(draft.slots[effectiveActiveSlot]?.modifiers ?? []);
  }, [draft, effectiveActiveSlot]);

  const allModifiers = useMemo(
    () => (activeItem ? modifiersFor(activeItem.pos) : []),
    [activeItem],
  );
  const modifierItems = useMemo(() => {
    if (allModifiers.length === 0) return allModifiers;
    const start = (modifierPage * MODIFIERS_PER_PAGE) % allModifiers.length;
    return [...allModifiers.slice(start), ...allModifiers.slice(0, start)].slice(0, MODIFIERS_PER_PAGE);
  }, [allModifiers, modifierPage]);
  useEffect(() => { setModifierPage(0); }, [effectiveActiveSlot]);

  const colorOptions = useMemo(() => (activeItem ? colorModifiersFor(activeItem.pos) : []), [activeItem]);
  const emotionOptions = useMemo(() => (activeItem ? emotionModifiersFor(activeItem.pos) : []), [activeItem]);
  const amountOptions = useMemo(() => (activeItem ? gaugeModifiersFor(activeItem.pos) : []), [activeItem]);
  const qualityPairs = useMemo(() => (activeItem ? qualityPairsFor(activeItem.pos) : []), [activeItem]);
  // Only words the compositor actually CONSUMES as joins are armable — with
  // arrow notation off, spatial relations are ordinary slot words.
  const joinOptions = useMemo(() => listConnectors().filter((j) => JOINS.has(j.key)), []);
  const canJoin = draft.slots.length > 0 && draft.slots.length < MAX_SLOTS;

  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [emotionPickerOpen, setEmotionPickerOpen] = useState(false);
  const [amountPickerOpen, setAmountPickerOpen] = useState(false);
  const [qualityPickerOpen, setQualityPickerOpen] = useState(false);
  const [joinPickerOpen, setJoinPickerOpen] = useState(false);
  useEffect(() => { if (colorOptions.length === 0) setColorPickerOpen(false); }, [colorOptions]);
  useEffect(() => { if (emotionOptions.length === 0) setEmotionPickerOpen(false); }, [emotionOptions]);
  useEffect(() => { if (amountOptions.length === 0) setAmountPickerOpen(false); }, [amountOptions]);
  useEffect(() => { if (qualityPairs.length === 0) setQualityPickerOpen(false); }, [qualityPairs]);
  useEffect(() => {
    if (!canJoin) { setJoinPickerOpen(false); setPendingJoin(null); }
  }, [canJoin]);

  const activeKeyOfTransform = useCallback(
    (transform: string): string | null => {
      if (effectiveActiveSlot == null) return null;
      for (const modKey of draft.slots[effectiveActiveSlot]?.modifiers ?? []) {
        if (getVocabularyItem(modKey)?.modifier?.transform === transform) return modKey;
      }
      return null;
    },
    [draft, effectiveActiveSlot],
  );

  const handleModifierPress = useCallback(
    (mod: VocabularyItem) => {
      if (effectiveActiveSlot == null) return;
      // Relational modifiers (next/prev/this) stack, cancel opposites and keep
      // the neutral member axis-exclusive — the pure helper owns all of that.
      if (mod.modifier?.transform === "relational") {
        setDraft((g) => applyRelationalModifier(g, effectiveActiveSlot, mod.key));
        return;
      }
      // A toggle that never leaves two members of one axis on the same head —
      // a thing cannot be hot AND cold, or one AND three.
      setDraft((g) => applyModifierPress(g, effectiveActiveSlot, mod.key));
    },
    [effectiveActiveSlot],
  );

  // Engine rail press. A canonical registry modifier routes through the rail
  // above so it gets the same axis-exclusivity; an engine-only key has no
  // declared conflicts to honour and falls back to a raw toggle.
  const handleEngineModifierPress = useCallback(
    (word: BuilderWord) => {
      if (effectiveActiveSlot == null) return;
      const item = getVocabularyItem(word.key);
      if (item) { handleModifierPress(item); return; }
      setDraft((g) =>
        activeModifierKeys.has(word.key)
          ? removeModifier(g, effectiveActiveSlot, word.key)
          : addModifier(g, effectiveActiveSlot, word.key),
      );
    },
    [effectiveActiveSlot, activeModifierKeys, handleModifierPress],
  );

  const pickExclusive = useCallback(
    (item: VocabularyItem, transform: "color" | "emotion" | "gauge") => {
      if (effectiveActiveSlot == null) return;
      setDraft((g) => applyExclusiveModifier(g, effectiveActiveSlot, item.key, transform));
    },
    [effectiveActiveSlot],
  );

  const handleQualityPress = useCallback(
    (pair: { pos: VocabularyItem; neg: VocabularyItem }) => {
      if (effectiveActiveSlot == null) return;
      setDraft((g) => cycleQualityPole(g, effectiveActiveSlot, pair.pos.key, pair.neg.key));
    },
    [effectiveActiveSlot],
  );

  const handleJoinPick = useCallback((key: string) => {
    setPendingJoin((cur) => (cur === key ? null : key));
    setJoinPickerOpen(false);
  }, []);

  // The engine's rail is computed for the LAST composed word, so it only shows
  // when that word is the active one; an earlier selection gets the registry
  // rail alone.
  const engineModifierItems = useMemo(() => {
    if (effectiveActiveSlot == null || effectiveActiveSlot !== draft.slots.length - 1) {
      return EMPTY_MODIFIERS;
    }
    const rail = engineSurface?.modifiers ?? [];
    const renderable = SHOW_UNRENDERABLE_ENGINE_MODIFIERS
      ? rail
      : rail.filter((w) => engineModifierRenders(w.key));
    return renderable.slice(0, ENGINE_MODIFIERS_SHOWN);
  }, [effectiveActiveSlot, draft.slots.length, engineSurface]);

  // ── Selection handlers ────────────────────────────────────────────────────
  const selectEngineTab = useCallback((category: string | null) => {
    setImagesTab(false);
    setEngineCategory(category);
    setEngineChip(null);
  }, []);
  const selectEngineChip = useCallback((chipId: string | null) => {
    setEngineChip((cur) => (cur === chipId ? null : chipId));
  }, []);
  const selectRegistryTab = useCallback((tab: GlyphCategory) => {
    setImagesTab(false);
    setActiveTab(tab);
    setModeChip(defaultModeChip(tab));
  }, []);
  const selectImagesTab = useCallback(() => setImagesTab(true), []);

  // A different word list is a different page-0.
  useEffect(() => {
    setGridPage(0);
  }, [activeTab, modeChip, engineCategory, engineChip, imagesTab, imagesChip, engineSurface]);
  useEffect(() => { setChipPage(0); }, [activeTab]);

  // ── The two sidebar columns, as DATA ──────────────────────────────────────
  const imagesTabEntry = useMemo<BuilderSidebarEntry>(
    () => ({
      id: IMAGES_TAB,
      label: t("button.gbImages"),
      icon: "🖼️",
      active: imagesTab,
      testId: "gb-tab-images",
      pinned: "trail" as const,
      onPress: selectImagesTab,
      onKeyDown: (e) => tabKeyActivate(e, selectImagesTab),
    }),
    [t, imagesTab, selectImagesTab],
  );

  const engineTabLabel = useCallback(
    (id: string) => {
      const key = `construction.engineTabs.${id}`;
      const translated = t(key);
      return translated === key ? id : translated;
    },
    [t],
  );

  const sidebarTabs = useMemo<BuilderSidebarEntry[]>(() => {
    if (engineUiActive) {
      return [
        {
          id: "all",
          label: engineTabLabel("all"),
          icon: ENGINE_ALL_TAB_ICON,
          active: !imagesTab && engineCategory == null,
          testId: "engine-tab-all",
          pinned: "lead" as const,
          onPress: () => selectEngineTab(null),
        },
        ...visibleEngineTabs.map((cat) => ({
          id: cat,
          label: engineTabLabel(cat),
          icon: ENGINE_TAB_ICON[cat] ?? "🔤",
          active: !imagesTab && cat === engineCategory,
          testId: `engine-tab-${cat}`,
          onPress: () => selectEngineTab(cat),
        })),
        imagesTabEntry,
      ];
    }
    return [
      ...TABS.map((tab) => ({
        id: tab,
        label: t(`construction.tabs.${tab}`),
        icon: TAB_ICON[tab],
        active: !imagesTab && tab === activeTab,
        onPress: () => selectRegistryTab(tab),
        onKeyDown: (e: React.KeyboardEvent) => tabKeyActivate(e, () => selectRegistryTab(tab)),
      })),
      imagesTabEntry,
    ];
  }, [
    engineUiActive, engineTabLabel, engineCategory, visibleEngineTabs, selectEngineTab,
    imagesTab, imagesTabEntry, t, activeTab, selectRegistryTab,
  ]);

  const sidebarChips = useMemo<BuilderSidebarEntry[]>(() => {
    if (imagesTab) {
      return IMAGES_CHIPS.map((chip) => ({
        id: chip,
        label: t(chip === "images" ? "button.gbImages" : chip === "upload" ? "button.gbUpload" : "button.gbEmoji"),
        icon: IMAGES_CHIP_ICON[chip],
        active: imagesChip === chip,
        testId: `gb-chip-${chip}`,
        onPress: () => setImagesChip(chip),
      }));
    }
    if (engineUiActive) {
      return [
        {
          id: "all",
          label: t("construction.chips.all"),
          icon: "🔠",
          active: engineChip == null,
          testId: "engine-chip-all",
          pinned: "lead" as const,
          onPress: () => selectEngineChip(null),
        },
        ...visibleEngineChips.map((chip) => {
          // The chip wears THREE of its members (best examples first,
          // engine-ranked) rather than one word standing in for the whole
          // category; a group that advertises no art at all falls back to 📂.
          //
          // [contacts] is the one chip whose members the ENGINE cannot draw out
          // of game — they are this student's own directory — so its face is
          // the first few real contacts who have a photo, and only if there are
          // none does the engine's own exemplar art show.
          const engineFaces = chip.glyph || chip.glyphs?.length
            ? chip.glyphs ?? (chip.glyph ? [chip.glyph] : [])
            : undefined;
          const faces =
            chip.id === ENGINE_CONTACTS_CHIP && contactFaceGlyphs.length
              ? contactFaceGlyphs
              : engineFaces;
          return {
            id: chip.id,
            label: chip.label,
            glyphs: faces,
            icon: faces ? undefined : chip.id === ENGINE_CONTACTS_CHIP ? CONTACTS_CHIP_ICON : "📂",
            active: chip.id === engineChip,
            testId: `engine-chip-${chip.id}`,
            onPress: () => selectEngineChip(chip.id),
          };
        }),
      ];
    }
    return visibleRegistryChips.map((chip) => ({
      id: chip.key,
      label: chip.label,
      icon: CHIP_ICON[chip.key],
      active: chip.key === modeChip,
      onPress: () => setModeChip(chip.key),
    }));
  }, [
    imagesTab, imagesChip, t, engineUiActive, engineChip, contactFaceGlyphs,
    visibleEngineChips, selectEngineChip, visibleRegistryChips, modeChip,
  ]);

  // ── The main grid's content ───────────────────────────────────────────────
  const registryItems = useMemo(() => listByModeChip(activeTab, modeChip), [activeTab, modeChip]);
  const registryPage = useMemo(() => pageBuilderGrid(registryItems, gridPage), [registryItems, gridPage]);

  const engineWords = useMemo(
    () => (engineUiActive && !engineContacts && engineSurface ? engineSurface.buttons : []),
    [engineUiActive, engineContacts, engineSurface],
  );
  const enginePage = useMemo(() => pageBuilderGrid(engineWords, gridPage), [engineWords, gridPage]);

  const contactsPage = useMemo(() => pageBuilderGrid(contactTiles, gridPage), [contactTiles, gridPage]);
  const symbolPage = useMemo(() => pageBuilderGrid(symbols, gridPage), [symbols, gridPage]);
  const emojiPage = useMemo(() => pageBuilderGrid(recentEmoji, gridPage), [recentEmoji, gridPage]);

  // The legacy taxonomy keeps its own "who → photos" mode chip (that path has
  // no engine to ask).
  const contactsActive = engineUiActive
    ? engineContacts
    : activeTab === "who" && modeChip === "photos";

  const engineTypeChips = useMemo(
    () => (engineUiActive && !imagesTab ? engineSurface?.typeChips ?? [] : []),
    [engineUiActive, imagesTab, engineSurface],
  );
  const engineTypeChipLabel = useCallback(
    (kind: string, engineLabel: string) => {
      const key = `construction.typeChips.${kind}`;
      const translated = t(key);
      return translated === key ? engineLabel : translated;
    },
    [t],
  );

  // ── Advanced: the glyph text ──────────────────────────────────────────────
  // `null` = the line FOLLOWS the draft; a string = the clinician is editing it
  // and the draft follows on commit.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedText, setAdvancedText] = useState<string | null>(null);
  const commitAdvanced = useCallback(() => {
    if (advancedText == null) return;
    setDraft(parseGlyph(advancedText));
    setActiveSlot(null);
    setAdvancedText(null);
  }, [advancedText]);

  // ── Upload ────────────────────────────────────────────────────────────────
  const handleUpload = useCallback(
    async (file: File) => {
      setUploading(true);
      setUploadFailed(false);
      try {
        const form = new FormData();
        form.append("image", file, file.name || "symbol.png");
        if (personImage) form.append("personImage", "true");
        const created = await apiRequest("POST", "/api/custom-symbols", form).then((r) => r.json());
        if (studentId) {
          await apiRequest("POST", `/api/custom-symbols/${created.id}/student-associate`, { studentId })
            .catch(() => {});
        }
        insertKey(`symbol:${created.id}`);
        loadSymbols();
        setImagesChip("images");
      } catch {
        setUploadFailed(true);
      } finally {
        setUploading(false);
      }
    },
    [personImage, studentId, insertKey, loadSymbols],
  );

  // WHAT THIS CLIENT LENDS THE SHARED CHROME: its translator, its reading
  // direction, its Glyph wrapper, its bundled-icon resolver, and its people
  // sources. Nothing below this point knows which client it is drawing for.
  const builderDeps = useMemo<BuilderRenderDeps>(
    () => ({ t, rtl: isRTL, GlyphComponent: Glyph, resolveIconPath, getFaceImage, getPersonName }),
    [t, isRTL, getFaceImage, getPersonName],
  );

  const hasSlots = draft.slots.length > 0;

  return (
    <BuilderDepsProvider value={builderDeps}>
      <div
        // `flex-1 min-h-0` as well as `h-full`: the sidebar's ResizeObserver
        // needs a DEFINITE height to report, and a flex item that only says
        // h-full inside a flex-col parent can still be sized by its content.
        className="flex flex-1 h-full w-full min-h-0 overflow-hidden bg-gray-50 dark:bg-gray-900"
        data-testid="glyph-builder-board"
      >
        {/* The two measured sidebar columns — the engine's advertised
            categories behind a pinned "all" tab, with the clinician's Images
            tab pinned last; the engine's own group chips (or the Images tab's
            three) beneath them. */}
        <BuilderSidebar
          ariaLabel={t("construction.tabsLabel")}
          heightPx={sidebarHeight}
          onMeasure={handleSidebarMeasure}
          tabs={sidebarTabs}
          chips={sidebarChips}
          tabsNeedMore={engineUiActive && engineTabsNeedMore}
          chipsNeedMore={imagesTab ? false : engineUiActive ? engineChipsNeedMore : registryChipsNeedMore}
          onTabsMore={() => setEngineTabPage((p) => p + 1)}
          onChipsMore={() => (engineUiActive ? setEngineChipPage((p) => p + 1) : setChipPage((p) => p + 1))}
          tabsTestId={engineUiActive ? "engine-tabs" : undefined}
          chipsTestId={engineUiActive ? "engine-chips" : undefined}
          tabsMoreTestId="engine-tab-more"
          chipsMoreTestId={engineUiActive ? "engine-chip-more" : "chip-more"}
          chipsPagerStyle={engineUiActive ? "density" : "plain"}
        />

        {/* Main area */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Top action row, in reading order: DONE — the sentence — the eraser
              — tone — CANCEL. Done leads because it is what the dialog is for;
              the glyphs grow away from it toward the eraser. */}
          <div className="flex items-stretch gap-2 p-3 border-b border-gray-200 dark:border-gray-700 shrink-0 h-36">
            <ActionButton
              label={t("button.gbDone")}
              icon="✓"
              primary
              onPress={commit}
              testId="glyph-builder-done"
            />

            <div className="flex-1 min-w-0 bg-white dark:bg-gray-800 rounded-xl border-2 border-gray-200 dark:border-gray-700 p-2 overflow-hidden">
              <GlyphCompositor
                glyph={draft}
                rtl={isRTL}
                resolveImage={defaultImageResolver}
                activeSlot={activeSlot}
                ariaLabel={t("construction.glyphPreviewLabel")}
                onSlotPress={handleSlotPress}
                align="start"
              />
            </div>

            {/* Clear-selected when a slot is selected; the same spot is
                Backspace otherwise. The two never coexist. */}
            {activeSlot != null ? (
              <ActionButton
                label={t("common.delete")}
                icon="✕"
                onPress={handleClearSelected}
                testId="glyph-builder-clear"
              />
            ) : hasSlots ? (
              <ActionButton
                label={t("construction.backspace")}
                icon="⌫"
                mirrorIcon={isRTL}
                onPress={handleBackspace}
                testId="glyph-builder-backspace"
              />
            ) : null}

            {/* Prosody: the student's own pair. */}
            <div className="flex flex-col gap-2">
              <ToneToggle
                label="?"
                active={draft.toneTags.includes("question")}
                onToggle={() => toggleTone("question")}
                ariaLabel={t("construction.toggleQuestion")}
              />
              <ToneToggle
                label="!"
                active={draft.toneTags.includes("exclamation")}
                onToggle={() => toggleTone("exclamation")}
                ariaLabel={t("construction.toggleExclamation")}
              />
            </div>

            {/* Tense: the clinician's extra. A stored glyph often means a
                yesterday or a tomorrow; the child's live board does not. */}
            <div className="flex flex-col gap-2">
              <ToneToggle
                label="⏪"
                active={draft.toneTags.includes("past")}
                onToggle={() => toggleTone("past")}
                ariaLabel={t("button.gbPast")}
              />
              <ToneToggle
                label="⏩"
                active={draft.toneTags.includes("future")}
                onToggle={() => toggleTone("future")}
                ariaLabel={t("button.gbFuture")}
              />
            </div>

            <ActionButton
              label={t("common.cancel")}
              icon="✕"
              onPress={onClose}
              testId="glyph-builder-cancel"
            />
          </div>

          {/* THE MODIFIER BAND and its five picker rows — one shared component
              (see @client-shared/builder/ModifierBand for the layout laws).
              No AI strip: that is the student's board alone. */}
          <ModifierBand
            engineModifiers={engineModifierItems}
            onEngineModifierPress={handleEngineModifierPress}
            activeModifierKeys={activeModifierKeys}
            modifiers={modifierItems}
            onModifierPress={handleModifierPress}
            modifiersHaveMore={allModifiers.length > MODIFIERS_PER_PAGE}
            onModifierMore={() => setModifierPage((p) => p + 1)}
            colorOptions={colorOptions}
            colorPickerOpen={colorPickerOpen}
            activeColorKey={activeKeyOfTransform("color")}
            onColorToggle={() => setColorPickerOpen((o) => !o)}
            onColorPick={(item) => { pickExclusive(item, "color"); setColorPickerOpen(false); }}
            emotionOptions={emotionOptions}
            emotionPickerOpen={emotionPickerOpen}
            activeEmotionKey={activeKeyOfTransform("emotion")}
            onEmotionToggle={() => setEmotionPickerOpen((o) => !o)}
            onEmotionPick={(item) => { pickExclusive(item, "emotion"); setEmotionPickerOpen(false); }}
            amountOptions={amountOptions}
            amountPickerOpen={amountPickerOpen}
            activeAmountKey={activeKeyOfTransform("gauge")}
            onAmountToggle={() => setAmountPickerOpen((o) => !o)}
            onAmountPick={(item) => { pickExclusive(item, "gauge"); setAmountPickerOpen(false); }}
            qualityPairs={qualityPairs}
            qualityPickerOpen={qualityPickerOpen}
            onQualityToggle={() => setQualityPickerOpen((o) => !o)}
            onQualityPress={handleQualityPress}
            // A join that cannot be ARMED is not offered at all: no slot to bind
            // back to, or the sentence is already at MAX_SLOTS.
            joinOptions={canJoin ? joinOptions : EMPTY_JOIN_OPTIONS}
            joinPickerOpen={joinPickerOpen}
            pendingJoin={pendingJoin}
            onJoinToggle={() => setJoinPickerOpen((o) => !o)}
            onJoinPick={handleJoinPick}
          />

          {/* Sentence-type chips — CONTROLS (what KIND of thing am I saying?),
              never words: pressing one composes nothing, it re-asks the engine
              for that move's openers. The engine offers them on the empty
              composition only. */}
          {engineTypeChips.length > 0 && (
            <div
              className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0 bg-gray-50 dark:bg-gray-800/60"
              data-testid="engine-type-chips"
            >
              {engineTypeChips.map((chip) => {
                const active = chip.kind === engineSeedKind;
                return (
                  <motion.button
                    key={chip.kind}
                    type="button"
                    data-testid={`engine-type-chip-${chip.kind}`}
                    aria-pressed={active}
                    onClick={() => setEngineSeedKind((cur) => (cur === chip.kind ? null : chip.kind))}
                    whileTap={{ scale: 0.95 }}
                    className={cn(
                      "rounded-xl border-2 text-xs font-medium py-2 px-3 flex flex-col items-center justify-center gap-1 min-w-[4.5rem]",
                      active
                        ? "bg-teal-600 border-teal-700 text-white"
                        : "bg-teal-50 dark:bg-teal-900/30 border-teal-300 dark:border-teal-700 text-teal-900 dark:text-teal-100",
                    )}
                  >
                    <span className="text-2xl leading-none" aria-hidden>
                      {TYPE_CHIP_ICON[chip.kind] ?? TYPE_CHIP_FALLBACK_ICON}
                    </span>
                    <span className="truncate w-full text-center">
                      {engineTypeChipLabel(chip.kind, chip.label)}
                    </span>
                  </motion.button>
                );
              })}
            </div>
          )}

          {/* Main grid — absorbs the remaining vertical space. */}
          <div className="flex-1 min-h-0 p-3 overflow-hidden">
            {imagesTab ? (
              imagesChip === "upload" ? (
                <UploadPanel
                  disabled={!studentId}
                  uploading={uploading}
                  failed={uploadFailed}
                  personImage={personImage}
                  onPersonImageChange={setPersonImage}
                  onFile={handleUpload}
                />
              ) : imagesChip === "emoji" ? (
                <div className="flex flex-col h-full min-h-0 gap-2">
                  <div className="flex items-center gap-2 shrink-0">
                    <Input
                      value={emojiInput}
                      onChange={(e) => setEmojiInput(e.target.value)}
                      placeholder={t("button.gbEmojiPlaceholder")}
                      className="h-10 w-56 text-lg text-center"
                      data-testid="gb-emoji-input"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && emojiInput.trim()) {
                          handleEmojiPress(emojiInput);
                          setEmojiInput("");
                        }
                      }}
                    />
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {t("button.gbRecentEmoji")}
                    </span>
                  </div>
                  <div className="flex-1 min-h-0">
                    <BuilderGrid
                      needsMore={emojiPage.needsMore}
                      onBack={() => setGridPage((p) => p - 1)}
                      onMore={() => setGridPage((p) => p + 1)}
                      backTestId="gb-emoji-back"
                      moreTestId="gb-emoji-more"
                    >
                      {emojiPage.items.length === 0 ? (
                        <BuilderGridEmpty>{t("button.gbNoRecentEmoji")}</BuilderGridEmpty>
                      ) : (
                        emojiPage.items.map((emoji) => (
                          <ImageTile
                            key={emoji}
                            emoji={emoji}
                            label={emoji}
                            testId={`gb-emoji-${emoji}`}
                            onPress={() => handleEmojiPress(emoji)}
                          />
                        ))
                      )}
                    </BuilderGrid>
                  </div>
                </div>
              ) : (
                <BuilderGrid
                  needsMore={symbolPage.needsMore}
                  onBack={() => setGridPage((p) => p - 1)}
                  onMore={() => setGridPage((p) => p + 1)}
                  backTestId="gb-images-back"
                  moreTestId="gb-images-more"
                  testId="gb-images-grid"
                >
                  {!studentId ? (
                    <BuilderGridEmpty>{ts("button.gbNoStudent")}</BuilderGridEmpty>
                  ) : symbolPage.items.length === 0 ? (
                    <BuilderGridEmpty>{t("button.gbNoImages")}</BuilderGridEmpty>
                  ) : (
                    symbolPage.items.map((s) => (
                      <ImageTile
                        key={s.id}
                        src={apiUrl(`/api/custom-symbols/${s.id}/image`)}
                        label={s.key || ""}
                        testId={`gb-symbol-${s.id}`}
                        onPress={() => handleSymbolPress(s.id)}
                      />
                    ))
                  )}
                </BuilderGrid>
              )
            ) : contactsActive ? (
              <BuilderGrid
                needsMore={contactsPage.needsMore}
                onBack={() => setGridPage((p) => p - 1)}
                onMore={() => setGridPage((p) => p + 1)}
                backTestId="who-back"
                moreTestId="who-more"
              >
                {!studentId ? (
                  <BuilderGridEmpty>{ts("button.gbNoStudent")}</BuilderGridEmpty>
                ) : contactsPage.items.length === 0 ? (
                  <BuilderGridEmpty>{ts("button.gbNoPeople")}</BuilderGridEmpty>
                ) : (
                  contactsPage.items.map((tile) =>
                    tile.type === "person" ? (
                      <PersonButton
                        key={`p-${tile.person.id}`}
                        person={tile.person}
                        faceUrl={getFaceImage(tile.person.id)}
                        present={false}
                        onPress={() => handlePersonPress(tile.person.id)}
                      />
                    ) : (
                      <EngineWordButton
                        key={`e-${tile.word.key}`}
                        word={tile.word}
                        onPress={() => handleEngineWordPress(tile.word)}
                      />
                    ),
                  )
                )}
              </BuilderGrid>
            ) : engineUiActive ? (
              <BuilderGrid
                needsMore={enginePage.needsMore}
                onBack={() => setGridPage((p) => p - 1)}
                onMore={() => setGridPage((p) => p + 1)}
                backTestId="grid-back"
                moreTestId="grid-more"
                testId="engine-grid"
              >
                {enginePage.items.map((word) => (
                  <EngineWordButton
                    key={word.key}
                    word={word}
                    onPress={() => handleEngineWordPress(word)}
                  />
                ))}
              </BuilderGrid>
            ) : (
              <BuilderGrid
                needsMore={registryPage.needsMore}
                onBack={() => setGridPage((p) => p - 1)}
                onMore={() => setGridPage((p) => p + 1)}
                backTestId="grid-back"
                moreTestId="grid-more"
              >
                {registryPage.items.map((item) => (
                  <GridButton key={item.key} item={item} onPress={() => handleGridPress(item)} />
                ))}
              </BuilderGrid>
            )}
          </div>

          {/* ADVANCED — the serialized glyph, editable. Clinicians paste
              AI-produced glyphs; `parseGlyph` is lenient, so a malformed line
              simply yields whatever it can make of it. */}
          <div className="shrink-0 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
            <button
              type="button"
              onClick={() => setAdvancedOpen((o) => !o)}
              aria-expanded={advancedOpen}
              data-testid="gb-advanced-toggle"
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/40"
            >
              <span aria-hidden>{advancedOpen ? "▾" : "▸"}</span>
              <span>{t("button.gbAdvanced")}</span>
              {!advancedOpen && (
                <span className="truncate font-mono opacity-70">{serialized}</span>
              )}
            </button>
            {advancedOpen && (
              <div className="px-3 pb-2">
                <Input
                  dir="ltr"
                  value={advancedText ?? serialized}
                  onChange={(e) => setAdvancedText(e.target.value)}
                  onBlur={commitAdvanced}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitAdvanced(); } }}
                  className="h-8 font-mono text-xs"
                  data-testid="gb-advanced-input"
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </BuilderDepsProvider>
  );
}

/**
 * The upload form. Not a grid — it is a single act, and the 9×2 geometry has
 * nothing to hold. `personImage` marks the upload as depicting an identifiable
 * person: such images may be used inside an organization but never in a public
 * package, and their bytes are access-gated (planning-docs/aac-packages-plan.md §3).
 */
function UploadPanel(props: {
  disabled: boolean;
  uploading: boolean;
  failed: boolean;
  personImage: boolean;
  onPersonImageChange: (v: boolean) => void;
  onFile: (file: File) => void;
}) {
  const { t } = useLanguage();
  const { ts } = useStudentLabel();
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col items-start gap-3 h-full">
      <button
        type="button"
        disabled={props.disabled || props.uploading}
        onClick={() => fileRef.current?.click()}
        data-testid="gb-upload-button"
        className={cn(
          "rounded-xl border-2 border-dashed border-gray-400 dark:border-gray-500 bg-white dark:bg-gray-800 px-6 py-4 flex items-center gap-3 text-sm font-medium",
          props.disabled || props.uploading ? "opacity-40 cursor-not-allowed" : "hover:bg-gray-50 dark:hover:bg-gray-700/40",
        )}
      >
        <span className="text-2xl" aria-hidden>
          {props.uploading ? "⏳" : "⬆️"}
        </span>
        <span>{props.uploading ? t("button.gbUploading") : t("button.gbUpload")}</span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) props.onFile(f);
          e.target.value = "";
        }}
      />
      <label className="flex items-start gap-2 text-xs cursor-pointer max-w-xl">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={props.personImage}
          onChange={(e) => props.onPersonImageChange(e.target.checked)}
          data-testid="symbol-person-image"
        />
        <span className="text-gray-500 dark:text-gray-400">
          {t("packages.personImageLabel")}
          <span className="block opacity-80">{t("packages.personImageHelp")}</span>
        </span>
      </label>
      {props.disabled && (
        <span className="text-xs text-gray-400">{ts("button.gbNoStudent")}</span>
      )}
      {props.failed && (
        <span className="text-xs text-red-500" data-testid="gb-upload-failed">
          {t("button.gbUploadFailed")}
        </span>
      )}
    </div>
  );
}

export default GlyphBuilder;
