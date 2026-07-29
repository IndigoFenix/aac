// Tests for createStreamingSession's gRPC-stream rotation and recovery.
// Google kills a streamingRecognize stream at 305s (and after ~10s without
// audio); the session must transparently swap to a fresh stream instead of
// silently swallowing the rest of the utterance — that failure mode left a
// real AAC session deaf for its last 4.5 minutes.

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { createStreamingSession, __setSttClientForTests } from '../services/voice/google-stt-service';

class FakeStream extends EventEmitter {
  written: Buffer[] = [];
  halfClosed = false;
  wasDestroyed = false;
  write(buf: Buffer) { this.written.push(buf); }
  end() { this.halfClosed = true; this.emit('end'); }
  destroy() { this.wasDestroyed = true; }
}

describe('createStreamingSession rotation/recovery', () => {
  let streams: FakeStream[];
  let now: number;
  let nowSpy: jest.SpiedFunction<typeof Date.now>;

  beforeEach(() => {
    streams = [];
    now = 1_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    __setSttClientForTests({
      streamingRecognize: () => {
        const s = new FakeStream();
        streams.push(s);
        return s;
      },
    } as any);
  });

  afterEach(() => {
    nowSpy.mockRestore();
    __setSttClientForTests(null);
  });

  const chunk = (label: string) => Buffer.from(label);
  const finalEvent = (transcript: string, confidence?: number) => ({
    results: [{ isFinal: true, alternatives: [{ transcript, ...(confidence === undefined ? {} : { confidence }) }] }],
  });

  it('recovers from a terminal stream error on the next write, replaying the tail', () => {
    const onError = jest.fn();
    const session = createStreamingSession({ onError });
    expect(streams).toHaveLength(1);
    expect(session.write(chunk('a'))).toBe(true);

    streams[0].emit('error', new Error('Exceeded maximum allowed stream duration of 305 seconds.'));
    expect(onError).toHaveBeenCalledTimes(1);

    now += 1000;
    expect(session.write(chunk('b'))).toBe(true); // accepted — recovery kicked in
    expect(streams).toHaveLength(2);
    expect(streams[0].wasDestroyed).toBe(true);
    // Both chunks are still inside the tail window → replayed on the new stream.
    expect(streams[1].written.map(String)).toEqual(['a', 'b']);
  });

  it('throttles repeated recovery attempts, reporting dropped chunks via write()', () => {
    const session = createStreamingSession();
    streams[0].emit('error', new Error('boom'));

    now += 1000;
    expect(session.write(chunk('a'))).toBe(true); // first recovery
    expect(streams).toHaveLength(2);

    streams[1].emit('error', new Error('boom')); // backend still failing
    now += 1000;
    expect(session.write(chunk('b'))).toBe(false); // throttled — dropped, not billed
    expect(streams).toHaveLength(2);

    now += 5000; // throttle window elapsed
    expect(session.write(chunk('c'))).toBe(true);
    expect(streams).toHaveLength(3);
  });

  it('hard-rotates before the 305s cap, replaying only the recent tail', () => {
    const onRotate = jest.fn();
    const session = createStreamingSession({ onRotate });
    session.write(chunk('old'));

    now += 289_000; // still under the hard-rotate threshold
    session.write(chunk('recent'));
    expect(streams).toHaveLength(1);

    now += 2_000; // stream age 291s — past the threshold
    expect(session.write(chunk('fresh'))).toBe(true);
    expect(streams).toHaveLength(2);
    expect(onRotate).toHaveBeenCalledTimes(1);
    // 'old' fell out of the tail window; the cut loses nothing recent.
    expect(streams[1].written.map(String)).toEqual(['recent', 'fresh']);
  });

  it('soft-rotates at a final (natural pause) without replaying transcribed audio', () => {
    const onFinal = jest.fn();
    const session = createStreamingSession({ onFinal });
    session.write(chunk('a'));

    now += 241_000; // past the soft-rotate threshold
    streams[0].emit('data', finalEvent('hello'));
    expect(onFinal).toHaveBeenCalledWith('hello', undefined);
    expect(streams).toHaveLength(2);
    expect(streams[1].written).toHaveLength(0); // nothing re-heard

    session.write(chunk('b'));
    expect(streams[1].written.map(String)).toEqual(['b']);
  });

  it('does not rotate at a final on a young stream', () => {
    const session = createStreamingSession();
    session.write(chunk('a'));
    now += 10_000;
    streams[0].emit('data', finalEvent('hello'));
    expect(streams).toHaveLength(1);
  });

  it('delivers rolling interims via onInterim without affecting the final transcript', async () => {
    const onInterim = jest.fn();
    const onFinal = jest.fn();
    const session = createStreamingSession({ onInterim, onFinal });
    streams[0].emit('data', { results: [{ isFinal: false, alternatives: [{ transcript: 'swee' }] }] });
    streams[0].emit('data', { results: [{ isFinal: false, alternatives: [{ transcript: 'sweet pot' }] }] });
    streams[0].emit('data', finalEvent('sweet potato'));
    expect(onInterim.mock.calls.map((c) => c[0])).toEqual(['swee', 'sweet pot']);
    expect(onFinal).toHaveBeenCalledWith('sweet potato', undefined);
    const done = session.end();
    await expect(done).resolves.toBe('sweet potato'); // interims never accumulate
  });

  // The recogniser's own score is the only signal that separates "she said it"
  // from "the decoder invented a fluent sentence out of room noise". It was
  // being dropped here and replaced downstream with a hard-coded 0.9, which is
  // what let a mis-decode reach the board as high-confidence speech.
  it('passes the recogniser confidence through with each final phrase', () => {
    const onFinal = jest.fn();
    const session = createStreamingSession({ onFinal });
    streams[0].emit('data', finalEvent('I am the mother of media', 0.41));
    expect(onFinal).toHaveBeenCalledWith('I am the mother of media', 0.41);
    void session;
  });

  it('reports a missing or 0.0 confidence as undefined, never as a low score', () => {
    const onFinal = jest.fn();
    createStreamingSession({ onFinal });
    // Google uses 0.0 for "no confidence available" — treating that as "very
    // low" would blur every caption from a model that simply omits the field.
    streams[0].emit('data', finalEvent('hello', 0));
    streams[0].emit('data', finalEvent('again'));
    expect(onFinal.mock.calls.map((c) => c[1])).toEqual([undefined, undefined]);
  });

  it('accumulates finals across rotations and rejects writes after end()', async () => {
    const session = createStreamingSession();
    streams[0].emit('data', finalEvent('one'));

    streams[0].emit('error', new Error('cap'));
    now += 6000;
    session.write(chunk('x')); // recovery → stream 2
    streams[1].emit('data', finalEvent('two'));

    const done = session.end();
    expect(session.write(chunk('y'))).toBe(false); // ended — dropped
    await expect(done).resolves.toBe('one two');
  });
});
