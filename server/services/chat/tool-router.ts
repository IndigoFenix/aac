import { ChatMessage, ChatState } from "./chat-handler";
import { CREDITS_PER_WEB_SEARCH } from "./cost-helpers";
import { GPTFunctionToolCall, GPTToolCall, JSONSchema } from "./gpt";
import { sendEmail } from "./tools/email";
import { MemoryOperationResult, MemoryToolInput, processMemoryToolResponse } from "./memory-system";
import { ArticleResponse, fetchPage, SearchItem, webSearch } from "./tools/search-engine";
import { getDistance } from "./tools/map-data";
import { AgentAPIEndpoint } from "@shared/schema";
//import { McpWsClient } from "./mcp-client";
const API_PREFIX = "api_";

// tool-router.ts
export type ToolExecutor = (args: any) => Promise<any>;

export interface ToolRegistry {
  apiCall: (toolCall: GPTFunctionToolCall) => Promise<any>;
  openTopic: (args: { topic: string }) => Promise<{success: boolean, error?: string}>;
  manageMemory: (input: MemoryToolInput) => Promise<MemoryOperationResult[]>;
  webSearch: (args: { query: string }) => Promise<SearchItem[]>;
  fetchPage: (args: { url: string }) => Promise<ArticleResponse | null>;
  sendEmail: (args: { to: string, subject: string, html: string }) => Promise<any>;
  getDistance: (args: { from: string, to: string }) => Promise<any>;
  listRooms: (args: { }) => Promise<any>;
  setRooms: (args: { roomIds: string[] }) => Promise<any>;
  spawn: (args: { subAgentId: string }) => Promise<any>;
  despawn: (args: { subAgentId: string }) => Promise<any>;
}

