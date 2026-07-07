import { useMemo, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";

interface EnabledAppEntry {
  id: string;
  name: string;
  icon: string;
  /** When true, picking this app resolves startup params server-side before
   *  opening (the parent shows a loading state). Pass-through only here. */
  needsStartupResolution?: boolean;
}

interface CustomAppEntry {
  id: string;
  name: string;
  imageUrl?: string | null;
  description?: string | null;
}

interface WebsiteEntry {
  url: string;
  label?: string;
}

interface AppsBoardProps {
  enabledApps: EnabledAppEntry[];
  availableCustomApps: CustomAppEntry[];
  /** Permitted websites — each becomes a tile that opens the in-app browser.
   *  Its icon is the site's own favicon (falling back to a globe). */
  permittedWebsites?: WebsiteEntry[];
  /** True when the glyph-caption strip is showing. It eats vertical space, so
   *  the grid switches to a shorter 5×2 layout (10 tiles/page) instead of 4×3. */
  captionsActive?: boolean;
  /** Called when the user picks an app — receives the app id, display name, and
   *  optional appData (custom-app payloads, or the website url for browser tiles). */
  onPick: (appId: string, displayName: string, appData?: any) => void;
  /** Called when the user closes the overlay without picking anything. */
  onClose: () => void;
}

interface AppTile {
  id: string;
  name: string;
  /** Emoji icon for built-ins; null when an image (custom app / favicon) renders. */
  icon: string | null;
  imageUrl?: string | null;
  /** Emoji shown if `imageUrl` fails to load (e.g. a site with no favicon). */
  fallbackIcon?: string;
  /** App id to launch (defaults to `id`). Website tiles launch "browser". */
  appId?: string;
  /** Payload passed to onPick (e.g. the browser's { url, label }). */
  appData?: any;
}

/** Site hostname without a leading www., for a friendly default tile label. */
function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The site's own favicon URL, or null if the url can't be parsed. */
function faviconUrl(url: string): string | null {
  try {
    return `${new URL(url).origin}/favicon.ico`;
  } catch {
    return null;
  }
}

/** Tile icon: renders the image (custom-app art or site favicon) and falls back
 *  to an emoji if it fails to load. Own state so one broken favicon doesn't
 *  affect the others. */
function TileIcon({ tile }: { tile: AppTile }) {
  const [imgFailed, setImgFailed] = useState(false);
  if (tile.imageUrl && !imgFailed) {
    return (
      <img
        src={tile.imageUrl}
        alt=""
        className="max-w-full max-h-full object-contain"
        onError={() => setImgFailed(true)}
      />
    );
  }
  return <span className="text-6xl leading-none">{tile.fallbackIcon ?? tile.icon ?? "🎮"}</span>;
}

export default function AppsBoard({
  enabledApps,
  availableCustomApps,
  permittedWebsites = [],
  captionsActive = false,
  onPick,
  onClose,
}: AppsBoardProps) {
  const { t, isRTL } = useLanguage();

  // With the glyph-caption strip up there's less vertical room, so cap the grid
  // at 2 rows of 5; otherwise use the roomier 3 rows of 4.
  const COLS = captionsActive ? 5 : 4;
  const MAX_ROWS = captionsActive ? 2 : 3;
  const PAGE_SIZE = COLS * MAX_ROWS;

  const tiles = useMemo<AppTile[]>(() => {
    const builtIn: AppTile[] = enabledApps
      // social_trainer lives on the home board ("Practice friend"), not here.
      .filter(a => a.id !== "social_trainer")
      .map(a => ({
        id: a.id,
        // Built-in app names arrive from the server in English (the registry
        // stores plain strings). Translate by id via appsBoard.appNames, falling
        // back to the server name when no translation key exists.
        name: (() => {
          const key = `appsBoard.appNames.${a.id}`;
          const translated = t(key);
          return translated === key ? a.name : translated;
        })(),
        icon: a.icon,
      }));
    const custom: AppTile[] = availableCustomApps.map(a => ({
      id: a.id,
      // Custom-app names are user-authored free text — not translatable.
      name: a.name,
      icon: a.imageUrl ? null : "🎮",
      imageUrl: a.imageUrl ?? null,
    }));
    // Each permitted website opens the in-app browser; icon = the site favicon.
    const websites: AppTile[] = permittedWebsites.map(w => {
      const name = w.label || hostFromUrl(w.url);
      return {
        id: `web:${w.url}`,
        name,
        icon: null,
        imageUrl: faviconUrl(w.url),
        fallbackIcon: "🌐",
        appId: "browser",
        appData: { url: w.url, label: name },
      };
    });
    return [...builtIn, ...custom, ...websites];
  }, [enabledApps, availableCustomApps, permittedWebsites, t]);

  // Pagination — only kicks in when total > PAGE_SIZE. Each non-final page
  // shows (PAGE_SIZE - 1) app tiles plus a "More" button as the last cell.
  const pages = useMemo<AppTile[][]>(() => {
    if (tiles.length <= PAGE_SIZE) return [tiles];
    const result: AppTile[][] = [];
    const chunk = PAGE_SIZE - 1;
    let i = 0;
    while (i < tiles.length) {
      const remaining = tiles.length - i;
      if (remaining <= PAGE_SIZE) {
        result.push(tiles.slice(i));
        break;
      }
      result.push(tiles.slice(i, i + chunk));
      i += chunk;
    }
    return result;
  }, [tiles, PAGE_SIZE]);

  const [pageIndex, setPageIndex] = useState(0);
  // Clamp if the apps list shrinks mid-view.
  const safePageIndex = Math.min(pageIndex, pages.length - 1);
  const currentTiles = pages[safePageIndex] ?? [];
  const showMore = safePageIndex < pages.length - 1;

  // Rows needed for this page's cells, capped at the layout's max.
  const cellCount = currentTiles.length + (showMore ? 1 : 0);
  const rows = Math.min(MAX_ROWS, Math.max(1, Math.ceil(cellCount / COLS)));

  return (
    <div className="flex flex-col w-full h-full p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {t("appsBoard.title")}
        </h2>
        <button
          onClick={onClose}
          data-dwell="apps-close"
          className="px-4 py-2 rounded-lg bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-100 text-lg font-medium hover:bg-gray-300 dark:hover:bg-gray-600"
          aria-label={t("common.close")}
        >
          {t("common.close")}
        </button>
      </div>

      {tiles.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xl text-gray-500 dark:text-gray-400">
          {t("appsBoard.empty")}
        </div>
      ) : (
        <div
          className="flex-1 grid gap-4 overflow-hidden"
          style={{
            gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          }}
        >
          {currentTiles.map(tile => (
            <button
              key={tile.id}
              onClick={() => onPick(tile.appId ?? tile.id, tile.name, tile.appData)}
              data-dwell={`app-${tile.id}`}
              className="flex flex-col items-center justify-center gap-2 p-4 rounded-2xl bg-white dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-700 shadow-sm hover:shadow-md hover:border-blue-400 dark:hover:border-blue-500 transition"
              aria-label={tile.name}
            >
              <div className="flex-1 flex items-center justify-center w-full overflow-hidden">
                <TileIcon tile={tile} />
              </div>
              <div className="text-base font-medium text-gray-900 dark:text-gray-100 text-center truncate w-full">
                {tile.name}
              </div>
            </button>
          ))}
          {showMore && (
            <button
              onClick={() => setPageIndex(i => Math.min(i + 1, pages.length - 1))}
              data-dwell="apps-more"
              className="flex flex-col items-center justify-center gap-2 p-4 rounded-2xl bg-blue-50 dark:bg-blue-900/30 border-2 border-blue-200 dark:border-blue-700 shadow-sm hover:shadow-md hover:border-blue-400 dark:hover:border-blue-500 transition"
              aria-label={t("common.more")}
            >
              <div className="flex-1 flex items-center justify-center w-full overflow-hidden">
                <span className="text-6xl leading-none">{isRTL ? "⬅️" : "➡️"}</span>
              </div>
              <div className="text-base font-medium text-gray-900 dark:text-gray-100 text-center truncate w-full">
                {t("common.more")}
              </div>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
