// client/src/features/guided-setup/GuidedSetupRail.tsx
//
// The Guided Setup step rail (Phase B). Rendered by MainLayout ABOVE the current
// feature panel whenever a flow view exists. Two shapes:
//
//   full rail   — a live flow is running (`live && view.active`): stepper,
//                 consent gate, the current step's checklist and the controls.
//   compact     — a student has an unfinished record but no live flow: a single
//                 "Continue setup" line.
//
// Display-only over server state: everything it shows comes from GuidedSetupView
// (@shared/guided-setup), and every button is a server action. No local flow
// logic lives here.

import { useCallback, useState } from 'react';

import { useFeaturePanel } from '@/contexts/FeaturePanelContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useStudent } from '@/hooks/useStudent';
import { useStudentLabel } from '@/hooks/useStudentLabel';
import { openUI } from '@/lib/uiEvents';
import { cn } from '@/lib/utils';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Check, Info, Loader2, Minus, ShieldCheck } from 'lucide-react';

import type {
  GuidedSetupAccount,
  GuidedSetupConsentBatchItem,
  GuidedSetupGate,
  GuidedSetupParkedStudent,
  GuidedSetupRefusalReason,
  GuidedSetupSkippableStep,
  GuidedSetupStepStatus,
  GuidedSetupStepView,
} from '@shared/guided-setup';

import {
  consentBranch,
  consentStageState,
  offersInPersonAttestation,
  GATE_NEEDS_REQUEST,
  type ConsentStageState,
} from './consent-branch';
import { RosterReviewTable } from './RosterReviewTable';
import { useGuidedSetup } from './useGuidedSetup';

// ============================================================================
// STEP DOT
// ============================================================================

/**
 * Theme tokens only. Progression direction is the writing direction — the row is
 * a plain flex row inside a `dir`-aware container, so no directional icon is
 * involved and RTL reads right-to-left on its own.
 */
// A COMPLETED step is green, not primary-tinted: `current` is already the solid
// primary fill, so a primary-tinted `done` sat too close to it to scan at a
// glance — which is the whole job of this row. Green matches the vocabulary the
// consent panels already use for "settled" (`ConsentHistoryPanel`), and carries
// explicit dark variants because the tinted greens vanish on a dark ground.
const STATUS_DOT: Record<Exclude<GuidedSetupStepStatus, 'hidden'>, string> = {
  done: 'bg-green-50 text-green-600 border-green-500/50 dark:bg-green-950/30 dark:text-green-400 dark:border-green-500/40',
  current: 'bg-primary text-primary-foreground border-primary',
  locked: 'bg-muted text-muted-foreground border-border',
  skipped: 'bg-muted text-muted-foreground border-border',
};

function StepDot({ step, index }: { step: GuidedSetupStepView; index: number }) {
  const { t } = useLanguage();
  const status = step.status as Exclude<GuidedSetupStepStatus, 'hidden'>;

  return (
    <div className="flex flex-col items-center gap-1 min-w-0">
      <div
        className={cn(
          'w-7 h-7 rounded-full border flex items-center justify-center text-xs font-semibold shrink-0',
          STATUS_DOT[status] ?? STATUS_DOT.locked,
        )}
        aria-hidden="true"
      >
        {status === 'done' ? <Check className="w-4 h-4" /> : index + 1}
      </div>
      <span
        className={cn(
          'text-xs truncate max-w-[7rem]',
          status === 'current' ? 'font-medium text-foreground' : 'text-muted-foreground',
          status === 'skipped' && 'line-through',
        )}
      >
        {t(`guidedSetup.step.${step.id}`)}
      </span>
      <span className="sr-only">{t(`guidedSetup.status.${status}`)}</span>
    </div>
  );
}

// ============================================================================
// CONSENT BADGE
// ============================================================================

const GATE_VARIANT: Record<Exclude<GuidedSetupGate, 'off'>, 'default' | 'secondary' | 'destructive'> = {
  none: 'secondary',
  sign_required: 'destructive',
  request_sent: 'secondary',
  active: 'default',
  revoked: 'destructive',
};

// ============================================================================
// CONSENT STAGE MARKER
// ============================================================================

