// client/src/components/syntAACx/use-clinician-board-deps.tsx
//
// Shared clinician-side wiring for the unified <BoardButtonVisual />. Both the
// board editor canvas and the button inspector's preview build their button
// visuals from these deps, so a button looks identical wherever the clinician
// sees it — and matches the AAC student view.

import { useMemo } from "react";
import { apiUrl } from "@/lib/queryClient";
import { useSymbolStore } from "@/store/symbol-store";
import { useLanguage } from "@/contexts/LanguageContext";
import { Glyph } from "@/components/Glyph";
import type { BoardButtonInput, BoardRenderDeps, GlyphRenderProps, IconVisual } from "@client-shared/board/types";

// Adapt the clinician Glyph to the shared renderer's Glyph slot.
const ClinicianGlyph = (p: GlyphRenderProps) => (
  <Glyph glyph={p.glyph} fallback={p.fallback} noBackground={p.noBackground} ariaLabel={p.ariaLabel} />
);

/** True if the string renders as text (emoji/single char) rather than a Font Awesome class. */
export function isDisplayableIcon(str: string): boolean {
  if (!str || str.startsWith("fa") || str.includes(" ")) return false;
  if ([...str].length === 1) return true;
  return /[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FEFF}]|[\u{1F900}-\u{1F9FF}]|[\u{2702}-\u{27B0}]|[\u{E000}-\u{F8FF}]|[\u{200D}]|[\u{20E3}]|[\u{FE0F}]|[\u{2190}-\u{21FF}]|[\u{2300}-\u{23FF}]|[\u{2460}-\u{24FF}]|[\u{25A0}-\u{25FF}]|[\u{2B00}-\u{2BFF}]|[\u{3000}-\u{303F}]|[\u{3200}-\u{32FF}]|[\u{1F100}-\u{1F1FF}]|[\u{1F200}-\u{1F2FF}]|[\u{1F300}-\u{1F5FF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1F700}-\u{1F77F}]/u.test(str);
}

/** Pick a sensible fallback emoji for a label that has no icon at all. */
export function getEmojiForLabel(label: string): string {
  const emojiMap: { [key: string]: string } = {
    hello: "\u{1F44B}", hi: "\u{1F44B}", hey: "\u{1F44B}",
    yes: "✅", no: "❌", maybe: "\u{1F914}",
    help: "\u{1F198}", please: "\u{1F64F}", "thank you": "\u{1F64F}", thanks: "\u{1F64F}",
    more: "➕", less: "➖", stop: "\u{1F6D1}",
    eat: "\u{1F37D}️", food: "\u{1F37D}️", hungry: "\u{1F37D}️",
    drink: "\u{1F964}", water: "\u{1F4A7}", thirsty: "\u{1F4A7}",
    happy: "\u{1F60A}", sad: "\u{1F622}", angry: "\u{1F620}", tired: "\u{1F634}",
    play: "\u{1F3AE}", game: "\u{1F3AE}", fun: "\u{1F389}",
    home: "\u{1F3E0}", school: "\u{1F3EB}", outside: "\u{1F333}",
    mom: "\u{1F469}", dad: "\u{1F468}", family: "\u{1F468}‍\u{1F469}‍\u{1F467}",
    love: "❤️", like: "\u{1F44D}", want: "\u{1F446}",
    go: "\u{1F6B6}", come: "\u{1F44B}", wait: "⏳",
    bath: "\u{1F6C1}", toilet: "\u{1F6BD}", sleep: "\u{1F634}",
  };
  const lower = label.toLowerCase();
  for (const [key, emoji] of Object.entries(emojiMap)) {
    if (lower.includes(key)) return emoji;
  }
  return "\u{1F4AC}";
}

/**
 * Bridge the editor's ButtonIR (which doesn't type glyph/buttonType but carries
 * them at runtime) to the shared renderer's input shape.
 */
export function irToButtonInput(b: any): BoardButtonInput {
  return {
    label: b.label,
    sentence: b.sentence,
    glyph: b.glyph,
    glyphFallback: b.glyphFallback,
    color: b.color,
    iconRef: b.iconRef,
    symbolPath: b.symbolPath,
    imageKey: b.imageKey,
    buttonType: b.buttonType,
    action: b.action,
  };
}

/**
 * Clinician render deps for <BoardButtonVisual />. The icon chain mirrors the
 * legacy inline order so editor/preview buttons match the AAC exactly:
 * back/home FA icon → glyph → resolved symbol/imageKey → pending spinner →
 * emoji iconRef → FA iconRef → emoji-from-label.
 */
export function useClinicianBoardDeps(): BoardRenderDeps {
  const { isRTL } = useLanguage();
  const getSymbolPath = useSymbolStore((s) => s.getSymbolPath);
  const isPendingSymbol = useSymbolStore((s) => s.isPending);

  return useMemo<BoardRenderDeps>(() => {
    const resolveSymbolSrc = (symbolPath: string): string =>
      symbolPath.startsWith("/api/") ? apiUrl(symbolPath) : symbolPath;

    return {
      GlyphComponent: ClinicianGlyph,
      rtl: isRTL,
      resolveIcon: (button: BoardButtonInput): IconVisual => {
        const actionType = button.action?.type;
        if (actionType === "back" || actionType === "home") {
          const faClass = actionType === "home" ? "fa-house" : isRTL ? "fa-arrow-right" : "fa-arrow-left";
          return { kind: "fontawesome", className: `fas ${faClass}` };
        }
        if (button.glyph || button.glyphFallback) {
          return { kind: "glyph", glyph: button.glyph, fallback: button.glyphFallback };
        }
        const resolvedPath = button.symbolPath
          ? resolveSymbolSrc(button.symbolPath)
          : button.imageKey
            ? getSymbolPath(button.imageKey)
            : undefined;
        if (resolvedPath) return { kind: "image", src: resolvedPath };
        if (button.imageKey && isPendingSymbol(button.imageKey)) {
          const emoji = button.iconRef && isDisplayableIcon(button.iconRef) ? button.iconRef : getEmojiForLabel(button.label);
          return { kind: "spinner", emoji };
        }
        if (button.iconRef && isDisplayableIcon(button.iconRef)) return { kind: "emoji", text: button.iconRef };
        if (button.iconRef) return { kind: "fontawesome", className: button.iconRef };
        return { kind: "emoji", text: getEmojiForLabel(button.label) };
      },
    };
  }, [isRTL, getSymbolPath, isPendingSymbol]);
}
