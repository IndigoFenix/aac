/**
 * Shared entity visual: how a class or class+overrides should look on a tile.
 *
 * Used by both the live GameRuntime and the editor's RoomEditor canvas so the
 * two stay visually in sync.
 */

import type { ClassDef } from "@shared/custom-app-types";
import type { EntityInstance } from "./engine-types";

export type ResolveImage = (ref: string) => string | undefined;

export function resolveColor(
  entity: EntityInstance | null,
  cls: ClassDef,
  prop: "tileColor" | "imageColor",
): string | undefined {
  const overrides = (entity?.overrides ?? {}) as Record<string, unknown>;
  const v = overrides[prop] ?? (cls as unknown as Record<string, unknown>)[prop];
  return typeof v === "string" ? v : undefined;
}

export function resolveLabel(
  entity: EntityInstance | null,
  cls: ClassDef,
): string | undefined {
  const v = (entity?.overrides.label as string | undefined) ?? cls.label;
  return typeof v === "string" ? v : undefined;
}

export interface EntityVisualProps {
  /** The entity instance, if there is one. Pass null to render the class default. */
  entity: EntityInstance | null;
  cls: ClassDef;
  resolveImage?: ResolveImage;
  /** Font size override (used when rendering at smaller sizes). */
  fontSize?: number;
}

export function EntityVisual({
  entity,
  cls,
  resolveImage,
  fontSize = 24,
}: EntityVisualProps) {
  const overrides = (entity?.overrides ?? {}) as Record<string, unknown>;
  const symbolPath = (overrides.symbolPath as string | undefined) ?? cls.symbolPath;
  const iconRef = (overrides.iconRef as string | undefined) ?? cls.iconRef;
  const imageColor = resolveColor(entity, cls, "imageColor");
  const char = (overrides.char as string | undefined) ?? cls.char;
  const label = resolveLabel(entity, cls);

  if (symbolPath) {
    const resolved = resolveImage?.(symbolPath) ?? symbolPath;
    return (
      <img
        src={resolved}
        alt={label ?? cls.id}
        style={{ maxWidth: "80%", maxHeight: "80%" }}
      />
    );
  }
  if (iconRef) {
    return <span style={{ fontSize, color: imageColor ?? "#e2e8f0" }}>{iconRef}</span>;
  }
  if (char) {
    return <span style={{ fontSize, color: imageColor ?? "#e2e8f0" }}>{char}</span>;
  }
  if (label) {
    return <span style={{ color: imageColor ?? "#e2e8f0" }}>{label}</span>;
  }
  return null;
}
