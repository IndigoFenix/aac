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

interface AppsBoardProps {
  enabledApps: EnabledAppEntry[];
  availableCustomApps: CustomAppEntry[];
  /** Called when the user picks an app — receives the app id, display name, and
   *  optional appData (currently only used for custom apps that need a payload). */
  onPick: (appId: string, displayName: string, appData?: any) => void;
  /** Called when the user closes the overlay without picking anything. */
  onClose: () => void;
}

interface AppTile {
  id: string;
  name: string;
  /** Emoji icon for built-ins; null for custom apps that render an image. */
  icon: string | null;
  imageUrl?: string | null;
}

const COLS = 4;
const PAGE_SIZE = 12;

export default function AppsBoard({ enabledApps, availableCustomApps, onPick, onClose }: AppsBoardProps) {
  const { t, isRTL } = useLanguage();

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
    return [...builtIn, ...custom];
  }, [enabledApps, availableCustomApps, t]);

  // Pagination — only kicks in when total > PAGE_SIZE. Each non-final page
  // shows (PAGE_SIZE - 1) app tiles plus a "More" button as the 12th cell.
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
  }, [tiles]);

  const [pageIndex, setPageIndex] = useState(0);
  // Clamp if the apps list shrinks mid-view.
  const safePageIndex = Math.min(pageIndex, pages.length - 1);
  const currentTiles = pages[safePageIndex] ?? [];
  const showMore = safePageIndex < pages.length - 1;

  // Cell count drives row count per the rules:
  //   ≤4 → 1 row, 5–8 → 2 rows, 9–12 → 3 rows.
  const cellCount = currentTiles.length + (showMore ? 1 : 0);
  const rows = cellCount <= 4 ? 1 : cellCount <= 8 ? 2 : 3;

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
              onClick={() => onPick(tile.id, tile.name)}
              data-dwell={`app-${tile.id}`}
              className="flex flex-col items-center justify-center gap-2 p-4 rounded-2xl bg-white dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-700 shadow-sm hover:shadow-md hover:border-blue-400 dark:hover:border-blue-500 transition"
              aria-label={tile.name}
            >
              <div className="flex-1 flex items-center justify-center w-full overflow-hidden">
                {tile.imageUrl ? (
                  <img
                    src={tile.imageUrl}
                    alt=""
                    className="max-w-full max-h-full object-contain"
                  />
                ) : (
                  <span className="text-6xl leading-none">{tile.icon}</span>
                )}
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
