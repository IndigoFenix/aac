import { Phone, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { useCall } from "./CallContext";

/** Ringing-in modal shown when another person is calling this user. */
export function IncomingCallModal() {
  const { t } = useLanguage();
  const { incoming, callState, accept, decline } = useCall();

  if (!incoming || callState !== "ringing-in") return null;

  const callerName = incoming.fromName || t("call.unknownCaller");

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("call.incoming")}
    >
      <div className="w-full max-w-sm rounded-xl bg-background p-6 text-center shadow-xl">
        <div className="text-sm text-muted-foreground">{t("call.incoming")}</div>
        <div className="mt-1 text-xl font-semibold">{callerName}</div>

        <div className="mt-6 flex items-center justify-center gap-6">
          <Button
            type="button"
            size="icon"
            variant="destructive"
            onClick={decline}
            aria-label={t("call.decline")}
            data-testid="call-decline"
          >
            <PhoneOff className="w-5 h-5" />
          </Button>
          <Button
            type="button"
            size="icon"
            className="bg-green-600 hover:bg-green-700 text-white"
            onClick={() => { void accept(); }}
            aria-label={t("call.accept")}
            data-testid="call-accept"
          >
            <Phone className="w-5 h-5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
