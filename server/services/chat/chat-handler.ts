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
  
      cullMessages: boolean;
      cullMessagesTo: number;
      cullMessagesThreshold: number;
      maximumMessages: number;
      onUpdateMemoryValues?: (memoryValues: any) => Promise<void>;
      onUpdateChatState?: (chatState: ChatState, log?: ChatMessage[]) => Promise<void>;
      onCreditsUsed?: (creditsUsed: number) => Promise<void>;
      onThinkingUpdate?: (thinkingText: string) => void;
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
          memoryProcessor?: MemoryProcessor,
          vectorStoreId?: string,
          loopDetectionConfig?: LoopDetectionConfig;
          currentImage?: CurrentImage;
          images?: string[];
          providerConfig?: { provider: import("@shared/llm-options").LLMProviderKey; model: string };
      }){
          this.chatState = JSON.parse(JSON.stringify(settings.chatState));
          this.log = JSON.parse(JSON.stringify(settings.log));
          this.memoryValues = settings.memoryValues ? JSON.parse(JSON.stringify(settings.memoryValues)) : {};
          this.maxCredits = settings.maxCredits;
          this.gpt = new GPT(settings.providerConfig);
          this.onUpdateMemoryValues = async (memoryValues: any) => {
              memoryValues = JSON.parse(JSON.stringify(memoryValues));
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
          this.loopDetectionConfig = settings.loopDetectionConfig;

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
              loopDetectionConfig: this.loopDetectionConfig,
              onPruneMessages: (forget, summary) => this.compressHistory(forget, summary),
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
      async persistMessages(messages: ChatMessage[]) {
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
      }
  
      // Generate a response to the conversation in its current state, without adding new messages.
      async getResponse(responseType: 'text' | 'html', apiValues?: { [key: string]: string }): Promise<MessageResponse> {
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
                      stringifiedContent = message.content.html || message.content.text || '';
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
                      stringifiedContent = message.content.html || message.content.text || '';
                  }
              }

              if (stringifiedContent && message.role !== 'tool') {
                  items.push({
                      type: "message",
                      role: message.role as "user" | "assistant" | "system",
                      content: stringifiedContent,
                  });
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
      async compressHistory(forget: number[], summary: string): Promise<{ removed: number; warnings: string[]; historyLength: number }> {
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
              const existing = this.chatState.conversationSummary || '';
              const combined = existing ? `${existing}\n\n${summary}` : summary;
              if (combined.length > 2000) {
                  this.chatState.conversationSummary = await this.resummarize(combined);
              } else {
                  this.chatState.conversationSummary = combined;
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
                          text = (msg.content as ChatMessageContent).text || (msg.content as ChatMessageContent).html || '';
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
          replyType?: 'text' | 'html',
      }) {
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
              replyType: params?.replyType || 'text',
          });
      }
  
      // Updates the conversation after confirming that the bot should interact
      async updateConversation(totalCreditsUsed: number = 0, responseType: 'text' | 'html', apiValues?: { [key: string]: any }): Promise<ChatResponse> {
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

          const tokensAvailableForResponse = 15000;
          const temperature = 0.7;
          try {
              const gptResponse: GPTResponse = await this.gpt.getStructuredResponse(
                  inputItems,
                  String(hashCode(JSON.stringify(promptBuild.schema))),
                  promptBuild.schema,
                  promptBuild.tools,
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
                      this.addMessage(replyMessage);
                  }
                  return await this.updateConversation(totalCreditsUsed, responseType, apiValues);
              } else if (gptResponse.content){
                  let reply = await this.uponGPTResponse(gptResponse.content, creditsUsed);
                  totalCreditsUsed += creditsUsed;
                  return {
                      message: reply,
                      creditsUsed: totalCreditsUsed
                  };
              } else if (gptResponse.refused){
                  return {
                      message: {
                          role: 'system',
                          content: { text: 'This response was refused due to policy violation.' },
                          timestamp: Date.now(),
                      },
                      creditsUsed: totalCreditsUsed,
                      error: 'POLICY_VIOLATION_ERROR',
                  }
              } else {
                  return {
                      message: {
                          role: 'system',
                          content: { text: 'An error occured while processing the response.' },
                          timestamp: Date.now(),
                      },
                      creditsUsed: totalCreditsUsed,
                      error: 'NO_RESPONSE',
                  }
              }
          } catch (e: any) {
              console.error('ERROR:', e.message);
              return {
                  message: {
                      role: 'system',
                      content: { text: 'An error occured while calling the LLM.' },
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
  
      async uponGPTResponse(response: string, creditsUsed: number): Promise<ChatMessage> {
          let parsedResponse;
          try {
              parsedResponse = JSON.parse(response);
          } catch (e) {
              // Model may include text before JSON — try extracting the JSON portion
              const lastBrace = response.lastIndexOf('{');
              if (lastBrace >= 0) {
                  try {
                      const jsonPart = response.substring(lastBrace);
                      parsedResponse = JSON.parse(jsonPart);
                      // Preserve the non-JSON prefix as text content so callers
                      // (e.g. monitor-agent) can still parse [CONTEXT] blocks
                      const prefix = response.substring(0, lastBrace).trim();
                      if (prefix && !parsedResponse.text) {
                          parsedResponse.text = prefix;
                      }
                  } catch {}
              }
              if (!parsedResponse) {
                  const loggedMessage = isProd ? 'REDACTED' : response;
                  console.log('Error parsing response:', e, loggedMessage);
                  return {
                      role: 'system',
                      timestamp: new Date().getTime(),
                      content: { text: 'An error occured while processing the response.' },
                      error: 'PARSE_ERROR',
                  };
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
  }
  
  export { ChatMessageManager }
  
  // Re-export types for convenience
  export type { ChatMessage, ChatMessageContent, ChatState } from "@shared/schema";