// client/src/features/guided-setup/RosterReviewTable.tsx
//
// Guided Setup step 1 for a SCHOOL or CLINIC (Phase D, plan §3.5 / §3.7).
//
// The AI reads an uploaded roster and PROPOSES rows; this table is where a
// human checks them before anything is created. That order is the whole point:
// a model misreading a birth date silently is how a child ends up with the
// wrong consent notice, so the rows land here as editable text, warnings and
// all, and nothing exists in the database until the button is pressed.
//
// The rows are sent back verbatim (with the user's edits) — the SERVER
// re-validates and re-normalises every cell, so nothing here needs to be
// authoritative. Local state is a draft, not a source of truth.

import { useEffect, useMemo, useState } from 'react';

import { useLanguage } from '@/contexts/LanguageContext';
import { useStudentLabel } from '@/hooks/useStudentLabel';
import { cn } from '@/lib/utils';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Loader2 } from 'lucide-react';

import type {
  GuidedSetupRosterConfirmResult,
  GuidedSetupRosterProposal,
  GuidedSetupRosterRow,
} from '@shared/guided-setup';

import { useGuidedSetup } from './useGuidedSetup';

type Outcome = Omit<GuidedSetupRosterConfirmResult, 'view'>;

/** The editable text columns, in reading order. */
const TEXT_COLUMNS: Array<{
  field: keyof GuidedSetupRosterRow;
  labelKey: string;
  width: string;
  placeholder?: string;
}> = [
  { field: 'firstName', labelKey: 'firstName', width: 'w-32' },
  { field: 'lastName', labelKey: 'lastName', width: 'w-32' },
  { field: 'birthDate', labelKey: 'birthDate', width: 'w-32', placeholder: 'YYYY-MM-DD' },
];

const TAIL_COLUMNS: Array<{ field: keyof GuidedSetupRosterRow; labelKey: string; width: string }> = [
  { field: 'grade', labelKey: 'grade', width: 'w-24' },
  { field: 'idNumber', labelKey: 'idNumber', width: 'w-28' },
  { field: 'guardianName', labelKey: 'guardianName', width: 'w-36' },
  { field: 'guardianEmail', labelKey: 'guardianEmail', width: 'w-44' },
  { field: 'guardianPhone', labelKey: 'guardianPhone', width: 'w-32' },
];

/** The three values `students.gender` ever holds, with the labels that ship. */
const GENDERS: Array<{ value: string; labelKey: string }> = [
  { value: 'male', labelKey: 'student.genderMale' },
  { value: 'female', labelKey: 'student.genderFemale' },
  { value: 'other', labelKey: 'student.genderOther' },
];

