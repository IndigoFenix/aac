// server/services/providers/claude-structured.ts
// Claude implementation of StructuredLLMProvider
// Uses a forced tool-call pattern for structured output since Claude has no
// native json_schema response format.  A synthetic "_structured_response" tool
// whose input_schema is the desired output schema is always provided, and
// tool_choice is set to "any" so the model MUST call a tool on every turn.

import { resolveModelId } from "@shared/llm-options";
import { getAnthropicClient, isUsingVertex } from "./anthropic-client";
import { recordDisclosure } from "../processorDisclosure";
import type { StructuredLLMProvider, StructuredRequest } from "./structured-provider";
import type { GPTResponse, GPTFunctionToolCall, GPTInputItem } from "../chat/gpt";

/** Name of the synthetic tool used to enforce structured output. */
const STRUCTURED_TOOL_NAME = "_structured_response";

export class ClaudeStructuredProvider implements StructuredLLMProvider {
  private client = getAnthropicClient();
  /** CLAUDE_CACHE_DEBUG only: the previous request's cacheable blocks, so the
   *  dump can name the first character that broke the prefix between calls. */
  private static lastPrefix: { system: string; tools: string } | null = null;

  async structuredComplete(request: StructuredRequest): Promise<GPTResponse> {
    const model = resolveModelId("claude", request.model);

    // AKIM §18.5: the prompt about to be sent is PHI leaving for Anthropic.
    recordDisclosure({
      processor: "anthropic",
      channel: "structured",
      model,
      endpoint: isUsingVertex() ? "vertex" : "api",
      context: request.disclosure,
    });

    // Build system prompt (no schema instructions needed — the tool enforces it)
    let systemPrompt = request.instructions || "";

    // Convert input items to Claude messages
    const { system: extraSystem, messages } = this.convertInputItems(request.input);
    // NOTE: extraSystem contains system-role messages from conversation history
    // (summary, memory snapshots, etc). These change between rounds, so prepending
    // them to the system prompt would invalidate prompt caching. Instead, inject
    // them as a user message at the start of the conversation.
    if (extraSystem) {
      messages.unshift({
        role: "user" as const,
        content: [{ type: "text", text: `[System Context]\n${extraSystem}` }],
      });
      // Claude requires alternating roles — if the next message is also user, merge
      if (messages.length > 1 && messages[1].role === "user") {
        const first = messages.shift()!;
        const second = messages[0];
        const firstParts = Array.isArray(first.content) ? first.content : [{ type: "text", text: first.content }];
        const secondParts = Array.isArray(second.content) ? second.content : [{ type: "text", text: second.content }];
        messages[0] = { role: "user", content: [...firstParts, ...secondParts] };
      }
    }

    // Convert real tools to Claude format
    const tools = this.convertTools(request);

    // Only add the structured output tool when a schema is provided.
    // When schema is undefined (e.g. md mode), the model returns plain text.
    if (request.schema) {
      tools.push({
        name: STRUCTURED_TOOL_NAME,
        description:
          "Return your final structured response. Call this tool when you are " +
          "ready to reply to the user (i.e. you have no more tool calls to make). " +
          "The input MUST conform to the output schema.",
        input_schema: request.schema,
      });
    }

    // Prompt caching is always on. The memory schema runs in static mode so the
    // system prompt is stable across turns, which is what makes the cache produce
    // reads (0.1x) instead of just writes (1.25x). See prompt-cache-stability.test.ts.
    const systemBlock = systemPrompt
      ? [{ type: "text" as const, text: systemPrompt, cache_control: { type: "ephemeral" as const } }]
      : undefined;

    // Also mark the last tool with cache_control so the system+tools prefix stays
    // within the 20-block lookback window even as messages grow
    if (tools.length > 0) {
      (tools[tools.length - 1] as any).cache_control = { type: "ephemeral" as const };
    }

    // Incremental conversation caching: put a breakpoint on the LAST message block
    // so the entire conversation-so-far (system + tools + all prior messages) is
    // cached. The next turn/round reads that whole prefix (0.1x) and only writes the
    // newly-appended delta — instead of re-billing the full, growing history at 1x
    // every round. The cache invalidates from the point history is rewritten
    // (compression/summary), which is the natural "until we compress" boundary.
    // Caps at Anthropic's 4-breakpoint limit (system + last tool + last message = 3).
    if (messages.length > 0) {
      const last = messages[messages.length - 1];
      // cache_control must sit on a content BLOCK, so coerce a bare string first.
      if (typeof last.content === "string") {
        last.content = [{ type: "text", text: last.content }];
      }
      if (Array.isArray(last.content) && last.content.length > 0) {
        (last.content[last.content.length - 1] as any).cache_control = { type: "ephemeral" as const };
      }
    }

    // Opt-in verbose request/usage dump for cache debugging (off by default —
    // would otherwise append to a file on every production call).
    const cacheDebug = process.env.CLAUDE_CACHE_DEBUG === 'true';

    const params: any = {
      model,
      system: systemBlock,
      messages,
      max_tokens: request.maxTokens || 2048,
      temperature: request.temperature ?? 0.7,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? { type: "any" as const } : undefined,
    };

    // Dump COMPLETE request params to file for cache debugging
    if (cacheDebug) {
      try {
        const fs = await import('fs');
        const { join, dirname } = await import('path');
        const { fileURLToPath } = await import('url');
        const __fn = fileURLToPath(import.meta.url);
        const logFile = join(dirname(__fn), '..', '..', 'claude-cache-debug.log');
        // Truncate system text to avoid massive logs, but keep everything else complete
        const logParams = JSON.parse(JSON.stringify(params));
        if (Array.isArray(logParams.system) && logParams.system[0]?.text?.length > 200) {
          logParams.system[0].text = logParams.system[0].text.slice(0, 100) + `... [${logParams.system[0].text.length} chars] ...` + logParams.system[0].text.slice(-100);
        }
        // Cache-prefix forensics: hash the two cacheable blocks and, when the
        // system text differs from the PREVIOUS request in this process, name
        // the first differing character with context. The truncated dump above
        // can't answer "what busted the cache" — this line can.
        const { createHash } = await import('crypto');
        const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
        const sysText: string = params.system?.[0]?.text ?? '';
        const toolsText = JSON.stringify(params.tools ?? []);
        let prefixNote = `PREFIX: system=${sysText.length}ch sha=${sha(sysText)} tools=${toolsText.length}ch sha=${sha(toolsText)}`;
        const prev = ClaudeStructuredProvider.lastPrefix;
        if (prev) {
          const diffAt = (a: string, b: string) => { let i = 0; const n = Math.min(a.length, b.length); while (i < n && a[i] === b[i]) i++; return i; };
          if (prev.system !== sysText) {
            const i = diffAt(prev.system, sysText);
            prefixNote += `\n  SYSTEM DIFFERS from previous request at ${i}/${prev.system.length}` +
              `\n    prev: ${JSON.stringify(prev.system.slice(Math.max(0, i - 60), i + 80))}` +
              `\n    now:  ${JSON.stringify(sysText.slice(Math.max(0, i - 60), i + 80))}`;
          } else prefixNote += '\n  system identical to previous request';
          if (prev.tools !== toolsText) {
            const i = diffAt(prev.tools, toolsText);
            prefixNote += `\n  TOOLS DIFFER from previous request at ${i}/${prev.tools.length}: ${JSON.stringify(toolsText.slice(Math.max(0, i - 40), i + 60))}`;
          } else prefixNote += '\n  tools identical to previous request';
        }
        ClaudeStructuredProvider.lastPrefix = { system: sysText, tools: toolsText };
        fs.appendFileSync(logFile, `\n${'='.repeat(80)}\n[${new Date().toISOString()}]\n${'='.repeat(80)}\n${prefixNote}\n${JSON.stringify(logParams, null, 2)}\n${'─'.repeat(80)}\n`);
      } catch {}
    }

    const response = await this.client.messages.create(params);

    if (cacheDebug) {
      try {
        const fs = await import('fs');
        const { join, dirname } = await import('path');
        const { fileURLToPath } = await import('url');
        const __fn = fileURLToPath(import.meta.url);
        const logFile = join(dirname(__fn), '..', '..', 'claude-cache-debug.log');
        fs.appendFileSync(logFile, `USAGE: ${JSON.stringify(response.usage)}\n`);
      } catch {}
    }

    return this.parseResponse(response);
  }