// Wrap your existing switch-case into functions:
export function defaultToolRegistry(deps: {
  agent: any,
  openedTopics: string[],
  memoryValuesRef: { current: any },
  chatStateRef: { current: ChatState },
  onUpdateMemoryValues?: (v: any) => Promise<void>,
  onUpdateChatState?: (v: ChatState) => Promise<void>
  onCreditsUsed?: (v: number) => Promise<void>
}) : ToolRegistry {
  return {
    apiCall: async (toolCall: GPTFunctionToolCall) => {
      // User-defined API call
      const functionToolCall = toolCall as GPTFunctionToolCall;
      const fnName = (toolCall as GPTFunctionToolCall).function.name;
      const endpointData = deps.agent.apiEndpoints.find((endpoint: any) => `${API_PREFIX}${endpoint.name}` === fnName);
      if (!endpointData){
          return {error: `API endpoint "${fnName}" not found.`};
      } else {
          const params = functionToolCall.function.arguments ? JSON.parse(functionToolCall.function.arguments) : {};
          try {
              console.log('Calling API endpoint', endpointData.name, 'with params:', params);
              const response = await callApiEndpoint(endpointData, params);
              return response;
          } catch (e: any) {
              return {error: e.message};
          }
      }
    },
    openTopic: async ({ topic }) => {
        if (!deps.openedTopics.includes(topic)){
          deps.openedTopics.push(topic);
          return {success: true};
        } else {
          return {success: false, error: `Topic "${topic}" is already open.`};
        }
    },
    manageMemory: async (input: MemoryToolInput) => {
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
      if (!query) throw new Error('No query provided');
      const searchResults = await webSearch(query);
      return searchResults;
    },
    fetchPage: async ({ url }) => {
      if (!url) throw new Error('No url provided');
      const searchResults = await fetchPage(url);
      return searchResults;
    },
    sendEmail: async (args: { to: string, subject: string, html: string }) => {
      const mailOptions = deps.agent.tools?.email;
      if (!mailOptions) throw new Error('No email tool found');
      if (!mailOptions?.address) throw new Error('No email address found');
      const auth = (mailOptions?.username && mailOptions?.password) ? {
          user: mailOptions?.username,
          pass: mailOptions?.password
      } : null;
      const result = await sendEmail({
          from: mailOptions?.address,
          to: args.to,
          subject: args.subject,
          html: args.html,
      }, mailOptions?.service || 'gmail', auth);
      return result;
    },
    getDistance: async (args: { from: string, to: string }) => {
      const result = await getDistance(args.from, args.to);
      return result;
    },
    listRooms: async () => {
      const result = {};
      return result;
    },
    setRooms: async (args: { roomIds: string[] }) => {
      /*
      deps.chatStateRef.current.
      setActiveRooms(ctx.session, args.roomIds);
      buildHistoryForRooms(ctx.session);
      return { activeRoomIds: ctx.session.activeRoomIds };*/
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
/*
const mcpClients = new Map<string, McpWsClient>(); // url -> client

function getMcp(url: string): McpWsClient {
  let c = mcpClients.get(url);
  if (!c) { c = new McpWsClient(url); mcpClients.set(url, c); }
  return c;
}
*/

export async function callApiEndpoint(
  endpoint: AgentAPIEndpoint,
  params: { [key: string]: any } = {}
): Promise<any> {
  if (!endpoint || !endpoint.name || !endpoint.url) {
    throw new Error("Invalid API endpoint");
  }

  console.log(`Calling ${endpoint.name} with params:`, params);

  try {
    // === HTTP or vanilla JSON-RPC-over-HTTP ===
    const body = (endpoint.useRpc || endpoint.protocol === "jsonrpc")
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

/**
 * Look up a value for a key-type property.
 * Tries both the bare name ("apiKey") and a dotted path ("auth.apiKey")
 * to allow disambiguation of nested keys.
 */
function lookupKeyValue(values: Record<string, any>, name: string, path: string[]): any | undefined {
  if (Object.prototype.hasOwnProperty.call(values, name)) return values[name];
  const dotted = [...path, name].join(".");
  if (Object.prototype.hasOwnProperty.call(values, dotted)) return values[dotted];
  return undefined;
}

/**
 * Recursively insert key-type values under parentArgs[propName] according to schema.
 * Returns true if it mutated parentArgs.
 *
 * - Handles nested `object` schemas (via `properties`)
 * - Skips arrays and $ref (no resolution)
 */
function insertKeysForProperty(
  parentArgs: Record<string, any>,
  propName: string,
  schema: JSONSchema,
  values: Record<string, any>,
  pathSoFar: string[]
): boolean {
  // $ref not supported here
  if (isRefSchema(schema)) return false;

  // Direct key at this level
  if (isKeySchema(schema)) {
    const v = lookupKeyValue(values, propName, pathSoFar);
    if (v !== undefined) {
      parentArgs[propName] = v;
      return true;
    }
    return false; // no value provided; leave as-is
  }

  // If this property is (or behaves like) an object, walk its child properties
  const childProps = getObjectProps(schema);
  if (childProps) {
    // Only create/attach the child object if we actually insert anything
    const existing = isPlainObject(parentArgs[propName]) ? (parentArgs[propName] as Record<string, any>) : {};
    let mutated = false;

    for (const [childName, childSchema] of Object.entries(childProps)) {
      const didMutate = insertKeysForProperty(existing, childName, childSchema, values, [...pathSoFar, propName]);
      mutated = mutated || didMutate;
    }

    if (mutated) {
      parentArgs[propName] = existing;
      return true;
    }
  }

  // Arrays (and anything else) are skipped by design
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

    // Parse the model's arguments; only proceed for plain objects
    let args: unknown;
    try {
      args = JSON.parse((toolCall as GPTFunctionToolCall).function.arguments || "{}");
    } catch {
      // If parse fails, leave as-is for robustness
      return;
    }
    if (!isPlainObject(args)) return;

    // Walk each top-level endpoint property and inject keys where needed
    for (const p of endpoint.properties ?? []) {
      const { name, ...schema } = p;
      if (!name) continue;
      insertKeysForProperty(args as Record<string, any>, name, schema as JSONSchema, values, []);
    }

    // Write back the enriched arguments
    (toolCall as GPTFunctionToolCall).function.arguments = JSON.stringify(args);
  });

  return toolCallMessage;
}

export async function makeToolCalls(registry: ToolRegistry, toolCallMessage: ChatMessage){
  const toolCallMessages: ChatMessage[] = [
    toolCallMessage
  ];

  if (!toolCallMessage.toolCalls) return toolCallMessages;

  const toolCalls = toolCallMessage.toolCalls;

  const insertToolCallResponse = (toolCall: GPTToolCall, response: any, credits?: number) => {
    const message: ChatMessage = {
        role: 'tool',
        toolCallId: toolCall.id,
        content: JSON.stringify(response),
        timestamp: Date.now(),
        credits: credits || 0,
    };
    toolCallMessages.push(message);
  }

  await Promise.all(toolCalls.map(async (toolCall) => {
    try {
      let response;
      if (toolCall.type === 'function') {
          if (toolCall.function?.name?.startsWith(API_PREFIX)){
            // User-defined API call
            response = await registry.apiCall(toolCall);
            insertToolCallResponse(toolCall, response);
          } else {
              // Built-in tools
              let args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
              let response;
              switch (toolCall.function.name) {
                  case 'openTopic':
                    response = await registry.openTopic(args as { topic: string });
                    insertToolCallResponse(toolCall, response);
                    break;
                  case 'manageMemory':
                    response = await registry.manageMemory(args);
                    insertToolCallResponse(toolCall, response);
                    break;
                  case 'webSearch':
                    response = await registry.webSearch(args);
                    insertToolCallResponse(toolCall, response, CREDITS_PER_WEB_SEARCH);
                    break;
                  case 'fetchPage':
                    response = await registry.fetchPage(args);
                    insertToolCallResponse(toolCall, response, CREDITS_PER_WEB_SEARCH);
                    break;
                  case 'sendEmail':
                    response = await registry.sendEmail(args as { to: string, subject: string, html: string });
                    insertToolCallResponse(toolCall, response);
                    break;
                  case 'getDistance':
                    response = await registry.getDistance(args as { from: string, to: string });
                    insertToolCallResponse(toolCall, response);
                    break;
                  case 'pruneMessages':
                    insertToolCallResponse(toolCall, {success: true});
                    break;
                  default:
                    insertToolCallResponse(toolCall, {error: `Unknown tool: ${toolCall.function.name}`});
                    break;
              }
          }
      }
    } catch (e: any) {
      insertToolCallResponse(toolCall, {error: e.message});
    }
  }));
  return toolCallMessages;
}