import { MemoryState, AgentAPIEndpoint, Topic, ChatMessage } from "@shared/schema";
import { GPTTool, JSONSchema } from "./gpt";
import { getKeysFromSchema, InteractionSchemaProperties } from "./gpt-schema";
import { buildMemoryTool, renderMemoryVisualization } from "./memory-system";
import { memDebugSeparator, memDebug } from "./memory-debug-log";

const API_PREFIX = "api_";

/**
 * Agent template interface - matches the structure expected by prompt building
 * This can be a database agent or a local template
 */
export interface AgentLike {
  id?: string;
  name: string;
  corePrompt: string;
  greeting?: string;
  intelligence?: number;
  memory?: number;
  memoryFields?: any[];
  tools?: any;
  library?: Topic[];
  apiEndpoints?: AgentAPIEndpoint[];
}

// prompt-kit.ts
export interface PromptBuild {
    instructions: string;          // startPrompt
    endInstructions?: string;      // endPrompt (optional)
    tools: GPTTool[];
    schema?: JSONSchema;
    searchEnabled: boolean;
    searchContextSize: 1 | 2 | 3;
  }
  
export interface NlpSchema {
      type: 'array' | 'object' | 'string' | 'number' | 'boolean' | 'button';
      instructions?: string;
      enum?: string[]; // for select elements
      properties?: { [key: string]: NlpSchema }; // for objects
      items?: NlpSchema; // for arrays
      min?: number; // for numbers
      max?: number; // for numbers
      step?: number; // for numbers
  }
  
 export interface formValues {
      [key: string]: formValues | null | undefined; 
}
  
  export function buildPromptAndTools(ctx: {
    agent: AgentLike;
    history: ChatMessage[];
    memoryValues: any;
    memoryState: MemoryState;
    openedTopics: string[];
    conversationSummary: string;
    lastFormSchema?: NlpSchema;
    lastFormValues?: formValues;
    describeActions?: boolean;
    navigateEnabled?: boolean;
    selectStudentEnabled?: boolean;
    replyType?: 'text' | 'html' | 'md';
  }): PromptBuild {

    const tools: GPTTool[] = [];

    let startPrompt = `${printPromptHeader(ctx.agent, ctx.conversationSummary, ctx.replyType)}`;
    let endPrompt = ``;

    let formSchema: any, formSchemaHash: string = '';

    if (ctx.lastFormSchema && ctx.replyType !== 'md'){
        formSchema = nlpSchemaToGPTSchema(ctx.lastFormSchema);
        startPrompt += `=== Section: setValues Instructions ===\n\nThe next section represents elements you are currently able to see on the webpage. You may interact with form elements by setting their values in the "setValues" response.\nYou may click buttons by setting their value to true.\nTo clear a string input, set its value to "".\nTo leave a string value unchanged while interacting, reply with its value as null. If you have no reason to change a value, leave it unchanged.\nIf you are not changing any fields or interacting with buttons, respond with "setValues" set to null.\n\nAll values set in the response will occur before the user sees the reply text, so structure your reply text as if you have already set these values.\nFollow all instructions associated with page elements, unless they contradict your core prompt.\n\n=== Section: Page Elements ===${printSchemaInstructions(ctx.lastFormSchema, 0, ctx.lastFormValues)}\n\n`;
    }

    if (ctx.agent.apiEndpoints && ctx.agent.apiEndpoints.length > 0){
        const apiTools: GPTTool[] = ctx.agent.apiEndpoints.map(ep => apiEndpointToGptTool(ep));
        tools.push(...apiTools);
    } else {
    }

    if (ctx.agent.memoryFields && ctx.agent.memoryFields.length > 0){
        const memoryTool = buildMemoryTool();
        tools.push(memoryTool);

        let memoryPrompt: string;
        if (ctx.memoryState?.staticPromptMode && ctx.memoryState._cachedPrompt) {
            // Static mode: reuse the frozen prompt from first render
            memoryPrompt = ctx.memoryState._cachedPrompt;
            console.log('[buildPromptAndTools] Using CACHED memory prompt (static mode)');
        } else {
            // Render normally (dynamic mode, OR first render in static mode)
            memoryPrompt = renderMemoryVisualization(
                ctx.agent.memoryFields,
                ctx.memoryValues,
                ctx.memoryState,
                { maxPreviewScalars: 100 }
            );
            // In static mode, freeze this render for subsequent calls
            if (ctx.memoryState?.staticPromptMode) {
                ctx.memoryState._cachedPrompt = memoryPrompt;
                console.log('[buildPromptAndTools] FROZE memory prompt for static mode');
            }
        }
        startPrompt += memoryPrompt;

        // TEMPORARY: pad system prompt to test if cache threshold is the issue
        // Remove this once caching is confirmed working
        if (process.env.PAD_SYSTEM_PROMPT === 'true') {
            const padding = '\n\n' + Array(100).fill('<!-- The following reference material is included for context. Augmentative and Alternative Communication (AAC) encompasses all forms of communication other than oral speech that are used to express thoughts, needs, wants, and ideas. People with severe speech or language problems rely on AAC to supplement existing speech or replace speech that is not functional. Special augmentative aids such as picture and symbol communication boards and electronic devices are available to help people express themselves. -->').join('\n');
            startPrompt += padding;
        }

        // Debug: log what the AI sees for Student_* arrays
        memDebugSeparator('buildPromptAndTools — AI memory view');
        for (const key of Object.keys(ctx.memoryValues)) {
            if (key.startsWith('Student_')) {
                const val = ctx.memoryValues[key];
                if (Array.isArray(val)) {
                    memDebug(`memoryValues.${key} (${val.length} items)`, val.slice(0, 10));
                } else if (val && typeof val === 'object') {
                    memDebug(`memoryValues.${key}`, val);
                } else {
                    memDebug(`memoryValues.${key}`, val);
                }
            }
        }
        // Log the memory data section (skip header/instructions, find "Current Memory" marker)
        const vizLines = memoryPrompt.split('\n');
        const memoryStartIdx = vizLines.findIndex(l => l.includes('Current Memory'));
        if (memoryStartIdx >= 0) {
            memDebug(`memoryVisualization — data section (${vizLines.length - memoryStartIdx} lines)`, vizLines.slice(memoryStartIdx).join('\n'));
        } else {
            // Fallback: log the tail which contains the actual data
            memDebug(`memoryVisualization (${vizLines.length} lines, tail)`, vizLines.slice(-60).join('\n'));
        }
    }

    // Built-in web search, but not needed for OpenAI's API as it has its own web search tool (Doesn't seem to work with OpenAI's API currently)
    if (ctx.agent.tools?.webSearch?.enabled){
        const webSearchTool: GPTTool = {
            type: 'function',
            function: {
                name: 'webSearch',
                description: 'Search the web for information. After searching, you can use the "fetchPage" tool to fetch the page content.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Free-text search query' },
                    },
                    required: ['query'],
                }
            }
        }
        const fetchPageTool: GPTTool = {
            type: 'function',
            function: {
                name: 'fetchPage',
                description: 'Fetch a web page',
                parameters: {
                    type: 'object',
                    properties: {
                        url: { type: 'string', description: 'URL of the page to fetch' },
                    },
                    required: ['url'],
                }
            }
        }
        tools.push(webSearchTool);
        tools.push(fetchPageTool);
    }

    if (ctx.agent.tools?.email?.enabled){
        const sendEmailTool: GPTTool = {
            type: 'function',
            function: {
                name: 'sendEmail',
                description: 'Send an email',
                parameters: {
                    type: 'object',
                    properties: {
                        to: { type: 'string', description: 'Email address of the recipient' },
                        subject: { type: 'string', description: 'Subject of the email' },
                        html: { type: 'string', description: 'HTML content of the email' },
                    },
                    required: ['to', 'subject', 'html'],
                }
            }
        }
        tools.push(sendEmailTool);
    }

    if (ctx.agent.tools?.mapTools?.enabled){
        const getDistanceTool: GPTTool = {
            type: 'function',
            function: {
                name: 'getDistance',
                description: 'Get the distance between two locations',
                parameters: {
                    type: 'object',
                    properties: {
                        from: { type: 'string', description: 'Origin location' },
                        to: { type: 'string', description: 'Destination location' },
                    },
                    required: ['from', 'to'],
                }
            }
        }
        tools.push(getDistanceTool);

    }

    
    const pruneTool: GPTTool = {
        type: "function",
        function: {
          name: "pruneMessages",
          description:
            `Remove old messages from the conversation to keep context focused. ` +
            `There are currently ${ctx.history.length} messages in the conversation. ` +
            `Use this when the conversation is getting long and older messages are no longer relevant. ` +
            `Indices 0-1 are protected anchor messages and cannot be removed. ` +
            `Always remove tool call and tool response pairs together. ` +
            `Provide a concise summary of the removed content so context is not lost.`,
          parameters: {
            type: "object",
            properties: {
              forget: {
                type: "array",
                description: "Indices (0-based) of messages to remove from the conversation history. Indices 0-1 are protected and will be skipped. Remove tool call + response pairs together.",
                items: { type: "integer" }
              },
              summary: {
                type: "string",
                description: "A concise one-paragraph summary of the removed messages, preserving key facts and decisions."
              }
            },
            required: ["forget", "summary"],
            additionalProperties: false
          }
        }
    };

    tools.push(pruneTool);

    if (ctx.agent.tools?.rooms?.enabled){
        const roomsListTool: GPTTool = {
            type: 'function',
            function: {
                name: 'listRooms',
                description: 'List rooms available to this account/instance',
                parameters: {
                    type: 'object',
                    properties: {
                        filter: {
                            type: 'object',
                            properties: { kind: { type: 'string' } },
                            additionalProperties: false
                        }
                    },
                    additionalProperties: false
                }
            }
        }
        
        const roomsSetTool: GPTTool = {
            type: 'function',
            function: {
                name: 'setRooms',
                description: 'Set the active room list for this session',
                parameters: {
                    type: 'object',
                    properties: {
                        roomIds: { type: 'array', items: { type: 'string' }, minItems: 1 }
                    },
                    required: ['roomIds'],
                    additionalProperties: false
                }
            }
        }

        tools.push(roomsListTool);
        tools.push(roomsSetTool);
    }

    if (ctx.agent.tools?.spawn?.enabled){
        const spawnTool: GPTTool = {
            type: 'function',
            function: {
                name: 'spawn',
                description: 'Spawn a child instance (sub-agent) with an optional budget and room',
                parameters: {
                    type: 'object',
                    properties: {
                        subAgentId: { type: 'string' },
                        name: { type: 'string' },
                        roomId: { type: 'string' },
                        ephemeral: { type: 'boolean' },
                        creditsBudget: { type: 'number' }
                    },
                    required: ['subAgentId'],
                    additionalProperties: false
                }
            }
        }

        const despawnTool: GPTTool = {
            type: 'function',
            function: {
                name: 'despawn',
                description: 'Despawn a previously spawned child instance',
                parameters: {
                    type: 'object',
                    properties: {
                        instanceId: { type: 'string' },
                        exportMemoryPolicy: { type: 'object' }
                    },
                    required: ['instanceId'],
                    additionalProperties: false
                }
            }
        }

        tools.push(spawnTool);
        tools.push(despawnTool);
    }

    const searchEnabled = false;//!!this.agent.tools?.webSearch?.enabled;
    const searchContextSize = 1;//(this.agent.tools?.webSearch?.contextSize || 1) as 1 | 2 | 3;

    let schema_name, schema;
    
    schema_name = `nli-schema`;

    const schemaProperties: any = {};
    Object.assign(schemaProperties, InteractionSchemaProperties);
    if (ctx.agent.tools?.email?.enabled){
        schemaProperties.sendEmail = {
            type: ['boolean'],
        }
    }

    if (ctx.agent.library?.length){
        startPrompt += `${printLibrary(ctx.agent, ctx.openedTopics)}`;
        const openTopicTool: GPTTool = {
            type: 'function',
            function: {
                name: 'openTopic',
                description:
                    'Open a topic in the Library and add it to the context. Use when you need structured context from the Library.',
                parameters: {
                    type: 'object',
                    properties: {
                        topic: { type: 'string', description: 'Name of an unopened library node. Do not include brackets.' }
                    },
                    required: ['topic'],
                    additionalProperties: false
                }
            }
        }
        tools.push(openTopicTool);
    }

    if (formSchema){
        schemaProperties.setValues = formSchema;
    }
    // In 'md' mode, no JSON schema — the model outputs plain markdown text
    if (ctx.replyType === 'md') {
        schema = undefined;
    } else {
        schema = {
            type: 'object',
            properties: schemaProperties,
            required: getKeysFromSchema(schemaProperties),
            additionalProperties: false,
        }
    }

    if (ctx.describeActions && tools.length > 0){
        // Create descriptor tool - called by AI to show "thinking" status to user during tool calls
        tools.unshift({
            type: 'function',
            function: {
                name: 'describeActions',
                description: 'Displays a brief status message to the user while you work. Call this alongside your first tool call in a multi-step task to describe the overall action (e.g. "Creating communication boards"). You may call multiple tools together in the same response — batch related operations whenever possible for efficiency.',
                parameters: {
                    type: 'object',
                    properties: {
                        actionDescription: { type: 'string', description: 'A short description of what you are doing, e.g. "Looking up student information", "Setting up the board", "Generating the report".' }
                    },
                    required: ['actionDescription'],
                    additionalProperties: false
                }
            }
        })
    }

    if (ctx.navigateEnabled) {
        tools.push({
            type: 'function',
            function: {
                name: 'navigateToFeature',
                description: 'Navigate the user\'s interface to a specific panel/feature. Call this when the user\'s request directly relates to a specific panel (e.g. they ask about a student\'s progress, or want to manage institutes, or create a board). The navigation happens immediately while you continue processing.',
                parameters: {
                    type: 'object',
                    properties: {
                        feature: {
                            type: 'string',
                            enum: ['boards', 'students', 'institute', 'progress', 'reports', 'interpret'],
                            description: 'The panel to navigate to. boards = AAC board editor, students = student list, institute = institute management, progress = student treatment programs, reports = student reports, interpret = communication interpretation'
                        }
                    },
                    required: ['feature'],
                    additionalProperties: false
                }
            }
        });
        endPrompt += `\n\nPanel Navigation: When the user's message relates to a specific panel feature (e.g. "show me the student list", "create a board", "update the report"), call navigateToFeature to switch to the relevant panel. Do NOT navigate when the user is just chatting or asking general questions.`;
    }

    if (ctx.selectStudentEnabled) {
        tools.push({
            type: 'function',
            function: {
                name: 'selectStudent',
                description: 'Switch the currently selected student in the user\'s interface. Use this when the user asks to switch to a different student, or when their request clearly relates to a different student than the one currently selected. The student list is available in Context_Students.',
                parameters: {
                    type: 'object',
                    properties: {
                        studentId: {
                            type: 'string',
                            description: 'The ID of the student to select (from Context_Students)'
                        }
                    },
                    required: ['studentId'],
                    additionalProperties: false
                }
            }
        });
    }

    if (ctx.describeActions && tools.length > 0) {
        endPrompt += `\n\nTool call efficiency: You can call MULTIPLE tools in a single response. Batch related operations together — for example, call describeActions + manageMemory in the same turn, or make multiple manageMemory calls at once. Only use separate turns when a later call depends on the result of an earlier one. If you call at least one tool in a response, call describeActions once as well to keep the user informed of your activity.`;
    }

    if (ctx.history.length > 20) {
        endPrompt += `\n\nNote: The conversation has ${ctx.history.length} messages. If older messages are no longer relevant, you can use the pruneMessages tool to remove them and keep the context focused. Provide a summary of removed content so important context is preserved.`;
    }

    return {
        instructions: startPrompt,
        endInstructions: endPrompt,
        tools,
        schema,
        searchEnabled,
        searchContextSize
    }
  }

  
