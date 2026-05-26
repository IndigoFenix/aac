// client-aac/src/hooks/usePeopleDirectory.ts
//
// Fetches the student's full selectable-people directory (every active
// contact, linked user, and the student) for the sentence builder. This is
// the source for the "person list" the student picks from, the display name
// for `face:<id>` suggestions, and the stored-photo fallback used when the
// live camera hasn't identified someone this session.
//
// Distinct from usePersonIdentification's known-people fetch, which is gated
// on having a face embedding (the camera-matching pool). Here we want
// everyone the student can talk about, photo or not.

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithAuth, apiUrl } from "@/lib/queryClient";

export interface DirectoryPerson {
  id: string;
  type: "student" | "user" | "contact";
  name: string;
  relationship?: string;
  hasPhoto: boolean;
}

export interface PeopleDirectory {
  people: DirectoryPerson[];
  /** Display name for a person id (e.g. resolving `face:<id>` → "Mom"). */
  getName: (personId: string) => string | null;
  /**
   * Stored-photo URL for a person id, or null when no stored photo exists.
   * Used as the fallback face image when the live camera cache has no entry.
   */
  getPhotoUrl: (personId: string) => string | null;
  refresh: () => Promise<void>;
}

export function usePeopleDirectory(
  studentId: string | undefined,
  enabled: boolean,
): PeopleDirectory {
  const [people, setPeople] = useState<DirectoryPerson[]>([]);
  // Index by id for O(1) name/photo lookups from the resolver hot paths.
  const byIdRef = useRef<Map<string, DirectoryPerson>>(new Map());

  const fetchDirectory = useCallback(async () => {
    if (!studentId) return;
    try {
      const res = await fetchWithAuth(`/api/aac/students/${studentId}/people-directory`);
      if (!res.ok) throw new Error(`people-directory ${res.status}`);
      const data = await res.json();
      const list: DirectoryPerson[] = data.people || [];
      byIdRef.current = new Map(list.map((p) => [p.id, p]));
      setPeople(list);
    } catch (err) {
      // Non-critical — the sentence builder still works without the
      // directory (people just show the 👤 silhouette and bare ids).
      console.error("[usePeopleDirectory] fetch failed:", err);
    }
  }, [studentId]);

  useEffect(() => {
    if (!enabled || !studentId) return;
    void fetchDirectory();
  }, [enabled, studentId, fetchDirectory]);

  const getName = useCallback((personId: string): string | null => {
    return byIdRef.current.get(personId)?.name ?? null;
  }, []);

  const getPhotoUrl = useCallback((personId: string): string | null => {
    const p = byIdRef.current.get(personId);
    if (!p || !p.hasPhoto || !studentId) return null;
    return apiUrl(`/api/aac/students/${studentId}/people/${personId}/photo`);
  }, [studentId]);

  return { people, getName, getPhotoUrl, refresh: fetchDirectory };
}

export default usePeopleDirectory;