/**
 * Same 7×7 token-only treatment as StepDot, so the two read as one row — but a
 * shield instead of a number, because this is NOT one of the numbered steps and
 * must not shift their numbering. It sits between step 1 and step 2 purely so
 * the user can see the gate coming while they are still filling in basics,
 * instead of finishing step 1 and hitting an invisible wall.
 *
 * No directional icon is involved (the logical-arrow rule doesn't apply to a
 * shield), and the row is a plain flex row inside a `dir`-aware container, so
 * RTL orders itself.
 */
const CONSENT_STAGE_DOT: Record<ConsentStageState, string> = {
  // Same green as a completed numbered step — the consent stage reads as one of
  // them, so it must settle the same way.
  done: 'bg-green-50 text-green-600 border-green-500/50 dark:bg-green-950/30 dark:text-green-400 dark:border-green-500/40',
  attention: 'bg-destructive/10 text-destructive border-destructive/50',
  pending: 'bg-muted text-muted-foreground border-border',
};

function ConsentStageDot({ gate }: { gate: GuidedSetupGate }) {
  const { t } = useLanguage();
  const state = consentStageState(gate);
  if (!state) return null;

  return (
    <div className="flex flex-col items-center gap-1 min-w-0">
      <div
        className={cn(
          'w-7 h-7 rounded-full border flex items-center justify-center shrink-0',
          CONSENT_STAGE_DOT[state],
        )}
        aria-hidden="true"
      >
        <ShieldCheck className="w-4 h-4" />
      </div>
      <span
        className={cn(
          'text-xs truncate max-w-[7rem]',
          state === 'attention' ? 'font-medium text-foreground' : 'text-muted-foreground',
        )}
      >
        {t('guidedSetup.consent.stage')}
      </span>
      {/* The gate badge's own wording, so the screen reader hears the same
          sentence the sighted user reads off the header. */}
      <span className="sr-only">{t(`guidedSetup.consent.badge.${gate}`)}</span>
    </div>
  );
}

// ============================================================================
// CONSENT EXPLAINER CARD
// ============================================================================

/**
 * What consent IS, why the flow stopped, and the ONE thing to do about it.
 *
 * The branch comes from `consentBranch` (consent-branch.ts), which is total:
 * every reachable (account, gate, contact) triple yields either a button or an
 * explicit "nothing to do but wait". Before it existed an institution that
 * added one student in chat and then added a guardian landed on `sign_required`
 * with a contact id and got NO affordance at all — not the family-only Sign
 * button, not the roster-only batch button, not the gate-`none`-only Add
 * guardian button — while the assistant told them to press one.
 *
 * Styled like the Info hint lines elsewhere in the rail rather than the shadcn
 * Alert, whose absolutely-positioned icon assumes a full-size card and
 * misaligns at this compact size.
 */
