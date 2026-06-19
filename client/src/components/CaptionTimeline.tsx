// client/src/components/CaptionTimeline.tsx
//
// A compact horizontal stepper for the Video Caption Studio, so the user can
// see where they are in the pipeline: Video → Transcript → Key ideas → Glyphs.
// Purely presentational — the panel computes each step's status.

import { Check, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type StepStatus = 'idle' | 'active' | 'done' | 'error';

export interface TimelineStep {
  key: string;
  label: string;
  status: StepStatus;
}

function StepDot({ step, index }: { step: TimelineStep; index: number }) {
  const { status } = step;
  return (
    <div className="flex flex-col items-center gap-1 min-w-0">
      <div
        className={cn(
          'flex items-center justify-center w-7 h-7 rounded-full border text-xs font-medium shrink-0',
          status === 'done' && 'bg-primary border-primary text-primary-foreground',
          status === 'active' && 'border-primary text-primary',
          status === 'error' && 'border-destructive text-destructive',
          status === 'idle' && 'border-muted-foreground/30 text-muted-foreground',
        )}
        data-testid={`caption-step-${step.key}`}
        data-status={status}
      >
        {status === 'done' ? (
          <Check className="w-4 h-4" />
        ) : status === 'active' ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : status === 'error' ? (
          <X className="w-4 h-4" />
        ) : (
          index + 1
        )}
      </div>
      <span
        className={cn(
          'text-[11px] leading-tight text-center truncate max-w-[5.5rem]',
          status === 'idle' ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {step.label}
      </span>
    </div>
  );
}

export function CaptionTimeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <div className="flex items-start gap-1" data-testid="caption-timeline">
      {steps.map((step, i) => (
        <div key={step.key} className="flex items-start gap-1 flex-1 min-w-0">
          <StepDot step={step} index={i} />
          {i < steps.length - 1 && (
            <div
              className={cn(
                'flex-1 h-px mt-3.5',
                steps[i + 1].status !== 'idle' || step.status === 'done'
                  ? 'bg-primary/50'
                  : 'bg-muted-foreground/20',
              )}
            />
          )}
        </div>
      ))}
    </div>
  );
}
