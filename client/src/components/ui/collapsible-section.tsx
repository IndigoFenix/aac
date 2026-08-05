// Collapsible settings sections.
//
// Both of these lived privately inside AACSettingsPanel.tsx, which meant a
// component defined anywhere else could not render as a real settings section —
// it could only drop a bare <Card> into someone else's section body and look
// subtly out of place. Extracted so the AAC settings page has ONE definition of
// what a section looks like, wherever the section's contents come from.

import { useState, type ReactNode } from 'react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/** A top-level settings section: a whole Card whose header toggles the body. */
export function CollapsibleSection({
  icon,
  title,
  description,
  defaultOpen = false,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button type="button" className="w-full text-start">
            <CardHeader
              className={cn(
                'cursor-pointer transition-colors hover:bg-muted/40',
                open ? 'rounded-t-lg' : 'rounded-lg',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                  {icon}
                  {title}
                </CardTitle>
                <ChevronDown
                  className={cn(
                    'w-5 h-5 shrink-0 text-muted-foreground transition-transform',
                    open && 'rotate-180',
                  )}
                />
              </div>
              {description && <CardDescription>{description}</CardDescription>}
            </CardHeader>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>{children}</CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

/**
 * A nested collapsible group used INSIDE a CollapsibleSection's content (e.g. the
 * "Visibility" group under Accessibility, or "YouTube" / "Websites" under Apps).
 * Visually a bordered box with a clickable header; pass the existing
 * `<CardContent>` as children so the body keeps its own padding/spacing.
 */
export function CollapsibleSubSection({
  icon,
  title,
  description,
  defaultOpen = false,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border bg-card">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button type="button" className="w-full text-start">
            <div className="flex items-center justify-between gap-2 px-6 py-4 transition-colors hover:bg-muted/40">
              <div className="space-y-1">
                <div className="flex items-center gap-2 font-semibold leading-none">
                  {icon}
                  {title}
                </div>
                {description && (
                  <p className="text-sm text-muted-foreground">{description}</p>
                )}
              </div>
              <ChevronDown
                className={cn(
                  'w-4 h-4 shrink-0 text-muted-foreground transition-transform',
                  open && 'rotate-180',
                )}
              />
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>{children}</CollapsibleContent>
      </Collapsible>
    </div>
  );
}
