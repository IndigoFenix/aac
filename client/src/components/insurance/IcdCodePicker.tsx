// ICD-10 code picker for the Insurance Bridge module. Searchable combobox
// over a curated, regime-tagged list. Free-text fallback retained — when
// the typed value doesn't exist in the curated set, it's still accepted
// (some payers want codes outside the AAC subset). A specificity warning
// is surfaced for "unspecified" codes (e.g. F80.9, F84.9), which insurers
// frequently reject for AAC LMNs.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Check, ChevronDown, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BillingRegime } from '@shared/license-permissions';

interface IcdCode {
  code: string;
  description: string;
  category: string;
  unspecified: boolean;
  regimes: string[];
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  regime?: BillingRegime;
  /** Renders an extra free-text input next to the picker for codes outside the curated set. */
  allowFreeText?: boolean;
  placeholder?: string;
  disabled?: boolean;
  testId?: string;
}

export function IcdCodePicker({
  value,
  onChange,
  regime,
  allowFreeText = true,
  placeholder,
  disabled,
  testId,
}: Props) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const lastFetchedRef = useRef('');

  const regimeParam = regime && regime !== 'none' ? `&regime=${encodeURIComponent(regime)}` : '';

  const { data, isFetching } = useQuery<{ success: boolean; codes: IcdCode[] }>({
    queryKey: ['insurance', 'icd10', regime ?? 'any', query],
    enabled: open,
    queryFn: async () => {
      lastFetchedRef.current = query;
      const res = await apiRequest(
        'GET',
        `/api/insurance/icd10?q=${encodeURIComponent(query)}${regimeParam}&limit=30`,
      );
      return res.json();
    },
  });

  const codes = data?.codes ?? [];

  // Look up the selected value's metadata so we can show the specificity
  // warning even when the popover is closed. We piggy-back on the latest
  // query data when possible; otherwise we fire a one-shot exact lookup.
  const exactMatch: IcdCode | undefined = useMemo(() => {
    if (!value) return undefined;
    return codes.find((c) => c.code.toUpperCase() === value.toUpperCase());
  }, [codes, value]);

  // Cached result for the value when not present in the current search
  // results (so the warning persists across edits).
  const [cachedExact, setCachedExact] = useState<IcdCode | null>(null);
  useEffect(() => {
    if (!value) {
      setCachedExact(null);
      return;
    }
    if (exactMatch) {
      setCachedExact(exactMatch);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest(
          'GET',
          `/api/insurance/icd10?q=${encodeURIComponent(value)}${regimeParam}&limit=5`,
        );
        const json = (await res.json()) as { success: boolean; codes: IcdCode[] };
        if (cancelled) return;
        const hit = json.codes.find((c) => c.code.toUpperCase() === value.toUpperCase());
        setCachedExact(hit ?? null);
      } catch {
        if (!cancelled) setCachedExact(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [value, regimeParam, exactMatch]);

  const selectedCode = exactMatch ?? cachedExact;
  const showSpecificityWarning = selectedCode?.unspecified === true;

  const triggerLabel = value
    ? selectedCode
      ? `${selectedCode.code} — ${selectedCode.description}`
      : value
    : placeholder ?? t('insurance.icd.placeholder') ?? 'Search ICD-10…';

  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              disabled={disabled}
              className="flex-1 justify-between font-normal"
              data-testid={testId ?? 'icd-picker-trigger'}
            >
              <span className="truncate text-start">{triggerLabel}</span>
              <ChevronDown className="ms-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
            <Command shouldFilter={false}>
              <CommandInput
                placeholder={t('insurance.icd.searchPlaceholder') ?? 'Type code or description…'}
                value={query}
                onValueChange={setQuery}
              />
              <CommandList>
                {!isFetching && codes.length === 0 && (
                  <CommandEmpty>
                    {t('insurance.icd.noMatches') ?? 'No curated codes match.'}
                  </CommandEmpty>
                )}
                <CommandGroup>
                  {codes.map((c) => (
                    <CommandItem
                      key={c.code}
                      value={c.code}
                      onSelect={() => {
                        onChange(c.code);
                        setCachedExact(c);
                        setOpen(false);
                      }}
                      className="flex items-start gap-2"
                    >
                      <Check
                        className={cn(
                          'mt-0.5 h-4 w-4',
                          value.toUpperCase() === c.code.toUpperCase() ? 'opacity-100' : 'opacity-0',
                        )}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm">{c.code}</span>
                          {c.unspecified && (
                            <span className="text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
                              {t('insurance.icd.unspecifiedTag') ?? 'unspecified'}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {c.description}
                        </div>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {allowFreeText && (
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder={t('insurance.icd.freeTextPlaceholder') ?? 'or type a code'}
            className="w-32 font-mono"
            data-testid={`${testId ?? 'icd-picker'}-freetext`}
          />
        )}
      </div>
      {showSpecificityWarning && (
        <div
          className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-2 text-xs text-amber-800 dark:text-amber-200"
          data-testid="icd-specificity-warning"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            {t('insurance.icd.specificityWarning') ??
              'This is an "unspecified" code. Insurers frequently reject these for AAC letters of medical necessity — pick a more specific code if one applies.'}
          </span>
        </div>
      )}
    </div>
  );
}
