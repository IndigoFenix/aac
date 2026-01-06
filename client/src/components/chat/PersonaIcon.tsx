// src/components/chat/PersonaIcon.tsx
// Shared component that renders persona icons based on icon name from PersonaInfo

import { 
    Bot, 
    Target, 
    Stethoscope, 
    GraduationCap, 
    Activity, 
    MessageCircle, 
    Hand, 
    Brain,
    LucideIcon
  } from 'lucide-react';
  import { PersonaIconName, PersonaInfo, CHAT_PERSONAS } from '@/hooks/useChat';
  import { cn } from '@/lib/utils';
import { ChatPersona } from '@shared/schema';
  
  // Map icon names to Lucide components
  const ICON_MAP: Record<PersonaIconName, LucideIcon> = {
    Bot,
    Target,
    Stethoscope,
    GraduationCap,
    Activity,
    MessageCircle,
    Hand,
    Brain,
  };
  
  interface PersonaIconProps {
    /** Persona ID or PersonaInfo object */
    persona: ChatPersona | PersonaInfo;
    /** Icon size: 'sm' = 12px, 'md' = 16px, 'lg' = 20px */
    size?: 'sm' | 'md' | 'lg';
    /** Additional CSS classes */
    className?: string;
    /** Whether to include the colored background wrapper */
    withBackground?: boolean;
  }
  
  const SIZE_CLASSES = {
    sm: 'w-3 h-3',
    md: 'w-4 h-4',
    lg: 'w-5 h-5',
  };
  
  const BG_SIZE_CLASSES = {
    sm: 'w-5 h-5',
    md: 'w-6 h-6',
    lg: 'w-8 h-8',
  };
  
  /**
   * Renders a persona icon based on the persona ID or PersonaInfo
   * Can optionally wrap with a colored background circle
   */
  export function PersonaIcon({ 
    persona, 
    size = 'md', 
    className,
    withBackground = false 
  }: PersonaIconProps) {
    // Get PersonaInfo if only ID was passed
    const personaInfo: PersonaInfo | undefined = 
      typeof persona === 'string' 
        ? CHAT_PERSONAS.find(p => p.id === persona)
        : persona;
  
    if (!personaInfo) {
      // Fallback to Bot icon if persona not found
      const Icon = Bot;
      return <Icon className={cn(SIZE_CLASSES[size], className)} />;
    }
  
    const Icon = ICON_MAP[personaInfo.iconName] || Bot;
  
    if (withBackground) {
      return (
        <div className={cn(
          "rounded-full flex items-center justify-center",
          BG_SIZE_CLASSES[size],
          personaInfo.color,
          className
        )}>
          <Icon className={cn(SIZE_CLASSES[size], personaInfo.textColor)} />
        </div>
      );
    }
  
    return <Icon className={cn(SIZE_CLASSES[size], personaInfo.textColor, className)} />;
  }
  
  /**
   * Get combined color classes for a persona (background + text)
   */
  export function getPersonaColorClasses(persona: ChatPersona | PersonaInfo): string {
    const personaInfo: PersonaInfo | undefined = 
      typeof persona === 'string' 
        ? CHAT_PERSONAS.find(p => p.id === persona)
        : persona;
  
    if (!personaInfo) {
      return 'bg-primary/10 text-primary';
    }
  
    return cn(personaInfo.color, personaInfo.textColor);
  }
  
  export default PersonaIcon;