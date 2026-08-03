/**
 * Conditional-GET headers for entity-keyed blob endpoints (face photos).
 *
 * The regression these lock down: `/api/biometric-data/:id/photo` is keyed on
 * the PERSON, so replacing someone's photo leaves the URL unchanged. The old
 * `Cache-Control: private, max-age=300` therefore made the browser serve the
 * previous face for five minutes after an upload — the uploader saw their new
 * photo vanish and concluded it hadn't saved.
 */

import { describe, it, expect } from '@jest/globals';
import { blobETag, sendNotModified } from '../lib/blob-cache.js';
import { makeReq, makeRes } from './helpers/http.js';

const KEY = 'biometric/d014dfa2-111c-4580-9632-e16ff552ec88.jpg';
const REPLACED_KEY = 'biometric/8f21bd90-0000-4c5e-9a11-2b6d0f1e77aa.jpg';

describe('blob-cache conditional GET', () => {
  it('never lets a stored blob go stale without revalidation', () => {
    const { res, capture } = makeRes();
    const done = sendNotModified(makeReq({}), res, KEY);

    expect(done).toBe(false); // caller must go on to stream the body
    expect(capture.headers['cache-control']).toBe('private, no-cache');
    expect(capture.headers['etag']).toBe(blobETag(KEY));
  });

  it('keeps the blob out of shared caches', () => {
    const { res, capture } = makeRes();
    sendNotModified(makeReq({}), res, KEY);
    expect(capture.headers['cache-control']).toContain('private');
  });

  it('answers 304 when the client already holds this exact blob', () => {
    const { res, capture } = makeRes();
    const done = sendNotModified(
      makeReq({ headers: { 'if-none-match': blobETag(KEY) } }),
      res,
      KEY,
    );

    expect(done).toBe(true); // caller returns — no storage read
    expect(capture.statusCode).toBe(304);
    expect(capture.ended).toBe(true);
  });

  it('serves the new image after the photo is replaced', () => {
    // The browser still holds the OLD photo's validator; the row now points at
    // a new key. This must NOT 304 — that was the whole bug.
    const { res, capture } = makeRes();
    const done = sendNotModified(
      makeReq({ headers: { 'if-none-match': blobETag(KEY) } }),
      res,
      REPLACED_KEY,
    );

    expect(done).toBe(false);
    expect(capture.statusCode).toBe(200);
    expect(capture.headers['etag']).toBe(blobETag(REPLACED_KEY));
  });

  it('accepts weak validators and multi-tag If-None-Match lists', () => {
    const { res } = makeRes();
    const done = sendNotModified(
      makeReq({ headers: { 'if-none-match': `"aaa", W/${blobETag(KEY)}` } }),
      res,
      KEY,
    );
    expect(done).toBe(true);
  });

  it('does not leak the storage key in the ETag', () => {
    const etag = blobETag(KEY);
    expect(etag).not.toContain('d014dfa2');
    expect(etag).not.toContain('biometric/');
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it('gives different blobs different validators', () => {
    expect(blobETag(KEY)).not.toBe(blobETag(REPLACED_KEY));
  });
});
