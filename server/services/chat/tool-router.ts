import { ChatMessage, ChatState } from "./chat-handler";
import { CREDITS_PER_WEB_SEARCH } from "./cost-helpers";
import { GPTFunctionToolCall, GPTToolCall, JSONSchema } from "./gpt";
import { sendEmail } from "./tools/email";
import { MemoryOperationResult, MemoryToolInput, processMemoryToolResponse } from "./memory-system";
import { ArticleResponse, fetchPage, SearchItem, webSearch } from "./tools/search-engine";
import { getDistance } from "./tools/map-data";
import { AgentAPIEndpoint } from "@shared/schema";

const API_PREFIX = "api_";

// ============================================================================
// TYPES
// ============================================================================

export type ToolExecutor = (args: any) => Promise<any>;

/**
 * Custom memory processor function type.
 * Allows external systems to inject their own memory handling logic
 * (e.g., database-backed memory with sync).
 */
export type MemoryProcessor = (
  input: MemoryToolInput
) => Promise<{
  results: MemoryOperationResult[];
  updatedMemoryValues: any;
  updatedMemoryState: any;
}>;

/**
 * Tool registry interface - all available tools
 */
export interface ToolRegistry {
  apiCall: (toolCall: GPTFunctionToolCall) => Promise<any>;
  openTopic: (args: { topic: string }) => Promise<{ success: boolean; error?: string }>;
  manageMemory: (input: MemoryToolInput) => Promise<MemoryOperationResult[]>;
  webSearch: (args: { query: string }) => Promise<SearchItem[]>;
  fetchPage: (args: { url: string }) => Promise<ArticleResponse | null>;
  sendEmail: (args: { to: string; subject: string; html: string }) => Promise<any>;
  getDistance: (args: { from: string; to: string }) => Promise<any>;
  listRooms: (args: {}) => Promise<any>;
  setRooms: (args: { roomIds: string[] }) => Promise<any>;
  spawn: (args: { subAgentId: string }) => Promise<any>;
  despawn: (args: { subAgentId: string }) => Promise<any>;
}

/**
 * Dependencies for creating a tool registry.
 * External systems can customize behavior by providing optional overrides.
 */
export interface ToolRegistryDeps {
  agent: any;
  openedTopics: string[];
  memoryValuesRef: { current: any };
  chatStateRef: { current: ChatState };
  onUpdateMemoryValues?: (v: any) => Promise<void>;
  onUpdateChatState?: (v: ChatState) => Promise<void>;
  onCreditsUsed?: (v: number) => Promise<void>;

  /**
   * Optional custom memory processor.
   * When provided, this replaces the default processMemoryToolResponse.
   * Use this to inject database-backed memory systems.
   * 
   * Example usage with ProgressModeManager:
   * ```
   * memoryProcessor: async (input) => {
   *   return progressManager.processMemoryTool(
   *     memoryValuesRef.current,
   *     chatStateRef.current.memoryState,
   *     input,
   *     processMemoryToolResponse
   *   );
   * }
   * ```
   */
  memoryProcessor?: MemoryProcessor;
}

// ============================================================================
// DEFAULT TOOL REGISTRY
// ============================================================================

/**
 * Creates the default tool registry with all standard tools.
 * 
 * @param deps - Dependencies including refs, callbacks, and optional overrides
 * @returns ToolRegistry with all tools configured
 */
