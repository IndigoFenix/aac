// src/components/admin/LicenseStudents.tsx
// Admin: students belonging to a license's institute, with a snapshot of each
// student's AAC token-budget tier. Selecting a student opens the budget editor.

import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useLicense, useLicenseStudents, type StudentBudget } from '@/hooks/useAdminData';
import { useLanguage } from '@/contexts/LanguageContext';
import { tierByKey } from '@shared/aac/budget-tiers';

function studentDisplayName(s: StudentBudget): string {
  const name = [s.firstName, s.lastName].filter(Boolean).join(' ').trim();
  return name || s.name || s.id;
}

function tierLabel(key: string | null): string {
  const tier = tierByKey(key);
  return `${tier.key.charAt(0).toUpperCase() + tier.key.slice(1)} — $${tier.priceMonthly}/mo`;
}

interface LicenseStudentsProps {
  licenseId: string;
}

export function LicenseStudents({ licenseId }: LicenseStudentsProps) {
  const { t, isRTL } = useLanguage();
  const [, navigate] = useLocation();
  const { data: license } = useLicense(licenseId);
  const { data, isLoading, error } = useLicenseStudents(licenseId);

  const students = data?.students ?? [];
  const BackIcon = isRTL ? ChevronRight : ChevronLeft;

  return (
    <div className="space-y-6">
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="mb-2 -ms-2"
          onClick={() => navigate('/admin/licenses')}
          data-testid="button-back-to-licenses"
        >
          <BackIcon className="w-4 h-4 me-1" />
          {t('admin.budget.backToLicenses')}
        </Button>
        <h1 className="text-2xl font-bold">
          {license?.name || license?.instituteName || t('admin.budget.title')}
        </h1>
        <p className="text-muted-foreground">{t('admin.budget.studentsSubtitle')}</p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="flex items-center justify-center h-64">
          <p className="text-destructive">{t('admin.budget.loadError')}</p>
        </div>
      ) : students.length > 0 ? (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('admin.budget.studentName')}</TableHead>
                <TableHead>{t('admin.budget.tier')}</TableHead>
                <TableHead className="w-[40px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {students.map((s) => (
                <TableRow
                  key={s.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/admin/licenses/${licenseId}/students/${s.id}`)}
                  data-testid={`row-student-${s.id}`}
                >
                  <TableCell className="font-medium">{studentDisplayName(s)}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{tierLabel(s.budgetTier)}</Badge>
                  </TableCell>
                  <TableCell>
                    <ChevronRight className="w-4 h-4 text-muted-foreground rtl:rotate-180" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-12 border rounded-md">
          <p className="text-muted-foreground">{t('admin.budget.noStudents')}</p>
        </div>
      )}
    </div>
  );
}
