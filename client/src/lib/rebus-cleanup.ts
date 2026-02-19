/**
 * Widgit Rebus Key Cleanup Utility
 *
 * Normalizes rebusKey values from AI-generated board data to match
 * Widgit Rebus symbol naming conventions:
 * - Lowercase British English
 * - Spaces for multi-word concepts
 * - Known variant corrections (e.g. "more" → "more 1")
 *
 * The cleaned key maps directly to a Grid3 symbol path:
 *   [widgit]widgit rebus\{first_letter}\{key}.emf
 */

// American → British English spelling corrections
const BRITISH_CORRECTIONS: Record<string, string> = {
  'mom': 'mum',
  'mommy': 'mummy',
  'color': 'colour',
  'colors': 'colours',
  'favorite': 'favourite',
  'favorites': 'favourites',
  'behavior': 'behaviour',
  'airplane': 'aeroplane',
  'airplanes': 'aeroplanes',
  'catalog': 'catalogue',
  'center': 'centre',
  'defense': 'defence',
  'dialog': 'dialogue',
  'gray': 'grey',
  'honor': 'honour',
  'humor': 'humour',
  'labor': 'labour',
  'license': 'licence',
  'neighbor': 'neighbour',
  'neighbors': 'neighbours',
  'organize': 'organise',
  'pajamas': 'pyjamas',
  'practice': 'practise',
  'program': 'programme',
  'realize': 'realise',
  'recognize': 'recognise',
  'theater': 'theatre',
  'tire': 'tyre',
  'traveled': 'travelled',
  'traveling': 'travelling',
  'diaper': 'nappy',
  'diapers': 'nappies',
  'cookie': 'biscuit',
  'cookies': 'biscuits',
  'candy': 'sweet',
  'french fries': 'chips',
  'fries': 'chips',
  'elevator': 'lift',
  'sidewalk': 'pavement',
  'trash': 'rubbish',
  'garbage': 'rubbish',
  'trunk': 'boot',
  'hood': 'bonnet',
  'sweater': 'jumper',
  'sneakers': 'trainers',
  'fall': 'autumn',
  'soccer': 'football',
  'math': 'maths',
  'eraser': 'rubber',
  'flashlight': 'torch',
  'line': 'queue',
  'vacation': 'holiday',
  'apartment': 'flat',
  'restroom': 'toilet',
  'bathroom': 'toilet',
  'stroller': 'pushchair',
  'pacifier': 'dummy',
  'closet': 'wardrobe',
  'drugstore': 'chemist',
  'pharmacy': 'chemist',
};

// Known Widgit filename quirks (concept → actual filename stem)
const WIDGIT_QUIRKS: Record<string, string> = {
  'more': 'more 1',
  'cold': 'shiver',
  'tv': 'television',
};

/**
 * Clean and normalize a rebusKey value.
 * - Trims and lowercases
 * - Applies British English corrections
 * - Applies known Widgit filename quirks
 * - Strips leading/trailing punctuation
 */
export function cleanRebusKey(key: string | undefined | null): string | undefined {
  if (!key) return undefined;

  let cleaned = key.trim().toLowerCase();

  // Strip leading/trailing punctuation/emoji (keep letters, numbers, spaces)
  cleaned = cleaned.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');

  if (!cleaned) return undefined;

  // Apply British English corrections
  if (BRITISH_CORRECTIONS[cleaned]) {
    cleaned = BRITISH_CORRECTIONS[cleaned];
  }

  // Apply known Widgit quirks
  if (WIDGIT_QUIRKS[cleaned]) {
    cleaned = WIDGIT_QUIRKS[cleaned];
  }

  // Collapse multiple spaces
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned || undefined;
}

/**
 * Build the Grid3 Widgit Rebus symbol path from a rebusKey.
 * Format: [widgit]widgit rebus\{first_letter}\{key}.emf
 */
export function rebusKeyToGrid3Path(key: string): string {
  const firstLetter = key.charAt(0).toLowerCase();
  return `[widgit]widgit rebus\\${firstLetter}\\${key}.emf`;
}

/**
 * Resolve a button's Grid3 symbol path.
 * Priority: rebusKey → label text → default
 */
export function resolveGrid3Path(
  rebusKey: string | undefined,
  label: string,
): string {
  // Try rebusKey first
  if (rebusKey) {
    const cleaned = cleanRebusKey(rebusKey);
    if (cleaned) return rebusKeyToGrid3Path(cleaned);
  }

  // Fall back to label text
  const labelKey = label.trim().toLowerCase();
  if (labelKey) {
    // Apply corrections to label too
    const corrected = BRITISH_CORRECTIONS[labelKey] || labelKey;
    const quirked = WIDGIT_QUIRKS[corrected] || corrected;
    return rebusKeyToGrid3Path(quirked);
  }

  // Last resort
  return '[widgit]widgit rebus\\c\\communicate.emf';
}