  // ---------------------------------------------------------------------------
  // Input conversion
  // ---------------------------------------------------------------------------

  private convertInputItems(items: GPTInputItem[]): {
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string | any[] }>;
  } {
    const systemParts: string[] = [];
    const messages: Array<{ role: "user" | "assistant"; content: string | any[] }> = [];

    for (const item of items) {
      if (item.type === "message") {
        if (item.role === "system") {
          const text = typeof item.content === "string"
            ? item.content
            : (item.content as any[]).map((p: any) => p.text || "").join("\n");
          systemParts.push(text);
        } else if (typeof item.content === "string") {
          messages.push({
            role: item.role as "user" | "assistant",
            content: item.content,
          });
        } else {
          // Multimodal content — convert to Claude's native format
          const parts = (item.content as any[]);

          const hasMultimodal = parts.some((p: any) =>
            p.type === "input_image" || p.type === "input_document"
          );

          if (hasMultimodal) {
            const claudeParts: any[] = [];
            for (const p of parts) {
              if (p.type === "input_text" && p.text) {
                claudeParts.push({ type: "text", text: p.text });
              } else if (p.type === "input_image" && p.image_url) {
                const match = (p.image_url as string).match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                  claudeParts.push({
                    type: "image",
                    source: { type: "base64", media_type: match[1], data: match[2] },
                  });
                }
              } else if (p.type === "input_document" && p.data_url) {
                const match = (p.data_url as string).match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                  const mimeType = match[1];
                  const base64Data = match[2];
                  if (mimeType === "application/pdf") {
                    claudeParts.push({
                      type: "document",
                      source: { type: "base64", media_type: "application/pdf", data: base64Data },
                    });
                  } else {
                    const text = Buffer.from(base64Data, "base64").toString("utf-8");
                    claudeParts.push({ type: "text", text: `--- ${p.filename || "file"} ---\n${text}\n---` });
                  }
                }
              }
            }

            messages.push({
              role: item.role as "user" | "assistant",
              content: claudeParts,
            });
          } else {
            messages.push({
              role: item.role as "user" | "assistant",
              content: parts.map((p: any) => p.text || "").join("\n"),
            });
          }
        }
      } else if (item.type === "function_call") {
        // Use Claude's native tool_use content block so the model
        // recognises prior tool calls and doesn't mimic them as text.
        let parsedInput: any = {};
        try { parsedInput = JSON.parse(item.arguments || "{}"); } catch {}
        messages.push({
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: item.call_id,
              name: item.name,
              input: parsedInput,
            },
          ],
        });
      } else if (item.type === "function_call_output") {
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: item.call_id,
              content: item.output,
            },
          ],
        });
      }
    }

    // Claude requires at least one user message
    if (messages.length === 0) {
      messages.push({ role: "user", content: "Respond." });
    }

    // Claude requires alternating user/assistant messages
    // Merge consecutive same-role messages
    const merged: Array<{ role: "user" | "assistant"; content: string | any[] }> = [];
    for (const msg of messages) {
      if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
        const prev = merged[merged.length - 1];
        // If either side is multimodal (array), merge as arrays
        if (Array.isArray(prev.content) || Array.isArray(msg.content)) {
          const prevParts = Array.isArray(prev.content) ? prev.content : [{ type: "text", text: prev.content }];
          const newParts = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
          prev.content = [...prevParts, ...newParts];
        } else {
          prev.content += "\n" + msg.content;
        }
      } else {
        merged.push({ ...msg });
      }
    }

    // Ensure first message is from user
    if (merged.length > 0 && merged[0].role === "assistant") {
      merged.unshift({ role: "user", content: "(conversation continued)" });
    }

    return { system: systemParts.join("\n\n"), messages: merged };
  }

  // ---------------------------------------------------------------------------
  // Tool conversion
  // ---------------------------------------------------------------------------

  private convertTools(request: StructuredRequest): any[] {
    if (!request.tools) return [];
    return request.tools
      .filter((t) => t.type === "function")
      .map((t) => {
        if (t.type !== "function") return null;
        return {
          name: t.function.name,
          description: t.function.description || "",
          input_schema: t.function.parameters,
        };
      })
      .filter(Boolean);
  }

  // ---------------------------------------------------------------------------
  // Response parsing
  // ---------------------------------------------------------------------------

  private parseResponse(response: any): GPTResponse {
    let textContent = "";
    let structuredContent = "";
    const functionCalls: GPTFunctionToolCall[] = [];

    for (const block of response.content || []) {
      if (block.type === "text") {
        textContent += block.text;
      } else if (block.type === "tool_use") {
        if (block.name === STRUCTURED_TOOL_NAME) {
          // This is the structured output — extract as content JSON
          structuredContent = JSON.stringify(block.input || {});
        } else {
          // Real tool call — pass through
          functionCalls.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          });
        }
      }
    }

    // If there are real tool calls, prioritise those (the structured response
    // will come on a subsequent turn after tool results are provided).
    // Otherwise, use the structured content as the response.
    const content = functionCalls.length > 0
      ? textContent
      : (structuredContent || textContent);

    return {
      promptTokens: response.usage?.input_tokens ?? 0,
      completionTokens: response.usage?.output_tokens ?? 0,
      cachedTokens: (response.usage as any)?.cache_read_input_tokens ?? 0,
      // Anthropic bills cache writes at 1.25x base. `input_tokens` EXCLUDES
      // both cache reads and cache writes, so this must be billed on top.
      cacheCreationTokens: (response.usage as any)?.cache_creation_input_tokens ?? 0,
      content,
      output: response.content,
      toolCalls: functionCalls,
      refused: response.stop_reason === "end_turn" && !textContent && !structuredContent && functionCalls.length === 0,
      searchCalls: 0,
    };
  }
}
