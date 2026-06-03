// client/src/features/consent/ConsentAuthorityPanel.tsx
//
// Lets a clinician set who may consent for a student (guardian vs. self).
// The default is age-of-majority based; this panel records the overrides:
//   - guardian_required: an adult under legal guardianship (records the legal
//     basis + evidence + review date)
//   - self: a self-consenting minor
// Shows the currently-resolved signer so the clinician sees the effect.
// Lives inside StudentInfoPanel as a collapsible section.

import { useEffect, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import {
  useConsentAuthority,
  useSetConsentAuthority,
  type ConsentAuthorityMode,
  type GuardianshipBasis,
} from "@/hooks/useConsentApi";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronDown, UserCog } from "lucide-react";

interface ConsentAuthorityPanelProps {
  studentId: string;
}

const BASIS_VALUES: GuardianshipBasis[] = [
  "court_appointed_guardian",
  "limited_guardian",
  "supported_decision_making",
  "power_of_attorney",
];

export function ConsentAuthorityPanel({ studentId }: ConsentAuthorityPanelProps) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const query = useConsentAuthority(studentId);
  const setAuthority = useSetConsentAuthority(studentId);
  const [open, setOpen] = useState(false);

  const [mode, setMode] = useState<ConsentAuthorityMode>("auto");
  const [basis, setBasis] = useState<GuardianshipBasis | "">("");
  const [reviewDate, setReviewDate] = useState("");
  const [notes, setNotes] = useState("");

  // Seed local form from the server once loaded.
  useEffect(() => {
    if (!query.data) return;
    setMode(query.data.consentAuthority);
    setBasis((query.data.guardianshipBasis as GuardianshipBasis) ?? "");
    setReviewDate(query.data.guardianshipReviewDate ?? "");
    setNotes(
      typeof (query.data.guardianshipEvidence as any)?.notes === "string"
        ? ((query.data.guardianshipEvidence as any).notes as string)
        : "",
    );
  }, [query.data]);

  if (query.isLoading) return null;

  const resolved = query.data?.resolved ?? null;
  const isGuardianRequired = mode === "guardian_required";

  const handleSave = async () => {
    try {
      await setAuthority.mutateAsync({
        mode,
        basis: isGuardianRequired ? (basis || null) : null,
        evidence: isGuardianRequired && notes.trim() ? { notes: notes.trim() } : null,
        reviewDate: isGuardianRequired ? (reviewDate || null) : null,
      });
      toast({
        title: t("consent.authority.saved") || "Consent authority updated",
      });
    } catch (err: any) {
      toast({
        title:
          err?.code === "guardianship_basis_required"
            ? t("consent.authority.errorBasisRequired") ||
              "A guardianship basis is required for an adult under guardianship"
            : err?.message || (t("consent.authority.saveError") || "Could not update"),
        variant: "destructive",
      });
    }
  };

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/30">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <UserCog className="w-5 h-5" />
                {t("consent.authority.title") || "Consent authority"}
              </CardTitle>
              <div className="flex items-center gap-2">
                {resolved && (
                  <Badge variant={resolved.signerType === "self" ? "secondary" : "default"}>
                    {resolved.signerType === "self"
                      ? t("consent.authority.signerSelf") || "Self-consent"
                      : t("consent.authority.signerGuardian") || "Guardian consent"}
                  </Badge>
                )}
                <ChevronDown
                  className={`w-4 h-4 transition-transform ${open ? "rotate-180" : ""}`}
                />
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t("consent.authority.description") ||
                "By default, who consents is decided by the student's age. Override it here if an adult student remains under legal guardianship, or a minor consents for themselves."}
            </p>

            <div className="space-y-2">
              <Label>{t("consent.authority.modeLabel") || "Who consents"}</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as ConsentAuthorityMode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    {t("consent.authority.modeAuto") || "Automatic (by age of majority)"}
                  </SelectItem>
                  <SelectItem value="guardian_required">
                    {t("consent.authority.modeGuardian") || "Guardian required (adult under guardianship)"}
                  </SelectItem>
                  <SelectItem value="self">
                    {t("consent.authority.modeSelf") || "Self-consent (minor)"}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {isGuardianRequired && (
              <>
                <div className="space-y-2">
                  <Label>{t("consent.authority.basisLabel") || "Legal basis"}</Label>
                  <Select value={basis} onValueChange={(v) => setBasis(v as GuardianshipBasis)}>
                    <SelectTrigger>
                      <SelectValue placeholder={t("consent.authority.basisPlaceholder") || "Select a legal instrument"} />
                    </SelectTrigger>
                    <SelectContent>
                      {BASIS_VALUES.map((b) => (
                        <SelectItem key={b} value={b}>
                          {t(`consent.authority.basis.${b}`) || b}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>{t("consent.authority.reviewDateLabel") || "Review / expiry date"}</Label>
                  <Input
                    type="date"
                    value={reviewDate}
                    onChange={(e) => setReviewDate(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>{t("consent.authority.evidenceLabel") || "Evidence / reference"}</Label>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder={t("consent.authority.evidencePlaceholder") || "Court order reference, issuing authority, notes…"}
                    rows={3}
                  />
                </div>
              </>
            )}

            <div className="flex justify-end">
              <Button onClick={handleSave} disabled={setAuthority.isPending}>
                {setAuthority.isPending
                  ? t("common.saving") || "Saving…"
                  : t("common.save") || "Save"}
              </Button>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
