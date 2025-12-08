// src/features/DocuSLPPanel.tsx
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { cn } from '@/lib/utils';

interface DocuSLPPanelProps {
  isOpen: boolean;
  onClose?: () => void;
}

export function DocuSLPPanel({ isOpen, onClose }: DocuSLPPanelProps) {
  const { t, isRTL } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  if (!isOpen) return null;

  return (
    <div className={cn(
      'flex flex-col h-full min-h-0 items-center justify-center',
      isDark ? 'bg-slate-950' : 'bg-gray-50'
    )}>
      <div className={cn(
        'text-center p-8',
        isDark ? 'text-slate-400' : 'text-gray-500'
      )}>
        <h2 className="text-xl font-semibold mb-2">{t('nav.docuslp')}</h2>
        <p className="text-sm">{t('features.comingSoon')}: {t('features.docuslpDesc')}</p>
      </div>
    </div>
  );
}