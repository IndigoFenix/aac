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
} from "@/components/ui/dropdown-menu";
import { Globe } from "lucide-react";
import { useLanguage, type LanguageCode } from "@/contexts/LanguageContext";
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
  const { language, languageInfo, setLanguage, supportedLanguages, isRTL, t } = useLanguage();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("gap-2", className)}
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