export function defaultToolRegistry(deps: ToolRegistryDeps): ToolRegistry {
  return {
    apiCall: async (toolCall: GPTFunctionToolCall) => {
      const functionToolCall = toolCall as GPTFunctionToolCall;
      const fnName = (toolCall as GPTFunctionToolCall).function.name;
      const endpointData = deps.agent.apiEndpoints.find(
        (endpoint: any) => `${API_PREFIX}${endpoint.name}` === fnName
      );
      if (!endpointData) {
        return { error: `API endpoint "${fnName}" not found.` };
      } else {
        const params = functionToolCall.function.arguments
          ? JSON.parse(functionToolCall.function.arguments)
          : {};
        try {
          console.log("Calling API endpoint", endpointData.name, "with params:", params);
          const response = await callApiEndpoint(endpointData, params);
          return response;
        } catch (e: any) {
          return { error: e.message };
        }
      }
    },

    openTopic: async ({ topic }) => {
      if (!deps.openedTopics.includes(topic)) {
        deps.openedTopics.push(topic);
        return { success: true };
      } else {
        return { success: false, error: `Topic "${topic}" is already open.` };
      }
    },

    manageMemory: async (input: MemoryToolInput) => {
      // Use custom processor if provided, otherwise use default
      if (deps.memoryProcessor) {
        console.log(`[manageMemory] memoryValuesRef before processing: ${JSON.stringify(deps.memoryValuesRef.current)}`);
        const result = await deps.memoryProcessor(input);
        
        // Update refs with new values
        deps.memoryValuesRef.current = result.updatedMemoryValues;
        deps.chatStateRef.current.memoryState = result.updatedMemoryState;
        
        // Notify callbacks
        if (deps.onUpdateMemoryValues) {
          await deps.onUpdateMemoryValues(deps.memoryValuesRef.current);
        }
        if (deps.onUpdateChatState) {
          await deps.onUpdateChatState(deps.chatStateRef.current);
        }

        console.log('[manageMemory] After - result:', result);
        console.log(`[manageMemory] memoryValuesRef after processing: ${JSON.stringify(deps.memoryValuesRef.current)}`);
        
        return result.results;
      }

      // Default: use standard in-memory processor
      const result = processMemoryToolResponse(
        deps.agent.memoryFields || [],
        deps.memoryValuesRef.current,
        deps.chatStateRef.current.memoryState,
        input
      );
      
      deps.memoryValuesRef.current = result.updatedMemoryValues;
      deps.chatStateRef.current.memoryState = result.updatedMemoryState;
      
      if (deps.onUpdateMemoryValues) {
        await deps.onUpdateMemoryValues(deps.memoryValuesRef.current);
      }
      
      return result.results;
    },

    webSearch: async ({ query }) => {
      if (!query) throw new Error("No query provided");
      const searchResults = await webSearch(query);
      return searchResults;
    },

    fetchPage: async ({ url }) => {
      if (!url) throw new Error("No url provided");
      const searchResults = await fetchPage(url);
      return searchResults;
    },

    sendEmail: async (args: { to: string; subject: string; html: string }) => {
      const mailOptions = deps.agent.tools?.email;
      if (!mailOptions) throw new Error("No email tool found");
      if (!mailOptions?.address) throw new Error("No email address found");
      const auth =
        mailOptions?.username && mailOptions?.password
          ? {
              user: mailOptions?.username,
              pass: mailOptions?.password,
            }
          : null;
      const result = await sendEmail(
        {
          from: mailOptions?.address,
          to: args.to,
          subject: args.subject,
          html: args.html,
        },
        mailOptions?.service || "gmail",
        auth
      );
      return result;
    },

    getDistance: async (args: { from: string; to: string }) => {
      const result = await getDistance(args.from, args.to);
      return result;
    },

    listRooms: async () => {
      const result = {};
      return result;
    },

    setRooms: async (args: { roomIds: string[] }) => {
      // TODO: Implement room management
    },

    spawn: async (args: { subAgentId: string }) => {
      const result = {};
      return result;
    },

    despawn: async (args: { subAgentId: string }) => {
      const result = {};
      return result;
    },
  };
}

// ============================================================================
// MEMORY PROCESSOR FACTORIES
// ============================================================================

/**
 * Creates a standard in-memory processor (no database sync).
 * This is the default behavior when no custom processor is provided.
 */
export function createStandardMemoryProcessor(
  memoryFields: any[],
  memoryValuesRef: { current: any },
  memoryStateRef: { current: any }
): MemoryProcessor {
  return async (input: MemoryToolInput) => {
    const result = processMemoryToolResponse(
      memoryFields,
      memoryValuesRef.current,
      memoryStateRef.current,
      input
    );
    return {
      results: result.results,
      updatedMemoryValues: result.updatedMemoryValues,
      updatedMemoryState: result.updatedMemoryState,
    };
  };
}

