// client/src/components/AACSettingsCaretakerPin.tsx
//
// Clinician-side control for the AAC device's caretaker PIN. The device is
// signed in for a year by design; the PIN is what keeps its caretaker
// surfaces (switch student, manage devices, sign out) from a child at the
// keyboard. Set / replace / remove — the PIN itself is never read back.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useLanguage } from "@/contexts/LanguageContext";
import { Loader2, Lock, LockOpen } from "lucide-react";

const PIN_PATTERN = /^[0-9]{4,8}$/;

export function AACSettingsCaretakerPin({ studentId }: { studentId: string }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [pin, setPin] = useState("");

  const statusKey = ["caretaker-pin-status", studentId];
  const status = useQuery<{ set: boolean }>({
    queryKey: statusKey,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/aac/students/${studentId}/caretaker-pin`);
      if (!res.ok) return { set: false };
      const body = await res.json();
      return { set: body?.set === true };
    },
  });

  const save = useMutation({
    mutationFn: async (value: string | null) => {
      const res = await apiRequest("PUT", `/api/students/${studentId}/caretaker-pin`, { pin: value });
      if (!res.ok) throw new Error(String(res.status));
      return value !== null;
    },
    onSuccess: (isSet) => {
      setPin("");
      void queryClient.invalidateQueries({ queryKey: statusKey });
      toast({ description: t(isSet ? "aacSettings.caretakerPinSaved" : "aacSettings.caretakerPinCleared") });
    },
    onError: () => toast({ variant: "destructive", description: t("aacSettings.caretakerPinFailed") }),
  });

  const submit = () => {
    if (!PIN_PATTERN.test(pin)) {
      toast({ variant: "destructive", description: t("aacSettings.caretakerPinInvalid") });
      return;
    }
    save.mutate(pin);
  };

  const isSet = status.data?.set === true;

  return (
    <div className="space-y-3" data-testid="caretaker-pin-section">
      <p className="flex items-center gap-2 text-sm">
        {isSet ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
        {status.isLoading ? "…" : t(isSet ? "aacSettings.caretakerPinIsSet" : "aacSettings.caretakerPinNotSet")}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="space-y-1.5 sm:flex-1">
          <Label className="text-sm font-medium">{t("aacSettings.caretakerPinTitle")}</Label>
          <Input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            placeholder={t("aacSettings.caretakerPinPlaceholder")}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            data-testid="input-caretaker-pin"
          />
        </div>
        <Button type="button" onClick={submit} disabled={save.isPending || pin.length < 4}>
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : t("aacSettings.caretakerPinSet")}
        </Button>
        {isSet && (
          <Button type="button" variant="outline" onClick={() => save.mutate(null)} disabled={save.isPending}>
            {t("aacSettings.caretakerPinClear")}
          </Button>
        )}
      </div>
    </div>
  );
}