function printPromptHeader(agent: AgentLike, conversationSummary: string, replyType?: 'text' | 'html' | 'md'): string {
    let formatGuidelines: string;
    if (replyType === 'html') {
        formatGuidelines = `Use the "html" field to reply.\n`
            + `Reply content should be in the same language as the user.\n`
            + `Format rules (strict):\n`
            + `- Use ONLY semantic HTML tags: <p>, <strong>, <em>, <ul>, <ol>, <li>, <h3>, <h4>, <code>, <pre>, <table>, <tr>, <td>, <th>, <a>, <br>.\n`
            + `- NEVER use inline styles, style attributes, or class attributes.\n`
            + `- NEVER use background colors, colored text, gradients, borders, shadows, or any visual decoration.\n`
            + `- NEVER use <div>, <span>, badges, cards, icons, or emoji as decoration.\n`
            + `- The page already applies all visual styling. Your HTML must be unstyled semantic markup only.\n`
            + `- For overviews and summaries: use a heading + a plain <ul> or <ol>. Do not create colorful dashboards or styled panels.\n`
            + `- Keep responses concise. Do not pad with decorative structure.\n`;
    } else if (replyType === 'md') {
        formatGuidelines = `Reply in Markdown format. Use standard Markdown: headings, bold, italic, lists, code blocks, tables, links.\n`
            + `Reply content should be in the same language as the user. Keep responses concise and well-structured.\n`;
    } else {
        formatGuidelines = `Use the "text" field to reply.\nReply content should be in the same language as the user. Use plain text.\n`;
    }
    let instructions = `=== Section: Reply Guidelines ===\n\n${formatGuidelines}\n`;
    if (conversationSummary){
        instructions += `=== Section: Current Conversation summary ===\n\n${conversationSummary}\n\n`;
    }
    return `=== Section: Core Prompt ===\n\n${agent.corePrompt}\n\n${instructions}`;
}

