// src/features/DownloadsPanel.tsx
// Downloads page for the AAC student app — the Windows (Electron) installer
// and the iPad (Capacitor) .ipa.
//
// The two platforms are deliberately asymmetric. Windows is a one-click
// installer that auto-updates itself afterwards. iPad has no App Store listing
// yet, so the .ipa must be re-signed onto the device with Sideloadly and the
// clinician needs the full walkthrough — that's why the iOS card carries a
// numbered procedure and the Windows card doesn't.
//
// Availability and version come from GET /api/app-downloads, which reads the
// release feeds' manifests server-side. The download button links STRAIGHT at
// the CDN (public objects, ~200 MB) rather than routing bytes through the API.

import { useQuery } from '@tanstack/react-query';
import { useLanguage } from '@/contexts/LanguageContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  MonitorDown,
  Download,
  Tablet,
  Loader2,
  ExternalLink,
  Info,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiRequest } from '@/lib/queryClient';
import type { AppDownloadInfo, AppDownloadsResponse } from '@shared/app-downloads';

interface DownloadsPanelProps {
  isOpen?: boolean;
}

const SIDELOADLY_URL = 'https://sideloadly.io';

/** Bytes → "204 MB". Sizes here are always installer-scale, so MB is enough. */
function formatSize(bytes: number | null, locale: string): string | null {
  if (!bytes || bytes <= 0) return null;
  return `${new Intl.NumberFormat(locale).format(Math.round(bytes / 1_000_000))} MB`;
}

