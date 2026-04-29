// src/features/custom-app/editors/interactions-editor.tsx
//
// Editor for ClassDef.interactions. Each interaction has trigger events,
// optional self/other match specs, a list of effects, and an optional
// aiInstructions string.

import type { ClassDef, GameDefinition, Interaction } from "@shared/custom-app-types";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";
import { ListEditor } from "./list-editor";
import { TriggerEventsListEditor } from "./trigger-event-editor";
import { MatchSpecEditor } from "./match-spec-editor";
import { EffectsListEditor } from "./effect-editor";

interface InteractionsEditorProps {
  value: Interaction[] | undefined;
  onChange: (next: Interaction[] | undefined) => void;
  /** The class being edited — used for self counters/states pickers. */
  selfClass: ClassDef;
  definition: GameDefinition;
  isDark: boolean;
}

export function InteractionsEditor({
  value,
  onChange,
  selfClass,
  definition,
  isDark,
}: InteractionsEditorProps) {
  const { t } = useLanguage();
  const items = value ?? [];

  // Other classes available for the `other` match-spec dropdown.
  const otherClasses = definition.classes;

  return (
    <ListEditor<Interaction>
      items={items}
      onChange={(next) => onChange(next.length ? next : undefined)}
      defaultItem={() => ({
        triggers: { events: [{ type: "onClick" }] },
        effects: [{ type: "endTurn" }],
      })}
      addLabel={t("customApps.addInteraction")}
      emptyLabel={t("customApps.noInteractions")}
      isDark={isDark}
      renderItem={(inter, _i, update) => {
        // Look up the picked other-class so the counter-condition picker can show its counters.
        const otherClassId = inter.triggers.other?.classId;
        const otherClass = otherClassId
          ? definition.classes.find((c) => c.id === otherClassId)
          : undefined;

        return (
          <div className="space-y-3">
            <Subsection title={t("customApps.triggerEvents")} isDark={isDark}>
              <TriggerEventsListEditor
                value={inter.triggers.events}
                onChange={(events) =>
                  update({ ...inter, triggers: { ...inter.triggers, events } })
                }
                isDark={isDark}
              />
            </Subsection>

            <Subsection title={t("customApps.matchSelf")} isDark={isDark}>
              <MatchSpecEditor
                kind="self"
                value={inter.triggers.self}
                onChange={(self) =>
                  update({ ...inter, triggers: { ...inter.triggers, self } })
                }
                classes={otherClasses}
                knownCounters={selfClass.counters}
                isDark={isDark}
              />
            </Subsection>

            <Subsection title={t("customApps.matchOther")} isDark={isDark}>
              <MatchSpecEditor
                kind="other"
                value={inter.triggers.other}
                onChange={(other) =>
                  update({ ...inter, triggers: { ...inter.triggers, other } })
                }
                classes={otherClasses}
                knownCounters={otherClass?.counters}
                isDark={isDark}
              />
            </Subsection>

            <Subsection title={t("customApps.effects")} isDark={isDark}>
              <EffectsListEditor
                value={inter.effects}
                onChange={(effects) => update({ ...inter, effects })}
                definition={definition}
                selfClass={selfClass}
                isDark={isDark}
              />
            </Subsection>

            <Subsection title={t("customApps.aiInstructions")} isDark={isDark}>
              <Textarea
                value={inter.aiInstructions ?? ""}
                onChange={(e) =>
                  update({ ...inter, aiInstructions: e.target.value || undefined })
                }
                rows={2}
                className="text-xs"
                placeholder={t("customApps.aiInstructionsPlaceholder")}
              />
            </Subsection>
          </div>
        );
      }}
    />
  );
}

function Subsection({
  title,
  children,
  isDark,
}: {
  title: string;
  children: React.ReactNode;
  isDark: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label
        className={cn(
          "text-[10px] font-semibold uppercase tracking-wide",
          isDark ? "text-slate-400" : "text-gray-500",
        )}
      >
        {title}
      </Label>
      {children}
    </div>
  );
}
