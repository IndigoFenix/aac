// client-aac/src/components/WorldHudStrip.tsx
//
// Compact display of an embedded world-engine game's ambient HUD (`world_hud`
// bridge message): the city ribbon, the family members present, pocket
// contents — the information the game's OWN side panel shows on the lab bench
// before it is hidden in embedded mode (that screen edge is reserved for
// video-chat tiles). Rendered ABOVE the button sidebar, so it shares the column
// the student already scans, and drawn to READ like the lab panel: a dense chip
// ribbon on top, a box-per-creature row under it, an icon grid for the pocket.
//
// Deliberately a dumb display engine: sections/items (and which of the three
// layouts each wants) come whole from the game and render generically — AAC
// construction strategy, logic lives game/server side. Icons go through the
// SYMBOL SYSTEM (<Glyph>), never a raw emoji text node, so a creature's state
// reads pixel-identical to the same glyph on a board button.

import type { GameMessage } from "@shared/games-bridge";
import { Glyph } from "@/components/Glyph";

export type WorldHudSections = Extract<GameMessage, { type: "world_hud" }>["sections"];
type WorldHudSection = WorldHudSections[number];
type WorldHudItem = WorldHudSection["items"][number];

/** Shared shell state: highlighted (addressed) / away (not in the scene). */
function shellClass(item: WorldHudItem, base: string): string {
  return `${base} ${item.active ? "border-amber-400 bg-amber-400/20" : "border-white/15 bg-white/5"} ${
    item.dim ? "opacity-50" : ""
  }`;
}

/** A composed glyph in a fixed box (falls back to the item's emoji face). */
function ItemGlyph({ item, size }: { item: WorldHudItem; size: string }) {
  if (!item.glyph && !item.emoji) return null;
  return (
    <span className="flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <Glyph glyph={item.glyph ?? item.emoji} fallback={item.emoji} ariaLabel={item.label} noBackground />
    </span>
  );
}

/** "chips" — the dense status ribbon (city districts): icon, name, face, count. */
function ChipRow({ items }: { items: WorldHudItem[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <div
          key={item.id}
          title={item.label}
          className={shellClass(item, "flex items-center gap-1 rounded-lg border px-1.5 py-0.5")}
        >
          <ItemGlyph item={item} size="1.15rem" />
          <span className="max-w-[6rem] truncate text-[10px] font-semibold">{item.label}</span>
          {item.note && <span className="text-[10px] tabular-nums text-white/70">{item.note}</span>}
        </div>
      ))}
    </div>
  );
}

/** "cards" — a box per creature: big state glyph over the name, mood beneath. */
function CardRow({ items }: { items: WorldHudItem[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <div
          key={item.id}
          title={item.note ?? item.label}
          className={shellClass(
            item,
            "flex min-w-[4.1rem] flex-1 basis-[4.1rem] flex-col items-center gap-0.5 rounded-xl border-2 px-1 py-1",
          )}
        >
          <ItemGlyph item={item} size="2.3rem" />
          <span className="w-full truncate text-center text-[11px] font-semibold leading-tight">{item.label}</span>
          {item.note && (
            <span className="w-full truncate text-center text-[9px] leading-tight text-white/60">{item.note}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/** "items" — the pocket grid: icon squares with a stack-count badge. */
function ItemGrid({ items }: { items: WorldHudItem[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <div
          key={item.id}
          title={item.label}
          className={shellClass(item, "relative flex h-11 w-11 items-center justify-center rounded-xl border-2 p-0.5")}
        >
          <ItemGlyph item={item} size="100%" />
          {typeof item.count === "number" && item.count > 1 && (
            <span className="absolute -bottom-1 -end-1 min-w-[1.05rem] rounded-full bg-amber-400 px-1 text-center text-[10px] font-bold leading-4 text-slate-900">
              {item.count}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function WorldHudStrip({ sections }: { sections: WorldHudSections }) {
  if (!sections.length) return null;
  return (
    <div className="mb-1 max-h-[38%] w-full flex-shrink-0 overflow-y-auto rounded-lg bg-slate-900/85 p-1.5 text-white">
      {sections.map((section) => (
        <div key={section.id} className="mb-1.5 last:mb-0">
          {section.title && (
            <div className="mb-0.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-white/50">
              {section.title}
            </div>
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
