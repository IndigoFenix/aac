import { useEffect, useRef, useState, type FormEvent } from "react";
import { MessageCircle, X, Send } from "lucide-react";
import { marked } from "marked";
import { apiRequest, apiUrl } from "@/lib/queryClient";
import { useLanguage } from "@/contexts/LanguageContext";

const STORAGE_KEY_CUSTOMER = "aivota_crm_customer_id";
const STORAGE_KEY_SESSION = "aivota_crm_session_id";

// Synchronous parser keeps render simple — we hand the resulting HTML to
// dangerouslySetInnerHTML.
marked.setOptions({ async: false });

type ChatMessageContent = { text?: string; html?: string; md?: string };

type ChatMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content?: string | ChatMessageContent;
  timestamp?: number;
  /** Set client-side while a token stream is in flight. Replaced by `content` when complete. */
  streamingMd?: string;
};

function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!message.content) return "";
  return message.content.text ?? message.content.md ?? message.content.html ?? "";
}

function renderAssistantHtml(message: ChatMessage): string {
  const md =
    message.streamingMd ??
    (typeof message.content === "object" ? message.content?.md : undefined) ??
    messageText(message);
  if (!md) return "";
  return marked.parse(md) as string;
}

// Minimal SSE event parser. Mirrors the format the server emits:
//   event: <name>\n
//   data: <json>\n
//   \n
type SSEParserState = { currentEvent: string; currentData: string };

function parseSSE(
  buffer: string,
  state: SSEParserState,
): { events: Array<{ event: string; data: string }>; remaining: string; state: SSEParserState } {
  const events: Array<{ event: string; data: string }> = [];
  const lines = buffer.split("\n");
  let { currentEvent, currentData } = state;
  let remaining = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === lines.length - 1 && line !== "") {
      remaining = line;
      continue;
    }
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7);
    } else if (line.startsWith("data: ")) {
      currentData = line.slice(6);
    } else if (line === "" && currentEvent && currentData) {
      events.push({ event: currentEvent, data: currentData });
      currentEvent = "";
      currentData = "";
    }
  }

  return { events, remaining, state: { currentEvent, currentData } };
}

