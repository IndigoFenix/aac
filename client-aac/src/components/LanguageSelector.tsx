/**
 * Language Selector Component
 * Uses LanguageContext for state management
 */

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Globe, Check } from "lucide-react";
import { useLanguage, type LanguageCode, type SignLanguageCode } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";

interface LanguageSelectorProps {
  /** Display variant: 'icon' for icon only, 'full' for icon + name */
  variant?: "icon" | "full";
  className?: string;
}

export function LanguageSelector({
  variant = "icon",
  className = ""
}: LanguageSelectorProps) {
  const { language, languageInfo, setLanguage, supportedLanguages, isRTL, t, signLanguage, setSignLanguage, supportedSignLanguages } = useLanguage();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn("gap-2 text-white hover:text-gray-200 hover:bg-white/10", className)}
        >
          <Globe className="h-4 w-4" />
          {variant === "full" && (
            <span>{languageInfo.nativeName}</span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={isRTL ? "start" : "end"}
        className="min-w-[150px]"
      >
        {supportedLanguages.map((lang) => (
          <DropdownMenuItem
            key={lang.code}
            onClick={() => setLanguage(lang.code as LanguageCode)}
            className={cn(
              "cursor-pointer flex items-center justify-between",
              language === lang.code && "bg-accent"
            )}
            style={{
              direction: lang.direction,
            }}
          >
            <span className="font-medium">{lang.nativeName}</span>
            {lang.code !== language && (
              <span className="text-xs text-muted-foreground ms-2">
                {lang.name}
              </span>
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">{t('profile.signLanguage')}</DropdownMenuLabel>
        {supportedSignLanguages.map((sl) => (
          <DropdownMenuItem
            key={sl.code}
            onClick={() => setSignLanguage(signLanguage === sl.code ? null : sl.code as SignLanguageCode)}
            className="cursor-pointer flex items-center justify-between"
          >
            <span className="font-medium">{sl.nativeName}</span>
            <span className="flex items-center gap-1">
              {signLanguage !== sl.code && (
                <span className="text-xs text-muted-foreground">{sl.name}</span>
              )}
              {signLanguage === sl.code && (
                <Check className="h-4 w-4 text-green-600" />
              )}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
