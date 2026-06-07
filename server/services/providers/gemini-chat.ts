// server/services/providers/gemini-chat.ts
// Gemini implementation of ChatProvider

import { GoogleGenAI } from "@google/genai";
import type {
  ChatProvider,
  ChatRequest,
  ChatCompletionResult,
  StreamChunk,
  ChatMessage,
} from "./streaming-provider";

export class GeminiChatProvider implements ChatProvider {
  private client: GoogleGenAI;

  constructor() {
    this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
  }

  // Safety settings to prevent Gemini from blocking legitimate AAC content
  // (e.g. camera images of a child's environment)
  private static SAFETY_SETTINGS = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  ];

  async completeChat(request: ChatRequest): Promise<ChatCompletionResult> {
    const { systemInstruction, contents, tools, toolConfig } = this.buildRequest(request);

    const config: any = {
      systemInstruction,
      temperature: request.temperature ?? 0.7,
      maxOutputTokens: request.maxTokens || 500,
      safetySettings: GeminiChatProvider.SAFETY_SETTINGS,
    };
    if (tools) config.tools = tools;
    if (toolConfig) config.toolConfig = toolConfig;
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
    console.log(`[GeminiChat] Request: model=${request.model}, sysInstr=${systemInstruction.length}ch, contents=[${contentSummary}], tools=[${toolNames}], toolConfig=${JSON.stringify(toolConfig)}, maxTokens=${config.maxOutputTokens}`);

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
            completionTokens: usage.candidatesTokenCount || 0,
            cachedTokens,
          }
        : undefined,
      finishReason: finishReason || undefined,
    };
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<StreamChunk> {
    const { systemInstruction, contents, tools, toolConfig } = this.buildRequest(request);

    const config: any = {
      systemInstruction,
      temperature: request.temperature ?? 0.7,
      maxOutputTokens: request.maxTokens || 500,
      safetySettings: GeminiChatProvider.SAFETY_SETTINGS,
    };
    if (tools) config.tools = tools;
    if (toolConfig) config.toolConfig = toolConfig;

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
          completionTokens: usage.candidatesTokenCount || 0,
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

    // Convert tools
    let tools: any = undefined;
    let toolConfig: any = undefined;

    if (request.tools && request.tools.length > 0) {
      const functionDeclarations = request.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description || "",
        parameters: this.cleanSchema(t.function.parameters),
      }));
      tools = [{ functionDeclarations }];

      // Map tool_choice
      if (request.toolChoice === "required") {
        toolConfig = { functionCallingConfig: { mode: "ANY" } };
      } else if (request.toolChoice === "none") {
        toolConfig = { functionCallingConfig: { mode: "NONE" } };
      }
    }

    return {
      systemInstruction: systemParts.join("\n\n"),
      contents,
      tools,
      toolConfig,
    };
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
