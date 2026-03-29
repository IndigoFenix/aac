/**
 * useChatStream Hook
 *
 * Provides SSE-based streaming chat functionality with real-time thinking updates.
 * Uses fetch with ReadableStream to parse SSE events.
 */

import { useCallback, useRef } from 'react';

// Read and sanitize the base URL from Vite env (same as queryClient.ts)
const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, "") ?? "";

// Helper to join base + path safely (same as queryClient.ts)
function withBase(path: string): string {
  const cleanPath = path.replace(/^\/+/, ""); // strip leading slashes
  return API_BASE_URL ? `${API_BASE_URL}/${cleanPath}` : `/${cleanPath}`;
}

/**
 * SSE event types sent by the server
 */
export type SSEEventType = 'thinking' | 'navigate' | 'select_student' | 'text_delta' | 'file_extracted' | 'complete' | 'error' | 'close';

/**
 * Thinking event data
 */
export interface ThinkingEvent {
  text: string;
  timestamp: number;
}

/**
 * Callbacks for stream events
 */
export interface StreamCallbacks {
  /** Called when AI sends a thinking update during tool processing */
  onThinking: (text: string) => void;
  /** Called when AI navigates to a panel feature */
  onNavigate?: (feature: string) => void;
  /** Called when AI selects a different student */
  onSelectStudent?: (studentId: string) => void;
  /** Called when a text token is received (md streaming mode) */
  onTextDelta?: (text: string) => void;
  /** Called when the server has extracted text from an uploaded file */
  onFileExtracted?: (filename: string, extractedText: string) => void;
  /** Called when the final response is ready */
  onComplete: (response: any) => void;
  /** Called when an error occurs */
  onError: (error: string) => void;
}

/**
 * Result of the useChatStream hook
 */
export interface UseChatStreamResult {
  /** Send a message using the streaming endpoint */
  sendStreamingMessage: (body: any, callbacks: StreamCallbacks) => Promise<boolean>;
  /** Abort the current stream */
  abort: () => void;
  /** Whether a stream is currently active */
  isStreaming: boolean;
}

/**
 * Persistent state for the SSE parser across chunk boundaries.
 * When TCP or CloudFront splits an SSE event across chunks (e.g. the
 * "event:" line arrives in one chunk and the "data:" line in the next),
 * this state preserves the partial event so it can be completed later.
 */
interface SSEParserState {
  currentEvent: string;
  currentData: string;
}

/**
 * Parse SSE events from a text buffer.
 * Accepts and returns parser state to handle event/data lines split across chunks.
 */
function parseSSEEvents(
  buffer: string,
  state: SSEParserState = { currentEvent: '', currentData: '' },
): { events: Array<{ event: string; data: string }>; remaining: string; state: SSEParserState } {
  const events: Array<{ event: string; data: string }> = [];
  const lines = buffer.split('\n');

  let { currentEvent, currentData } = state;
  let remaining = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this might be an incomplete line at the end
    if (i === lines.length - 1 && line !== '') {
      // This is an incomplete line, save it for next iteration
      remaining = line;
      continue;
    }

    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7);
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6);
    } else if (line === '' && currentEvent && currentData) {
      // Empty line signals end of an event
      events.push({ event: currentEvent, data: currentData });
      currentEvent = '';
      currentData = '';
    }
  }

  return { events, remaining, state: { currentEvent, currentData } };
}

/**
 * Hook for streaming chat messages with thinking updates
 */
export function useChatStream(): UseChatStreamResult {
  const abortControllerRef = useRef<AbortController | null>(null);
  const isStreamingRef = useRef(false);

  /**
   * Send a message to the streaming endpoint and process SSE events
   */
  const sendStreamingMessage = useCallback(async (
    body: any,
    callbacks: StreamCallbacks
  ): Promise<boolean> => {
    // Abort any existing stream
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();
    isStreamingRef.current = true;

    try {
      const url = withBase('/api/chat/stream');
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: abortControllerRef.current.signal,
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let completed = false;
      let parserState: SSEParserState = { currentEvent: '', currentData: '' };

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        // Decode the chunk and add to buffer
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer (state preserves partial events across chunks)
        const { events, remaining, state: newState } = parseSSEEvents(buffer, parserState);
        buffer = remaining;
        parserState = newState;

        // Process each event
        for (const { event, data } of events) {
          try {
            const parsed = JSON.parse(data);

            switch (event) {
              case 'thinking':
                callbacks.onThinking(parsed.text);
                break;

              case 'text_delta':
                callbacks.onTextDelta?.(parsed.text);
                break;

              case 'navigate':
                callbacks.onNavigate?.(parsed.feature);
                break;

              case 'select_student':
                callbacks.onSelectStudent?.(parsed.studentId);
                break;

              case 'file_extracted':
                callbacks.onFileExtracted?.(parsed.filename, parsed.extractedText);
                break;

              case 'complete':
                callbacks.onComplete(parsed);
                completed = true;
                break;

              case 'error':
                callbacks.onError(parsed.error || 'Unknown error');
                break;

              case 'close':
                // Server signals end of stream
                return completed;
            }
          } catch (e) {
            console.error('[useChatStream] Failed to parse SSE data:', e, data);
          }
        }
      }

      return completed;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        // Stream was intentionally aborted
        return false;
      }

      console.error('[useChatStream] Stream error:', error);
      callbacks.onError(error.message || 'Stream connection failed');
      return false;
    } finally {
      isStreamingRef.current = false;
    }
  }, []);

  /**
   * Abort the current stream
   */
  const abort = useCallback(() => {
    abortControllerRef.current?.abort();
    isStreamingRef.current = false;
  }, []);

  return {
    sendStreamingMessage,
    abort,
    get isStreaming() {
      return isStreamingRef.current;
    }
  };
}