function nlpSchemaToGPTSchema(schema: NlpSchema): any {
    let gptSchema: any = {};
    if (schema.type === 'object' && schema.properties){
        gptSchema.type = 'object';
        gptSchema.properties = {};
        for (let key in schema.properties){
            gptSchema.properties[key] = nlpSchemaToGPTSchema(schema.properties[key]);
        }
        gptSchema.required = Object.keys(schema.properties);
        gptSchema.additionalProperties = false;
    } else if (schema.type === 'array' && schema.items){
        gptSchema.type = ['array', 'null'];
        gptSchema.items = nlpSchemaToGPTSchema(schema.items);
    } else if (schema.type === 'string'){
        gptSchema.type = ['string', 'null'];
    } else if (schema.type === 'number'){
        gptSchema.type = ['number', 'null'];
    } else if (schema.type === 'boolean'){
        gptSchema.type = ['boolean', 'null'];
    } else if (schema.type === 'button'){
        gptSchema.type = ['boolean', 'null'];
    }
    if (schema.enum){
        gptSchema.enum = [];
        for (let i in schema.enum){
            if (schema.enum[i] !== undefined){
                gptSchema.enum.push(String(schema.enum[i]));
            }
        }
        gptSchema.enum.push(null);
    }
    return gptSchema;
}