function ConsentCard({
  account,
  gate,
  studentId,
  consentContactId,
  isBusy,
  onSign,
  onAddGuardian,
  onSendRequest,
  onAttestInPerson,
}: {
  account: GuidedSetupAccount;
  gate: GuidedSetupGate;
  studentId: string | null;
  consentContactId: string | null | undefined;
  isBusy: boolean;
  onSign: () => void;
  onAddGuardian: () => void;
  onSendRequest: (contactId: string) => Promise<boolean>;
  onAttestInPerson: (contactId: string) => void;
}) {
  const { t } = useLanguage();
  const { ts } = useStudentLabel();
  const [sendResult, setSendResult] = useState<'ok' | 'failed' | null>(null);

  const branch = consentBranch({ account, gate, studentId, consentContactId });
  if (!branch) return null;

  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 space-y-1.5">
      <p className="text-sm font-semibold text-foreground flex items-center gap-1.5">
        <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
        {t('guidedSetup.consent.explainTitle')}
      </p>
      <p className="text-xs text-muted-foreground">{ts('guidedSetup.consent.explainBody')}</p>

      {branch.kind === 'sign' && (
        <>
          <p className="text-xs text-muted-foreground">{t('guidedSetup.consent.signCaption')}</p>
          <Button size="sm" variant="outline" onClick={onSign}>
            {t('guidedSetup.consent.sign')}
          </Button>
        </>
      )}

      {branch.kind === 'addGuardianFamily' && (
        <>
          <p className="text-xs text-muted-foreground">
            {ts('guidedSetup.consent.familyNoGuardianCaption')}
          </p>
          <Button size="sm" variant="outline" onClick={onAddGuardian}>
            {t('guidedSetup.consent.addGuardian')}
          </Button>
        </>
      )}

      {branch.kind === 'addGuardianInstitution' && (
        <>
          <p className="text-xs text-muted-foreground">{t('guidedSetup.consent.noGuardian')}</p>
          <Button size="sm" variant="outline" onClick={onAddGuardian}>
            {t('guidedSetup.consent.addGuardian')}
          </Button>
        </>
      )}

      {branch.kind === 'sendRequest' && (
        <>
          <p className="text-xs text-muted-foreground">{t('guidedSetup.consent.sendCaption')}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={isBusy}
            onClick={() => {
              void onSendRequest(branch.contactId).then((ok) =>
                setSendResult(ok ? 'ok' : 'failed'),
              );
            }}
          >
            {isBusy && <Loader2 className="w-3.5 h-3.5 me-1.5 animate-spin" />}
            {t('guidedSetup.consent.sendRequest')}
          </Button>
          {/* A successful send flips the gate to `request_sent`, so this line is
              usually replaced by the wait caption on the next view. It still
              earns its place: the view arrives a beat later, and a failure
              never moves the gate at all. */}
          {sendResult === 'ok' && (
            <p className="text-xs text-muted-foreground">{t('guidedSetup.consent.sentOne')}</p>
          )}
          {sendResult === 'failed' && (
            <p className="text-xs text-destructive">{t('guidedSetup.consent.sendFailed')}</p>
          )}
        </>
      )}

      {/* The second move on the same branch: the guardian is not at the other
          end of an email, they are at the desk. Secondary styling because the
          link is the common case — but it is a real button, not a hint, because
          a clinic that has the parent in the room should never be told to email
          them. See offersInPersonAttestation in consent-branch.ts. */}
      {offersInPersonAttestation(branch) && (
        <div className="pt-1.5 border-t border-border/60 space-y-1.5">
          <p className="text-xs text-muted-foreground">
            {t('guidedSetup.consent.attestCaption')}
          </p>
          <Button
            size="sm"
            variant="ghost"
            className="px-0 h-auto text-xs underline underline-offset-2"
            onClick={() => onAttestInPerson(branch.contactId)}
          >
            {t('guidedSetup.consent.attestInPerson')}
          </Button>
        </div>
      )}

      {/* No button on purpose — a second magic link for the same child is not a
          nudge. See GATE_NEEDS_REQUEST. */}
      {branch.kind === 'wait' && (
        <p className="text-xs text-muted-foreground flex items-start gap-1.5">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          {t('guidedSetup.consent.sentCaption')}
        </p>
      )}
    </div>
  );
}

// ============================================================================
// REFUSAL BANNER
// ============================================================================

/**
 * Reasons that are internal bookkeeping, not news: the assistant speculatively
 * calls `guidedSetup(advance)` after every write, and the engine refuses with
 * one of these whenever the next step just isn't ready yet — that's the normal
 * rhythm of the flow, not something the user did wrong. Everything else is a
 * refusal the user can actually act on (missing consent, no room on the
 * license, a roster row that failed, …), so it's shown by default — an
 * allowlist here would silently swallow a new actionable reason.
 */
const SUPPRESSED_REFUSAL_REASONS: ReadonlySet<string> = new Set<GuidedSetupRefusalReason>([
  'stepIncomplete',
  'programMissing',
  'programDraft',
  'notSkippable',
  'notStarted',
  'unknownStep',
  'unknownAction',
]);

// ============================================================================
// PARKED LIST (institutions)
// ============================================================================

// `GATE_NEEDS_REQUEST` lives in consent-branch.ts now: the batch button here and
// the single-send button in the card must agree on what a request can move.

