// client/src/features/call/MirroredHudStrip.tsx
//
// WHAT THE STUDENT'S GAME LOOKS LIKE FROM THE OUTSIDE.
//
// While an AAC student plays a world-engine game, the board mirror can only
// carry the 8-button mini-board beside the game window — so a clinician saw a
// handful of communication buttons and had no idea where the child was, who was
// with them, or what they were carrying. The game already computes exactly that
// as its ambient HUD (`world_hud`), which the AAC renders beside its own board;
// this relays the SAME sections to the clinician.
//
// A deliberate twin of `client-aac/src/components/WorldHudStrip.tsx` rather
// than a shared component. `client-shared/` is Tailwind-free on purpose — it is
// consumed by the games' own bundles too, which have their own CSS pipelines
// (see the header of client-shared/src/board/GlyphTriad.tsx) — so sharing the
// RENDERER would mean rewriting both in inline styles for no gain. What is
// actually shared is the DATA: `MirrorHudSections` is the game's own bridge
// type, so the two views cannot disagree about what a section means, and a game
// that adds one gets it on both screens without touching either file.
//
// The sizing differs on purpose: the AAC squeezes this above a sidebar, while
// here it owns most of a pane, so it reads at conversation distance.

import type { MirrorHudSections } from "@shared/call/call-data-messages";
import { Glyph } from "@/components/Glyph";
import { cn } from "@/lib/utils";

type HudSection = MirrorHudSections[number];
type HudItem = HudSection["items"][number];

/** Shared shell state: highlighted (addressed) / away (not in the scene). */
function shellClass(item: HudItem, base: string): string {
  return cn(
    base,
    item.active ? "border-amber-400 bg-amber-400/20" : "border-white/15 bg-white/5",
    item.dim && "opacity-50",
  );
}

/** A composed glyph in a fixed box (falls back to the item's emoji face). */
function ItemGlyph({ item, size }: { item: HudItem; size: string }) {
  if (!item.glyph && !item.emoji) return null;
  return (
    <span className="flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <Glyph glyph={item.glyph ?? item.emoji} fallback={item.emoji} ariaLabel={item.label} noBackground />
    </span>
  );
}

/** "chips" — the dense status ribbon (city districts): icon, name, count. */
function ChipRow({ items }: { items: HudItem[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <div key={item.id} title={item.label} className={shellClass(item, "flex items-center gap-1.5 rounded-lg border px-2 py-1")}>
          <ItemGlyph item={item} size="1.4rem" />
          <span className="max-w-[8rem] truncate text-xs font-semibold">{item.label}</span>
          {item.note && <span className="text-xs tabular-nums text-white/70">{item.note}</span>}
        </div>
      ))}
    </div>
  );
}

/** "cards" — a box per creature: big state glyph over the name, mood beneath. */
function CardRow({ items }: { items: HudItem[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <div
          key={item.id}
          title={item.note ?? item.label}
          className={shellClass(item, "flex min-w-[5.5rem] flex-col items-center gap-1 rounded-xl border-2 px-1.5 py-1.5")}
        >
          <ItemGlyph item={item} size="3rem" />
          <span className="w-full truncate text-center text-xs font-semibold leading-tight">{item.label}</span>
          {item.note && <span className="w-full truncate text-center text-[10px] leading-tight text-white/60">{item.note}</span>}
        </div>
      ))}
    </div>
  );
}

/** "items" — the pocket grid: icon squares with a stack-count badge. */
function ItemGrid({ items }: { items: HudItem[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <div key={item.id} title={item.label} className={shellClass(item, "relative flex h-14 w-14 items-center justify-center rounded-xl border-2 p-1")}>
          <ItemGlyph item={item} size="100%" />
          {typeof item.count === "number" && item.count > 1 && (
            <span className="absolute -bottom-1 -end-1 min-w-[1.2rem] rounded-full bg-amber-400 px-1 text-center text-xs font-bold leading-5 text-slate-900">
              {item.count}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function MirroredHudStrip({ sections, className }: { sections: MirrorHudSections; className?: string }) {
  if (!sections.length) return null;
  return (
    <div className={cn("w-full overflow-y-auto rounded-lg bg-slate-900/85 p-2 text-white", className)}>
      {sections.map((section) => (
        <div key={section.id} className="mb-2 last:mb-0">
          {section.title && (
            <div className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-white/50">{section.title}</div>
          )}
          {section.layout === "chips" ? (
            <ChipRow items={section.items} />
          ) : section.layout === "items" ? (
            <ItemGrid items={section.items} />
          ) : (
            <CardRow items={section.items} />
          )}
        </div>
      ))}
    </div>
  );
}

export default MirroredHudStrip;