/**
 * Creates a database-backed memory processor.
 * Use this with systems like ProgressModeManager that sync to a database.
 * 
 * @param dbProcessor - The database-aware processor function
 * @param memoryFields - Memory field definitions (with optional db ops)
 * @param memoryValuesRef - Reference to current memory values
 * @param memoryStateRef - Reference to current memory state
 * @param baseContext - Base context for database operations (e.g., { studentId, userId })
 * 
 * @example
 * ```typescript
 * const processor = createDBMemoryProcessor(
 *   processMemoryToolWithDB,
 *   progressMemoryFields,
 *   memoryValuesRef,
 *   memoryStateRef,
 *   { studentId: student.id, programId: program.id }
 * );
 * ```
 */
export function createDBMemoryProcessor(
  dbProcessor: (
    memoryFields: any[],
    memoryValues: any,
    memoryState: any,
    loadState: any,
    input: MemoryToolInput,
    baseContext: Record<string, any>,
    fallbackProcessor: any
  ) => Promise<{
    updatedMemoryValues: any;
    updatedMemoryState: any;
    results: any[];
  }>,
  memoryFields: any[],
  memoryValuesRef: { current: any },
  memoryStateRef: { current: any },
  loadStateRef: { current: any },
  baseContext: Record<string, any>
): MemoryProcessor {
  return async (input: MemoryToolInput) => {
    console.log('[createDBMemoryProcessor] Called with input:', JSON.stringify(input));
    console.log('[createDBMemoryProcessor] Base context:', baseContext);
    console.log('[createDBMemoryProcessor] Current memoryValues keys:', Object.keys(memoryValuesRef.current));
    const result = await dbProcessor(
      memoryFields,
      memoryValuesRef.current,
      memoryStateRef.current,
      loadStateRef.current,
      input,
      baseContext,
      processMemoryToolResponse
    );
    return {
      results: result.results,
      updatedMemoryValues: result.updatedMemoryValues,
      updatedMemoryState: result.updatedMemoryState,
    };
  };
}

// ============================================================================
// API ENDPOINT HELPERS
// ============================================================================

