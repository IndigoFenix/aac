// src/features/custom-app/editors/trigger-event-editor.tsx
//
// Editor for a single TriggerEvent. The four event types each have their own
// extra fields — `onAiTrigger` has instructions, `onSignalReceived` has an
// id, the others are bare.

import type { TriggerEvent } from "@shared/custom-app-types";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLanguage } from "@/contexts/LanguageContext";
import { ListEditor } from "./list-editor";

const EVENT_TYPES = ["onMoved", "onClick", "onAiTrigger", "onSignalReceived"] as const;
type EventType = (typeof EVENT_TYPES)[number];

interface TriggerEventsListEditorProps {
  value: TriggerEvent[];
  onChange: (next: TriggerEvent[]) => void;
  isDark: boolean;
}

export function TriggerEventsListEditor({ value, onChange, isDark }: TriggerEventsListEditorProps) {
  const { t } = useLanguage();
  return (
    <ListEditor<TriggerEvent>
      items={value}
      onChange={onChange}
      replaceOnUpdate
      defaultItem={() => ({ type: "onClick" })}
      addLabel={t("customApps.addTriggerEvent")}
      emptyLabel={t("customApps.noTriggerEvents")}
      isDark={isDark}
      renderItem={(ev, _i, update) => (
        <TriggerEventEditor event={ev} onChange={(next) => update(next)} />
      )}
    />
  );
}

function TriggerEventEditor({
  event,
  onChange,
}: {
  event: TriggerEvent;
  onChange: (next: TriggerEvent) => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <Label className="text-[10px] opacity-70">{t("customApps.triggerEventType")}</Label>
        <Select
          value={event.type}
          onValueChange={(v) => onChange(defaultForEventType(v as EventType))}
        >
          <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {EVENT_TYPES.map((tt) => (
              <SelectItem key={tt} value={tt}>{labelForType(tt, t)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {event.type === "onAiTrigger" && (
        <div className="space-y-0.5">
          <Label className="text-[10px] opacity-70">{t("customApps.aiInstructions")}</Label>
          <Textarea
            value={event.instructions}
            onChange={(e) => onChange({ ...event, instructions: e.target.value })}
            rows={2}
            className="text-xs"
          />
        </div>
      )}
      {event.type === "onSignalReceived" && (
        <div className="space-y-0.5">
          <Label className="text-[10px] opacity-70">{t("customApps.signalId")}</Label>
          <Input
            value={event.id}
            onChange={(e) => onChange({ ...event, id: e.target.value })}
            className="h-7 text-xs"
          />
        </div>
      )}
    </div>
  );
}

function defaultForEventType(type: EventType): TriggerEvent {
  switch (type) {
    case "onMoved":
    case "onClick":
      return { type };
    case "onAiTrigger":
      return { type, instructions: "" };
    case "onSignalReceived":
      return { type, id: "" };
  }
}

function labelForType(type: EventType, t: (k: string) => string): string {
  const key = `customApps.eventType_${type}`;
  const v = t(key);
  return v && v !== key ? v : type;
}
