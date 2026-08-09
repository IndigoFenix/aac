// client/src/components/syntAACx/glyph-builder.tsx
//
// Focused glyph composer for the CLINICIAN board editor. A clinician builds a
// button's visual (a glyph string like "i_me+want+💧") by selecting individual
// SYMBOLs — canonical registry keys, emoji, the student's uploaded custom
// symbols (symbol:ID), and faces (face:ID) — with a live preview. Clinician
// glyphs use ONLY immediate-render SYMBOLs (no `generate:`, so no fallback).
//
// All parsing / mutation / rendering reuses shared code; this is just UI.

import { useMemo, useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Upload, ArrowLeft, Loader2, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiRequest, apiUrl } from "@/lib/queryClient";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTheme } from "@/contexts/ThemeContext";
import { Glyph } from "@/components/Glyph";
import { resolveIconPath, registerStudentFace } from "@/lib/glyph-images";
import {
  parseGlyph,
  serializeGlyph,
  replaceSlot,
  clearSlot,
  addModifier,
  removeModifier,
  applyRelationalModifier,
  setToneTags,
  MAX_SLOTS,
  type ParsedGlyph,
  type ToneTag,
} from "@shared/glyph-compositor";
import { placeArt } from "@shared/glyph-place-art";
import { applyExclusiveModifier, cycleQualityPole, pushSlotWithJoin } from "@shared/glyph-builder-ops";
import {
  listByCategory,
  listByModeChip,
  MODE_CHIPS,
  defaultModeChip,
  modifiersFor,
  colorModifiersFor,
  emotionModifiersFor,
  gaugeModifiersFor,
  qualityPairsFor,
  listConnectors,
  getVocabularyItem,
  type VocabularyItem,
  type GlyphCategory,
} from "@shared/glyph-registry";
import { resolveEmoji, rtlMirrorStyle } from "@shared/emoji-registry";

const TABS: readonly GlyphCategory[] = ["who", "do", "what", "where", "when", "chat"];
const TAB_ICON: Record<GlyphCategory, string> = {
  who: "👤", do: "🤲", what: "📦", where: "📍", when: "🕐", chat: "💬",
};
const TONES: { tag: ToneTag; label: string }[] = [
  { tag: "question", label: "?" },
  { tag: "past", label: "⏪ past" },
  { tag: "future", label: "⏩ future" },
];

/** The SYMBOL key to store for an item: its canonical key if the AI uses it, else its emoji. */
function slotKeyForSelection(item: VocabularyItem): string {
  if (item.exposeToAi) return item.key;
  if (item.emoji) return item.emoji;
  return item.key;
}

interface CustomSymbol { id: string; key: string | null; description: string | null }
interface Contact { id: string; name: string; relationship?: string | null; biometricDataId?: string | null }