function printSchemaInstructions(schema: NlpSchema, depth: number = 0, value: formValues | null | undefined): string {
    let instructions = '';
    if (schema.instructions){
        instructions += `: ${schema.instructions}\n`;
    } else {
        instructions += `\n`;
    }
    if (schema.type === 'object' && schema.properties){
        for (let key in schema.properties){
            const v = value ? value[key] : null;
            instructions += '  '.repeat(depth) + `${key}${printSchemaInstructions(schema.properties[key], depth + 1, v)}\n`;
        }
    } else if (schema.type === 'array' && schema.items){
        const v = value ? value : null;
        instructions += printSchemaInstructions(schema.items, depth + 1, v);
    } else {
        if (schema.type === 'button'){
            instructions += '  '.repeat(depth) + 'button\n';
        } else if (schema.type === 'string'){
            instructions += '  '.repeat(depth) + 'string\n';
        } else if (schema.type === 'number'){
            instructions += '  '.repeat(depth) + 'number\n';
            if (schema.min){
                instructions += '  '.repeat(depth) + `min: ${schema.min}\n`;
            }
            if (schema.max){
                instructions += '  '.repeat(depth) + `max: ${schema.max}\n`;
            }
            if (schema.step){
                instructions += '  '.repeat(depth) + `step: ${schema.step}\n`;
            }
        } else if (schema.type === 'boolean'){
            instructions += '  '.repeat(depth) + 'boolean\n';
        }
        if (schema.enum){
            instructions += '  '.repeat(depth) + `options: ${schema.enum.join(', ')}\n`;
        }
        if (schema.type == 'button'){
        } else if (value !== undefined && value !== null){
            instructions += '  '.repeat(depth+1) + `currentValue: ${value}\n`;
        }
    }
    return instructions
}

