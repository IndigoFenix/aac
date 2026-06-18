// Tests for the Video Caption Studio caption parser. The parser lives in the
// clinician client (client/src/lib/captionParser.ts) but its core is pure TS
// with no browser globals at import time, so we exercise it here under the
// existing server jest suite (the project has no client-side test runner yet).

import {
  parseCaptions,
  detectCaptionFormat,
  formatTimestamp,
  glyphAtTimeMs,
  CaptionParseError,
  type GlyphCue,
} from '../../client/src/lib/captionParser';

const SRT = `1
00:00:01,000 --> 00:00:04,000
Hello there
how are you?

2
00:00:05,500 --> 00:00:07,250
I am fine
`;

const VTT = `WEBVTT

NOTE this is a comment block

1
00:00:01.000 --> 00:00:04.000 line:80%
<v Alice>Hello there</v>

00:00:05.500 --> 00:00:07.250
I am fine
`;

describe('detectCaptionFormat', () => {
  it('detects by extension', () => {
    expect(detectCaptionFormat('movie.srt', '')).toBe('srt');
    expect(detectCaptionFormat('movie.vtt', '')).toBe('vtt');
  });

  it('falls back to a content sniff for the WEBVTT signature', () => {
    expect(detectCaptionFormat('subs.txt', 'WEBVTT\n\n...')).toBe('vtt');
    expect(detectCaptionFormat('subs.txt', '1\n00:00:01,000 --> ...')).toBe('srt');
  });
});

describe('parseCaptions (SRT)', () => {
  const segments = parseCaptions(SRT, 'srt');

  it('parses every cue', () => {
    expect(segments).toHaveLength(2);
  });

  it('converts comma-millisecond timestamps to ms', () => {
    expect(segments[0].startMs).toBe(1000);
    expect(segments[0].endMs).toBe(4000);
    expect(segments[1].startMs).toBe(5500);
    expect(segments[1].endMs).toBe(7250);
  });

  it('collapses multi-line cue text to a single line', () => {
    expect(segments[0].text).toBe('Hello there how are you?');
  });
});

describe('parseCaptions (VTT)', () => {
  const segments = parseCaptions(VTT, 'vtt');

  it('skips the header and NOTE blocks', () => {
    expect(segments).toHaveLength(2);
  });

  it('handles dot-millisecond timestamps and ignores cue settings', () => {
    expect(segments[0].startMs).toBe(1000);
    expect(segments[0].endMs).toBe(4000);
  });

  it('strips inline VTT tags', () => {
    expect(segments[0].text).toBe('Hello there');
  });

  it('parses cues with no identifier line', () => {
    expect(segments[1].text).toBe('I am fine');
  });
});

describe('parseCaptions ordering and hours', () => {
  it('sorts out-of-order cues by start time', () => {
    const outOfOrder = `2\n00:00:05,000 --> 00:00:06,000\nsecond\n\n1\n00:00:01,000 --> 00:00:02,000\nfirst\n`;
    const segments = parseCaptions(outOfOrder, 'srt');
    expect(segments.map((s) => s.text)).toEqual(['first', 'second']);
  });

  it('parses the optional hours field', () => {
    const withHours = `1\n01:02:03,400 --> 01:02:05,000\nlate\n`;
    const [seg] = parseCaptions(withHours, 'srt');
    expect(seg.startMs).toBe(((1 * 60 + 2) * 60 + 3) * 1000 + 400);
  });
});

describe('parseCaptions errors', () => {
  it('throws CaptionParseError when there are no cues', () => {
    expect(() => parseCaptions('not a caption file', 'srt')).toThrow(CaptionParseError);
  });
});

describe('glyphAtTimeMs', () => {
  const cues: GlyphCue[] = [
    { startMs: 1000, endMs: 4000, glyph: 'i_me+want+🍎' },
    { startMs: 5000, endMs: 7000, glyph: '😴' },
  ];

  it('returns the glyph whose half-open interval covers the time', () => {
    expect(glyphAtTimeMs(cues, 1000)).toBe('i_me+want+🍎'); // inclusive start
    expect(glyphAtTimeMs(cues, 2500)).toBe('i_me+want+🍎');
    expect(glyphAtTimeMs(cues, 5500)).toBe('😴');
  });

  it('returns null in gaps and at the exclusive end', () => {
    expect(glyphAtTimeMs(cues, 0)).toBeNull();
    expect(glyphAtTimeMs(cues, 4000)).toBeNull(); // exclusive end
    expect(glyphAtTimeMs(cues, 4500)).toBeNull(); // gap between cues
    expect(glyphAtTimeMs(cues, 9000)).toBeNull();
  });
});

describe('formatTimestamp', () => {
  it('formats ms as M:SS with zero-padded seconds', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(5000)).toBe('0:05');
    expect(formatTimestamp(65000)).toBe('1:05');
    expect(formatTimestamp(605000)).toBe('10:05');
  });
});
