// server/services/providers/gemini-chat.ts
// Gemini implementation of ChatProvider

import { createHash } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { vertexClientOptions } from "./vertex-config";
import type {
  ChatProvider,
  ChatRequest,
  ChatCompletionResult,
  StreamChunk,
  ChatMessage,
  ChatTool,
} from "./streaming-provider";

/** One live explicit-cache entry (Gemini cachedContents resource). */
type PromptCacheEntry = {
  name: string;
  expireAt: number;
  lastUsed: number;
};

/** Refresh a cache's TTL when it has less than this long left at use time. */
const PROMPT_CACHE_REFRESH_BELOW_MS = 5 * 60 * 1000;
/** Treat an entry as unusable when it expires sooner than this. */
const PROMPT_CACHE_MIN_VALID_MS = 60 * 1000;
const PROMPT_CACHE_TTL = "1800s";
/** Global LRU bound. Storage bills per token-hour, so keep the set small
 *  (8 × ~8k tokens ≈ $0.06/hr worst case — negligible, but bounded). */
const PROMPT_CACHE_MAX_ENTRIES = 8;
/** Back off creates after a failure so a persistent error (e.g. prompt under
 *  the 1024-token cache minimum) doesn't add a failing API call per turn. */
const PROMPT_CACHE_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

export class GeminiChatProvider implements ChatProvider {
  private client: GoogleGenAI;
  /** Explicit prompt caches, keyed by content hash (model+system+tools).
   *  Provider is a singleton, so identical prompts share across sessions. */
  private promptCaches = new Map<string, PromptCacheEntry>();
  private promptCacheFailedUntil = 0;

  /** True when this instance is talking to Vertex rather than AI Studio. */
  private readonly usingVertex: boolean;

  /**
   * @param useVertex route through the paid GCP project instead of the AI
   *   Studio `GEMINI_API_KEY`. Carries the SAME signal the Live provider takes
   *   (AgentCoordinator.useVertex), so the HTTP agents of a session bill the
   *   same way its live agents do. Falls back to the API key when Vertex is not
   *   configured, so a developer machine without a service account still works.
   */
  constructor(useVertex = false) {
    const vertex = useVertex ? vertexClientOptions() : null;
    this.usingVertex = !!vertex;
    if (vertex) {
      console.log(`[GeminiChat] Using Vertex AI (project=${vertex.project}, location=${vertex.location})`);
      this.client = new GoogleGenAI(vertex);
    } else {
      if (useVertex) {
        // Asked for Vertex, no project configured. Worth saying out loud: this
        // is the silent downgrade onto the free key that cost a day of the
        // Board Manager returning RESOURCE_EXHAUSTED.
        console.warn("[GeminiChat] useVertex requested but no GOOGLE_CLOUD_PROJECT_ID — falling back to GEMINI_API_KEY.");
      }
      this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
    }
  }

