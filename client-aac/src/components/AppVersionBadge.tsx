// A small, unobtrusive version label for the startup screens (there's no
// in-app settings page to read it from). On a native host it reads the real
// installed app version at runtime; on the web build it falls back to the
// version baked in at build time (see vite.config.aac.ts).

import { useEffect, useState } from "react";
import { capabilities, getNativeVersion } from "@/lib/platform";

export default function AppVersionBadge() {
  // Start with the build-time version so the label is present immediately on the
  // web build; a native host overwrites it with the live version once ready.
  const [version, setVersion] = useState<string | null>(
    typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : null
  );

  useEffect(() => {
    if (!capabilities().nativeVersion) return;
    let alive = true;
    getNativeVersion().then(v => { if (alive && v) setVersion(v); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!version) return null;

  return (
    <div className="fixed inset-x-0 bottom-1 z-50 pointer-events-none select-none text-center text-[11px] leading-none text-gray-400 dark:text-gray-600">
      v{version}
    </div>
  );
}