export function RosterReviewTable({ proposal }: { proposal: GuidedSetupRosterProposal }) {
  const { t } = useLanguage();
  const { ts } = useStudentLabel();
  const { confirmRoster, isBusy } = useGuidedSetup();

  // The proposal is the server's; the draft is the user's. Re-seeding on a new
  // proposal id (a second upload) is deliberate — re-seeding on every render of
  // the same one would eat every keystroke.
  const [rows, setRows] = useState<GuidedSetupRosterRow[]>(proposal.rows);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    setRows(proposal.rows);
    setOutcome(null);
  }, [proposal.id, proposal.rows]);

  const includedCount = useMemo(() => rows.filter((r) => r.include).length, [rows]);

  const patch = (rowId: string, field: keyof GuidedSetupRosterRow, value: string | boolean) => {
    setRows((prev) =>
      prev.map((r) =>
        r.rowId === rowId
          ? { ...r, [field]: typeof value === 'string' ? (value.trim() === '' ? null : value) : value }
          : r,
      ),
    );
  };

  const submit = async () => {
    const result = await confirmRoster(proposal.id, rows);
    if (result) setOutcome(result);
  };

  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        {t('guidedSetup.roster.empty')}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{t('guidedSetup.roster.title')}</h3>
          <p className="text-xs text-muted-foreground">{ts('guidedSetup.roster.subtitle')}</p>
        </div>
        <span className="text-xs text-muted-foreground">
          {proposal.remainingSeats === -1
            ? t('guidedSetup.roster.seatsUnlimited')
            : t('guidedSetup.roster.seats', { count: proposal.remainingSeats })}
        </span>
      </div>

      {/* A roster is wider than any panel. It scrolls in its own box so the page
          itself never scrolls sideways. */}
      <div className="overflow-x-auto border border-border rounded-md max-h-80 overflow-y-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm">
            <tr className="text-start">
              <th className="p-1.5 font-medium text-start w-10">{t('guidedSetup.roster.include')}</th>
              {TEXT_COLUMNS.map((c) => (
                <th key={c.field} className="p-1.5 font-medium text-start">
                  {t(`guidedSetup.roster.${c.labelKey}`)}
                </th>
              ))}
              <th className="p-1.5 font-medium text-start">{t('guidedSetup.roster.gender')}</th>
              {TAIL_COLUMNS.map((c) => (
                <th key={c.field} className="p-1.5 font-medium text-start">
                  {t(`guidedSetup.roster.${c.labelKey}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.rowId}
                className={cn(
                  'border-t border-border align-top',
                  !row.include && 'opacity-50',
                  row.warnings.includes('missingName') && 'bg-destructive/5',
                )}
              >
                <td className="p-1.5">
                  <Checkbox
                    checked={row.include}
                    onCheckedChange={(v) => patch(row.rowId, 'include', v === true)}
                    aria-label={t('guidedSetup.roster.include')}
                  />
                </td>

                {TEXT_COLUMNS.map((c) => (
                  <td key={c.field} className={cn('p-1', c.width)}>
                    <Input
                      className="h-7 text-xs"
                      value={(row[c.field] as string | null) ?? ''}
                      placeholder={c.placeholder}
                      onChange={(e) => patch(row.rowId, c.field, e.target.value)}
                      aria-label={t(`guidedSetup.roster.${c.labelKey}`)}
                    />
                    {/* Warnings sit under the first column so one row reads as
                        one row, however far it scrolls. */}
                    {c.field === 'firstName' && row.warnings.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {row.warnings.map((w) => (
                          <Badge
                            key={w}
                            variant={
                              w === 'missingName' || w === 'overCap' ? 'destructive' : 'secondary'
                            }
                            className="text-[10px] px-1 py-0 font-normal"
                          >
                            {t(`guidedSetup.roster.warn.${w}`)}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </td>
                ))}

                <td className="p-1 w-24">
                  <select
                    className="h-7 w-full rounded-md border border-input bg-background px-1 text-xs"
                    value={row.gender ?? ''}
                    onChange={(e) => patch(row.rowId, 'gender', e.target.value)}
                    aria-label={t('guidedSetup.roster.gender')}
                  >
                    <option value="">—</option>
                    {GENDERS.map((g) => (
                      <option key={g.value} value={g.value}>
                        {t(g.labelKey)}
                      </option>
                    ))}
                  </select>
                </td>

                {TAIL_COLUMNS.map((c) => (
                  <td key={c.field} className={cn('p-1', c.width)}>
                    <Input
                      className="h-7 text-xs"
                      value={(row[c.field] as string | null) ?? ''}
                      onChange={(e) => patch(row.rowId, c.field, e.target.value)}
                      aria-label={t(`guidedSetup.roster.${c.labelKey}`)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <Button size="sm" disabled={isBusy || includedCount === 0} onClick={() => void submit()}>
          {isBusy && <Loader2 className="w-3.5 h-3.5 me-1.5 animate-spin" />}
          {ts('guidedSetup.roster.create', { count: includedCount })}
        </Button>

        {outcome && (
          <span className="text-xs text-muted-foreground">
            {t('guidedSetup.roster.created', { count: outcome.created.length })}
            {' · '}
            {t('guidedSetup.roster.skipped', { count: outcome.skipped.length })}
            {outcome.failed.length > 0 && (
              <span className="text-destructive">
                {' · '}
                {t('guidedSetup.roster.failed', { count: outcome.failed.length })}
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