export interface GlyphBuilderProps {
  value: string | undefined;
  onChange: (glyph: string) => void;
  studentId: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function GlyphBuilder({ value, onChange, studentId, open, onOpenChange }: GlyphBuilderProps) {
  const { t, isRTL } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const parsed = useMemo(() => parseGlyph(value || ""), [value]);
  const [activeSlot, setActiveSlot] = useState<number | null>(null);
  const [tab, setTab] = useState<GlyphCategory>("what");
  const [modeChip, setModeChip] = useState<string>(defaultModeChip("what"));
  const [emojiInput, setEmojiInput] = useState("");
  const [view, setView] = useState<"main" | "symbol" | "person">("main");
  // Forward-binding join armed for the next pushed slot (connector / spatial).
  const [pendingJoin, setPendingJoin] = useState<string | null>(null);

  const apply = (next: ParsedGlyph) => onChange(serializeGlyph(next));

  const addSymbol = (key: string) => {
    if (activeSlot != null && activeSlot < parsed.slots.length) {
      apply(replaceSlot(parsed, activeSlot, key));
    } else {
      apply(pushSlotWithJoin(parsed, key, pendingJoin));
      setActiveSlot(parsed.slots.length); // select the newly added slot
      setPendingJoin(null);
    }
  };

  const removeSlot = (idx: number) => {
    apply(clearSlot(parsed, idx));
    setActiveSlot(null);
  };

  // Modifier families for the currently-selected slot. The carousel (activeMods)
  // excludes hiddenFromCarousel families (color/emotion/amount/quality); those
  // get their own rows below, mirroring the AAC sentence builder. All mutation
  // goes through the shared glyph-builder-ops so the two builders stay in sync.
  const activeItem = activeSlot != null ? getVocabularyItem(parsed.slots[activeSlot]?.key || "") : undefined;
  const activeMods = activeItem ? modifiersFor(activeItem.pos) : [];
  const activeColorMods = activeItem ? colorModifiersFor(activeItem.pos) : [];
  const activeEmotionMods = activeItem ? emotionModifiersFor(activeItem.pos) : [];
  const activeAmountMods = activeItem ? gaugeModifiersFor(activeItem.pos) : [];
  const activeQualityPairs = activeItem ? qualityPairsFor(activeItem.pos) : [];
  const joinOptions = listConnectors();
  const canJoin = parsed.slots.length > 0 && parsed.slots.length < MAX_SLOTS;
  const activeSlotModifiers = activeSlot != null ? parsed.slots[activeSlot]?.modifiers ?? [] : [];

  const toggleModifier = (item: VocabularyItem) => {
    if (activeSlot == null) return;
    const mod = item.modifier;
    if (!mod) return;
    if (mod.transform === "relational") {
      apply(applyRelationalModifier(parsed, activeSlot, item.key));
      return;
    }
    const has = activeSlotModifiers.includes(item.key);
    apply(has ? removeModifier(parsed, activeSlot, item.key) : addModifier(parsed, activeSlot, item.key));
  };

  // Mutually-exclusive families (color / emotion / amount) + quality poles +
  // forward-binding join — all via the shared ops shared with the AAC builder.
  const pickExclusive = (item: VocabularyItem) => {
    if (activeSlot == null || !item.modifier) return;
    apply(applyExclusiveModifier(parsed, activeSlot, item.key, item.modifier.transform));
  };
  const toggleQuality = (pair: { pos: VocabularyItem; neg: VocabularyItem }) => {
    if (activeSlot == null) return;
    apply(cycleQualityPole(parsed, activeSlot, pair.pos.key, pair.neg.key));
  };
  const pickJoin = (key: string) => setPendingJoin((cur) => (cur === key ? null : key));

  const toggleTone = (tag: ToneTag) => {
    const has = parsed.toneTags.includes(tag);
    apply(setToneTags(parsed, has ? parsed.toneTags.filter((x) => x !== tag) : [...parsed.toneTags, tag]));
  };

  const gridItems = useMemo(
    () => (listByModeChip(tab, modeChip).length ? listByModeChip(tab, modeChip) : listByCategory(tab)),
    [tab, modeChip],
  );

  // Match the AAC sentence builder: a PLACE WORD goes through the compositor
  // (its symbol is a shell plus a fixture — two PNGs, one symbol), otherwise
  // prefer the bundled artwork (imagePath) and fall back to the emoji. This is
  // what the selected slot will actually show.
  const renderItemVisual = (item: VocabularyItem) => {
    if (placeArt(item.key)) {
      return (
        <div className="w-11 h-11">
          <Glyph glyph={item.key} noBackground />
        </div>
      );
    }
    const url = item.imagePath ? resolveIconPath(item.imagePath) : null;
    // Same mirror rule as the compositor and the student's own board: the
    // clinician is picking the symbol the student will see, so it has to face
    // the way it will face in their sentence.
    const emoji = item.emoji ?? resolveEmoji(item.key);
    const mirror = rtlMirrorStyle(isRTL, { key: item.key, emoji, item });
    if (url) return <img src={url} alt="" className="w-11 h-11 object-contain" style={mirror} />;
    return <span className="text-4xl leading-none" style={mirror}>{emoji ?? "•"}</span>;
  };

  const panelBg = isDark ? "bg-slate-900 border-slate-800" : "bg-white border-gray-200";
  const chipCls = (active: boolean) =>
    cn(
      "px-2 h-7 rounded-md text-xs border transition-colors whitespace-nowrap",
      active
        ? "border-blue-500 " + (isDark ? "bg-slate-700 text-slate-100" : "bg-blue-50 text-blue-700")
        : (isDark ? "border-slate-700 text-slate-400 hover:bg-slate-800" : "border-gray-300 text-gray-600 hover:bg-gray-100"),
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("max-w-2xl", panelBg)}>
        <DialogHeader>
          <DialogTitle className={isDark ? "text-slate-100" : "text-gray-900"}>
            {view === "symbol" ? t("button.gbAddImage") : view === "person" ? t("button.gbAddPerson") : t("button.gbTitle")}
          </DialogTitle>
        </DialogHeader>

        {/* Live preview + composed slots */}
        <div className={cn("rounded-lg border p-3 flex items-center gap-3", isDark ? "border-slate-800 bg-slate-800/40" : "border-gray-200 bg-gray-50")}>
          <div className="w-24 h-24 shrink-0">
            <Glyph glyph={parsed} activeSlot={activeSlot} onSlotPress={setActiveSlot} showEmptyHostSlot />
          </div>
          <div className="flex flex-wrap gap-1.5 flex-1 min-w-0 self-stretch content-start">
            {parsed.slots.length === 0 && (
              <span className={cn("text-xs", isDark ? "text-slate-500" : "text-gray-400")}>{t("button.gbEmpty")}</span>
            )}
            {parsed.slots.map((slot, i) => {
              const item = getVocabularyItem(slot.key);
              const emoji = item?.emoji ?? resolveEmoji(slot.key) ?? (slot.key.startsWith("symbol:") ? "🖼️" : slot.key.startsWith("face:") ? "👤" : slot.key);
              const slotMirror = rtlMirrorStyle(isRTL, { key: slot.key, emoji, item });
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setActiveSlot(activeSlot === i ? null : i)}
                  className={cn(
                    "h-9 px-2.5 rounded-md text-base border flex items-center gap-1",
                    activeSlot === i
                      ? "border-blue-500 ring-1 ring-blue-400 " + (isDark ? "bg-slate-700" : "bg-blue-50")
                      : (isDark ? "border-slate-700 bg-slate-800" : "border-gray-300 bg-white"),
                  )}
                >
                  <span className="leading-none" style={slotMirror}>{emoji}</span>
                  {slot.modifiers.length > 0 && <span className="text-[9px] text-blue-500">+{slot.modifiers.length}</span>}
                </button>
              );
            })}
          </div>
          {/* Add a new glyph / delete the selected one */}
          <div className="flex flex-col gap-1.5 shrink-0">
            <Button
              type="button"
              size="sm"
              variant={activeSlot == null ? "default" : "outline"}
              className={cn("h-8 text-xs", activeSlot == null ? "bg-blue-600 hover:bg-blue-700" : "")}
              onClick={() => setActiveSlot(null)}
            >
              <Plus size={13} className="mr-1" />{t("button.gbAdd")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={activeSlot == null}
              className="h-8 text-xs text-red-500 hover:bg-red-500/10 disabled:opacity-40"
              onClick={() => { if (activeSlot != null) removeSlot(activeSlot); }}
            >
              <Trash2 size={13} className="mr-1" />{t("button.delete")}
            </Button>
          </div>
        </div>

        {view === "main" && (
          <>
            {/* Category tabs */}
            <div className="flex gap-1">
              {TABS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => { setTab(c); setModeChip(defaultModeChip(c)); }}
                  className={cn("flex-1 h-9 rounded-md text-base border", chipCls(tab === c))}
                  title={c}
                >
                  {TAB_ICON[c]}
                </button>
              ))}
            </div>

            {/* Mode chips */}
            <div className="flex gap-1 flex-wrap">
              {MODE_CHIPS[tab].map((chip) => (
                <button key={chip} type="button" onClick={() => setModeChip(chip)} className={chipCls(modeChip === chip)}>
                  {chip.replace(/[-_]/g, " ")}
                </button>
              ))}
            </div>

            {/* Symbol grid */}
            <ScrollArea className="h-52 -mx-1 px-1">
              <div className="grid grid-cols-5 gap-1.5">
                {gridItems.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => addSymbol(slotKeyForSelection(item))}
                    title={item.key}
                    className={cn(
                      "aspect-square rounded-md border flex flex-col items-center justify-center gap-0.5 p-1",
                      isDark ? "border-slate-700 hover:bg-slate-800" : "border-gray-200 hover:bg-gray-100",
                    )}
                  >
                    {renderItemVisual(item)}
                    <span className={cn("text-[8px] truncate w-full text-center", isDark ? "text-slate-500" : "text-gray-500")}>
                      {item.key}
                    </span>
                  </button>
                ))}
              </div>
            </ScrollArea>

            {/* Add emoji / custom image / person */}
            <div className="flex items-center gap-2">
              <Input
                value={emojiInput}
                onChange={(e) => setEmojiInput(e.target.value)}
                placeholder={t("button.gbEmoji")}
                className={cn("h-8 w-24 text-sm text-center", isDark ? "bg-slate-800 border-slate-700 text-slate-200" : "bg-white border-gray-300")}
                onKeyDown={(e) => { if (e.key === "Enter" && emojiInput.trim()) { addSymbol(emojiInput.trim()); setEmojiInput(""); } }}
              />
              <Button variant="outline" size="sm" className="h-8 text-xs" disabled={!emojiInput.trim()}
                onClick={() => { addSymbol(emojiInput.trim()); setEmojiInput(""); }}>
                ＋ {t("button.gbEmoji")}
              </Button>
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setView("symbol")}>
                ＋ {t("button.gbCustomImage")}
              </Button>
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setView("person")} disabled={!studentId}>
                ＋ {t("button.gbPerson")}
              </Button>
            </div>

            {/* Modifiers + tone for the selected slot */}
            {activeItem ? (
              <div className={cn("rounded-md border p-2 space-y-2", isDark ? "border-slate-800" : "border-gray-200")}>
                <div className={cn("text-[10px]", isDark ? "text-slate-500" : "text-gray-500")}>
                  {t("button.gbModifiers")} “{activeItem.key}”
                </div>
                <div className="flex flex-wrap gap-1">
                  {activeColorMods.map((m) => (
                    <button key={m.key} type="button" title={m.key} onClick={() => pickExclusive(m)}
                      className={cn("w-6 h-6 rounded-full border", activeSlotModifiers.includes(m.key) ? "ring-2 ring-blue-500" : (isDark ? "border-slate-600" : "border-gray-300"))}
                      style={{ backgroundColor: m.modifier?.colorValue || "#ccc" }} />
                  ))}
                  {activeEmotionMods.map((m) => (
                    <button key={m.key} type="button" title={m.key} onClick={() => pickExclusive(m)}
                      className={cn("w-6 h-6 rounded-full border flex items-center justify-center text-sm leading-none", activeSlotModifiers.includes(m.key) ? "ring-2 ring-blue-500" : (isDark ? "border-slate-600" : "border-gray-300"))}>
                      <span style={rtlMirrorStyle(isRTL, { key: m.key, emoji: m.emoji ?? "🙂", item: m })}>{m.emoji ?? "🙂"}</span>
                    </button>
                  ))}
                  {activeAmountMods.map((m) => (
                    <button key={m.key} type="button" onClick={() => pickExclusive(m)} className={chipCls(activeSlotModifiers.includes(m.key))}>
                      {m.emoji && <span style={rtlMirrorStyle(isRTL, { key: m.key, emoji: m.emoji, item: m })}>{m.emoji}</span>}{m.emoji ? " " : ""}{m.key}
                    </button>
                  ))}
                  {activeQualityPairs.map((p) => {
                    const has = activeSlotModifiers.includes(p.pos.key)
                      ? "pos" : activeSlotModifiers.includes(p.neg.key) ? "neg" : "off";
                    return (
                      <button key={p.pos.key} type="button" title={`${p.pos.key} / ${p.neg.key}`} onClick={() => toggleQuality(p)}
                        className={chipCls(has !== "off")}>
                        {(() => {
                          const pole = has === "neg" ? p.neg : p.pos;
                          const face = pole.emoji ?? (has === "neg" ? "👎" : "👍");
                          return <span style={rtlMirrorStyle(isRTL, { key: pole.key, emoji: face, item: pole })}>{face}</span>;
                        })()}
                      </button>
                    );
                  })}
                  {activeMods.map((m) => (
                    <button key={m.key} type="button" onClick={() => toggleModifier(m)} className={chipCls(activeSlotModifiers.includes(m.key))}>
                      {m.emoji && <span style={rtlMirrorStyle(isRTL, { key: m.key, emoji: m.emoji, item: m })}>{m.emoji}</span>}{m.emoji ? " " : ""}{m.key.replace(/_/g, " ")}
                    </button>
                  ))}
                  {activeMods.length === 0 && activeColorMods.length === 0 && activeEmotionMods.length === 0
                    && activeAmountMods.length === 0 && activeQualityPairs.length === 0 && (
                    <span className={cn("text-[10px]", isDark ? "text-slate-600" : "text-gray-400")}>{t("button.gbNoModifiers")}</span>
                  )}
                </div>
              </div>
            ) : (
              <div className={cn("text-[10px]", isDark ? "text-slate-600" : "text-gray-400")}>{t("button.gbSelectForMods")}</div>
            )}

            {/* Join (connector / spatial) — arm a forward-binding join for the
                NEXT symbol added. Available once at least one slot exists. */}
            {canJoin && (
              <div className="flex items-center gap-1 flex-wrap">
                <span className={cn("text-[10px] mr-1", isDark ? "text-slate-500" : "text-gray-500")}>{t("button.gbJoin")}:</span>
                {joinOptions.map((j) => (
                  <button key={j.key} type="button" title={j.key} onClick={() => pickJoin(j.key)} className={chipCls(pendingJoin === j.key)}>
                    {j.emoji && <span style={rtlMirrorStyle(isRTL, { key: j.key, emoji: j.emoji, item: j })}>{j.emoji}</span>}{j.emoji ? " " : ""}{j.key}
                  </button>
                ))}
              </div>
            )}

            {/* Tone / operators */}
            <div className="flex items-center gap-1">
              <span className={cn("text-[10px] mr-1", isDark ? "text-slate-500" : "text-gray-500")}>{t("button.gbTone")}:</span>
              {TONES.map(({ tag, label }) => (
                <button key={tag} type="button" onClick={() => toggleTone(tag)} className={chipCls(parsed.toneTags.includes(tag))}>
                  {label}
                </button>
              ))}
            </div>
          </>
        )}

        {view === "symbol" && (
          <CustomSymbolPicker
            studentId={studentId}
            isDark={isDark}
            onBack={() => setView("main")}
            onPick={(id) => { addSymbol(`symbol:${id}`); setView("main"); }}
          />
        )}

        {view === "person" && (
          <PersonPicker
            studentId={studentId}
            isDark={isDark}
            onBack={() => setView("main")}
            onPick={(id) => { addSymbol(`face:${id}`); setView("main"); }}
          />
        )}

        <div className="flex justify-end pt-1">
          <Button size="sm" onClick={() => onOpenChange(false)} className="bg-blue-600 hover:bg-blue-700">
            {t("common.done") || "Done"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Custom-symbol picker + upload (reuses the existing custom-symbols API)
// ---------------------------------------------------------------------------
function CustomSymbolPicker({ studentId, isDark, onBack, onPick }: {
  studentId: string | undefined; isDark: boolean; onBack: () => void; onPick: (id: string) => void;
}) {
  const { t } = useLanguage();
  const [symbols, setSymbols] = useState<CustomSymbol[]>([]);
  const [uploading, setUploading] = useState(false);
  // Marks the upload as depicting an identifiable person. Person images may be
  // used inside an organization but never in a public package, and their image
  // bytes are access-gated rather than served to any caller.
  // See planning-docs/aac-packages-plan.md §3.
  const [personImage, setPersonImage] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => {
    if (!studentId) return;
    apiRequest("GET", `/api/custom-symbols/available/${studentId}`)
      .then((r) => r.json())
      .then((d) => setSymbols(Array.isArray(d) ? d : d?.symbols ?? d?.contacts ?? []))
      .catch(() => {});
  };
  useEffect(load, [studentId]);

  const handleUpload = async (file: File) => {
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("image", file, file.name || "symbol.png");
      if (personImage) form.append("personImage", "true");
      const created = await apiRequest("POST", "/api/custom-symbols", form).then((r) => r.json());
      if (studentId) {
        await apiRequest("POST", `/api/custom-symbols/${created.id}/student-associate`, { studentId }).catch(() => {});
      }
      onPick(created.id);
    } catch {
      /* surfaced by apiRequest's thrown error; keep the dialog open */
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onBack}><ArrowLeft size={13} className="mr-1" />{t("button.gbBack")}</Button>
        <Button variant="outline" size="sm" className="h-7 text-xs" disabled={uploading} onClick={() => fileRef.current?.click()}>
          {uploading ? <Loader2 size={12} className="mr-1 animate-spin" /> : <Upload size={12} className="mr-1" />}{t("button.gbUpload")}
        </Button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = ""; }} />
      </div>
      <label className="flex items-start gap-1.5 text-[11px] cursor-pointer px-1">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={personImage}
          onChange={(e) => setPersonImage(e.target.checked)}
          data-testid="symbol-person-image"
        />
        <span className={isDark ? "text-slate-400" : "text-gray-500"}>
          {t("packages.personImageLabel")}
          <span className="block opacity-80">{t("packages.personImageHelp")}</span>
        </span>
      </label>
      <ScrollArea className="h-52 -mx-1 px-1">
        <div className="grid grid-cols-5 gap-1.5">
          {symbols.map((s) => (
            <button key={s.id} type="button" onClick={() => onPick(s.id)} title={s.key || ""}
              className={cn("aspect-square rounded-md border flex flex-col items-center justify-center gap-0.5 p-1", isDark ? "border-slate-700 hover:bg-slate-800" : "border-gray-200 hover:bg-gray-100")}>
              <img src={apiUrl(`/api/custom-symbols/${s.id}/image`)} alt={s.key || ""} className="w-9 h-9 object-contain" loading="lazy" />
              <span className={cn("text-[8px] truncate w-full text-center", isDark ? "text-slate-500" : "text-gray-500")}>{s.key || ""}</span>
            </button>
          ))}
          {symbols.length === 0 && (
            <div className={cn("col-span-5 text-center text-xs py-6", isDark ? "text-slate-500" : "text-gray-500")}>
              {t("button.gbNoImages")}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Person (face) picker — the student's known contacts
// ---------------------------------------------------------------------------
function PersonPicker({ studentId, isDark, onBack, onPick }: {
  studentId: string | undefined; isDark: boolean; onBack: () => void; onPick: (id: string) => void;
}) {
  const { t } = useLanguage();
  const [contacts, setContacts] = useState<Contact[]>([]);
  useEffect(() => {
    if (!studentId) return;
    apiRequest("GET", `/api/biometric/students/${studentId}/contacts`)
      .then((r) => r.json())
      // Endpoint returns { success, contacts, count } — unwrap to the array.
      .then((d) => {
        const list: Contact[] = Array.isArray(d) ? d : d?.contacts ?? [];
        setContacts(list);
        for (const c of list) {
          if (c?.id && c?.biometricDataId) {
            registerStudentFace(c.id, apiUrl(`/api/aac/students/${studentId}/people/${c.id}/photo`));
          }
        }
      })
      .catch(() => {});
  }, [studentId]);

  return (
    <div className="space-y-2">
      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onBack}><ArrowLeft size={13} className="mr-1" />{t("button.gbBack")}</Button>
      <ScrollArea className="h-52 -mx-1 px-1">
        <div className="grid grid-cols-4 gap-1.5">
          {contacts.map((c) => (
            <button key={c.id} type="button" onClick={() => onPick(c.id)} title={c.name}
              className={cn("rounded-md border flex flex-col items-center justify-center gap-1 p-2", isDark ? "border-slate-700 hover:bg-slate-800" : "border-gray-200 hover:bg-gray-100")}>
              {c.biometricDataId
                ? <img src={apiUrl(`/api/biometric-data/${c.biometricDataId}/photo`)} alt={c.name} className="w-10 h-10 object-cover rounded-full" loading="lazy" />
                : <span className="text-2xl">👤</span>}
              <span className={cn("text-[10px] truncate w-full text-center", isDark ? "text-slate-300" : "text-gray-700")}>{c.name}</span>
            </button>
          ))}
          {contacts.length === 0 && (
            <div className={cn("col-span-4 text-center text-xs py-6", isDark ? "text-slate-500" : "text-gray-500")}>
              {t("button.gbNoPeople")}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
