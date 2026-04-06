import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useInstitute } from "@/hooks/useInstitute";
import { useLanguage } from "@/contexts/LanguageContext";
import { ShieldCheck } from "lucide-react";

export function IdentityVerificationDialog() {
  const { t } = useLanguage();
  const {
    showIdentityPrompt,
    identityVerification,
    currentInstitute,
    initiateIdentityLink,
    dismissIdentityPrompt,
  } = useInstitute();

  if (!showIdentityPrompt || !identityVerification?.provider) return null;

  const providerName = identityVerification.provider.name;
  const isExpired = identityVerification.expired;

  return (
    <Dialog open={showIdentityPrompt} onOpenChange={(open) => { if (!open) dismissIdentityPrompt(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5" />
            {t('identity.verificationRequired')}
          </DialogTitle>
          <DialogDescription>
            {isExpired
              ? t('identity.verificationExpired', { provider: providerName, institute: currentInstitute?.name || '' })
              : t('identity.verificationNeeded', { provider: providerName, institute: currentInstitute?.name || '' })
            }
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex gap-2 sm:gap-0">
          <Button variant="outline" onClick={dismissIdentityPrompt}>
            {t('common.later')}
          </Button>
          <Button onClick={initiateIdentityLink}>
            {t('identity.verifyNow', { provider: providerName })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
