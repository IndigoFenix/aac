/**
 * The sentence-builder chrome lives in client-shared/src/builder and is
 * rendered by BOTH the student's AAC app and the clinician's "Edit visual"
 * dialog. Its labels are `t("construction.*")` plus a handful of leaf keys
 * outside that block (`builder.amount|emotion|join|quality` on the picker
 * toggles, `aac.glyph.color` on the colour picker), so the SAME strings have to
 * exist in both bundles' locale files — `validate-i18n` only compares a
 * bundle's locales to each other, and `scan:i18n` only sees a bundle's own call
 * sites, so neither notices the two drifting apart.
 *
 * This pins them byte-for-byte, per locale.
 *
 * NOT pinned: `common.*` (back / more / delete / cancel). Those are generic
 * app chrome the shared leaves happen to borrow, and each client may phrase
 * them in its own voice — a child's board and a clinician's console are not
 * obliged to say "Back" the same way.
 */

import { describe, it, expect } from "@jest/globals";

import { ar } from "../../client/src/i18n/ar.js";
import { de } from "../../client/src/i18n/de.js";
import { en } from "../../client/src/i18n/en.js";
import { es } from "../../client/src/i18n/es.js";
import { fr } from "../../client/src/i18n/fr.js";
import { he } from "../../client/src/i18n/he.js";
import { ko } from "../../client/src/i18n/ko.js";
import { pt } from "../../client/src/i18n/pt.js";
import { ru } from "../../client/src/i18n/ru.js";
import { yue } from "../../client/src/i18n/yue.js";
import { zh } from "../../client/src/i18n/zh.js";

import { ar as aacAr } from "../../client-aac/src/i18n/ar.js";
import { de as aacDe } from "../../client-aac/src/i18n/de.js";
import { en as aacEn } from "../../client-aac/src/i18n/en.js";
import { es as aacEs } from "../../client-aac/src/i18n/es.js";
import { fr as aacFr } from "../../client-aac/src/i18n/fr.js";
import { he as aacHe } from "../../client-aac/src/i18n/he.js";
import { ko as aacKo } from "../../client-aac/src/i18n/ko.js";
import { pt as aacPt } from "../../client-aac/src/i18n/pt.js";
import { ru as aacRu } from "../../client-aac/src/i18n/ru.js";
import { yue as aacYue } from "../../client-aac/src/i18n/yue.js";
import { zh as aacZh } from "../../client-aac/src/i18n/zh.js";

const HINT =
  "the sentence builder chrome in client-shared/src/builder is rendered by BOTH clients; " +
  "edit client-aac/src/i18n/<locale>.ts and client/src/i18n/<locale>.ts together";

/** locale code → [clinician bundle, AAC bundle] */
const PAIRS: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ["ar", ar, aacAr],
  ["de", de, aacDe],
  ["en", en, aacEn],
  ["es", es, aacEs],
  ["fr", fr, aacFr],
  ["he", he, aacHe],
  ["ko", ko, aacKo],
  ["pt", pt, aacPt],
  ["ru", ru, aacRu],
  ["yue", yue, aacYue],
  ["zh", zh, aacZh],
];

describe("construction.* parity between the two clients", () => {
  it("covers every locale the app ships", () => {
    expect(PAIRS.map(([code]) => code)).toEqual([
      "ar", "de", "en", "es", "fr", "he", "ko", "pt", "ru", "yue", "zh",
    ]);
  });

  it.each(PAIRS)(
    "%s: client and client-aac carry the identical construction block",
    (locale, client, clientAac) => {
      const mine = client.construction;
      const theirs = clientAac.construction;

      expect(
        typeof theirs === "object" && theirs !== null
          ? true
          : `client-aac/src/i18n/${locale}.ts has no construction block — ${HINT}`
      ).toBe(true);
      expect(
        typeof mine === "object" && mine !== null
          ? true
          : `client/src/i18n/${locale}.ts has no construction block — ${HINT}`
      ).toBe(true);

      // deep equality: same keys, same nesting, same values
      try {
        expect(mine).toEqual(theirs);
      } catch (err) {
        (err as Error).message = `${locale}: construction blocks differ — ${HINT}\n\n${(err as Error).message}`;
        throw err;
      }
    }
  );
});

/**
 * The shared chrome's leaf labels that live OUTSIDE `construction.*`. Each is a
 * whole-key path so a bundle that never grew the block fails on the same
 * assertion as one whose value drifted.
 */
const LEAF_KEYS = [
  "builder.amount",
  "builder.emotion",
  "builder.join",
  "builder.quality",
  "aac.glyph.color",
] as const;

function lookup(bundle: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = bundle;
  for (const part of dotted.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

describe("shared builder LEAF labels parity between the two clients", () => {
  it.each(PAIRS)(
    "%s: client and client-aac agree on every shared leaf label",
    (locale, client, clientAac) => {
      for (const key of LEAF_KEYS) {
        const theirs = lookup(clientAac, key);
        const mine = lookup(client, key);
        expect(
          typeof theirs === "string"
            ? true
            : `client-aac/src/i18n/${locale}.ts has no ${key} — ${HINT}`
        ).toBe(true);
        expect(
          typeof mine === "string"
            ? true
            : `client/src/i18n/${locale}.ts has no ${key} — ${HINT}`
        ).toBe(true);
        expect(`${key}=${String(mine)}`).toBe(`${key}=${String(theirs)}`);
      }
    }
  );
});
