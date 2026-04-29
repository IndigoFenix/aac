// src/features/custom-app/editors/list-editor.tsx
//
// Generic list editor with add/remove and click-and-drag reordering via a
// dedicated grip handle (so inputs inside the rendered rows still work).
//
// Used by every advanced sub-editor (states, counters, dropRules,
// interactions, effects, events, override-props).

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ListEditorProps<T> {
  items: T[];
  onChange: (items: T[]) => void;
  /** Render the body of one row. The handle and delete button are added by the shell. */
  renderItem: (item: T, index: number, update: (patch: Partial<T> | T) => void) => React.ReactNode;
  /** Called when "Add" is clicked. Receives the current items so the new one can avoid id collisions. */
  defaultItem: (existing: T[]) => T;
  addLabel: string;
  /** Optional empty-state message. */
  emptyLabel?: string;
  isDark: boolean;
  /** When true, "patch" passed to renderItem replaces the whole item (rather than merging). */
  replaceOnUpdate?: boolean;
}

export function ListEditor<T>({
  items,
  onChange,
  renderItem,
  defaultItem,
  addLabel,
  emptyLabel,
  isDark,
  replaceOnUpdate,
}: ListEditorProps<T>) {
  const dragIndex = useRef<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const update = (index: number, patch: Partial<T> | T) => {
    const next = items.slice();
    next[index] = replaceOnUpdate
      ? (patch as T)
      : ({ ...(next[index] as object), ...(patch as object) } as T);
    onChange(next);
  };

  const remove = (index: number) => {
    const next = items.slice();
    next.splice(index, 1);
    onChange(next);
  };

  const reorder = (from: number, to: number) => {
    if (from === to) return;
    const next = items.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };

  const add = () => {
    onChange([...items, defaultItem(items)]);
  };

  return (
    <div className="space-y-2">
      {items.length === 0 && emptyLabel && (
        <div className={cn("text-xs italic", isDark ? "text-slate-500" : "text-gray-400")}>
          {emptyLabel}
        </div>
      )}

      {items.map((item, i) => (
        <div
          key={i}
          onDragOver={(e) => {
            if (dragIndex.current === null) return;
            e.preventDefault();
            setOverIndex(i);
          }}
          onDragLeave={() => setOverIndex((cur) => (cur === i ? null : cur))}
          onDrop={(e) => {
            if (dragIndex.current === null) return;
            e.preventDefault();
            reorder(dragIndex.current, i);
            dragIndex.current = null;
            setOverIndex(null);
          }}
          className={cn(
            "flex items-start gap-1 rounded border p-2",
            isDark ? "border-slate-800 bg-slate-950/50" : "border-gray-200 bg-white",
            overIndex === i && (isDark ? "border-blue-500" : "border-blue-400"),
          )}
        >
          <div
            draggable
            onDragStart={(e) => {
              dragIndex.current = i;
              e.dataTransfer.effectAllowed = "move";
              // Setting dragImage data lets some browsers treat it as a real drag.
              e.dataTransfer.setData("text/plain", String(i));
            }}
            onDragEnd={() => {
              dragIndex.current = null;
              setOverIndex(null);
            }}
            className={cn(
              "shrink-0 cursor-grab active:cursor-grabbing self-stretch flex items-center px-0.5 -ml-1",
              isDark ? "text-slate-500 hover:text-slate-300" : "text-gray-400 hover:text-gray-600",
            )}
            title="Drag to reorder"
          >
            <GripVertical className="h-4 w-4" />
          </div>

          <div className="flex-1 min-w-0">
            {renderItem(item, i, (patch) => update(i, patch))}
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={() => remove(i)}
            title="Remove"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}

      <Button variant="outline" size="sm" onClick={add} className="w-full">
        <Plus className="h-3.5 w-3.5 mr-1" />
        {addLabel}
      </Button>
    </div>
  );
}
