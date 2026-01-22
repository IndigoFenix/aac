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
  import { CreditsPerCompletionTokenByIntelligence, CreditsPerPromptTokenByIntelligence, CreditsPerSearchByIntelligence } from "./cost-helpers";
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
      }){
          this.chatState = JSON.parse(JSON.stringify(settings.chatState));
          this.log = JSON.parse(JSON.stringify(settings.log));
          this.memoryValues = settings.memoryValues ? JSON.parse(JSON.stringify(settings.memoryValues)) : {};
          this.maxCredits = settings.maxCredits;
          this.gpt = new GPT();
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
              loopDetectionConfig: this.loopDetectionConfig
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

          const creditsPerPromptToken = CreditsPerPromptTokenByIntelligence(this.intelligenceLevel);
          const creditsPerCompletionToken = CreditsPerCompletionTokenByIntelligence(this.intelligenceLevel);

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
  
                  const promptCharge        = (gptResponse.promptTokens - gptResponse.cachedTokens) * creditsPerPromptToken;
                  const cachedPromptCharge  = gptResponse.cachedTokens * (creditsPerPromptToken / 2);
                  const completionCharge    = gptResponse.completionTokens * creditsPerCompletionToken;
  
                  const searchCharge = (promptBuild.searchEnabled && promptBuild.searchContextSize)
                          ? (gptResponse.searchCalls || 0) * CreditsPerSearchByIntelligence(this.intelligenceLevel, promptBuild.searchContextSize)
                          : 0;
  
                  const rawCredits = promptCharge + cachedPromptCharge + completionCharge + searchCharge;
                  creditsUsed      = Math.ceil(rawCredits);
  
                  console.log(`prompt=${gptResponse.promptTokens} cached=${gptResponse.cachedTokens} `
                              + `completion=${gptResponse.completionTokens} searchCalls=${gptResponse.searchCalls} `
                              + `rawCredits=${rawCredits} billed=${creditsUsed}`);
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
            const loggedMessage = isProd ? 'REDACTED' : response;
            console.log('Error parsing response:', e, loggedMessage);
            return {
                role: 'system',
                timestamp: new Date().getTime(),
                content: { text: 'An error occured while processing the response.' },
                error: 'PARSE_ERROR',
            };
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