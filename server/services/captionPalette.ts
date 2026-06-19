// server/services/captionPalette.ts
//
// Resolves the per-context glyph palette for the Video Caption Studio — the
// custom SYMBOLs and known PEOPLE the AI may reference as `symbol:<id>` /
// `face:<id>`, matching what the board editor offers.
//
// Scope (per product decision):
//   - Custom images: the selected student's symbols + their institute's
//     symbols + public symbols (getAvailableSymbolsForStudent already merges
//     all three). With no student, fall back to institute + public.
//   - People: the selected student's people-directory — the student, their
//     linked caregivers (institute users), and their contacts — each with a
//     face the client can render.
//
// NOTE: institute-WIDE people not linked to the selected student are NOT here
// yet (no photo-serving path for arbitrary institute users/students) — that's
// the deferred "Phase 3b" extension.

import { customSymbolRepository } from "../repositories/customSymbolRepository";
import { getPeopleDirectoryForStudent } from "./biometric/recognition-service";
import type { GlyphCustomSymbol, GlyphKnownPerson } from "./memory-schema/glyph-syntax";

export interface CaptionPalette {
  customSymbols: GlyphCustomSymbol[];
  knownPeople: GlyphKnownPerson[];
}

const EMPTY: CaptionPalette = { customSymbols: [], knownPeople: [] };

export async function resolveCaptionPalette(opts: {
  studentId?: string | null;
  instituteId?: string | null;
}): Promise<CaptionPalette> {
  const { studentId, instituteId } = opts;

  if (studentId) {
    const [symbols, directory] = await Promise.all([
      customSymbolRepository.getAvailableSymbolsForStudent(studentId).catch((e) => {
        console.error("[captionPalette] symbols (student) failed:", e);
        return [];
      }),
      getPeopleDirectoryForStudent(studentId).catch((e) => {
        console.error("[captionPalette] people-directory failed:", e);
        return [];
      }),
    ]);
    return {
      customSymbols: symbols.map((s) => ({ id: s.id, key: s.key, description: s.description })),
      knownPeople: directory.map((p) => ({
        id: p.id,
        name: p.name,
        relationship: p.relationship ?? null,
      })),
    };
  }

  if (instituteId) {
    const [inst, pub] = await Promise.all([
      customSymbolRepository.getSymbolsByInstitute(instituteId).catch((e) => {
        console.error("[captionPalette] symbols (institute) failed:", e);
        return [];
      }),
      customSymbolRepository.getPublicSymbols(200).catch(() => []),
    ]);
    const byId = new Map<string, GlyphCustomSymbol>();
    for (const s of inst) {
      byId.set(s.id, { id: s.id, key: s.assocKey ?? s.key, description: s.assocDescription ?? s.description });
    }
    for (const s of pub) {
      if (!byId.has(s.id)) byId.set(s.id, { id: s.id, key: s.key, description: s.description });
    }
    return { customSymbols: Array.from(byId.values()), knownPeople: [] };
  }

  return EMPTY;
}
