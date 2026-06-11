// client-aac/src/components/IdentificationBadge.tsx
//
// A deliberately subtle, non-interactive indicator of who the camera has
// identified at the device. Reads the client-side identification
// (usePersonIdentification.currentIdentification), so it works DURING the slow
// session-init window — before the AI session is even live — to confirm that
// face recognition ran. Rendered inline next to the FaceMirror; more of a
// debug/reassurance affordance than UI chrome.

import { useEffect, useState } from "react";
import type { IdentificationResult } from "@/hooks/usePersonIdentification";

/** Hide the badge once the last identification is older than this — avoids a
 *  stale name lingering after the person leaves frame. */
const FRESH_MS = 6000;

export function IdentificationBadge({ identification }: { identification: IdentificationResult | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const person = identification?.identified ? identification.person : null;
  const fresh = !!identification && now - identification.timestamp < FRESH_MS;
  if (!person || !fresh) return null;

  const isStudent = identification!.isStudent;
  return (
    <div
      className="pointer-events-none select-none flex items-center gap-1 rounded-full bg-black/30 px-1.5 py-0.5 text-[10px] text-white/80"
      aria-hidden="true"
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${isStudent ? "bg-emerald-400" : "bg-sky-400"}`} />
      <span className="font-medium max-w-[88px] truncate">{person.name}</span>
    </div>
  );
}

export default IdentificationBadge;
