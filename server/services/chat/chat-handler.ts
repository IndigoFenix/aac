/**
 * Chat Handler
 * 
 * Migrated from Sequelize to Drizzle ORM.
 * Updated to work with agent templates instead of database agents.
 */

import {
    type ChatSession,
    type ChatState,
    type ChatMessage,
    type ChatMessageContent,
    type AgentMemoryField,
    MessageResponse,
  } from "@shared/schema";
  import { CreditsPerSearchByIntelligence, creditsForModelUsage } from "./cost-helpers";
  import { GPT, GPTResponse, GPTInputItem, GPTFunctionToolCall, GPTContentPart } from "./gpt";
  import { buildPromptAndTools, formValues, NlpSchema, AgentLike } from "./prompt-kit";
  import { defaultToolRegistry, enrichToolCallMessage, LoopDetectionConfig, makeToolCalls, MemoryProcessor, ToolRegistry } from "./tool-router";
  import { publish } from "./events.service";
  import { getChatProvider } from "../providers/provider-factory";
  import type { ChatMessage as ProviderChatMessage, ChatTool, StreamChunk } from "../providers/streaming-provider";
  import type { LLMProviderKey } from "@shared/llm-options";
  import { extractDocument } from "./file-extractor";
  import { storeFile } from "./tools/media-file-cache";

  const isProd = process.env.NODE_ENV === 'production';
  
  const getCullMessagesTo = (memory: number) => {
      if (memory === 1){
          return 10;
      } else if (memory === 2){
          return 25;
      } else {
          return -1;
      }
  }

  const hashCode = (str: string): number => {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0; // Convert to 32bit integer
        }
        return hash;
    }
  
  export interface Topic {
      name: string;
      open: boolean;
      info?: string;
      subtopics?: Topic[];
  }
  
  export interface ChatResponse {
      message: ChatMessage;
      creditsUsed?: number;
      refused?: boolean;
      error?: string;
  }
  
  export interface UserMessageContent {
      text: string,
      audioMimeType?: string,
      formSchema?: NlpSchema,
      formValues?: formValues,
      key?: string,
      apiValues?: { [key: string]: string }
  }

  /** Image data to be passed directly to the API (not stored in ChatMessage) */
  export interface CurrentImage {
      data: Buffer;
      mimeType: string;
  }
  
  /**
   * Agent template interface - extends AgentLike with additional fields
   * Used for local templates that act like database agents
   */
  export interface AgentTemplate extends AgentLike {
      accountId?: string;
      validSources?: string[];
      securityKeys?: string[];
      public?: boolean;
      creditsUsed?: number;
      updatedCredits?: Date;
      creditsTotal?: number;
      creditsRegen?: number;
      instanceCreditsTotal?: number;
      instanceCreditsRegen?: number;
      deletedAt?: Date | null;
      delegatePolicies?: any[];
      display?: any;
  }
  
  class ChatMessageManager {
      agent: AgentTemplate;
      session?: ChatSession;
      gpt: GPT;
      maxCredits: number;
      openedTopics: string[] = [];
      memoryValues: any = {}; // Memory values from User, Student, UserStudent
      chatState: ChatState; // Information the LLM knows about the session
      log: ChatMessage[] = []; // Full log of all messages (including culled messages)
      intelligenceLevel: 0 | 1 | 2 | 3;
      memoryLevel: number;
      vectorStoreId?: string; // For file_search tool support
      currentImage?: CurrentImage; // Image to inject into the next API call (not stored in history)
      images?: string[]; // Base64 data URLs for inline images (single-use, cleared after API call)
      documents?: Array<{ dataUrl: string; filename: string; extractedText?: string }>; // Pending documents from current request
      /** Active file context — keyed by filename, latest version wins. Not persisted to DB. */
      private contextFiles = new Map<string, { dataUrl: string; filename: string; extractedText?: string }>();
  
      cullMessages: boolean;
      cullMessagesTo: number;
      cullMessagesThreshold: number;
      maximumMessages: number;
      /** IANA timezone of the requesting user for this turn; injected into the system prompt. */
      requestTimezone?: string;
      onUpdateMemoryValues?: (memoryValues: any) => Promise<void>;
      onUpdateChatState?: (chatState: ChatState, log?: ChatMessage[]) => Promise<void>;
      onCreditsUsed?: (creditsUsed: number) => Promise<void>;
      onThinkingUpdate?: (thinkingText: string) => void;
      onNavigate?: (feature: string) => void;
      onSelectStudent?: (studentId: string) => void;
      onFilesNeeded?: (files: Array<{ fileId: string; filename: string }>) => void;
      loopDetectionConfig?: LoopDetectionConfig;
      memoryProcessor?: MemoryProcessor;
      toolRegistry: ToolRegistry;

      toJSON(): ChatState {
          return {
              history: this.chatState.history,
              conversationSummary: this.chatState.conversationSummary,
              openedTopics: this.chatState.openedTopics,
              memoryState: this.chatState.memoryState
          }
      }
  
      reloadData(
          agent: AgentTemplate, 
          chatState: ChatState
      ) {
          this.agent = agent;
          this.chatState.conversationSummary = chatState.conversationSummary;
          this.chatState.history = chatState.history;
          this.chatState.openedTopics = chatState.openedTopics;
          this.chatState.memoryState = chatState.memoryState || { opened: [] };
      }
  
      constructor(settings:{
          agent: AgentTemplate,
          session?: ChatSession,
          memoryValues: any,
          chatState: ChatState,
          log: ChatMessage[],
          maxCredits: number,
          onUpdateMemoryValues: (memoryValues: any) => Promise<void>,
          onUpdateChatState: (chatState: ChatState, log?: ChatMessage[]) => Promise<void>
          onCreditsUsed: (creditsUsed: number) => Promise<void>,
          onThinkingUpdate?: (thinkingText: string) => void,
          onNavigate?: (feature: string) => void,
          onSelectStudent?: (studentId: string) => void,
          onFilesNeeded?: (files: Array<{ fileId: string; filename: string }>) => void,
          memoryProcessor?: MemoryProcessor,
          vectorStoreId?: string,
          loopDetectionConfig?: LoopDetectionConfig;
          currentImage?: CurrentImage;
          images?: string[];
          documents?: Array<{ dataUrl: string; filename: string; extractedText?: string }>;
          providerConfig?: { provider: import("@shared/llm-options").LLMProviderKey; model: string };
          timezone?: string;
      }){
          this.chatState = JSON.parse(JSON.stringify(settings.chatState));
          this.log = JSON.parse(JSON.stringify(settings.log));
          this.memoryValues = settings.memoryValues ? JSON.parse(JSON.stringify(settings.memoryValues)) : {};
          this.maxCredits = settings.maxCredits;
          this.gpt = new GPT(settings.providerConfig);
          this.onUpdateMemoryValues = async (memoryValues: any) => {
              memoryValues = JSON.parse(JSON.stringify(memoryValues));
              console.log('[ChatMsgMgr] onUpdateMemoryValues — Context_Board name:', memoryValues?.Context_Board?.name ?? '(none)', 'pages:', memoryValues?.Context_Board?.pages?.length ?? 0);
              this.memoryValues = memoryValues;
              if (settings.onUpdateMemoryValues){
                  await settings.onUpdateMemoryValues(memoryValues);
              }
          };
          this.onUpdateChatState = async (chatState: ChatState, log?: ChatMessage[]) => {
              chatState = JSON.parse(JSON.stringify(chatState));
              log = log ? JSON.parse(JSON.stringify(log)) : undefined;
              settings.onUpdateChatState(chatState, log);
          }
          this.onCreditsUsed = settings.onCreditsUsed;
          this.memoryProcessor = settings.memoryProcessor;
          this.onThinkingUpdate = settings.onThinkingUpdate;
          this.onNavigate = settings.onNavigate;
          this.onSelectStudent = settings.onSelectStudent;
          this.onFilesNeeded = settings.onFilesNeeded;
          this.loopDetectionConfig = settings.loopDetectionConfig;
          this.requestTimezone = settings.timezone;

          this.toolRegistry = defaultToolRegistry({
              agent: settings.agent as any,
              openedTopics: this.chatState.openedTopics,
              memoryValuesRef: { current: this.memoryValues },
              chatStateRef: { current: this.chatState },
              onUpdateMemoryValues: this.onUpdateMemoryValues,
              onUpdateChatState: this.onUpdateChatState,
              onCreditsUsed: this.onCreditsUsed,
              memoryProcessor: this.memoryProcessor,
              onThinkingUpdate: this.onThinkingUpdate,
              onNavigate: this.onNavigate,
              onSelectStudent: this.onSelectStudent,
              onFilesNeeded: this.onFilesNeeded,
              loopDetectionConfig: this.loopDetectionConfig,
              onPruneMessages: (forget, summary, closePaths) => this.compressHistory(forget, summary, closePaths),
          });
  
          this.agent = settings.agent;
          this.session = settings.session;
          const intelligence = parseInt(String(settings.agent.intelligence)) || 1;
          this.intelligenceLevel = intelligence as 0 | 1 | 2 | 3;
          this.memoryLevel = settings.agent.memory || 1;
  
          this.cullMessages = this.memoryLevel < 3;

          this.cullMessagesTo = getCullMessagesTo(this.memoryLevel);
          this.cullMessagesThreshold = this.cullMessagesTo + 5;
          this.maximumMessages = this.cullMessagesTo + 15;

          // File search support
          this.vectorStoreId = settings.vectorStoreId;

          // Image for current request (not persisted in history)
          this.currentImage = settings.currentImage;

          // Inline images from client (base64 data URLs, single-use)
          this.images = settings.images;

          // Attached documents (base64 data URLs, single-use)
          this.documents = settings.documents;

      }

      // Set vector store ID for file search (can be set after construction)
      setVectorStoreId(vectorStoreId: string | undefined) {
          this.vectorStoreId = vectorStoreId;
      }

      // Set image for current request (cleared after use)
      setCurrentImage(image: CurrentImage | undefined) {
          this.currentImage = image;
      }
  
      // Add messages to history and run toolCalls if included.
      // Returns extraction results for files that were processed.
      async persistMessages(messages: ChatMessage[]): Promise<Array<{ filename: string; extractedText: string }> | undefined> {
          // Update context files — same filename overwrites older version
          // Run file extraction so the LLM gets readable text instead of raw base64
          let extractions: Array<{ filename: string; extractedText: string }> | undefined;
          if (this.documents && this.documents.length > 0) {
              for (const doc of this.documents) {
                  // If client already sent extracted text, use it directly
                  if (doc.extractedText) {
                      this.contextFiles.set(doc.filename, {
                          dataUrl: doc.dataUrl,
                          filename: doc.filename,
                          extractedText: doc.extractedText,
                      });
                      console.log(`[ChatMsgMgr] reusing client-cached extraction for ${doc.filename}`);
                      continue;
                  }

                  // Check if this is a video or large media file — store in server cache
                  // and provide a file reference instead of inlining
                  const mimeMatch = doc.dataUrl?.match(/^data:([^;]+);base64,/);
                  const mime = mimeMatch?.[1] || '';
                  if (mime.startsWith('video/') || mime.startsWith('audio/')) {
                      const base64Data = doc.dataUrl.replace(/^data:[^;]+;base64,/, '');
                      const buffer = Buffer.from(base64Data, 'base64');
                      const fileId = storeFile(buffer, mime, doc.filename);
                      this.contextFiles.set(doc.filename, {
                          dataUrl: '',
                          filename: doc.filename,
                          extractedText: `[Uploaded ${mime.startsWith('video/') ? 'video' : 'audio'}: ${doc.filename}]\nTo analyze this file, use the analyzeMedia tool with files: ["file:${fileId}"]`,
                      });
                      console.log(`[ChatMsgMgr] stored ${mime} file ${doc.filename} in cache as file:${fileId} (${buffer.length} bytes)`);
                      continue;
                  }

                  // Check for server-cached file reference (from /api/chat/files/upload)
                  if ((doc as any).fileId) {
                      const fileId = (doc as any).fileId;
                      this.contextFiles.set(doc.filename, {
                          dataUrl: '',
                          filename: doc.filename,
                          extractedText: `[Uploaded file: ${doc.filename}]\nTo analyze this file, use the analyzeMedia tool with files: ["file:${fileId}"]`,
                      });
                      console.log(`[ChatMsgMgr] using pre-uploaded file reference file:${fileId} for ${doc.filename}`);
                      continue;
                  }

                  try {
                      const result = await extractDocument(doc.dataUrl, doc.filename);
                      if (result.extracted && result.text) {
                          this.contextFiles.set(doc.filename, {
                              dataUrl: result.dataUrl ?? doc.dataUrl,
                              filename: doc.filename,
                              extractedText: result.text,
                          });
                          if (!extractions) extractions = [];
                          extractions.push({ filename: doc.filename, extractedText: result.text });
                          console.log(`[ChatMsgMgr] extracted text from ${doc.filename} (${result.text.length} chars)`);
                      } else {
                          this.contextFiles.set(doc.filename, doc);
                      }
                  } catch (err) {
                      console.error(`[ChatMsgMgr] extraction failed for ${doc.filename}:`, err);
                      this.contextFiles.set(doc.filename, doc);
                  }
              }
              console.log(`[ChatMsgMgr] contextFiles updated: ${[...this.contextFiles.keys()].join(', ')}`);
              this.documents = undefined;
          }

          for (const message of messages) {
              if (message.toolCalls) {
                  for (const toolCall of message.toolCalls) {
                      if (!toolCall.id){
                          toolCall.id = hashCode(JSON.stringify(toolCall)).toString();
                      }
                  }
              }

              await this.addMessage(message);
  
              if (message.toolCalls) {
                  const replyMessages = await makeToolCalls(this.toolRegistry, message);
                  for (let replyMessage of replyMessages){
                      await this.addMessage(replyMessage);
                  }
              }
          }
          if (this.onUpdateChatState) await this.onUpdateChatState(this.chatState, this.log);
          return extractions;
      }

      // Generate a response to the conversation in its current state, without adding new messages.
      async getResponse(responseType: 'text' | 'html' | 'md', apiValues?: { [key: string]: string }): Promise<MessageResponse> {
          const reply = await this.updateConversation(0, responseType, apiValues);
          try {
              if (this.onUpdateChatState){
                  await this.onUpdateChatState(this.chatState, this.log);
              }
              if (this.onCreditsUsed && reply.creditsUsed){
                  await this.onCreditsUsed(reply.creditsUsed);
              }
          } catch (error) {
              console.error('Error updating chat state after user message', error);
          }
          return {
              sessionId: this.session?.id,
              creditsUsed: reply.creditsUsed || 0,
              chatState: this.chatState,
              memoryValues: this.memoryValues,
              message: reply.message,
          };
      }
  
      async addMessage(message: ChatMessage) {
          this.chatState.history.push(message);
          this.log.push(message);
          // when a user or assistant or agent message is written
          const isReadableMessage = message.content && (message.role === 'user' || message.role === 'assistant') && this.session?.id;
          try {
              await publish('message_created', {
                  sessionId: isReadableMessage ? this.session?.id : undefined,
                  message
              });
              const loggedMessage = isProd ? 'REDACTED' : (message ? JSON.stringify(message) : undefined);
              console.log('Message published', loggedMessage, this.session?.id);
          } catch (error) {
              console.error('Message failed to publish', error);
          }
      }
  
      // Gets the data to be sent to the LLM in Responses API Items format
      getConversationHistoryAsInputItems(conversationHistory: ChatMessage[]): GPTInputItem[] {
          const items: GPTInputItem[] = [];

          for (const message of conversationHistory) {
              // Tool response messages -> function_call_output
              if (message.role === 'tool' && message.toolCallId) {
                  items.push({
                      type: "function_call_output",
                      call_id: message.toolCallId,
                      output: typeof message.content === 'string'
                          ? message.content
                          : JSON.stringify(message.content),
                  });
                  continue;
              }

              // Messages with tool calls -> separate function_call items
              if (message.toolCalls && message.toolCalls.length > 0) {
                  // First add the message content if it exists
                  let stringifiedContent = '';
                  if (typeof message.content === 'string') {
                      stringifiedContent = message.content;
                  } else if (typeof message.content === 'object' && message.content) {
                      stringifiedContent = message.content.html || message.content.md || message.content.text || '';
                  }

                  if (stringifiedContent && message.role !== 'tool') {
                      items.push({
                          type: "message",
                          role: message.role as "user" | "assistant" | "system",
                          content: stringifiedContent,
                      });
                  }

                  // Then add each tool call as a separate function_call item
                  for (const tc of message.toolCalls as GPTFunctionToolCall[]) {
                      items.push({
                          type: "function_call",
                          call_id: tc.call_id,
                          name: tc.name,
                          arguments: tc.arguments,
                      });
                  }
                  continue;
              }

              // Regular messages with content
              let stringifiedContent = '';
              if (typeof message.content === 'string') {
                  stringifiedContent = message.content;
              } else if (typeof message.content === 'object' && message.content) {
                  if (message.content.setValues) {
                      stringifiedContent = JSON.stringify(message.content);
                  } else {
                      stringifiedContent = message.content.html || message.content.md || message.content.text || '';
                  }
              }

              if (stringifiedContent && message.role !== 'tool') {
                  const item: any = {
                      type: "message",
                      role: message.role as "user" | "assistant" | "system",
                      content: stringifiedContent,
                  };
                  if (message.metadata?.files) {
                      item._filesMeta = message.metadata.files;
                  }
                  if (message.metadata?.files) {
                      console.log(`[ChatMsgMgr] Message has _filesMeta:`, message.metadata.files);
                  }
                  items.push(item);
              }
          }

          // Inject context files: attach each file to the last history message
          // that listed it in metadata.files. Files with no matching message go
          // into the first system message (history was culled).
          if (this.contextFiles.size > 0) {
              const orphanedFiles: GPTContentPart[] = [];
              for (const [filename, doc] of this.contextFiles) {
                  const mimeMatch = doc.dataUrl.match(/^data:([^;]+);/);
                  const mime = mimeMatch?.[1] || '';
                  let docPart: GPTContentPart;
                  if (doc.extractedText) {
                      // Use extracted text instead of raw base64
                      docPart = { type: 'input_text' as const, text: `[File: ${filename}]\n${doc.extractedText}` };
                  } else if (mime.startsWith('image/')) {
                      docPart = { type: 'input_image' as const, image_url: doc.dataUrl };
                  } else {
                      docPart = { type: 'input_document' as const, data_url: doc.dataUrl, filename };
                  }
                  let attached = false;
                  for (let i = items.length - 1; i >= 0; i--) {
                      const item = items[i] as any;
                      if (item._filesMeta && (item._filesMeta as string[]).includes(filename) && item.type === 'message') {
                          const existing: GPTContentPart[] = typeof item.content === 'string'
                              ? [{ type: 'input_text', text: item.content }]
                              : (item.content as GPTContentPart[]);
                          item.content = [...existing, docPart];
                          attached = true;
                          break;
                      }
                  }
                  if (!attached) orphanedFiles.push(docPart);
              }
              if (orphanedFiles.length > 0) {
                  console.log(`[ChatMsgMgr] ${orphanedFiles.length} orphaned file(s) not matched to any message — attaching as fallback`);
                  // Try the first system message
                  let injected = false;
                  if (items.length > 0 && items[0].type === 'message' && items[0].role === 'system') {
                      const sysText = typeof items[0].content === 'string' ? items[0].content : '';
                      items[0].content = [{ type: 'input_text' as const, text: sysText }, ...orphanedFiles];
                      injected = true;
                  }
                  // Fallback: inject into the last user message so the LLM always sees them
                  if (!injected) {
                      for (let i = items.length - 1; i >= 0; i--) {
                          const item = items[i] as any;
                          if (item.type === 'message' && item.role === 'user') {
                              const existing: GPTContentPart[] = typeof item.content === 'string'
                                  ? [{ type: 'input_text', text: item.content }]
                                  : (item.content as GPTContentPart[]);
                              item.content = [...existing, ...orphanedFiles];
                              injected = true;
                              break;
                          }
                      }
                  }
                  if (!injected) {
                      console.warn(`[ChatMsgMgr] Could not inject orphaned files — no system or user message found`);
                  }
              }
          }

          // Remove orphaned function_call / function_call_output items
          const callIds = new Set<string>();
          const outputIds = new Set<string>();
          for (const item of items) {
              if (item.type === 'function_call' && item.call_id) callIds.add(item.call_id);
              if (item.type === 'function_call_output' && item.call_id) outputIds.add(item.call_id);
          }
          for (let i = items.length - 1; i >= 0; i--) {
              const item = items[i];
              if (item.type === 'function_call' && item.call_id && !outputIds.has(item.call_id)) {
                  items.splice(i, 1);
              } else if (item.type === 'function_call_output' && item.call_id && !callIds.has(item.call_id)) {
                  items.splice(i, 1);
              }
          }

          // Inject image into the last user message if we have one
          if (this.currentImage) {
              // Find the last user message in items
              for (let i = items.length - 1; i >= 0; i--) {
                  const item = items[i];
                  if (item.type === 'message' && item.role === 'user') {
                      // Convert to multimodal content
                      const textContent = typeof item.content === 'string' ? item.content : '';
                      const base64Image = this.currentImage.data.toString('base64');
                      const imageUrl = `data:${this.currentImage.mimeType};base64,${base64Image}`;

                      const multimodalContent: GPTContentPart[] = [
                          { type: 'input_text', text: textContent },
                          { type: 'input_image', image_url: imageUrl }
                      ];

                      item.content = multimodalContent;
                      console.log(`[ChatMessageManager] Injected image into user message, size: ${this.currentImage.data.length} bytes`);
                      break;
                  }
              }
              // Clear the image after use (single-use)
              this.currentImage = undefined;
          }

          // Inject inline images (base64 data URLs from client) into the last user message
          if (this.images && this.images.length > 0) {
              for (let i = items.length - 1; i >= 0; i--) {
                  const item = items[i];
                  if (item.type === 'message' && item.role === 'user') {
                      const textContent = typeof item.content === 'string' ? item.content : '';
                      const multimodalContent: GPTContentPart[] = [
                          { type: 'input_text', text: textContent },
                          ...this.images.map(url => ({ type: 'input_image' as const, image_url: url })),
                      ];
                      item.content = multimodalContent;
                      console.log(`[ChatMessageManager] Injected ${this.images.length} inline image(s) into user message`);
                      break;
                  }
              }
              // Clear after use (single-use per request)
              this.images = undefined;
          }

          return items;
      }
  
      getLastUserMessage(): (ChatMessage | null) {
          for (let i=this.chatState.history.length - 1; i >= 0; i--){
              if (this.chatState.history[i].role === 'user'){
                  return this.chatState.history[i];
              }
          }
          return null;
      }

      /**
       * Compress history by removing messages at the given indices and appending a summary.
       * Protects the first 2 anchor messages (indices 0-1).
       * Always removes paired tool-call/tool-response messages together.
       */
      async compressHistory(forget: number[], summary: string, closePaths?: string[]): Promise<{ removed: number; warnings: string[]; historyLength: number }> {
          const warnings: string[] = [];
          const history = this.chatState.history;

          // Build set of indices to remove, skipping protected anchors and out-of-bounds
          const removalSet = new Set<number>();
          for (const idx of forget) {
              if (idx < 0 || idx >= history.length) {
                  warnings.push(`Index ${idx} out of bounds (history length ${history.length}), skipped.`);
                  continue;
              }
              if (idx < 2) {
                  warnings.push(`Index ${idx} is a protected anchor message, skipped.`);
                  continue;
              }
              removalSet.add(idx);
          }

          // Expand removal set to include paired tool-call/tool-response messages
          for (const idx of [...removalSet]) {
              const msg = history[idx];
              if (msg.role === 'tool' && msg.toolCallId) {
                  // Find the assistant message that contains the matching tool call
                  for (let j = 0; j < history.length; j++) {
                      if (j >= 2 && history[j].toolCalls) {
                          const hasMatch = (history[j].toolCalls as GPTFunctionToolCall[]).some(
                              tc => tc.call_id === msg.toolCallId
                          );
                          if (hasMatch) removalSet.add(j);
                      }
                  }
              }
              if (msg.toolCalls) {
                  // Find all tool responses for this message's tool calls
                  for (const tc of msg.toolCalls as GPTFunctionToolCall[]) {
                      for (let j = 0; j < history.length; j++) {
                          if (j >= 2 && history[j].role === 'tool' && history[j].toolCallId === tc.call_id) {
                              removalSet.add(j);
                          }
                      }
                  }
              }
          }

          // Remove in reverse order to preserve indices
          const sortedIndices = [...removalSet].sort((a, b) => b - a);
          for (const idx of sortedIndices) {
              history.splice(idx, 1);
          }

          // Append summary
          if (summary) {
              if (this.chatState.memoryState?.staticPromptMode) {
                  // Static mode: keep the system prompt stable for prompt caching.
                  // Inject the summary as a system message in the history instead
                  // of changing conversationSummary (which is in the system prompt).
                  this.chatState.history.splice(2, 0, {
                      role: 'system',
                      content: `[Conversation summary of removed messages]\n${summary}`,
                      timestamp: Date.now(),
                  });
                  // Close requested paths but preserve the frozen memory prompt
                  if (closePaths && closePaths.length > 0) {
                      const toClose = new Set(closePaths.map(p => p.startsWith('/') ? p : '/' + p));
                      this.chatState.memoryState.visible = this.chatState.memoryState.visible.filter(
                          p => !toClose.has(p) && ![...toClose].some(cp => p.startsWith(cp + '/'))
                      );
                  }
              } else {
                  const existing = this.chatState.conversationSummary || '';
                  const combined = existing ? `${existing}\n\n${summary}` : summary;
                  if (combined.length > 2000) {
                      this.chatState.conversationSummary = await this.resummarize(combined);
                  } else {
                      this.chatState.conversationSummary = combined;
                  }
              }
          }

          return { removed: removalSet.size, warnings, historyLength: history.length };
      }

      /**
       * Re-summarize an overly long conversation summary into ~800 chars using gpt-4o-mini.
       */
      private async resummarize(longSummary: string): Promise<string> {
          try {
              const summaryGpt = new GPT();
              const inputItems: GPTInputItem[] = [{
                  type: 'message',
                  role: 'user',
                  content: `Condense the following conversation summary into a single concise paragraph of about 800 characters. Keep the most important facts, decisions, and context:\n\n${longSummary}`,
              }];
              const response = await summaryGpt.getStructuredResponse(
                  inputItems,
                  'resummarize',
                  { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
                  [],
                  1000,
                  0, // gpt-4o-mini
                  { temperature: 0.3 },
                  false, 1,
                  'You are a helpful assistant that condenses conversation summaries. Return only a JSON object with a "text" field.'
              );
              if (response.content) {
                  try {
                      const parsed = JSON.parse(response.content);
                      if (parsed.text) return parsed.text;
                  } catch {}
              }
          } catch (e) {
              console.error('[ChatMessageManager] resummarize failed:', e);
          }
          // Fallback: hard truncate
          return longSummary.slice(0, 800) + '...';
      }

      /**
       * Auto-compress history when it exceeds the threshold.
       * Removes oldest messages (after anchors) down to cullMessagesTo,
       * generating a summary for the removed messages.
       */
      async autoCompress(): Promise<void> {
          if (!this.cullMessages) return;
          if (this.chatState.history.length <= this.cullMessagesThreshold) return;

          const removeCount = this.chatState.history.length - this.cullMessagesTo;
          if (removeCount <= 0) return;

          // Indices to remove: after the 2 anchor messages, take the oldest ones
          const indicesToRemove: number[] = [];
          for (let i = 2; i < 2 + removeCount && i < this.chatState.history.length; i++) {
              indicesToRemove.push(i);
          }

          if (indicesToRemove.length === 0) return;

          const summary = await this.generateSummaryForMessages(indicesToRemove);
          await this.compressHistory(indicesToRemove, summary);
          console.log(`[ChatMessageManager] autoCompress: removed ${indicesToRemove.length} messages, history now ${this.chatState.history.length}`);
      }

      /**
       * Generate a concise summary for a set of messages by index using gpt-4o-mini.
       */
      private async generateSummaryForMessages(indices: number[]): Promise<string> {
          try {
              const history = this.chatState.history;
              const texts: string[] = [];
              for (const idx of indices) {
                  const msg = history[idx];
                  if (!msg) continue;
                  if (msg.role === 'user' || msg.role === 'assistant') {
                      let text = '';
                      if (typeof msg.content === 'string') {
                          text = msg.content;
                      } else if (msg.content && typeof msg.content === 'object') {
                          text = (msg.content as ChatMessageContent).text || (msg.content as ChatMessageContent).html || (msg.content as ChatMessageContent).md || '';
                      }
                      if (text) texts.push(`${msg.role}: ${text}`);
                  }
              }

              if (texts.length === 0) return 'Earlier conversation messages were removed to save context space.';

              const summaryGpt = new GPT();
              const inputItems: GPTInputItem[] = [{
                  type: 'message',
                  role: 'user',
                  content: `Summarize the following conversation excerpt into one concise paragraph. Focus on key topics discussed, decisions made, and important context:\n\n${texts.join('\n')}`,
              }];
              const response = await summaryGpt.getStructuredResponse(
                  inputItems,
                  'generate-summary',
                  { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
                  [],
                  500,
                  0, // gpt-4o-mini
                  { temperature: 0.3 },
                  false, 1,
                  'You are a helpful assistant that summarizes conversations. Return only a JSON object with a "text" field containing the summary.'
              );
              if (response.content) {
                  try {
                      const parsed = JSON.parse(response.content);
                      if (parsed.text) return parsed.text;
                  } catch {}
              }
          } catch (e) {
              console.error('[ChatMessageManager] generateSummaryForMessages failed:', e);
          }
          return 'Earlier conversation messages were removed to save context space.';
      }

      buildPromptAndTools( params?: {
          lastFormSchema: NlpSchema | undefined,
          lastFormValues: formValues | undefined,
          replyType?: 'text' | 'html' | 'md',
      }) {
          console.log('[ChatMsgMgr] buildPromptAndTools — Context_Board name:', this.memoryValues?.Context_Board?.name ?? '(none)', 'pages:', this.memoryValues?.Context_Board?.pages?.length ?? 0);
          return buildPromptAndTools({
              agent: this.agent as any,
              history: this.chatState.history,
              memoryValues: this.memoryValues,
              memoryState: this.chatState.memoryState,
              openedTopics: this.chatState.openedTopics,
              conversationSummary: this.chatState.conversationSummary,
              lastFormSchema: params?.lastFormSchema,
              lastFormValues: params?.lastFormValues,
              describeActions: this.onThinkingUpdate !== undefined,
              navigateEnabled: this.onNavigate !== undefined,
              selectStudentEnabled: this.onSelectStudent !== undefined,
              replyType: params?.replyType || 'text',
              timezone: this.requestTimezone,
          });
      }
  
      // Updates the conversation after confirming that the bot should interact
      // toolRound tracks recursive depth — safety limit to prevent runaway tool loops
      private static readonly MAX_TOOL_ROUNDS = 30;
      async updateConversation(totalCreditsUsed: number = 0, responseType: 'text' | 'html' | 'md', apiValues?: { [key: string]: any }, toolRound: number = 0): Promise<ChatResponse> {
          const maxToolRoundsReached = toolRound >= ChatMessageManager.MAX_TOOL_ROUNDS;
          if (maxToolRoundsReached) {
              console.warn(`[ChatMsgMgr] updateConversation hit max tool rounds (${ChatMessageManager.MAX_TOOL_ROUNDS}) — forcing text-only response`);
              await this.addMessage({
                  role: 'system',
                  content: 'You have used the maximum number of tool calls for this turn. Please provide your final text response now without any further tool calls.',
                  timestamp: Date.now(),
              });
          }
          await this.autoCompress();
          const inputItems = this.getConversationHistoryAsInputItems(this.chatState.history);
          const lastUserMessage = this.getLastUserMessage();
          const lastContent = lastUserMessage?.content ? this.chatState.history[this.chatState.history.length - 1].content : undefined;
          const lastFormSchema = typeof lastContent === 'object' ? lastContent.formSchema : undefined;
          const lastFormValues = typeof lastContent === 'object' ? lastContent.formValues : undefined;

          const promptBuild = this.buildPromptAndTools({
              lastFormSchema: lastFormSchema,
              lastFormValues: lastFormValues,
              replyType: responseType,
          });

          const instructionsText = promptBuild.instructions + (promptBuild.endInstructions ? ('\n' + promptBuild.endInstructions) : '');

          // Debug: detect system prompt changes between tool rounds
          if (this.chatState.memoryState?.staticPromptMode) {
            const hash = instructionsText.length; // cheap proxy for change detection
            if ((this as any)._lastInstructionsHash !== undefined && (this as any)._lastInstructionsHash !== hash) {
              console.warn(`[ChatMsgMgr] ⚠ STATIC MODE: instructions changed between rounds! prev=${(this as any)._lastInstructionsHash} now=${hash} round=${toolRound}`);
            }
            (this as any)._lastInstructionsHash = hash;
          }

          // Strip tools when max rounds reached so the LLM cannot make more tool calls
          const tools = maxToolRoundsReached ? [] : promptBuild.tools;

          const tokensAvailableForResponse = 15000;
          const temperature = 0.7;
          try {
              const gptResponse: GPTResponse = await this.gpt.getStructuredResponse(
                  inputItems,
                  String(hashCode(JSON.stringify(promptBuild.schema ?? {}))),
                  promptBuild.schema,
                  tools,
                  tokensAvailableForResponse,
                  this.intelligenceLevel, {
                      temperature
                  },
                  promptBuild.searchEnabled,
                  promptBuild.searchContextSize,
                  instructionsText,
                  this.vectorStoreId // Pass vector store ID for file search
              );
              let creditsUsed = 0; // Credits used by this one response

              if (gptResponse.promptTokens !== undefined) {
                  const provider = this.gpt.providerConfig?.provider || "openai";
                  const model = this.gpt.providerConfig?.model || "gpt-4o-mini";

                  creditsUsed = creditsForModelUsage(
                      provider, model,
                      gptResponse.promptTokens,
                      gptResponse.completionTokens,
                      gptResponse.cachedTokens
                  );

                  // Search surcharge only applies to OpenAI
                  if (provider === "openai" && promptBuild.searchEnabled && promptBuild.searchContextSize) {
                      creditsUsed += (gptResponse.searchCalls || 0) * CreditsPerSearchByIntelligence(this.intelligenceLevel, promptBuild.searchContextSize);
                  }

                  console.log(`prompt=${gptResponse.promptTokens} cached=${gptResponse.cachedTokens} `
                              + `completion=${gptResponse.completionTokens} searchCalls=${gptResponse.searchCalls} `
                              + `provider=${provider} model=${model} billed=${creditsUsed}`);
              }
              if (gptResponse.toolCalls?.length){
                  // Send thinking update if callback is available
                  let toolCallMessage: ChatMessage = {
                      role: 'assistant',
                      toolCalls: gptResponse.toolCalls,
                      timestamp: Date.now(),
                      credits: creditsUsed,
                  }
                  if (apiValues) {
                      toolCallMessage = enrichToolCallMessage(toolCallMessage, this.agent.apiEndpoints || [], apiValues);
                  }
                  let replyMessages = await makeToolCalls(this.toolRegistry, toolCallMessage);
                  for (let replyMessage of replyMessages){
                      totalCreditsUsed += replyMessage.credits || 0;
                      await this.addMessage(replyMessage);
                  }
                  console.log('[ChatMsgMgr] After tool calls — Context_Board name:', this.memoryValues?.Context_Board?.name ?? '(none)', 'pages:', this.memoryValues?.Context_Board?.pages?.length ?? 0);
                  return await this.updateConversation(totalCreditsUsed, responseType, apiValues, toolRound + 1);
              } else if (gptResponse.content){
                  let reply = await this.uponGPTResponse(gptResponse.content, creditsUsed, responseType);
                  totalCreditsUsed += creditsUsed;
                  return {
                      message: reply,
                      creditsUsed: totalCreditsUsed
                  };
              } else if (gptResponse.refused){
                  return {
                      message: {
                          role: 'system',
                          content: { text: 'error:POLICY_VIOLATION' },
                          timestamp: Date.now(),
                      },
                      creditsUsed: totalCreditsUsed,
                      error: 'POLICY_VIOLATION_ERROR',
                  }
              } else {
                  return {
                      message: {
                          role: 'system',
                          content: { text: 'error:NO_RESPONSE' },
                          timestamp: Date.now(),
                      },
                      creditsUsed: totalCreditsUsed,
                      error: 'NO_RESPONSE',
                  }
              }
          } catch (e: any) {
              console.error('ERROR:', e.message, e.stack);
              return {
                  message: {
                      role: 'system',
                      content: { text: 'error:LLM_ERROR' },
                      timestamp: Date.now(),
                  },
                  creditsUsed: totalCreditsUsed,
                  error: 'LLM_ERROR',
              }
          }
      }
  
      async realtimeCallTools(toolCalls: GPTFunctionToolCall[], creditsUsed: number): Promise<ChatMessage[]> {
          const toolCallMessage: ChatMessage = {
              role: 'assistant',
              toolCalls: toolCalls,
              timestamp: Date.now(),
              credits: creditsUsed || 0,
          }
          const messages = await makeToolCalls(this.toolRegistry, toolCallMessage);
          for (let message of messages){
              await this.addMessage(message);
          }
          if (this.onUpdateChatState) this.onUpdateChatState(this.chatState, this.log);
          return messages;
      }
  
      async uponGPTResponse(response: string, creditsUsed: number, responseType?: 'text' | 'html' | 'md'): Promise<ChatMessage> {
          // In md mode, the LLM returns raw markdown (no JSON wrapper)
          if (responseType === 'md') {
              const trimmed = response.trim();
              const newMessage: ChatMessage = {
                  role: 'assistant',
                  timestamp: Date.now(),
                  content: { md: trimmed },
                  credits: creditsUsed,
              };
              await this.addMessage(newMessage);
              return newMessage;
          }

          let parsedResponse;
          try {
              parsedResponse = JSON.parse(response);
          } catch (e) {
              // Model may include text before/after JSON — try extracting the JSON portion
              // Try from each '{' position (first to last) to find the outermost valid JSON
              let bracePos = -1;
              while ((bracePos = response.indexOf('{', bracePos + 1)) >= 0) {
                  try {
                      const jsonPart = response.substring(bracePos);
                      parsedResponse = JSON.parse(jsonPart);
                      // Preserve the non-JSON prefix as text content so callers
                      // (e.g. monitor-agent) can still parse [CONTEXT] blocks
                      const prefix = response.substring(0, bracePos).trim();
                      if (prefix && !parsedResponse.text) {
                          parsedResponse.text = prefix;
                      }
                      break;
                  } catch {}
              }
              if (!parsedResponse) {
                  // Model returned plain text instead of JSON — treat it as a text response
                  const trimmed = response.trim();
                  if (trimmed.length > 0) {
                      console.log('LLM returned non-JSON text, using as plain text response');
                      parsedResponse = { text: trimmed };
                  } else {
                      const loggedMessage = isProd ? 'REDACTED' : response;
                      console.log('Error parsing response:', e, loggedMessage);
                      return {
                          role: 'system',
                          timestamp: new Date().getTime(),
                          content: { text: 'error:PARSE_ERROR' },
                          error: 'PARSE_ERROR',
                      };
                  }
              }
          }

          let reply: ChatMessage = {
              role: 'assistant',
              content: {},
              timestamp: new Date().getTime(),
          }

          const setValues = parsedResponse.setValues;

          // Set fields and push buttons
          if (setValues){
              let valueSetMessage = '';
              let valueSet = false;
              for (let form in setValues){
                  let valueSetInForm = false;
                  for (let field in setValues[form]){
                      if (setValues[form][field] !== null){
                          valueSetMessage += `- ${form}.${field}: ${setValues[form][field]}\n`;
                          valueSet = true;
                          valueSetInForm = true;
                      } else {
                          delete setValues[form][field];
                      }
                  }
                  if (!valueSetInForm){
                      delete setValues[form];
                  }
              }
              if (valueSet) {
                  (reply.content as ChatMessageContent).setValues = setValues;
              }
          }

          if (parsedResponse.html){
              (reply.content as ChatMessageContent).html = this.gpt.convertContent(parsedResponse.html);
          }
          if (parsedResponse.text){
              (reply.content as ChatMessageContent).text = parsedResponse.text;
          }
          const content = reply.content as ChatMessageContent;
          const plainText = (
              content.text &&
              !content.html &&
              !content.setValues
          );
          const newMessage: ChatMessage = {
              role: 'assistant',
              timestamp: new Date().getTime(),
              content: plainText ? content.text : reply.content,
              credits: creditsUsed,
          }
          await this.addMessage(newMessage);

          return reply
      }

      /**
       * Convert internal ChatMessage[] (schema format) to ProviderChatMessage[]
       * for use with the streaming ChatProvider.streamChat() interface.
       */
      getConversationHistoryAsChatMessages(
          conversationHistory: ChatMessage[],
          systemPrompt: string
      ): ProviderChatMessage[] {
          const messages: ProviderChatMessage[] = [];

          // System prompt first
          messages.push({ role: "system", content: systemPrompt });

          for (const message of conversationHistory) {
              // Tool response messages
              if (message.role === 'tool' && message.toolCallId) {
                  messages.push({
                      role: "tool",
                      content: typeof message.content === 'string'
                          ? message.content
                          : JSON.stringify(message.content),
                      toolCallId: message.toolCallId,
                  });
                  continue;
              }

              // Messages with tool calls
              if (message.toolCalls && message.toolCalls.length > 0) {
                  let textContent: string | null = null;
                  if (typeof message.content === 'string') {
                      textContent = message.content;
                  } else if (typeof message.content === 'object' && message.content) {
                      textContent = (message.content as ChatMessageContent).html
                          || (message.content as ChatMessageContent).md
                          || (message.content as ChatMessageContent).text
                          || null;
                  }

                  messages.push({
                      role: "assistant",
                      content: textContent,
                      toolCalls: (message.toolCalls as GPTFunctionToolCall[]).map((tc) => ({
                          id: tc.call_id,
                          name: tc.name,
                          arguments: tc.arguments,
                      })),
                  });
                  continue;
              }

              // Regular messages
              let stringifiedContent = '';
              if (typeof message.content === 'string') {
                  stringifiedContent = message.content;
              } else if (typeof message.content === 'object' && message.content) {
                  const c = message.content as ChatMessageContent;
                  if (c.setValues) {
                      stringifiedContent = JSON.stringify(message.content);
                  } else {
                      stringifiedContent = c.html || c.md || c.text || '';
                  }
              }

              if (stringifiedContent && message.role !== 'tool') {
                  const entry: any = {
                      role: message.role as "user" | "assistant" | "system",
                      content: stringifiedContent,
                  };
                  // Tag with file metadata so the injection phase can find the right message
                  if (message.metadata?.files) {
                      entry._filesMeta = message.metadata.files;
                  }
                  messages.push(entry);
              }
          }

          // Inject image into the last user message if we have one
          if (this.currentImage) {
              for (let i = messages.length - 1; i >= 0; i--) {
                  const msg = messages[i];
                  if (msg.role === 'user' && typeof msg.content === 'string') {
                      const base64Image = this.currentImage.data.toString('base64');
                      const imageUrl = `data:${this.currentImage.mimeType};base64,${base64Image}`;
                      msg.content = [
                          { type: 'text', text: msg.content },
                          { type: 'image_url', image_url: { url: imageUrl } },
                      ];
                      break;
                  }
              }
              this.currentImage = undefined;
          }

          // Inject inline images
          if (this.images && this.images.length > 0) {
              for (let i = messages.length - 1; i >= 0; i--) {
                  const msg = messages[i];
                  if (msg.role === 'user' && typeof msg.content === 'string') {
                      msg.content = [
                          { type: 'text', text: msg.content },
                          ...this.images.map(url => ({ type: 'image_url', image_url: { url } })),
                      ];
                      break;
                  }
              }
              this.images = undefined;
          }

          // Inject context files into messages.
          // Strategy: for each file, find the last message whose _filesMeta includes it.
          // If not found (message was culled), inject into system prompt.
          console.log(`[ChatMsgMgr] getConversationHistoryAsChatMessages: contextFiles=${this.contextFiles.size}, messages=${messages.length}, historyLen=${conversationHistory.length}`);
          // Debug: check metadata on history entries
          for (let h = 0; h < conversationHistory.length; h++) {
              const m = conversationHistory[h];
              if (m.metadata) console.log(`[ChatMsgMgr]   history[${h}] role=${m.role} metadata=${JSON.stringify(m.metadata)}`);
          }
          if (this.contextFiles.size > 0) {
              // Log all _filesMeta tags on messages
              for (let i = 0; i < messages.length; i++) {
                  const meta = (messages[i] as any)._filesMeta;
                  if (meta) console.log(`[ChatMsgMgr]   msg[${i}] role=${messages[i].role} _filesMeta=${JSON.stringify(meta)}`);
              }

              const orphanedParts: any[] = [];
              for (const [filename, doc] of this.contextFiles) {
                  const mimeMatch = doc.dataUrl?.match(/^data:([^;]+);/);
                  const mime = mimeMatch?.[1] || '';
                  let docPart: any;
                  if (doc.extractedText) {
                      // Use extracted text (includes video/audio file references)
                      docPart = { type: 'text', text: `[File: ${filename}]\n${doc.extractedText}` };
                  } else if (mime.startsWith('image/')) {
                      docPart = { type: 'image_url', image_url: { url: doc.dataUrl } };
                  } else {
                      docPart = { type: 'input_document', data_url: doc.dataUrl, filename };
                  }
                  let attached = false;
                  // Scan backwards for a message tagged with this file
                  for (let i = messages.length - 1; i >= 0; i--) {
                      const meta = (messages[i] as any)._filesMeta as string[] | undefined;
                      if (meta && meta.includes(filename)) {
                          const msg = messages[i];
                          const existing: any[] = typeof msg.content === 'string'
                              ? [{ type: 'text', text: msg.content }]
                              : Array.isArray(msg.content) ? msg.content : [];
                          msg.content = [...existing, docPart];
                          attached = true;
                          console.log(`[ChatMsgMgr]   attached "${filename}" to msg[${i}]`);
                          break;
                      }
                  }
                  if (!attached) {
                      orphanedParts.push(docPart);
                      console.log(`[ChatMsgMgr]   orphaned "${filename}" → system prompt`);
                  }
              }
              if (orphanedParts.length > 0) {
                  let injected = false;
                  if (messages.length > 0 && messages[0].role === 'system') {
                      const sysText = typeof messages[0].content === 'string' ? messages[0].content : '';
                      messages[0].content = [{ type: 'text', text: sysText }, ...orphanedParts];
                      injected = true;
                  }
                  if (!injected) {
                      for (let i = messages.length - 1; i >= 0; i--) {
                          if (messages[i].role === 'user') {
                              const existing: any[] = typeof messages[i].content === 'string'
                                  ? [{ type: 'text', text: messages[i].content }]
                                  : Array.isArray(messages[i].content) ? messages[i].content as any[] : [];
                              messages[i].content = [...existing, ...orphanedParts];
                              break;
                          }
                      }
                  }
              }
          }

          // Remove orphaned tool call / tool response pairs
          const callIds = new Set<string>();
          const responseIds = new Set<string>();
          for (const msg of messages) {
              if (msg.toolCalls) {
                  for (const tc of msg.toolCalls) callIds.add(tc.id);
              }
              if (msg.role === 'tool' && msg.toolCallId) responseIds.add(msg.toolCallId);
          }
          return messages.filter((msg) => {
              if (msg.toolCalls) {
                  // Keep assistant messages with tool calls only if at least one has a response
                  return msg.toolCalls.some((tc) => responseIds.has(tc.id));
              }
              if (msg.role === 'tool' && msg.toolCallId) {
                  return callIds.has(msg.toolCallId);
              }
              return true;
          });
      }

      /**
       * Stream a markdown response token-by-token using the ChatProvider interface.
       * Yields MdStreamEvent objects. Handles tool call loops internally.
       */
      async *getStreamingMdResponse(signal?: AbortSignal): AsyncGenerator<MdStreamEvent> {
          await this.autoCompress();

          const providerKey: LLMProviderKey = this.gpt.providerConfig?.provider || "openai";
          const model = this.gpt.providerConfig?.model || "gpt-4o-mini";
          const chatProvider = getChatProvider(providerKey);

          // Build prompt
          const promptBuild = this.buildPromptAndTools({ lastFormSchema: undefined, lastFormValues: undefined, replyType: 'md' });
          const systemPrompt = promptBuild.instructions + (promptBuild.endInstructions ? ('\n' + promptBuild.endInstructions) : '');

          // Convert GPTTool[] to ChatTool[] (only function tools)
          const chatTools: ChatTool[] = promptBuild.tools
              .filter((t): t is import("./gpt").GPTFunctionTool => t.type === 'function')
              .map((t) => ({
                  type: "function" as const,
                  function: {
                      name: t.function.name,
                      description: t.function.description,
                      parameters: t.function.parameters as Record<string, any>,
                  },
              }));

          // Build message history
          let providerMessages = this.getConversationHistoryAsChatMessages(this.chatState.history, systemPrompt);

          let totalCreditsUsed = 0;
          const MAX_ITERATIONS = 10;

          for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
              // Check abort before starting a new LLM call
              if (signal?.aborted) {
                  console.log('[ChatMessageManager] getStreamingMdResponse: aborted before iteration', iteration);
                  return;
              }

              let accumulatedText = '';
              const toolCallAccumulator: Map<number, { name: string; arguments: string }> = new Map();
              let usage: { promptTokens: number; completionTokens: number } | undefined;

              const stream = chatProvider.streamChat({
                  model,
                  messages: providerMessages,
                  tools: chatTools.length > 0 ? chatTools : undefined,
                  maxTokens: 15000,
                  temperature: 0.7,
                  signal,
              });

              for await (const chunk of stream) {
                  if (chunk.type === 'text_delta') {
                      accumulatedText += chunk.text;
                      yield { type: 'text_delta', text: chunk.text };
                  } else if (chunk.type === 'tool_call_delta') {
                      const existing = toolCallAccumulator.get(chunk.index);
                      if (existing) {
                          if (chunk.arguments) existing.arguments += chunk.arguments;
                      } else {
                          toolCallAccumulator.set(chunk.index, {
                              name: chunk.name || '',
                              arguments: chunk.arguments || '',
                          });
                      }
                  } else if (chunk.type === 'done') {
                      usage = chunk.usage;
                  }
              }

              // Calculate credits
              let creditsUsed = 0;
              if (usage) {
                  creditsUsed = creditsForModelUsage(providerKey, model, usage.promptTokens, usage.completionTokens, 0);
                  totalCreditsUsed += creditsUsed;
              }

              // If there are tool calls, execute them and continue the loop
              if (toolCallAccumulator.size > 0) {
                  // Convert accumulated tool calls to GPTFunctionToolCall format
                  const toolCalls: GPTFunctionToolCall[] = [];
                  for (const [, tc] of toolCallAccumulator) {
                      const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                      toolCalls.push({
                          type: 'function_call',
                          call_id: callId,
                          name: tc.name,
                          arguments: tc.arguments,
                      });
                  }

                  // Send thinking update if available
                  if (this.onThinkingUpdate) {
                      const toolNames = toolCalls.map(tc => tc.name).join(', ');
                      this.onThinkingUpdate(`Using tools: ${toolNames}`);
                  }

                  // Yield thinking event
                  const toolNames = toolCalls.map(tc => tc.name).join(', ');
                  yield { type: 'thinking', text: `Using tools: ${toolNames}` };

                  // Execute tool calls
                  const toolCallMessage: ChatMessage = {
                      role: 'assistant',
                      toolCalls,
                      timestamp: Date.now(),
                      credits: creditsUsed,
                  };

                  // Handle immediate-action tools specially
                  for (const tc of toolCalls) {
                      if (tc.name === 'navigateToFeature' && this.onNavigate) {
                          try {
                              const args = JSON.parse(tc.arguments);
                              if (args.feature) {
                                  this.onNavigate(args.feature);
                                  yield { type: 'navigate', feature: args.feature };
                              }
                          } catch {}
                      }
                      if (tc.name === 'selectStudent' && this.onSelectStudent) {
                          try {
                              const args = JSON.parse(tc.arguments);
                              if (args.studentId) {
                                  this.onSelectStudent(args.studentId);
                                  yield { type: 'select_student', studentId: args.studentId };
                              }
                          } catch {}
                      }
                  }

                  // Let in-flight tool calls finish and save their results
                  const replyMessages = await makeToolCalls(this.toolRegistry, toolCallMessage);

                  // Add all messages to history
                  for (const msg of replyMessages) {
                      await this.addMessage(msg);
                  }

                  // If aborted, save state and stop — don't call the model again
                  if (signal?.aborted) {
                      console.log('[ChatMessageManager] getStreamingMdResponse: aborted after tool calls, saving state');
                      if (this.onUpdateChatState) {
                          await this.onUpdateChatState(this.chatState, this.log);
                      }
                      if (this.onCreditsUsed && totalCreditsUsed) {
                          await this.onCreditsUsed(totalCreditsUsed);
                      }
                      yield {
                          type: 'complete',
                          message: {
                              role: 'assistant',
                              timestamp: Date.now(),
                              content: { md: accumulatedText || '*(Generation stopped)*' },
                              credits: creditsUsed,
                          },
                          creditsUsed: totalCreditsUsed,
                      };
                      return;
                  }

                  // Rebuild provider messages with updated history
                  providerMessages = this.getConversationHistoryAsChatMessages(this.chatState.history, systemPrompt);

                  // Continue the loop for next iteration
                  continue;
              }

              // No tool calls — this is the final text response
              // Save even partial text if aborted mid-stream
              if (accumulatedText) {
                  const newMessage: ChatMessage = {
                      role: 'assistant',
                      timestamp: Date.now(),
                      content: { md: accumulatedText },
                      credits: creditsUsed,
                  };
                  await this.addMessage(newMessage);

                  if (this.onUpdateChatState) {
                      await this.onUpdateChatState(this.chatState, this.log);
                  }
                  if (this.onCreditsUsed && totalCreditsUsed) {
                      await this.onCreditsUsed(totalCreditsUsed);
                  }

                  yield {
                      type: 'complete',
                      message: newMessage,
                      creditsUsed: totalCreditsUsed,
                  };
              }

              return;
          }

          // Safety: if we exhausted iterations, save what we have
          console.warn('[ChatMessageManager] getStreamingMdResponse: exhausted max iterations');
      }
  }

  /**
   * Events yielded by the streaming markdown response generator.
   */
  export type MdStreamEvent =
      | { type: "text_delta"; text: string }
      | { type: "thinking"; text: string }
      | { type: "navigate"; feature: string }
      | { type: "select_student"; studentId: string }
      | { type: "complete"; message: ChatMessage; creditsUsed: number };

  export { ChatMessageManager }
  
  // Re-export types for convenience
  export type { ChatMessage, ChatMessageContent, ChatState } from "@shared/schema";