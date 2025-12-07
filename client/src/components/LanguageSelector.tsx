import { Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLanguage } from "@/contexts/LanguageContext";

export function LanguageSelector() {
  const { language, setLanguage, t } = useLanguage();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="text-sm font-medium text-gray-700 hover:text-gray-900 bg-transparent border-none outline-none focus:outline-none cursor-pointer p-0 m-0" style={{border: 'none', outline: 'none', boxShadow: 'none'}}>
          {language === 'en' ? 'US' : 'IL'}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem 
          onClick={() => setLanguage('en')}
          className={language === 'en' ? 'font-bold' : ''}
        >
          {t('language.english')}
        </DropdownMenuItem>
        <DropdownMenuItem 
          onClick={() => setLanguage('he')}
          className={language === 'he' ? 'font-bold' : ''}
        >
          {t('language.hebrew')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}