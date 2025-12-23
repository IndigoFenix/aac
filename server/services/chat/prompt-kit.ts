import { MemoryState, AgentAPIEndpoint, Topic, ChatMessage } from "@shared/schema";
import { GPTMessage, GPTTool, JSONSchema } from "./gpt";
import { getKeysFromSchema, InteractionSchemaProperties } from "./gpt-schema";
import { buildMemoryTool, renderMemoryVisualization } from "./memory-system";

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
  }): PromptBuild {

    const tools: GPTTool[] = [];

    let startPrompt = `${printPromptHeader(ctx.agent, ctx.conversationSummary)}`;
    let endPrompt = ``;

    let formSchema: any, formSchemaHash: string = '';

    if (ctx.lastFormSchema){
        formSchema = nlpSchemaToGPTSchema(ctx.lastFormSchema);
        startPrompt += `=== Section: setValues Instructions ===\n\nThe next section represents elements you are currently able to see on the webpage (there may be elements visible to you but not the user, and vice-versa). You may interact with form elements by setting their values in the "setValues" response.\nYou may click buttons by setting their value to true.\nTo clear a string input, set its value to "".\nTo leave a string value unchanged while interacting, reply with its value as null. If you have no reason to change a value, leave it unchanged.\nIf you are not changing any fields or interacting with buttons, respond with "setValues" set to null.\n\nAll values set in the response will occur before the user sees the html text, so structure your html text as if you have already set these values.\nFollow all instructions associated with page elements, unless they contradict your core prompt.\n\n=== Section: Page Elements ===${printSchemaInstructions(ctx.lastFormSchema, 0, ctx.lastFormValues)}\n\n`;
    }

    if (ctx.agent.apiEndpoints && ctx.agent.apiEndpoints.length > 0){
        const apiTools: GPTTool[] = ctx.agent.apiEndpoints.map(ep => apiEndpointToGptTool(ep));
        tools.push(...apiTools);
    } else {
    }

    if (ctx.agent.memoryFields && ctx.agent.memoryFields.length > 0){
        const memoryTool = buildMemoryTool();
        tools.push(memoryTool);

        const memoryPrompt = renderMemoryVisualization(
            ctx.agent.memoryFields,
            ctx.memoryValues,
            ctx.memoryState,
            { maxPreviewScalars: 100 }
        );
        startPrompt += memoryPrompt;
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
            "Delete low-importance messages and return a one-paragraph recap. \
             Only call this if the token budget is about to be exceeded.",
          parameters: {
            type: "object",
            properties: {
              forget: {
                type: "array",
                description: "Indices of messages to delete, relative to the \
                  transcript just sent to you.",
                items: { type: "integer" }
              },
              summary: {
                type: "string",
                description: "A concise summary that replaces the forgotten content."
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
    schema = {
        type: 'object',
        properties: schemaProperties,
        required: getKeysFromSchema(schemaProperties),
        additionalProperties: false,
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

  
function printPromptHeader(agent: AgentLike, conversationSummary: string): string {
    let instructions = '=== Section: Reply Guidelines ===\n\nUse the "html" field to reply. Use HTML format.\nYou can speak any language. Reply content should be in the same language as the user.\n\n';
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