export async function callApiEndpoint(
  endpoint: AgentAPIEndpoint,
  params: { [key: string]: any } = {}
): Promise<any> {
  if (!endpoint || !endpoint.name || !endpoint.url) {
    throw new Error("Invalid API endpoint");
  }

  console.log(`Calling ${endpoint.name} with params:`, params);

  try {
    const body =
      endpoint.useRpc || endpoint.protocol === "jsonrpc"
        ? {
            jsonrpc: "2.0",
            id: Math.floor(Math.random() * 1_000_000),
            method: endpoint.name,
            params,
          }
        : params;

    const response = await fetch(endpoint.url, {
      method: endpoint.method || "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const responseBody = await response.json();
    if (responseBody?.error) throw new Error(responseBody.error.message);

    console.log(`HTTP endpoint ${endpoint.name} response:`, responseBody);
    return responseBody.result ?? responseBody;
  } catch (e: any) {
    throw new Error(`Error calling ${endpoint.name}: ${e.message}`);
  }
}

// ============================================================================
// TOOL CALL MESSAGE HELPERS
// ============================================================================

/**
 * Helper type guards/utilities
 */
type NonRefSchema = Exclude<JSONSchema, { $ref: string }>;

function isRefSchema(s: JSONSchema): s is { $ref: string } {
  return typeof s === "object" && s !== null && "$ref" in s;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isKeySchema(s: JSONSchema): s is NonRefSchema & { type: "key" } {
  return !isRefSchema(s) && (s as NonRefSchema).type === "key";
}

function getObjectProps(s: JSONSchema): Record<string, JSONSchema> | undefined {
  if (isRefSchema(s)) return undefined;
  const props = (s as NonRefSchema).properties;
  return props && typeof props === "object" ? (props as Record<string, JSONSchema>) : undefined;
}

function lookupKeyValue(values: Record<string, any>, name: string, path: string[]): any | undefined {
  if (Object.prototype.hasOwnProperty.call(values, name)) return values[name];
  const dotted = [...path, name].join(".");
  if (Object.prototype.hasOwnProperty.call(values, dotted)) return values[dotted];
  return undefined;
}

function insertKeysForProperty(
  parentArgs: Record<string, any>,
  propName: string,
  schema: JSONSchema,
  values: Record<string, any>,
  pathSoFar: string[]
): boolean {
  if (isRefSchema(schema)) return false;

  if (isKeySchema(schema)) {
    const v = lookupKeyValue(values, propName, pathSoFar);
    if (v !== undefined) {
      parentArgs[propName] = v;
      return true;
    }
    return false;
  }

  const childProps = getObjectProps(schema);
  if (childProps) {
    const existing = isPlainObject(parentArgs[propName])
      ? (parentArgs[propName] as Record<string, any>)
      : {};
    let mutated = false;

    for (const [childName, childSchema] of Object.entries(childProps)) {
      const didMutate = insertKeysForProperty(
        existing,
        childName,
        childSchema,
        values,
        [...pathSoFar, propName]
      );
      mutated = mutated || didMutate;
    }

    if (mutated) {
      parentArgs[propName] = existing;
      return true;
    }
  }

  return false;
}

export function enrichToolCallMessage(
  toolCallMessage: ChatMessage,
  apiEndpoints: AgentAPIEndpoint[],
  values: { [key: string]: any }
): ChatMessage {
  if (!toolCallMessage.toolCalls) return toolCallMessage;

  toolCallMessage.toolCalls.forEach((toolCall) => {
    if (toolCall.type !== "function") return;
    if (!toolCall.function?.name?.startsWith(API_PREFIX)) return;

    const endpoint = apiEndpoints.find(
      (ep) => `${API_PREFIX}${ep.name}` === toolCall.function.name
    );
    if (!endpoint) return;

    let args: unknown;
    try {
      args = JSON.parse((toolCall as GPTFunctionToolCall).function.arguments || "{}");
    } catch {
      return;
    }
    if (!isPlainObject(args)) return;

    for (const p of endpoint.properties ?? []) {
      const { name, ...schema } = p;
      if (!name) continue;
      insertKeysForProperty(args as Record<string, any>, name, schema as JSONSchema, values, []);
    }

    (toolCall as GPTFunctionToolCall).function.arguments = JSON.stringify(args);
  });

  return toolCallMessage;
}

export async function makeToolCalls(
  registry: ToolRegistry,
  toolCallMessage: ChatMessage
): Promise<ChatMessage[]> {
  const toolCallMessages: ChatMessage[] = [toolCallMessage];

  if (!toolCallMessage.toolCalls) return toolCallMessages;

  const toolCalls = toolCallMessage.toolCalls;

  const insertToolCallResponse = (toolCall: GPTToolCall, response: any, credits?: number) => {
    const message: ChatMessage = {
      role: "tool",
      toolCallId: toolCall.id,
      content: JSON.stringify(response),
      timestamp: Date.now(),
      credits: credits || 0,
    };
    toolCallMessages.push(message);
  };

  await Promise.all(
    toolCalls.map(async (toolCall) => {
      try {
        let response;
        if (toolCall.type === "function") {
          if (toolCall.function?.name?.startsWith(API_PREFIX)) {
            response = await registry.apiCall(toolCall);
            insertToolCallResponse(toolCall, response);
          } else {
            let args = toolCall.function.arguments
              ? JSON.parse(toolCall.function.arguments)
              : {};
            let response;
            switch (toolCall.function.name) {
              case "openTopic":
                response = await registry.openTopic(args as { topic: string });
                insertToolCallResponse(toolCall, response);
                break;
              case "manageMemory":
                response = await registry.manageMemory(args);
                insertToolCallResponse(toolCall, response);
                break;
              case "webSearch":
                response = await registry.webSearch(args);
                insertToolCallResponse(toolCall, response, CREDITS_PER_WEB_SEARCH);
                break;
              case "fetchPage":
                response = await registry.fetchPage(args);
                insertToolCallResponse(toolCall, response, CREDITS_PER_WEB_SEARCH);
                break;
              case "sendEmail":
                response = await registry.sendEmail(
                  args as { to: string; subject: string; html: string }
                );
                insertToolCallResponse(toolCall, response);
                break;
              case "getDistance":
                response = await registry.getDistance(args as { from: string; to: string });
                insertToolCallResponse(toolCall, response);
                break;
              case "pruneMessages":
                insertToolCallResponse(toolCall, { success: true });
                break;
              default:
                insertToolCallResponse(toolCall, {
                  error: `Unknown tool: ${toolCall.function.name}`,
                });
                break;
            }
          }
        }
      } catch (e: any) {
        insertToolCallResponse(toolCall, { error: e.message });
      }
    })
  );
  
  return toolCallMessages;
}