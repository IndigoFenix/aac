// client-aac/src/hooks/useLaunchOnBoot.ts
//
// Keep the OS in step with the student's `launchOnBoot` AAC setting.
//
// The setting is stored per student on the server; the thing it controls is a
// per-DEVICE OS login item. This hook is the join: whenever a profile is loaded
// with a stated preference, the running shell writes that preference into the
// OS. So the machine ends up holding the choice of whoever last used it, which
// is the correct answer for the dedicated device this feature exists for.
//
// Two rules the shape of this hook exists to enforce:
//
//  1. NEVER act on an absent setting. `enabled` is nullable, and null means "no
//     profile yet", not "off". A device that boots without a network would
//     otherwise deregister its own autostart on every launch and then, having
//     done so, never start again to fix it — the one failure this feature
//     cannot be allowed to have.
//  2. Write unconditionally, not only on change. The registry entry names an
//     executable path, so re-writing it is also how an entry left behind by a
//     previous install location is repaired.
//
// Silent on every host that cannot autostart (iPad, browser tab, an older
// Electron shell): the bridge is absent and `applyLaunchOnBoot` answers
// "unsupported" rather than throwing.

import { useEffect, useState } from "react";
import { applyLaunchOnBoot, capabilities, type AutoLaunchState } from "@/lib/platform";

const UNSUPPORTED: AutoLaunchState = { supported: false, enabled: false, error: null };

/**
 * @param enabled the student's `aacSettings.launchOnBoot`, or null while no
 *        profile has loaded. Null is inert — see rule 1 above.
 */
export function useLaunchOnBoot(enabled: boolean | null | undefined): AutoLaunchState {
  const [state, setState] = useState<AutoLaunchState>(UNSUPPORTED);
  const supported = capabilities().launchOnBoot;

  useEffect(() => {
    if (!supported || enabled === null || enabled === undefined) return;
    let cancelled = false;
    void applyLaunchOnBoot(enabled).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [supported, enabled]);

  return state;
}
