// A small, unobtrusive version label for the startup screens (there's no
// in-app settings page to read it from). Under Electron it reads the packaged
// app version through the preload (`electronAPI.getVersion()`); on the web build
// it falls back to the version baked in at build time (see vite.config.aac.ts).

import { useEffect, useState } from "react";

export default function AppVersionBadge() {
  // Start with the build-time version so the label is present immediately on the
  // web build; Electron overwrites it with the live packaged version once ready.
  const [version, setVersion] = useState<string | null>(
    typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : null
  );

  useEffect(() => {
    const api = (window as unknown as {
      electronAPI?: { getVersion?: () => Promise<string> };
    }).electronAPI;
    if (!api?.getVersion) return;
    let alive = true;
    api.getVersion().then(v => { if (alive && v) setVersion(v); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!version) return null;

  return (
    <div className="fixed inset-x-0 bottom-1 z-50 pointer-events-none select-none text-center text-[11px] leading-none text-gray-400 dark:text-gray-600">
      v{version}
    </div>
  );
}
