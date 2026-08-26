// client-aac/src/components/CaretakerPinPrompt.tsx
//
// Numeric PIN prompt that stands between the child-facing board and the
// caretaker surfaces (switch student, manage devices, sign out). The device
// is signed in for a year by design; this is what makes those surfaces a
// caretaker's, not the child's.
//
// `data-dwell-trap`: the keypad is deliberately unreachable by eye-gaze dwell —
// a PIN entered by looking at it is not a PIN. Physical press only.

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Delete, Loader2, Lock } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

const MAX_LEN = 8;
const MIN_LEN = 4;

export interface CaretakerPinPromptProps {
  open: boolean;
  /** Resolves true when the server accepted the PIN. */
  onVerify: (pin: string) => Promise<"ok" | "wrong" | "locked" | "error">;
  onSuccess: () => void;
  onCancel: () => void;
}

export default function CaretakerPinPrompt({ open, onVerify, onSuccess, onCancel }: CaretakerPinPromptProps) {
  const { t, direction } = useLanguage();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"wrong" | "locked" | "error" | null>(null);

  useEffect(() => {
    if (!open) {
      setPin("");
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const press = (digit: string) => {
    if (busy || pin.length >= MAX_LEN) return;
    setError(null);
    setPin((p) => p + digit);
  };

  const submit = async () => {
    if (busy || pin.length < MIN_LEN) return;
    setBusy(true);
    const result = await onVerify(pin);
    setBusy(false);
    if (result === "ok") {
      onSuccess();
      return;
    }
    setPin("");
    setError(result);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent data-dwell-trap dir={direction} className="max-w-xs" data-testid="caretaker-pin-prompt">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4" />
            {t("caretakerPin.title")}
          </DialogTitle>
          <DialogDescription>{t("caretakerPin.prompt")}</DialogDescription>
        </DialogHeader>

        <div
          className="h-10 flex items-center justify-center text-2xl tracking-[0.5em] font-mono"
          aria-label={t("caretakerPin.title")}
          data-testid="caretaker-pin-display"
        >
          {"•".repeat(pin.length)}
        </div>

        <div className="grid grid-cols-3 gap-2">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
            <Button key={d} type="button" variant="outline" className="h-12 text-lg" onClick={() => press(d)} disabled={busy}>
              {d}
            </Button>
          ))}
          <Button
            type="button"
            variant="ghost"
            className="h-12"
            onClick={() => setPin((p) => p.slice(0, -1))}
            disabled={busy || pin.length === 0}
            aria-label={t("caretakerPin.delete")}
          >
            <Delete className="h-5 w-5" />
          </Button>
          <Button type="button" variant="outline" className="h-12 text-lg" onClick={() => press("0")} disabled={busy}>
            0
          </Button>
          <Button type="button" className="h-12" onClick={submit} disabled={busy || pin.length < MIN_LEN}>
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : t("caretakerPin.confirm")}
          </Button>
        </div>

        <p className="min-h-[1.25rem] text-sm text-destructive" role="alert" data-testid="caretaker-pin-error">
          {error === "wrong" && t("caretakerPin.wrong")}
          {error === "locked" && t("caretakerPin.locked")}
          {error === "error" && t("caretakerPin.error")}
        </p>

        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {t("caretakerPin.cancel")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
