// src/lib/captionParser.ts
// Lightweight SRT / WebVTT caption parser. No external dependencies — we only
// need the timing + text of each cue, which both formats express plainly.
//
// The output `CaptionSegment[]` is the contract the Video Caption feature is
// built on: the AI glyph step keys its output to these `startMs`/`endMs`, and
// the preview player / exporter both drive off the same list.

/** One word with its timing — present only on STT-transcribed segments. */
export interface CaptionWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface CaptionSegment {
  /** Cue start, in milliseconds from the beginning of the video. */
  startMs: number;
  /** Cue end, in milliseconds. */
  endMs: number;
  /** Caption text, with line breaks collapsed to single spaces. */
  text: string;
  /** Per-word timings (STT path only) — lets the idea pass split on real word
   *  boundaries. Absent for SRT/VTT cues. */
  words?: CaptionWord[];
}

export type CaptionFormat = 'srt' | 'vtt';

export class CaptionParseError extends Error {}

/** Detect the caption format from a filename and/or its contents. */
export function detectCaptionFormat(filename: string, content: string): CaptionFormat {
  if (/\.vtt$/i.test(filename)) return 'vtt';
  if (/\.srt$/i.test(filename)) return 'srt';
  // Fall back to a content sniff: VTT files begin with the WEBVTT signature.
  if (/^﻿?WEBVTT/.test(content)) return 'vtt';
  return 'srt';
}

// Matches an SRT/VTT timestamp: HH:MM:SS,mmm or HH:MM:SS.mmm (hours optional).
const TIMESTAMP = /(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/;
// A cue timing line: "<start> --> <end>" (VTT may append positioning settings).
const TIMING_LINE = new RegExp(
  `${TIMESTAMP.source}\\s*-->\\s*${TIMESTAMP.source}`,
);

function timestampToMs(
  hours: string | undefined,
  minutes: string,
  seconds: string,
  fraction: string,
): number {
  const h = hours ? parseInt(hours, 10) : 0;
  const m = parseInt(minutes, 10);
  const s = parseInt(seconds, 10);
  // Pad/truncate the fractional part to exactly 3 digits (milliseconds).
  const ms = parseInt((fraction + '000').slice(0, 3), 10);
  return ((h * 60 + m) * 60 + s) * 1000 + ms;
}

/**
 * Parse SRT or WebVTT text into ordered caption segments.
 *
 * Both formats share a cue structure: an optional index/identifier line, a
 * timing line (`start --> end`), then one or more text lines, with blank lines
 * separating cues. We parse them with one routine and ignore format-specific
 * extras (VTT NOTE/STYLE/REGION blocks, cue settings, SRT indices).
 *
 * @throws {CaptionParseError} when no valid cues are found.
 */
export function parseCaptions(content: string, format: CaptionFormat): CaptionSegment[] {
  // Normalize newlines and strip a leading BOM.
  const text = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  // Split into blocks on blank lines. This works for both formats; the WEBVTT
  // header block (and NOTE/STYLE/REGION blocks) simply won't contain a timing
  // line and are skipped below.
  const blocks = text.split(/\n{2,}/);
  const segments: CaptionSegment[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;

    // Find the timing line within this block (it's the first line containing
    // "-->"). Anything before it is an index or cue identifier we don't need.
    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx === -1) continue;

    const match = TIMING_LINE.exec(lines[timingIdx]);
    if (!match) continue;

    const startMs = timestampToMs(match[1], match[2], match[3], match[4]);
    const endMs = timestampToMs(match[5], match[6], match[7], match[8]);

    const textLines = lines.slice(timingIdx + 1);
    if (textLines.length === 0) continue;

    // Join wrapped lines with a space and strip simple VTT inline tags
    // (<v Speaker>, <c.classname>, <i>, timestamp tags, etc.).
    const cueText = textLines
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cueText === '') continue;

    segments.push({ startMs, endMs, text: cueText });
  }

  if (segments.length === 0) {
    throw new CaptionParseError(
      format === 'vtt'
        ? 'No caption cues found in the WebVTT file.'
        : 'No caption cues found in the SRT file.',
    );
  }

  // Defensive: order by start time so downstream playback sync is monotonic
  // even if the source file listed cues out of order.
  segments.sort((a, b) => a.startMs - b.startMs);
  return segments;
}

/** Convenience: parse from a File, auto-detecting the format. */
export async function parseCaptionFile(file: File): Promise<CaptionSegment[]> {
  const content = await file.text();
  const format = detectCaptionFormat(file.name, content);
  return parseCaptions(content, format);
}

/** A timed glyph cue: a caption span with the glyph SENTENCE to show over it. */
export interface GlyphCue {
  startMs: number;
  endMs: number;
  glyph: string;
}

/**
 * The glyph active at a given playback time, or null if no cue covers it.
 * Half-open interval [startMs, endMs) so adjacent cues don't both match the
 * boundary. Pure + linear — fine for preview and for testing; the exporter
 * uses an advancing pointer for per-frame efficiency.
 */
export function glyphAtTimeMs(cues: GlyphCue[], ms: number): string | null {
  for (const cue of cues) {
    if (ms >= cue.startMs && ms < cue.endMs) return cue.glyph;
  }
  return null;
}

/** Format a millisecond offset as M:SS for compact display. */
export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