export function CrmChatWidget() {
  const { t, isRTL } = useLanguage();

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [identified, setIdentified] = useState(false);
  const [potentialCustomerId, setPotentialCustomerId] = useState<string | null>(
    () => (typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY_CUSTOMER) : null),
  );
  const [sessionId, setSessionId] = useState<string | null>(
    () => (typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY_SESSION) : null),
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Discover whether the chat is enabled.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest("GET", "/api/crm-chat/config");
        const data = await res.json();
        if (!cancelled) setEnabled(Boolean(data?.enabled));
      } catch {
        if (!cancelled) setEnabled(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-scroll to the latest message whenever the message list updates.
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Lazy identify on first open — avoids creating an orphan customer row for
  // every page view, only for visitors who actually engage.
  useEffect(() => {
    if (!open || identified) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest("POST", "/api/crm-chat/identify", {});
        const data = await res.json();
        if (cancelled) return;

        if (typeof data?.potentialCustomerId === "string") {
          setPotentialCustomerId(data.potentialCustomerId);
          localStorage.setItem(STORAGE_KEY_CUSTOMER, data.potentialCustomerId);
        }
        if (typeof data?.sessionId === "string") {
          setSessionId(data.sessionId);
          localStorage.setItem(STORAGE_KEY_SESSION, data.sessionId);
        }
        if (Array.isArray(data?.history)) {
          setMessages(
            (data.history as ChatMessage[]).filter(
              (m) => m.role === "user" || m.role === "assistant",
            ),
          );
        }
        setIdentified(true);
      } catch (err: any) {
        if (typeof err?.message === "string" && err.message.includes("404")) {
          setEnabled(false);
        } else {
          setError(t("landing.crm.errorIdentify"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, identified, t]);

  // Abort any in-flight stream on unmount or close.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // Toggle a body class while the chat is open so the landing page can
  // reserve horizontal space for the panel via CSS (desktop only — on mobile
  // the panel still floats over the content). Logical padding-inline-end
  // works for both LTR and RTL because the launcher uses inset-inline-end.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (open && enabled) {
      document.body.classList.add("crm-chat-open");
    } else {
      document.body.classList.remove("crm-chat-open");
    }
    return () => {
      document.body.classList.remove("crm-chat-open");
    };
  }, [open, enabled]);

  if (enabled === null || enabled === false) {
    return null;
  }

  const handleSend = async (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;

    setError(null);
    setSending(true);
    setInput("");

    const userMessage: ChatMessage = { role: "user", content: text, timestamp: Date.now() };

    // Insert the user message AND an empty assistant placeholder up front so
    // there's an immediate "thinking" bubble while we wait for the network.
    // The placeholder renders as loading dots until streamingMd is non-empty.
    const placeholderTimestamp = Date.now() + 1;
    const placeholder: ChatMessage = {
      role: "assistant",
      timestamp: placeholderTimestamp,
      streamingMd: "",
    };
    setMessages((prev) => [...prev, userMessage, placeholder]);

    const abort = new AbortController();
    abortRef.current = abort;

    const dropPlaceholder = () =>
      setMessages((prev) => prev.filter((m) => m.timestamp !== placeholderTimestamp));

    try {
      const res = await fetch(apiUrl("/api/crm-chat/message-stream"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, potentialCustomerId, sessionId }),
        credentials: "include",
        signal: abort.signal,
      });

      if (!res.ok) {
        if (res.status === 429) setError(t("landing.crm.errorRateLimited"));
        else if (res.status === 403) setError(t("landing.crm.errorBlocked"));
        else if (res.status === 404) setEnabled(false);
        else setError(t("landing.crm.errorSend"));
        // Roll back the optimistic user message + placeholder so retries
        // don't pile up.
        setMessages((prev) =>
          prev.filter((m) => m !== userMessage && m.timestamp !== placeholderTimestamp),
        );
        setInput(text);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("no-stream");

      const decoder = new TextDecoder();
      let buffer = "";
      let parserState: SSEParserState = { currentEvent: "", currentData: "" };
      let accumulated = "";
      let streamErrored: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSSE(buffer, parserState);
        buffer = parsed.remaining;
        parserState = parsed.state;

        for (const ev of parsed.events) {
          let payload: any;
          try {
            payload = JSON.parse(ev.data);
          } catch {
            continue;
          }

          if (ev.event === "session") {
            if (typeof payload.potentialCustomerId === "string") {
              setPotentialCustomerId(payload.potentialCustomerId);
              localStorage.setItem(STORAGE_KEY_CUSTOMER, payload.potentialCustomerId);
            }
            if (typeof payload.sessionId === "string") {
              setSessionId(payload.sessionId);
              localStorage.setItem(STORAGE_KEY_SESSION, payload.sessionId);
            }
          } else if (ev.event === "text_delta" && typeof payload.text === "string") {
            accumulated += payload.text;
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.timestamp === placeholderTimestamp);
              if (idx >= 0) next[idx] = { ...next[idx], streamingMd: accumulated };
              return next;
            });
          } else if (ev.event === "complete") {
            const finalMessage: ChatMessage = (payload?.message as ChatMessage) ?? {
              role: "assistant",
              timestamp: placeholderTimestamp,
              content: { md: accumulated },
            };
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex((m) => m.timestamp === placeholderTimestamp);
              if (idx >= 0) next[idx] = finalMessage;
              else next.push(finalMessage);
              return next;
            });
          } else if (ev.event === "error") {
            streamErrored = String(payload?.error ?? "internal_error");
          } else if (ev.event === "close") {
            // Server signals end of stream — exit outer loop on next read.
          }
        }
      }

      if (streamErrored) {
        if (streamErrored === "rate_limited") setError(t("landing.crm.errorRateLimited"));
        else if (streamErrored === "blocked") setError(t("landing.crm.errorBlocked"));
        else if (streamErrored === "crm_chat_disabled") setEnabled(false);
        else if (streamErrored === "daily_budget_exceeded") setError(t("landing.crm.errorRateLimited"));
        else setError(t("landing.crm.errorSend"));
        // Drop the unfinished placeholder if we never got any tokens.
        if (!accumulated) dropPlaceholder();
      }
    } catch (err: any) {
      if (err?.name === "AbortError") {
        // User-initiated abort (e.g. closed widget mid-stream). Drop the
        // empty placeholder so it doesn't sit there as a stuck spinner.
        dropPlaceholder();
      } else {
        setError(t("landing.crm.errorSend"));
        setMessages((prev) =>
          prev.filter((m) => m !== userMessage && m.timestamp !== placeholderTimestamp),
        );
        setInput(text);
      }
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  };

  return (
    <div className={`crm-widget ${isRTL ? "crm-widget-rtl" : ""}`}>
      {open ? (
        <div className="crm-widget-panel" role="dialog" aria-label={t("landing.crm.header")}>
          <div className="crm-widget-header">
            <div className="crm-widget-title">{t("landing.crm.header")}</div>
            <button
              type="button"
              className="crm-widget-close"
              onClick={() => setOpen(false)}
              aria-label={t("landing.crm.close")}
              data-testid="crm-widget-close"
            >
              <X size={18} />
            </button>
          </div>

          <div className="crm-widget-messages" ref={scrollRef}>
            {messages.length === 0 && !sending && (
              <div className="crm-widget-greeting">{t("landing.crm.greeting")}</div>
            )}
            {messages.map((m, i) => {
              if (m.role === "user") {
                const text = messageText(m);
                if (!text) return null;
                return (
                  <div key={i} className="crm-widget-message crm-widget-message-user">
                    {text}
                  </div>
                );
              }
              if (m.role === "assistant") {
                const html = renderAssistantHtml(m);
                // No tokens have arrived yet — show the loading dots inside
                // the assistant bubble so the user sees a clear "thinking"
                // indicator the moment they hit send.
                const isLoading = !html && !messageText(m);
                if (isLoading) {
                  return (
                    <div
                      key={i}
                      className="crm-widget-message crm-widget-message-assistant crm-widget-message-typing"
                      aria-live="polite"
                      aria-label={t("landing.crm.thinking")}
                    >
                      <span /><span /><span />
                    </div>
                  );
                }
                return (
                  <div
                    key={i}
                    className="crm-widget-message crm-widget-message-assistant crm-widget-message-md"
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                );
              }
              return null;
            })}
          </div>

          {error && <div className="crm-widget-error">{error}</div>}

          <form className="crm-widget-input-row" onSubmit={handleSend}>
            <input
              ref={inputRef}
              type="text"
              className="crm-widget-input"
              placeholder={t("landing.crm.placeholder")}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={4000}
              disabled={sending}
              data-testid="crm-widget-input"
            />
            <button
              type="submit"
              className="crm-widget-send"
              disabled={!input.trim() || sending}
              aria-label={t("landing.crm.send")}
              data-testid="crm-widget-send"
            >
              <Send size={16} />
            </button>
          </form>

          <div className="crm-widget-disclaimer">{t("landing.crm.disclaimer")}</div>
        </div>
      ) : (
        <button
          type="button"
          className="crm-widget-launcher"
          onClick={() => setOpen(true)}
          aria-label={t("landing.crm.openLabel")}
          data-testid="crm-widget-launcher"
        >
          <MessageCircle size={24} />
        </button>
      )}
    </div>
  );
}
