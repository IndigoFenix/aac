// client/src/components/venue-menus/VenueMenuSettingsCard.tsx
//
// The Location Menus settings editor (§4.7).
//
// CONTROLLED, not self-saving. It owns no state and no mutation: the panel
// holds `venueMenus`, feeds it in, and takes changes back out, so this rides
// the page's single Save and its dirty check like every other setting. An
// editor with its own Save button inside a page that already has one teaches a
// clinician that some settings save differently from others, which is the kind
// of thing people get wrong exactly once and then distrust the page.
//
// Two things this file is careful about:
//
//   1. `'auto'` is a STORED value, not a computed one (§4.8). The card shows
//      what auto currently resolves to for THIS student, but emits the string
//      'auto' — so the setting keeps tracking the child as they age instead of
//      freezing whatever was true the day a clinician opened this page.
//   2. There is deliberately NO allergen-filter switch (§4.7). A student with
//      no recorded allergies already has nothing filtered, so an off switch
//      buys no behaviour a real configuration needs — it only adds a way to
//      disable a safety control from a settings screen.
//
// See planning-docs/aac-restaurant-menus.md §4.7, §4.8.

import { useLanguage } from '@/contexts/LanguageContext';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import {
  resolveAutoDefaults,
  MIN_SEARCH_RADIUS_M,
  MAX_SEARCH_RADIUS_M,
  MIN_BROWSE_RADIUS_M,
  MAX_BROWSE_RADIUS_M,
  type VenueMenuSettings,
} from '@shared/venue-menus';

interface VenueMenuSettingsCardProps {
  settings: VenueMenuSettings;
  onChange: (next: VenueMenuSettings) => void;
  /** Only read for `birthDate` / `languageLevel`, to show what 'auto' means. */
  student?: any;
}

/** A labelled switch row, with an optional line of why-it-matters underneath. */
function ToggleRow({
  label,
  description,
  checked,
  onChange,
  testId,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  testId: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <Label className="text-sm">{label}</Label>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        data-testid={testId}
      />
    </div>
  );
}