function ParkedList({
  parked,
  gateOn,
  isBusy,
  onSelect,
  onSendRequests,
  sentSummary,
}: {
  parked: GuidedSetupParkedStudent[];
  gateOn: boolean;
  isBusy: boolean;
  onSelect: (studentId: string) => void;
  onSendRequests: (items: GuidedSetupConsentBatchItem[]) => void;
  sentSummary: string | null;
}) {
  const { t } = useLanguage();
  const { ts } = useStudentLabel();

  // Only students the server gave us a contact id for: without one there is
  // nobody to send to, and the count on the button has to be the truth.
  const sendable = parked.filter(
    (p) => GATE_NEEDS_REQUEST.includes(p.gate) && !!p.consentContactId,
  );

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-semibold text-foreground">{t('guidedSetup.parked.title')}</h3>
        {gateOn && sendable.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            disabled={isBusy}
            onClick={() =>
              onSendRequests(
                sendable.map((p) => ({
                  studentId: p.studentId,
                  contactId: p.consentContactId as string,
                  channel: 'email' as const,
                })),
              )
            }
          >
            {isBusy && <Loader2 className="w-3.5 h-3.5 me-1.5 animate-spin" />}
            {t('guidedSetup.consent.sendRequests', { count: sendable.length })}
          </Button>
        )}
      </div>

      {sentSummary && <p className="text-xs text-muted-foreground">{sentSummary}</p>}

      {parked.length === 0 ? (
        <p className="text-xs text-muted-foreground">{ts('guidedSetup.parked.empty')}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {parked.map((p) => (
            <li key={p.studentId}>
              <button
                type="button"
                onClick={() => onSelect(p.studentId)}
                className="flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-xs hover:bg-accent"
              >
                <span className="max-w-[9rem] truncate">{p.name}</span>
                <span className="text-muted-foreground">
                  {p.step === 'done'
                    ? t('guidedSetup.status.done')
                    : t(`guidedSetup.step.${p.step}`)}
                </span>
                {p.gate !== 'off' && p.gate !== 'active' && (
                  <Badge variant={GATE_VARIANT[p.gate] ?? 'secondary'} className="text-[10px] px-1 py-0">
                    {t('guidedSetup.parked.awaitingConsent')}
                  </Badge>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ============================================================================
// RAIL
// ============================================================================

export function GuidedSetupRail() {
  const { t } = useLanguage();
  const { ts } = useStudentLabel();
  const { selectStudent } = useStudent();
  const { setActiveFeature } = useFeaturePanel();
  const {
    view,
    live,
    isBusy,
    isChatBusy,
    skip,
    dismiss,
    notNow,
    continueSetup,
    beginFormPath,
    refresh,
    requestConsentBatch,
    rosterCreated,
  } = useGuidedSetup();

  const [sentSummary, setSentSummary] = useState<string | null>(null);

  const openParked = useCallback(
    async (studentId: string) => {
      await selectStudent(studentId);
      await refresh(studentId);
    },
    [selectStudent, refresh],
  );

  const sendRequests = useCallback(
    async (items: GuidedSetupConsentBatchItem[]) => {
      const results = await requestConsentBatch(items);
      if (!results) return;
      const ok = results.filter((r) => r.ok).length;
      setSentSummary(
        t('guidedSetup.consent.requestsSent', { count: ok, failed: results.length - ok }),
      );
    },
    [requestConsentBatch, t],
  );

  /**
   * The single-student send behind the consent card's button. A batch of one is
   * the supported shape — there is no separate endpoint — and the boolean it
   * hands back is what the card's confirmation line keys off.
   */
  const sendOneRequest = useCallback(
    async (studentId: string, contactId: string): Promise<boolean> => {
      const results = await requestConsentBatch([{ studentId, contactId, channel: 'email' }]);
      return !!results && results.every((r) => r.ok) && results.length > 0;
    },
    [requestConsentBatch],
  );

  if (!view) return null;

  const record = view.record ?? null;
  const resumable =
    !!record && !record.completedAt && !record.dismissedAt && view.step !== 'done';

  // ── Finished ──────────────────────────────────────────────────────────────
  // Checked BEFORE `view.active`, which cannot be trusted on the turn that
  // completes the flow: the completing view is published by the guidedSetup
  // tool action, and those code paths pass no `active` (so it defaults to
  // true) on a record whose `completedAt` has not been stamped yet. `step ===
  // 'done'` is what both server paths agree on — keying off `active` alone is
  // why the header stayed up until the user pressed "Finish later".
  //
  // A live finished flow gets a few seconds of "all done" and then the
  // provider retires it on its own (GUIDED_SETUP_COMPLETE_LINGER_MS); a
  // finished view that is merely in hand (a GET on selecting the student)
  // renders nothing at all.
  if (view.step === 'done' || record?.completedAt) {
    if (!live) return null;

    return (
      <div className="shrink-0 border-b border-border bg-muted/40 px-4 py-2 flex items-center gap-2 flex-wrap">
        <Check className="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
        <span className="text-sm font-medium">{t('guidedSetup.completed')}</span>
        <span className="text-xs text-muted-foreground">{ts('guidedSetup.completedDesc')}</span>
      </div>
    );
  }

  // ── Compact banner ────────────────────────────────────────────────────────
  if (!live || !view.active) {
    if (!resumable) return null;

    return (
      <div className="shrink-0 border-b border-border bg-muted/40 px-4 py-2 flex items-center gap-3 flex-wrap">
        <span className="text-sm font-medium">{t('guidedSetup.title')}</span>
        {/* `done` was filtered out above, so this is always a real step. */}
        <span className="text-xs text-muted-foreground">
          {t(`guidedSetup.step.${view.step}`)}
        </span>
        <div className="flex-1" />
        {/* Same rule as "New student": spin on OUR turn, refuse the click while
            any chat turn is in flight so a second press cannot stack a second
            kickoff on top of the first. */}
        <Button size="sm" onClick={() => void continueSetup()} disabled={isBusy || isChatBusy}>
          {isBusy && <Loader2 className="w-3.5 h-3.5 me-1.5 animate-spin" />}
          {t('guidedSetup.actions.continueSetup')}
        </Button>
      </div>
    );
  }

  // ── Full rail ─────────────────────────────────────────────────────────────
  const visibleSteps = view.steps.filter((s) => s.status !== 'hidden');
  const currentStep = view.steps.find((s) => s.id === view.step) ?? null;
  const checklist = currentStep?.checklist ?? [];

  // (`done` cannot reach here — the finished branch above returned.)
  const canSkip =
    view.step !== 'basics' &&
    !!view.studentId &&
    (currentStep?.status === 'current' || currentStep?.status === 'locked');

  const isInstitution = view.account !== 'family';

  // The students THIS session's roster import created, and only those. Before
  // an import has run `rosterCreated` is null and the parked section renders
  // nothing — one student's consent state is not news about another.
  const importedIds = new Set((rosterCreated ?? []).map((c) => c.studentId));
  const importedParked = (view.parked ?? []).filter((p) => importedIds.has(p.studentId));

  // The BOUND student's own parked row — the one place `consentContactId` is
  // published. Reading this row is fine; rendering any OTHER student's row is
  // the regression the parked-list comment below guards against.
  const boundParked = view.parked?.find((p) => p.studentId === view.studentId) ?? null;

  return (
    <div className="shrink-0 border-b border-border bg-card px-4 py-3 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            {t('guidedSetup.title')}
            {isBusy && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
          </h2>
          <p className="text-xs text-muted-foreground">
            {ts(view.account === 'family' ? 'guidedSetup.subtitle' : 'guidedSetup.subtitleRoster')}
          </p>
        </div>

        {/* Status only. The "Sign consent" button used to live here as well, and
            it is now the consent card's own primary action — one gate, one
            button, in the one place that also explains what it is for. */}
        {view.gate !== 'off' && (
          <Badge variant={GATE_VARIANT[view.gate] ?? 'secondary'}>
            {t(`guidedSetup.consent.badge.${view.gate}`)}
          </Badge>
        )}
      </div>

      {/* Stepper. The consent marker is spliced in after `basics` — the gate
          sits between step 1 and step 2 — and is NOT counted: `index` still
          comes from the visible-step array, so the numbered steps stay 1..N. */}
      {visibleSteps.length > 0 && (
        <div className="flex items-start gap-2">
          {visibleSteps.map((step, i) => (
            <div key={step.id} className="flex items-start gap-2 flex-1 min-w-0">
              <StepDot step={step} index={i} />
              {i < visibleSteps.length - 1 && (
                <div className="h-px flex-1 bg-border mt-3.5" aria-hidden="true" />
              )}
              {step.id === 'basics' && view.gate !== 'off' && i < visibleSteps.length - 1 && (
                <>
                  <ConsentStageDot gate={view.gate} />
                  <div className="h-px flex-1 bg-border mt-3.5" aria-hidden="true" />
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Current step checklist */}
      {checklist.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {checklist.map((item) => (
            <li
              key={item.key}
              className={cn(
                'flex items-center gap-1.5 text-xs',
                item.done ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {item.done ? (
                <Check className="w-3.5 h-3.5 text-primary" aria-hidden="true" />
              ) : (
                <Minus className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              {ts(`guidedSetup.checklist.${item.key}`)}
            </li>
          ))}
        </ul>
      )}

      {/* What the gate is, and the one move that clears it. Renders nothing when
          the gate is off, once consent is active, or before step 1 has created a
          student (so the roster-review screen below is never pushed down by it).
          The old standalone "Add guardian contact" block is folded in here — two
          of them on screen read as two different requests.
          Placed directly under the stepper: the consent marker there is what
          tells the user the flow has stopped, and this is the answer to it. */}
      <ConsentCard
        account={view.account}
        gate={view.gate}
        studentId={view.studentId}
        consentContactId={boundParked?.consentContactId}
        isBusy={isBusy}
        onSign={() => openUI('consentWizard', { studentId: view.studentId })}
        onAddGuardian={() => setActiveFeature('contacts')}
        onSendRequest={(contactId) => sendOneRequest(view.studentId as string, contactId)}
        onAttestInPerson={(contactId) =>
          openUI('consentWizard', { studentId: view.studentId, attestContactId: contactId })
        }
      />

      {/* Institution step 1: the roster the AI proposed, awaiting review. */}
      {isInstitution && view.step === 'basics' && !!view.roster && (
        <RosterReviewTable proposal={view.roster} />
      )}

      {/* What THIS session's roster import just created, and the consent batch
          button for it.
          NOT `view.parked` whole: that is every unfinished student in the
          institute, so the rail was telling a clinician who else is waiting for
          consent while they set up somebody entirely different. The flow may
          report what the flow did — the bound student's own state is the
          stepper's and the consent badge's job.
          Never on the basics step while a roster is open either — the table IS
          the list there, and two lists of the same names read as a bug. */}
      {isInstitution && importedParked.length > 0 && !(view.step === 'basics' && !!view.roster) && (
        <ParkedList
          parked={importedParked}
          gateOn={view.gate !== 'off'}
          isBusy={isBusy}
          onSelect={(id) => void openParked(id)}
          onSendRequests={(items) => void sendRequests(items)}
          sentSummary={sentSummary}
        />
      )}

      {/* Notes shown while collecting medical information */}
      {view.step === 'medical' && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
            {t('guidedSetup.notes.documentsNotStored')}
          </p>
          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
            {ts('guidedSetup.notes.draftsReachAac')}
          </p>
        </div>
      )}

      {/* The last refused transition, explained — but only when it's news the
          user can act on. Most refusals are the assistant's own speculative
          `advance` bookkeeping (see SUPPRESSED_REFUSAL_REASONS above) and show
          up at moments the user can't connect to anything they did, so those
          render nothing. Styled like the Info hint lines above rather than the
          default shadcn Alert, whose absolutely-positioned icon assumes a
          full-size card and misaligns at this compact, single-line size. */}
      {view.refused && !SUPPRESSED_REFUSAL_REASONS.has(view.refused.reason) && (
        <div role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          <p>{ts(`guidedSetup.refused.${view.refused.reason}`)}</p>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center gap-2 flex-wrap">
        {canSkip && (
          <Button
            size="sm"
            variant="outline"
            disabled={isBusy}
            onClick={() => void skip(view.step as GuidedSetupSkippableStep)}
          >
            {t('guidedSetup.actions.skipStep')}
          </Button>
        )}

        {view.step === 'basics' && view.account === 'family' && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              beginFormPath();
              openUI('createStudent');
            }}
          >
            {t('guidedSetup.actions.useForm')}
          </Button>
        )}

        <div className="flex-1" />

        {!view.studentId && (
          <Button size="sm" variant="ghost" onClick={() => void notNow()}>
            {t('guidedSetup.actions.notNow')}
          </Button>
        )}

        {!!view.studentId && (
          <Button size="sm" variant="ghost" disabled={isBusy} onClick={() => void dismiss()}>
            {t('guidedSetup.actions.finishLater')}
          </Button>
        )}
      </div>
    </div>
  );
}