  // Safety settings to prevent Gemini from blocking legitimate AAC content
  // (e.g. camera images of a child's environment)
  private static SAFETY_SETTINGS = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  ];

  /**
   * Get (or create) an explicit Gemini context cache holding a stable
   * system prompt + tool declarations + forced-call config, for reuse
   * across many completions. Returns the cachedContents resource name and
   * the token count billed by the CREATE call (0 on a cache hit) so the
   * caller can fold creation into its usage accounting. Returns null when
   * caching is unavailable (recent failure, create error) — the caller
   * falls back to inlining the prompt.
   *
   * NOTE (validated against the live API): a request using `cachedContent`
   * must NOT set systemInstruction / tools / toolConfig — the API rejects
   * it. All three live in the cache; pass `cachedContent` on the
   * ChatRequest and OMIT messages' system role + tools.
   */
  async ensurePromptCache(opts: {
    model: string;
    systemPrompt: string;
    tools?: ChatTool[];
    toolChoice?: "auto" | "required" | "none";
    displayName?: string;
  }): Promise<{ name: string; createdTokens: number } | null> {
    const now = Date.now();
    if (now < this.promptCacheFailedUntil) return null;

    const { tools, toolConfig } = this.convertTools(opts.tools, opts.toolChoice);
    const key = createHash("sha256")
      .update(opts.model).update("\0")
      .update(opts.systemPrompt).update("\0")
      .update(JSON.stringify(tools ?? null)).update("\0")
      .update(JSON.stringify(toolConfig ?? null))
      .digest("hex");

    const existing = this.promptCaches.get(key);
    if (existing && existing.expireAt - now > PROMPT_CACHE_MIN_VALID_MS) {
      existing.lastUsed = now;
      // Extend the TTL when it's running low — an update is free (no tokens).
      if (existing.expireAt - now < PROMPT_CACHE_REFRESH_BELOW_MS) {
        try {
          const updated = await this.client.caches.update({
            name: existing.name,
            config: { ttl: PROMPT_CACHE_TTL },
          });
          existing.expireAt = updated.expireTime
            ? new Date(updated.expireTime).getTime()
            : now + 1800 * 1000;
        } catch {
          this.promptCaches.delete(key);
          return null; // caller inlines this turn; next turn recreates
        }
      }
      return { name: existing.name, createdTokens: 0 };
    }

    try {
      const created = await this.client.caches.create({
        model: opts.model,
        config: {
          systemInstruction: { parts: [{ text: opts.systemPrompt }] },
          ...(tools ? { tools } : {}),
          ...(toolConfig ? { toolConfig } : {}),
          displayName: opts.displayName ?? "chat-prompt-cache",
          ttl: PROMPT_CACHE_TTL,
        },
      });
      if (!created.name) return null;
      const entry: PromptCacheEntry = {
        name: created.name,
        expireAt: created.expireTime ? new Date(created.expireTime).getTime() : now + 1800 * 1000,
        lastUsed: now,
      };
      this.promptCaches.set(key, entry);
      this.evictPromptCachesOverCap();
      const createdTokens = created.usageMetadata?.totalTokenCount ?? 0;
      console.log(`[GeminiChat] Prompt cache created: ${created.name} (${createdTokens} tokens, ${opts.displayName ?? "unnamed"})`);
      return { name: entry.name, createdTokens };
    } catch (err) {
      console.warn("[GeminiChat] Prompt cache create failed — inlining prompt:", (err as Error).message);
      this.promptCacheFailedUntil = now + PROMPT_CACHE_FAILURE_COOLDOWN_MS;
      return null;
    }
  }

  /** Drop a cache handle that the API rejected (expired/deleted server-side).
   *  Best-effort delete; the next ensurePromptCache recreates it. */
  invalidatePromptCache(name: string): void {
    for (const [key, entry] of this.promptCaches) {
      if (entry.name === name) this.promptCaches.delete(key);
    }
    this.client.caches.delete({ name }).catch(() => { /* already gone */ });
  }

  private evictPromptCachesOverCap(): void {
    while (this.promptCaches.size > PROMPT_CACHE_MAX_ENTRIES) {
      let oldestKey: string | null = null;
      let oldestUsed = Infinity;
      for (const [key, entry] of this.promptCaches) {
        if (entry.lastUsed < oldestUsed) { oldestUsed = entry.lastUsed; oldestKey = key; }
      }
      if (!oldestKey) return;
      const evicted = this.promptCaches.get(oldestKey)!;
      this.promptCaches.delete(oldestKey);
      this.client.caches.delete({ name: evicted.name }).catch(() => { /* ttl cleans up */ });
    }
  }

  async completeChat(request: ChatRequest): Promise<ChatCompletionResult> {
    const { systemInstruction, contents, tools, toolConfig } = this.buildRequest(request);

    const config: any = {
      temperature: request.temperature ?? 0.7,
      maxOutputTokens: request.maxTokens || 500,
      safetySettings: GeminiChatProvider.SAFETY_SETTINGS,
    };
    if (request.cachedContent) {
      // systemInstruction / tools / toolConfig live in the cache; the API
      // rejects a request that sets them alongside cachedContent.
      config.cachedContent = request.cachedContent;
      if (systemInstruction || tools || toolConfig) {
        console.warn("[GeminiChat] cachedContent set — ignoring inline systemInstruction/tools (caller should omit them)");
      }
    } else {
      config.systemInstruction = systemInstruction;
      if (tools) config.tools = tools;
      if (toolConfig) config.toolConfig = toolConfig;
    }
    if (request.thinkingBudget !== undefined) {
      config.thinkingConfig = { thinkingBudget: request.thinkingBudget };
    }
    // Honor caller's AbortSignal so a superseded invocation can be
    // cancelled mid-flight (cancels the local fetch — per SDK docs the
    // server still bills tokens, but our promise rejects immediately so
    // we don't pay the wall-clock wait).
    if (request.signal) config.abortSignal = request.signal;

    // Log request summary for debugging
    const contentSummary = contents.map((c: any) => {
      const partTypes = c.parts?.map((p: any) => {
        if (p.text) return `text(${p.text.length}ch)`;
        if (p.inlineData) return `inlineData(${p.inlineData.mimeType},${Math.round((p.inlineData.data?.length || 0) / 1024)}KB)`;
        return "unknown";
      }).join("+") || "empty";
      return `${c.role}:[${partTypes}]`;
    }).join(", ");
    const toolNames = tools?.[0]?.functionDeclarations?.map((f: any) => f.name).join(",") || "none";
    console.log(`[GeminiChat] Request: model=${request.model}, sysInstr=${systemInstruction.length}ch, cachedContent=${request.cachedContent ?? "none"}, contents=[${contentSummary}], tools=[${toolNames}], toolConfig=${JSON.stringify(toolConfig)}, maxTokens=${config.maxOutputTokens}`);

    const response = await this.client.models.generateContent({
      model: request.model,
      config,
      contents,
    });

    // Diagnostic: log raw response shape to debug empty/blocked responses
    const candidates = (response as any)?.candidates || [];
    const finishReason = candidates[0]?.finishReason;
    const blockReason = (response as any)?.promptFeedback?.blockReason;
    const safetyRatings = candidates[0]?.safetyRatings?.map((r: any) => `${r.category}:${r.probability}`).join(", ");
    const candidateParts = candidates[0]?.content?.parts?.length || 0;

    let text = "";
    try { text = response?.text || ""; } catch { /* .text getter can throw if blocked */ }
    const toolCalls = this.extractToolCalls(response);
    const usage = response?.usageMetadata;
    const cachedTokens = usage?.cachedContentTokenCount || 0;
    console.log(`[GeminiChat] Response: finish=${finishReason}, blockReason=${blockReason}, parts=${candidateParts}, text=${text.length}chars, tool_calls=${toolCalls.length}, prompt_tokens=${usage?.promptTokenCount} (cached=${cachedTokens}), candidates_tokens=${usage?.candidatesTokenCount}, safety=[${safetyRatings || "none"}]`);


    return {
      content: text || null,
      toolCalls,
      usage: usage
        ? {
            // Gemini's promptTokenCount is the EFFECTIVE prompt size and
            // already includes the cached portion. The cost-helpers split
            // cached vs. uncached billing using cachedTokens, so we pass
            // both through and the cost layer does (promptTokens -
            // cachedTokens) * uncached_rate + cachedTokens * cached_rate.
            promptTokens: usage.promptTokenCount || 0,
            // Thinking tokens bill as output on Gemini 2.5 and are reported
            // separately from candidatesTokenCount.
            completionTokens: (usage.candidatesTokenCount || 0) + ((usage as any).thoughtsTokenCount || 0),
            cachedTokens,
          }
        : undefined,
      finishReason: finishReason || undefined,
    };
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<StreamChunk> {
    const { systemInstruction, contents, tools, toolConfig } = this.buildRequest(request);

    const config: any = {
      temperature: request.temperature ?? 0.7,
      maxOutputTokens: request.maxTokens || 500,
      safetySettings: GeminiChatProvider.SAFETY_SETTINGS,
    };
    if (request.cachedContent) {
      // See completeChat — the cache carries systemInstruction/tools.
      config.cachedContent = request.cachedContent;
    } else {
      config.systemInstruction = systemInstruction;
      if (tools) config.tools = tools;
      if (toolConfig) config.toolConfig = toolConfig;
    }
    if (request.thinkingBudget !== undefined) {
      config.thinkingConfig = { thinkingBudget: request.thinkingBudget };
    }

    const response = await this.client.models.generateContentStream({
      model: request.model,
      config,
      contents,
    });

    let toolCallIndex = 0;
    let finalUsage: { promptTokens: number; completionTokens: number; cachedTokens?: number } | undefined;
    let lastFinishReason: string | undefined;
    let totalTextLength = 0;

    for await (const chunk of response) {
      if (request.signal?.aborted) break;

      // Text content
      const text = chunk?.text;
      if (text) {
        totalTextLength += text.length;
        yield { type: "text_delta", text };
      }

      // Function calls in streaming chunks
      const candidates = chunk?.candidates || [];
      for (const candidate of candidates) {
        // Capture finish reason from any candidate
        if (candidate?.finishReason) {
          lastFinishReason = candidate.finishReason;
        }

        const parts = candidate?.content?.parts || [];
        for (const part of parts) {
          if (part.functionCall) {
            yield {
              type: "tool_call_delta",
              index: toolCallIndex,
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args || {}),
            };
            toolCallIndex++;
          }
        }
      }

      // Capture usage metadata (Gemini includes it in stream chunks, typically the last)
      const usage = (chunk as any)?.usageMetadata;
      if (usage) {
        finalUsage = {
          promptTokens: usage.promptTokenCount || 0,
          // Thinking tokens bill as output on Gemini 2.5
          completionTokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
          cachedTokens: usage.cachedContentTokenCount || 0,
        };
      }
    }

    // Log diagnostic info if stream ended unexpectedly
    if (lastFinishReason && lastFinishReason !== "STOP") {
      console.warn(`[GeminiChat] Stream ended with finishReason=${lastFinishReason}, totalText=${totalTextLength}chars, completionTokens=${finalUsage?.completionTokens}`);
    }

    yield { type: "done", usage: finalUsage };
  }

  private buildRequest(request: ChatRequest) {
    // Extract system instruction
    const systemParts: string[] = [];
    const contents: Array<{ role: string; parts: Array<any> }> = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        const text = typeof msg.content === "string"
          ? msg.content
          : (msg.content as any[]).map((p: any) => p.text || "").join("\n");
        systemParts.push(text);
      } else if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
        // Assistant message with function calls
        const parts: any[] = [];
        if (msg.content && typeof msg.content === "string") {
          parts.push({ text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          let args: any = {};
          try { args = JSON.parse(tc.arguments); } catch {}
          parts.push({ functionCall: { name: tc.name, args } });
        }
        contents.push({ role: "model", parts });
      } else if (msg.role === "tool" && msg.toolCallId) {
        // Tool response — Gemini uses functionResponse with the function name
        // Look back through messages to find the matching tool call name
        let functionName = "unknown";
        for (let j = contents.length - 1; j >= 0; j--) {
          const prev = contents[j];
          if (prev.role === "model") {
            for (const p of prev.parts) {
              if (p.functionCall?.name) {
                // Check if this is the matching call by looking at tool call IDs in our messages
                functionName = p.functionCall.name;
                break;
              }
            }
            if (functionName !== "unknown") break;
          }
        }
        let responseData: any = {};
        try {
          responseData = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content;
        } catch {
          responseData = { result: msg.content };
        }
        contents.push({
          role: "user",
          parts: [{ functionResponse: { name: functionName, response: responseData } }],
        });
      } else if (typeof msg.content === "string") {
        contents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content }],
        });
      } else if (msg.content === null) {
        // Skip null-content messages
      } else {
        // Multi-part content (text + image + audio)
        const parts: any[] = [];
        for (const part of msg.content as any[]) {
          if (part.type === "text" && part.text) {
            parts.push({ text: part.text });
          } else if (part.type === "image_url" && part.image_url?.url) {
            // Convert OpenAI image_url to Gemini inlineData
            const url: string = part.image_url.url;
            if (url.startsWith("data:")) {
              const match = url.match(/^data:([^;]+);base64,(.+)$/);
              if (match) {
                parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
              }
            } else {
              // External URL — pass as text fallback
              parts.push({ text: `[Image: ${url}]` });
            }
          } else if (part.type === "input_audio" && part.input_audio?.data) {
            // Convert OpenAI input_audio to Gemini inlineData
            const format = part.input_audio.format || "webm";
            const mimeType = format === "webm" ? "audio/webm" : `audio/${format}`;
            parts.push({ inlineData: { mimeType, data: part.input_audio.data } });
          }
        }
        if (parts.length === 0) {
          parts.push({ text: "" });
        }
        contents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts,
        });
      }
    }

    if (contents.length === 0) {
      contents.push({ role: "user", parts: [{ text: "Respond." }] });
    }

    const { tools, toolConfig } = this.convertTools(request.tools, request.toolChoice);

    return {
      systemInstruction: systemParts.join("\n\n"),
      contents,
      tools,
      toolConfig,
    };
  }

  /** OpenAI-shaped ChatTool[] → Gemini tools + toolConfig. Shared by
   *  buildRequest and ensurePromptCache so a cached tool set is byte-
   *  identical to what an inline request would have sent. */
  private convertTools(
    toolsIn?: ChatTool[],
    toolChoice?: "auto" | "required" | "none",
  ): { tools: any; toolConfig: any } {
    let tools: any = undefined;
    let toolConfig: any = undefined;

    if (toolsIn && toolsIn.length > 0) {
      const functionDeclarations = toolsIn.map((t) => ({
        name: t.function.name,
        description: t.function.description || "",
        parameters: this.cleanSchema(t.function.parameters),
      }));
      tools = [{ functionDeclarations }];

      // Map tool_choice
      if (toolChoice === "required") {
        toolConfig = { functionCallingConfig: { mode: "ANY" } };
      } else if (toolChoice === "none") {
        toolConfig = { functionCallingConfig: { mode: "NONE" } };
      }
    }

    return { tools, toolConfig };
  }

  private cleanSchema(schema: any): any {
    if (!schema || typeof schema !== "object") return schema;
    // Preserve arrays (required, enum, etc.) — recurse into elements
    if (Array.isArray(schema)) {
      return schema.map((item: any) => this.cleanSchema(item));
    }
    const cleaned: any = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === "additionalProperties" || key === "$ref") continue;
      // Gemini expects "type" to be a string, not an array like ["string"]
      if (key === "type" && Array.isArray(value)) {
        const filtered = value.filter((t: string) => t !== "null");
        cleaned[key] = filtered[0] || "string";
        continue;
      }
      if (typeof value === "object" && value !== null) {
        cleaned[key] = this.cleanSchema(value);
      } else {
        cleaned[key] = value;
      }
    }
    return cleaned;
  }

  private extractToolCalls(response: any): Array<{ name: string; arguments: string }> {
    const toolCalls: Array<{ name: string; arguments: string }> = [];
    const candidates = response?.candidates || [];
    for (const candidate of candidates) {
      const parts = candidate?.content?.parts || [];
      for (const part of parts) {
        if (part.functionCall) {
          toolCalls.push({
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {}),
          });
        }
      }
    }
    return toolCalls;
  }
}