export function VenueMenuSettingsCard({ settings, onChange, student }: VenueMenuSettingsCardProps) {
  const { t } = useLanguage();

  /** What 'auto' means for THIS student right now — shown, never saved. */
  const auto = resolveAutoDefaults(
    student?.birthDate,
    student?.aacSettings?.languageLevel ?? null,
    new Date(),
  );

  const patch = (changes: Partial<VenueMenuSettings>) => onChange({ ...settings, ...changes });

  const on = settings.enabled;

  // No card chrome: the subsection around this already supplies the title,
  // the description, and the collapse.
  return (
    <div className="space-y-3">
        <ToggleRow
          label={t('venueMenus.settings.enabled')}
          description={t('venueMenus.settings.enabledDesc')}
          checked={settings.enabled}
          onChange={(value) => patch({ enabled: value })}
          testId="venue-menus-enabled"
        />

        {/* Everything below is inert until the feature is on — shown rather
            than hidden so a clinician can see what turning it on will do. */}
        {on && (
          <>
            <Separator />
            <p className="text-xs font-medium text-muted-foreground">
              {t('venueMenus.settings.sectionSources')}
            </p>
            <ToggleRow
              label={t('venueMenus.settings.sourceCamera')}
              checked={settings.sources.camera}
              onChange={(value) => patch({ sources: { ...settings.sources, camera: value } })}
              testId="venue-source-camera"
            />
            <ToggleRow
              label={t('venueMenus.settings.sourceWeb')}
              description={t('venueMenus.settings.sourceWebDesc')}
              checked={settings.sources.web}
              onChange={(value) => patch({ sources: { ...settings.sources, web: value } })}
              testId="venue-source-web"
            />
            <ToggleRow
              label={t('venueMenus.settings.sourceManual')}
              checked={settings.sources.manual}
              onChange={(value) => patch({ sources: { ...settings.sources, manual: value } })}
              testId="venue-source-manual"
            />

            <Separator />
            <p className="text-xs font-medium text-muted-foreground">
              {t('venueMenus.settings.sectionDiscovery')}
            </p>

            <div className="flex items-center justify-between gap-4 py-1.5">
              <div className="min-w-0">
                <Label className="text-sm">{t('venueMenus.settings.locationSearch')}</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t('venueMenus.settings.locationSearchDesc')}
                </p>
              </div>
              <Select
                value={settings.locationSearch}
                onValueChange={(value) => patch({ locationSearch: value as any })}
              >
                <SelectTrigger className="w-40" data-testid="venue-location-search">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="precise">{t('venueMenus.settings.locationPrecise')}</SelectItem>
                  <SelectItem value="coarse">{t('venueMenus.settings.locationCoarse')}</SelectItem>
                  <SelectItem value="off">{t('venueMenus.settings.locationOff')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between gap-4 py-1.5">
              <Label className="text-sm">{t('venueMenus.settings.radius')}</Label>
              <Input
                type="number"
                min={MIN_SEARCH_RADIUS_M}
                max={MAX_SEARCH_RADIUS_M}
                value={settings.searchRadiusM}
                onChange={(e) => patch({ searchRadiusM: Number(e.target.value) })}
                className="w-24 h-8"
                data-testid="venue-radius"
              />
            </div>

            {/* The one setting that changes WHO can start a search. Placed with
                discovery rather than with the board settings because that is
                what it is: a second, wider search, run by the student. */}
            <ToggleRow
              label={t('venueMenus.settings.studentBrowse')}
              description={t('venueMenus.settings.studentBrowseDesc')}
              checked={settings.studentBrowse}
              onChange={(value) => patch({ studentBrowse: value })}
              testId="venue-student-browse"
            />

            {settings.studentBrowse && (
              <div className="flex items-center justify-between gap-4 py-1.5">
                <div className="min-w-0">
                  <Label className="text-sm">{t('venueMenus.settings.browseRadius')}</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t('venueMenus.settings.browseRadiusDesc')}
                  </p>
                </div>
                <Input
                  type="number"
                  min={MIN_BROWSE_RADIUS_M}
                  max={MAX_BROWSE_RADIUS_M}
                  value={settings.browseRadiusM}
                  onChange={(e) => patch({ browseRadiusM: Number(e.target.value) })}
                  className="w-24 h-8"
                  data-testid="venue-browse-radius"
                />
              </div>
            )}

            <ToggleRow
              label={t('venueMenus.settings.providerOsm')}
              checked={settings.providers.osm}
              onChange={(value) => patch({ providers: { ...settings.providers, osm: value } })}
              testId="venue-provider-osm"
            />
            <ToggleRow
              label={t('venueMenus.settings.providerBrightData')}
              description={t('venueMenus.settings.providerBrightDataDesc')}
              checked={settings.providers.brightData}
              onChange={(value) =>
                patch({ providers: { ...settings.providers, brightData: value } })
              }
              testId="venue-provider-brightdata"
            />

            <Separator />
            <p className="text-xs font-medium text-muted-foreground">
              {t('venueMenus.settings.sectionTrust')}
            </p>

            <ToggleRow
              label={t('venueMenus.settings.confirmVenue')}
              description={t('venueMenus.settings.confirmVenueDesc')}
              checked={settings.requireVenueConfirmation}
              onChange={(value) => patch({ requireVenueConfirmation: value })}
              testId="venue-confirm"
            />

            <div className="flex items-center justify-between gap-4 py-1.5">
              <div className="min-w-0">
                <Label className="text-sm">{t('venueMenus.settings.reviewPolicy')}</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {settings.requireReview === 'auto'
                    ? t('venueMenus.settings.autoNow', {
                        value: t(`venueMenus.settings.review_${auto.requireReview}`),
                      })
                    : t('venueMenus.settings.reviewPolicyDesc')}
                </p>
              </div>
              <Select
                value={settings.requireReview}
                onValueChange={(value) => patch({ requireReview: value as any })}
              >
                <SelectTrigger className="w-40" data-testid="venue-review-policy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t('venueMenus.settings.review_auto')}</SelectItem>
                  <SelectItem value="always">{t('venueMenus.settings.review_always')}</SelectItem>
                  <SelectItem value="web_only">{t('venueMenus.settings.review_web_only')}</SelectItem>
                  <SelectItem value="never">{t('venueMenus.settings.review_never')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <ToggleRow
              label={t('venueMenus.settings.allergyReview')}
              description={t('venueMenus.settings.allergyReviewDesc')}
              checked={settings.requireReviewWithAllergies}
              onChange={(value) => patch({ requireReviewWithAllergies: value })}
              testId="venue-allergy-review"
            />

            <div className="flex items-center justify-between gap-4 py-1.5">
              <Label className="text-sm">{t('venueMenus.settings.maxAge')}</Label>
              <Input
                type="number"
                min={0}
                value={settings.maxMenuAgeDays}
                onChange={(e) => patch({ maxMenuAgeDays: Number(e.target.value) })}
                className="w-24 h-8"
                data-testid="venue-max-age"
              />
            </div>

            <ToggleRow
              label={t('venueMenus.settings.branchDisclaimer')}
              checked={settings.showBranchDisclaimer}
              onChange={(value) => patch({ showBranchDisclaimer: value })}
              testId="venue-branch-disclaimer"
            />

            <Separator />
            <p className="text-xs font-medium text-muted-foreground">
              {t('venueMenus.settings.sectionBoard')}
            </p>

            <ToggleRow
              label={t('venueMenus.settings.readingMode')}
              description={t('venueMenus.settings.readingModeDesc')}
              checked={settings.readingModeDefault}
              onChange={(value) => patch({ readingModeDefault: value })}
              testId="venue-reading-mode"
            />

            <div className="flex items-center justify-between gap-4 py-1.5">
              <div className="min-w-0">
                <Label className="text-sm">{t('venueMenus.settings.prices')}</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {settings.showPrices === 'auto'
                    ? t('venueMenus.settings.autoNow', {
                        value: auto.showPrices
                          ? t('venueMenus.settings.prices_true')
                          : t('venueMenus.settings.prices_false'),
                      })
                    : t('venueMenus.settings.pricesDesc')}
                </p>
              </div>
              <Select
                value={String(settings.showPrices)}
                onValueChange={(value) =>
                  patch({ showPrices: value === 'auto' ? 'auto' : value === 'true' })
                }
              >
                <SelectTrigger className="w-40" data-testid="venue-prices">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t('venueMenus.settings.prices_auto')}</SelectItem>
                  <SelectItem value="true">{t('venueMenus.settings.prices_true')}</SelectItem>
                  <SelectItem value="false">{t('venueMenus.settings.prices_false')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <ToggleRow
              label={t('venueMenus.settings.categoryPages')}
              checked={settings.categoryPages}
              onChange={(value) => patch({ categoryPages: value })}
              testId="venue-category-pages"
            />
            <ToggleRow
              label={t('venueMenus.settings.dietaryTags')}
              description={t('venueMenus.settings.dietaryTagsDesc')}
              checked={settings.showDietaryTags}
              onChange={(value) => patch({ showDietaryTags: value })}
              testId="venue-dietary-tags"
            />
          </>
        )}

    </div>
  );
}
