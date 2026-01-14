// src/components/chat/PersonaIcon.tsx
// Shared component that renders persona icons based on icon (emoji) from PersonaInfo

import { Bot } from 'lucide-react';
import { PersonaInfo, useChatPersona } from '@/hooks/useChat';
import { cn } from '@/lib/utils';

const SIZE_CLASSES = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-base',
};

const BG_SIZE_CLASSES = {
  sm: 'w-5 h-5',
  md: 'w-6 h-6',
  lg: 'w-8 h-8',
};

interface PersonaIconProps {
  /** Persona ID (UUID) or PersonaInfo object */
  persona: string | PersonaInfo | undefined;
  /** Icon size: 'sm' = 12px, 'md' = 16px, 'lg' = 20px */
  size?: 'sm' | 'md' | 'lg';
  /** Additional CSS classes */
  className?: string;
  /** Whether to include the colored background wrapper */
  withBackground?: boolean;
}

/**
 * Renders a persona icon (emoji) based on the persona ID or PersonaInfo
 * Can optionally wrap with a colored background circle
 */
export function PersonaIcon({
  persona,
  size = 'md',
  className,
  withBackground = false
}: PersonaIconProps) {
  const { getPersonaInfo } = useChatPersona();

  // Get PersonaInfo if only ID was passed
  const personaInfo: PersonaInfo | undefined =
    typeof persona === 'string'
      ? getPersonaInfo(persona)
      : persona;

  // If no persona found, show default bot icon
  if (!personaInfo) {
    if (withBackground) {
      return (
        <div className={cn(
          "rounded-full flex items-center justify-center bg-primary/10",
          BG_SIZE_CLASSES[size],
          className
        )}>
          <Bot className={cn('w-4 h-4 text-primary')} />
        </div>
      );
    }
    return <Bot className={cn('w-4 h-4 text-primary', className)} />;
  }

  // Render emoji icon from database
  const icon = personaInfo.icon || '🤖';

  if (withBackground) {
    return (
      <div className={cn(
        "rounded-full flex items-center justify-center bg-primary/10",
        BG_SIZE_CLASSES[size],
        className
      )}>
        <span className={SIZE_CLASSES[size]}>{icon}</span>
      </div>
    );
  }

  return <span className={cn(SIZE_CLASSES[size], className)}>{icon}</span>;
}

/**
 * Get combined color classes for a persona (background + text)
 * Returns default styling since database personas don't have color fields
 */
export function getPersonaColorClasses(_persona: string | PersonaInfo | undefined): string {
  return 'bg-primary/10 text-primary';
}

export default PersonaIcon;