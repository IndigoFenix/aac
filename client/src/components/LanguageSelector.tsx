// src/components/LanguageSelector.tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Globe } from 'lucide-react';
import { useLanguage, SUPPORTED_LANGUAGES, LanguageCode } from '@/contexts/LanguageContext';
import { cn } from '@/lib/utils';

interface LanguageSelectorProps {
  variant?: 'icon' | 'full';
  className?: string;
}

export function LanguageSelector({ 
  variant = 'icon',
  className 
}: LanguageSelectorProps) {
  const { language, setLanguage, languageInfo, isRTL } = useLanguage();
  const [open, setOpen] = useState(false);

  const handleLanguageChange = (code: LanguageCode) => {
    setLanguage(code);
    setOpen(false);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={variant === 'icon' ? 'icon' : 'sm'}
          className={cn(
            'gap-2',
            isRTL && 'flex-row-reverse',
            className
          )}
          aria-label="Select language"
        >
          <Globe className="w-4 h-4" />
          {variant === 'full' && (
            <span className="text-sm">{languageInfo.nativeName}</span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent 
        align={isRTL ? 'start' : 'end'} 
        className="w-48"
      >
        {SUPPORTED_LANGUAGES.map((lang) => (
          <DropdownMenuItem
            key={lang.code}
            onClick={() => handleLanguageChange(lang.code)}
            className={cn(
              'flex items-center justify-between cursor-pointer',
              language === lang.code && 'bg-accent',
              lang.direction === 'rtl' && 'flex-row-reverse text-right'
            )}
          >
            <span>{lang.nativeName}</span>
            <span className="text-xs text-muted-foreground">
              {lang.name}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}