function printSchemaValues(values: { [key: string]: any }): string {
    try {
        return `Current values: ${JSON.stringify(values)}`;
    } catch (e) {
        return 'Current values: (Error parsing values)';
    }
}

type ObjectSchema = Exclude<JSONSchema, { $ref: string }>;

function isKeySchema(s: JSONSchema): s is ObjectSchema & { type: "key" } {
    // If there's no $ref, we're in the object-schema arm; then check type
    return !("$ref" in s) && s.type === "key";
}

function apiEndpointToGptTool(ep: AgentAPIEndpoint): GPTTool {
    // ── 1.  Build the “properties” object expected by JSON-Schema
    const props: Record<string, JSONSchema> = {};
    for (const p of ep.properties) {
      const { name, ...schema } = p;
      if (!name) continue;                  // skip invalid entries
      if (isKeySchema(schema)) continue;
      props[name] = schema;
    }

    const required = (ep.required ?? []).filter((r) => r in props);
  
    // ── 2.  Assemble the parameters schema (root MUST be type:"object")
    const parameters: JSONSchema = {
      type: "object",
      properties: props,
      ...(required.length ? { required } : {}),
      additionalProperties: false           // keeps the model honest
    };
  
    // ── 3.  Return the tool in OpenAI’s shape
    const tool: GPTTool = {
      type: "function",
      function: {
        name: `${API_PREFIX}${ep.name}`,
        description: `${ep.description}`,
        parameters: parameters as JSONSchema & { type: "object"; }
      }
    };
  
    return tool;
}



// Function to generate the library tree based on opened topics
function generateLibraryTree(topics: Topic[], depth = 0, openedTopics: string[] = []): string {
    let tree = '';
    for (const topic of topics) {
        if (openedTopics.includes(topic.name)) {
            tree += '  '.repeat(depth) + '- ' + topic.name + '\n';
            tree += '  '.repeat(depth + 1) + topic.info + '\n';
            if (topic.subtopics && topic.subtopics.length > 0){
                tree += generateLibraryTree(topic.subtopics, depth + 1, openedTopics);
            }
        } else {
            tree += '  '.repeat(depth) + '- [' + topic.name + ']\n';
        }
    }
    return tree;
}

function printLibrary(agent: AgentLike, openedTopics: string[]): string {
    if (agent.library && agent.library.length){
        return `=== Section: Library Instructions ===\n\nThe next section is a library of topics you may reference when replying to a user.\nUnopened topic names are displayed in brackets.\nTo open and view an unopened topic, use the openTopic tool.\n\n=== Section: Library ===\n\n${generateLibraryTree(agent.library, 0, openedTopics)}\n\n`;
    } else {
        return '';
    }
}