/** ISO timestamp → a locale date, or null if the manifest didn't carry one. */
function formatDate(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function DownloadsPanel(_props: DownloadsPanelProps) {
  const { t, isRTL, language } = useLanguage();

  const { data, isLoading, isError, refetch, isFetching } = useQuery<AppDownloadsResponse>({
    queryKey: ['/api/app-downloads'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/app-downloads');
      return res.json();
    },
    // The feed changes only on release; don't re-poll while the panel is open.
    staleTime: 5 * 60_000,
  });

  /** Version + size + date line, or the "not published yet" note. */
  const BuildMeta = ({ info }: { info: AppDownloadInfo }) => {
    if (!info.available) {
      return (
        <p className="text-sm text-muted-foreground">{t('downloads.notPublished')}</p>
      );
    }
    const size = formatSize(info.sizeBytes, language);
    const date = formatDate(info.releaseDate, language);
    return (
      <div className={cn('flex flex-wrap items-center gap-2', isRTL && 'flex-row-reverse')}>
        <Badge variant="secondary">{t('downloads.version', { version: info.version ?? '' })}</Badge>
        {size && <span className="text-sm text-muted-foreground">{size}</span>}
        {date && (
          <span className="text-sm text-muted-foreground">
            {t('downloads.released', { date })}
          </span>
        )}
      </div>
    );
  };

  /** The download button — disabled, with an explanation, when nothing is published. */
  const DownloadButton = ({ info, label }: { info: AppDownloadInfo; label: string }) => {
    if (!info.available || !info.downloadUrl) {
      return (
        <Button disabled className={cn(isRTL && 'flex-row-reverse')}>
          <Download className="w-4 h-4 me-2" />
          {label}
        </Button>
      );
    }
    return (
      <Button asChild className={cn(isRTL && 'flex-row-reverse')}>
        {/* Straight to the CDN. `download` makes the browser save rather than
            navigate, and the filename is already the versioned one. */}
        <a href={info.downloadUrl} download data-testid={`download-${info.platform}`}>
          <Download className="w-4 h-4 me-2" />
          {label}
        </a>
      </Button>
    );
  };

  /** One numbered step in the Sideloadly walkthrough. */
  const Step = ({ n, children }: { n: number; children: React.ReactNode }) => (
    <li className={cn('flex gap-3', isRTL && 'flex-row-reverse text-right')}>
      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-muted text-muted-foreground text-xs font-semibold flex items-center justify-center">
        {n}
      </span>
      <span className="text-sm leading-6">{children}</span>
    </li>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className={cn('flex items-center justify-between p-4 border-b', isRTL && 'flex-row-reverse')}>
        <div className={cn('flex items-center gap-2', isRTL && 'flex-row-reverse')}>
          <MonitorDown className="h-5 w-5" />
          <h2 className="text-lg font-semibold">{t('downloads.title')}</h2>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="downloads-refresh"
        >
          {isFetching ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className={cn('p-4 space-y-6 max-w-3xl', isRTL && 'text-right')}>
          <p className="text-sm text-muted-foreground">{t('downloads.subtitle')}</p>

          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('downloads.loading')}
            </div>
          )}

          {isError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{t('downloads.loadFailed')}</AlertDescription>
            </Alert>
          )}

          {data && (
            <>
              {/* ── Windows ─────────────────────────────────────────────── */}
              <Card data-testid="downloads-windows">
                <CardHeader>
                  <CardTitle className={cn('flex items-center gap-2', isRTL && 'flex-row-reverse')}>
                    <MonitorDown className="w-5 h-5" />
                    {t('downloads.windows.title')}
                  </CardTitle>
                  <CardDescription>{t('downloads.windows.desc')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <BuildMeta info={data.windows} />
                  <DownloadButton info={data.windows} label={t('downloads.windows.button')} />

                  <Separator />

                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold">{t('downloads.windows.installTitle')}</h4>
                    <ol className="space-y-2">
                      <Step n={1}>{t('downloads.windows.step1')}</Step>
                      <Step n={2}>{t('downloads.windows.step2')}</Step>
                      <Step n={3}>{t('downloads.windows.step3')}</Step>
                    </ol>
                  </div>

                  <Alert>
                    <Info className="h-4 w-4" />
                    <AlertDescription>{t('downloads.windows.autoUpdateNote')}</AlertDescription>
                  </Alert>
                </CardContent>
              </Card>

              {/* ── iPad ────────────────────────────────────────────────── */}
              <Card data-testid="downloads-ios">
                <CardHeader>
                  <CardTitle className={cn('flex items-center gap-2', isRTL && 'flex-row-reverse')}>
                    <Tablet className="w-5 h-5" />
                    {t('downloads.ios.title')}
                  </CardTitle>
                  <CardDescription>{t('downloads.ios.desc')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <BuildMeta info={data.ios} />
                  <DownloadButton info={data.ios} label={t('downloads.ios.button')} />

                  <Alert>
                    <Info className="h-4 w-4" />
                    <AlertDescription>{t('downloads.ios.whyNote')}</AlertDescription>
                  </Alert>

                  <Separator />

                  <div className="space-y-3">
                    <h4 className="text-sm font-semibold">{t('downloads.ios.installTitle')}</h4>
                    <p className="text-sm text-muted-foreground">
                      {t('downloads.ios.needTitle')}
                    </p>
                    <ul className={cn('text-sm space-y-1 list-disc', isRTL ? 'pr-5' : 'pl-5')}>
                      <li>{t('downloads.ios.needComputer')}</li>
                      <li>{t('downloads.ios.needCable')}</li>
                      <li>{t('downloads.ios.needAppleId')}</li>
                    </ul>

                    <ol className="space-y-2 pt-1">
                      <Step n={1}>
                        {t('downloads.ios.step1')}{' '}
                        <a
                          href={SIDELOADLY_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary underline inline-flex items-center gap-1"
                        >
                          sideloadly.io
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </Step>
                      <Step n={2}>{t('downloads.ios.step2')}</Step>
                      <Step n={3}>{t('downloads.ios.step3')}</Step>
                      <Step n={4}>{t('downloads.ios.step4')}</Step>
                      <Step n={5}>{t('downloads.ios.step5')}</Step>
                      <Step n={6}>{t('downloads.ios.step6')}</Step>
                      <Step n={7}>{t('downloads.ios.step7')}</Step>
                    </ol>
                  </div>

                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>{t('downloads.ios.expiryWarning')}</AlertDescription>
                  </Alert>

                  <Alert>
                    <Info className="h-4 w-4" />
                    <AlertDescription>{t('downloads.ios.updateNote')}</AlertDescription>
                  </Alert>

                  <p className="text-xs text-muted-foreground">{t('downloads.ios.limitsNote')}</p>
                </CardContent>
              </Card>

              <p className="text-xs text-muted-foreground">{t('downloads.helpNote')}</p>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
