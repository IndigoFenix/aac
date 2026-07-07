// A small, unobtrusive version label for the startup screens (there's no
// in-app settings page to read it from). Reads the packaged app version through
// the Electron preload (`electronAPI.getVersion()`); renders nothing on the web
// build, where there's no packaged version to show.

import { useEffect, useState } from "react";

export default function AppVersionBadge() {
  const [version, setVersion] = useState<string | null>(null);

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
