export interface schemaProperties {
  type: ["array" | "object" | "string" | "number" | "boolean" | "null"];
  instructions?: string;
  enum?: string[];
  properties?: {[key: string]: schemaProperties};
  items?: schemaProperties;
}

export const InteractionSchemaProperties = {
    "html": {
        "type": ["string"]
    }
}

export const getKeysFromSchema = (schema: any) => {
    return Object.keys(schema);
}

/* topic.schema.ts  --------------------------------------------------- */

/**
 * Re-usable property bag for one Topic node.
 * Matches your previous { name, info, subtopics } interface.
 */
export const TopicSchemaProperties = {
    name: {                       // required
      type: 'string',
      description: 'Short title for this topic',
    },
    info: {                       // optional
      type: 'string',
      description: 'One-paragraph summary or notes for the topic',
    },
    subtopics: {                  // recursive list
      type: ['array'],
      description: 'Child topics (max depth 3 in total)',
      items: {
        $ref: '#/definitions/topic',   // self-reference
      },
      maxItems: 15,                    // guard token blow-ups
    },
  } as const;
  
  /**
   * Full Draft-07 schema object.
   * – `definitions.topic` lets us self-reference for recursion
   * –  root schema is also a topic
   */
// topic.schema.ts
export const TopicSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://example.com/schemas/topic-library.json',
    title: 'TopicLibrary',
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Short title for this topic'
      },
      info: {
        type: ['string', 'null'],
        description: 'Optional paragraph describing the topic'
      },
      subtopics: {
        type: ['array', 'null'],
        description: 'Child topics (depth ≤ 3)',
        items: { $ref: '#/definitions/topic' },
        maxItems: 15
      }
    },
    required: ['name', 'info', 'subtopics'],
    additionalProperties: false,
    definitions: {
      topic: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          info: { type: ['string', 'null'] },
          subtopics: {
            type: ['array', 'null'],
            items: { $ref: '#/definitions/topic' },
            maxItems: 15
          }
        },
        required: ['name', 'info', 'subtopics'],
        additionalProperties: false
      }
    }
  } as const;
  