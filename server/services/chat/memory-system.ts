/* memory-system.ts
 * Structured Memory revamp for Hello-Computer
 * Exports:
 *   - buildMemoryTool(agent)
 *   - renderMemoryVisualization(memoryFields, memoryValues, memoryState, options?)
 *   - processMemoryToolResponse(memoryFields, memoryValues, memoryState, toolInput)
 */

import { MemoryState } from "@shared/schema";
import { GPTFunctionTool, JSONSchema } from "./gpt";

const REQUIRE_VISIBLE_TO_UPDATE = false;
const RETURN_VIEW_DATA = true;

/* ------------------------------
 * Types (copied / compatible)
 * ------------------------------ */

export type MemoryPrimitiveType = 'string' | 'number' | 'integer' | 'boolean' | 'null';
export type MemoryCompositeType  = 'object' | 'array' | 'map' | 'topic';
export type MemoryType           = MemoryPrimitiveType | MemoryCompositeType;

export interface AgentMemoryFieldBase {
  id: string;
  type: MemoryType;
  title?: string;
  description?: string;
  default?: any;
  enum?: any[];
  const?: any;
  examples?: any[];
  opened?: boolean;
  // Strings
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  // Numbers
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
}

export interface AgentMemoryFieldObject extends AgentMemoryFieldBase {
  type: 'object';
  properties: Record<string, AgentMemoryField>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface AgentMemoryFieldArray extends AgentMemoryFieldBase {
  type: 'array';
  items: AgentMemoryField;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

export interface AgentMemoryFieldMap extends AgentMemoryFieldBase {
  type: 'map';
  values: AgentMemoryField;
  keyPattern?: string;
  minProperties?: number;
  maxProperties?: number;
}

export interface AgentMemoryFieldTopic extends AgentMemoryFieldBase {
  type: 'topic';
  maxDepth?: number;
  maxBreadthPerNode?: number;
}

export type AgentMemoryField =
  | AgentMemoryFieldObject
  | AgentMemoryFieldArray
  | AgentMemoryFieldMap
  | AgentMemoryFieldTopic
  | (AgentMemoryFieldBase & { type: MemoryPrimitiveType });

export interface TopicNode {
  description?: string;
  subtopics: Record<string, TopicNode>;
}

export type TopicTree = Record<string, TopicNode>;

/* --------------------------------
 * Tool input + results
 * -------------------------------- */
export type MemoryAction =
  | 'view' | 'hide'
  | 'set' | 'upsert'
  | 'add' | 'insert'
  | 'delete' | 'clear'
  | 'rename';

export interface MemoryToolInput {
  action: MemoryAction;
  /** Single target path OR an array of paths. Exactly one of these must be provided. */
  path?: string;
  paths?: string[];
  /** Value for set/upsert/add/insert; for topics, string value here targets "description" unless a node object is supplied. */
  value?: any;
  /** For insert (array) or upsert (array), index position. 0..length */
  index?: number;
  /** For add to map/topic: new key (required). For map rename/topic rename: the new key name. */
  key?: string;
  newKey?: string;
  /** Optional pagination for view (container paths only). */
  page?: { offset?: number; limit?: number };
  /** For view: if true and path is a container (no *), also make its immediate children visible. Default true for objects; false for others. */
  openChildren?: boolean;
}

export type MemoryToolBatchInput = { ops: MemoryToolInput[] } | { operations: MemoryToolInput[] };
export type MemoryToolCallInput  = MemoryToolInput | MemoryToolBatchInput;

export interface MemoryOperationResult {
  target: string;
  action: MemoryAction;
  ok: boolean;
  message?: string;
  newPath?: string;          // e.g., after rename
  mutatedPaths?: string[];   // concrete paths touched (esp. when wildcard expands)
}

export interface MemoryToolResponseProcessed {
  updatedMemoryValues: any;
  updatedMemoryState: MemoryState;
  results: MemoryOperationResult[];
}

/* ------------------------------
 * Utilities: paths & helpers
 * ------------------------------ */

const ROOT = '';

function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}
function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function normalizePath(path: string | undefined | null): string {
  if (!path) return ROOT;
  let p = path.trim();
  if (p === '' || p === '/') return ROOT;
  if (!p.startsWith('/')) p = '/' + p;
  // Collapse extra slashes
  p = p.replace(/\/+/g, '/');
  // Remove trailing slash except root
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

function splitPath(path: string): string[] {
  const p = normalizePath(path);
  if (p === ROOT) return [];
  return p.slice(1).split('/').map(unescapeToken);
}

function joinPath(tokens: string[]): string {
  if (!tokens.length) return ROOT;
  return '/' + tokens.map(escapeToken).join('/');
}

function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1];
}

function isIntegerKey(s: string): boolean {
  return /^-?\d+$/.test(s);
}

/* ------------------------------
 * Schema lookup along a path
 * ------------------------------ */

function topFieldById(fields: AgentMemoryField[], id: string | undefined): AgentMemoryField | undefined {
  return fields.find(f => f.id === id);
}

type SchemaStep =
  | { kind: 'field'; schema: AgentMemoryField; fieldId: string }
  | { kind: 'objectProp'; schema: AgentMemoryFieldObject; propName: string; propSchema: AgentMemoryField }
  | { kind: 'arrayItem'; schema: AgentMemoryFieldArray; index: number; itemSchema: AgentMemoryField }
  | { kind: 'mapValue'; schema: AgentMemoryFieldMap; key: string; valueSchema: AgentMemoryField }
  | { kind: 'topic'; schema: AgentMemoryFieldTopic; nodePath: string[] } // points to a TopicNode or the TopicTree root when nodePath=[]
  | { kind: 'topicDescription'; schema: AgentMemoryFieldTopic; nodePath: string[] }
  | { kind: 'topicSubtopics'; schema: AgentMemoryFieldTopic; nodePath: string[] };

function resolveSchemaPath(memoryFields: AgentMemoryField[], path: string): { steps: SchemaStep[]; leaf?: SchemaStep; error?: string } {
  const tokens = splitPath(path);
  if (tokens.length === 0) {
    return { steps: [] }; // root
  }
  const fieldId = tokens[0];
  const rootField = topFieldById(memoryFields, fieldId);
  if (!rootField) return { steps: [], error: `Unknown top-level field '${fieldId}'.` };
  const steps: SchemaStep[] = [{ kind: 'field', schema: rootField, fieldId }];

  let i = 1;
  let current: AgentMemoryField = rootField;
  const rest = tokens.slice(1);

  function pushLeaf(step: SchemaStep) { steps.push(step); }

  while (i <= rest.length) {
    const seg = rest[i - 1];

    if (current.type === 'object') {
      const obj = current as AgentMemoryFieldObject;
      if (seg in obj.properties) {
        const propSchema = obj.properties[seg];
        pushLeaf({ kind: 'objectProp', schema: obj, propName: seg, propSchema });
        current = propSchema;
      } else if (obj.additionalProperties) {
        // Allow any property
        const propSchema = (typeof obj.additionalProperties === 'object'
          ? obj.additionalProperties
          : { type: 'null' as const }) as AgentMemoryField;
        pushLeaf({ kind: 'objectProp', schema: obj, propName: seg, propSchema });
        current = propSchema;
      } else {
        return { steps, error: `Property '${seg}' not allowed in object '${(steps[0] as any).fieldId}'.` };
      }
    } else if (current.type === 'array') {
      if (!isIntegerKey(seg)) return { steps, error: `Expected array index, got '${seg}'.` };
      const arr = current as AgentMemoryFieldArray;
      const idx = parseInt(seg, 10);
      pushLeaf({ kind: 'arrayItem', schema: arr, index: idx, itemSchema: arr.items });
      current = arr.items;
    } else if (current.type === 'map') {
      const map = current as AgentMemoryFieldMap;
      pushLeaf({ kind: 'mapValue', schema: map, key: seg, valueSchema: map.values });
      current = map.values;
    } else if (current.type === 'topic') {
      // Topic path convention:
      // /field              -> TopicTree root (nodePath=[])
      // /field/<key>...     -> TopicNode
      // Optionally allow leaf "description" or "subtopics"
      const remaining = rest.slice(i - 1);
      // If we see explicit "description" or "subtopics", handle them specially
      if (remaining.length >= 1 && (remaining[0] === 'description' || remaining[0] === 'subtopics')) {
        const nodePath: string[] = [];
        // when path is /field/description or /field/subtopics (nodePath=[] at root)
        const kind = remaining[0] === 'description' ? 'topicDescription' : 'topicSubtopics';
        pushLeaf({ kind, schema: current as AgentMemoryFieldTopic, nodePath });
        i += 1;
        continue;
      }

      // Otherwise consume tokens until possibly we hit description/subtopics
      const nodePath: string[] = [];
      let j = 0;
      while (j < remaining.length && remaining[j] !== 'description' && remaining[j] !== 'subtopics') {
        nodePath.push(remaining[j]);
        j++;
      }
      pushLeaf({ kind: 'topic', schema: current as AgentMemoryFieldTopic, nodePath });
      i += nodePath.length;
      if (i - 1 < rest.length) {
        const tail = rest[i - 1];
        if (tail === 'description') {
          pushLeaf({ kind: 'topicDescription', schema: current as AgentMemoryFieldTopic, nodePath });
          i += 1;
        } else if (tail === 'subtopics') {
          pushLeaf({ kind: 'topicSubtopics', schema: current as AgentMemoryFieldTopic, nodePath });
          i += 1;
        }
      }
      continue;
    } else {
      // primitive reached but path continues
      return { steps, error: `Cannot traverse into primitive at '${joinPath(tokens.slice(0, i))}'.` };
    }

    i += 1;
  }

  const leaf = steps[steps.length - 1];
  return { steps, leaf };
}

/* ------------------------------
 * Validation helpers
 * ------------------------------ */

function isNumber(n: any): n is number { return typeof n === 'number' && Number.isFinite(n); }
function isInteger(n: any): n is number { return typeof n === 'number' && Number.isInteger(n); }

function typeMatches(schema: AgentMemoryField, value: any): boolean {
  switch (schema.type) {
    case 'string':  return typeof value === 'string';
    case 'number':  return isNumber(value);
    case 'integer': return isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null':    return value === null;
    case 'object':  return value && typeof value === 'object' && !Array.isArray(value);
    case 'array':   return Array.isArray(value);
    case 'map':     return value && typeof value === 'object' && !Array.isArray(value);
    case 'topic':   return value && typeof value === 'object' && !Array.isArray(value);
    default:        return true;
  }
}

function validateFormat(format?: string, value?: any): boolean {
  if (value == null || typeof value !== 'string' || !format) return true;
  switch (format) {
    case 'email':    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case 'uri':      try { new URL(value); return true; } catch { return false; }
    case 'date-time':return !isNaN(Date.parse(value));
    case 'uuid':     return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    default:         return true;
  }
}

function validateAgainstSchema(schema: AgentMemoryField, value: any, path: string): string[] {
  const errs: string[] = [];

  // const / enum
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errs.push(`Value at '${path}' must equal const ${JSON.stringify(schema.const)}.`);
    return errs;
  }
  if (schema.enum && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) {
    errs.push(`Value at '${path}' must be one of enum ${JSON.stringify(schema.enum)}.`);
    return errs;
  }

  if (!typeMatches(schema, value)) {
    errs.push(`Type mismatch at '${path}': expected '${schema.type}'.`);
    return errs;
  }

  // Primitive constraints
  if (schema.type === 'string') {
    const s = value as string;
    if (schema.minLength != null && s.length < schema.minLength) errs.push(`minLength ${schema.minLength} at '${path}'.`);
    if (schema.maxLength != null && s.length > schema.maxLength) errs.push(`maxLength ${schema.maxLength} at '${path}'.`);
    if (schema.pattern) {
      const re = new RegExp(schema.pattern);
      if (!re.test(s)) errs.push(`pattern ${schema.pattern} failed at '${path}'.`);
    }
    if (!validateFormat(schema.format, s)) errs.push(`format '${schema.format}' invalid at '${path}'.`);
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    const n = value as number;
    if (schema.minimum != null && n < schema.minimum) errs.push(`minimum ${schema.minimum} at '${path}'.`);
    if (schema.maximum != null && n > schema.maximum) errs.push(`maximum ${schema.maximum} at '${path}'.`);
    if (schema.exclusiveMinimum != null && n <= schema.exclusiveMinimum) errs.push(`exclusiveMinimum ${schema.exclusiveMinimum} at '${path}'.`);
    if (schema.exclusiveMaximum != null && n >= schema.exclusiveMaximum) errs.push(`exclusiveMaximum ${schema.exclusiveMaximum} at '${path}'.`);
    if (schema.multipleOf != null && (n / schema.multipleOf) % 1 !== 0) errs.push(`multipleOf ${schema.multipleOf} at '${path}'.`);
  }

  // Structural constraints (object/array/map)
  if (schema.type === 'array') {
    const arr = value as any[];
    const s = schema as AgentMemoryFieldArray;
    if (s.minItems != null && arr.length < s.minItems) errs.push(`minItems ${s.minItems} at '${path}'.`);
    if (s.maxItems != null && arr.length > s.maxItems) errs.push(`maxItems ${s.maxItems} at '${path}'.`);
    if (s.uniqueItems) {
      const seen = new Set(arr.map(e => JSON.stringify(e)));
      if (seen.size !== arr.length) errs.push(`uniqueItems violated at '${path}'.`);
    }
    // validate items shallowly (optional – to avoid heavy recursion)
  }
  if (schema.type === 'object') {
    const obj = value as Record<string, any>;
    const s = schema as AgentMemoryFieldObject;
    const req = new Set(s.required ?? []);
    for (const r of req) {
      if (!(r in obj)) errs.push(`Missing required property '${r}' at '${path}'.`);
    }
    if (s.additionalProperties === false) {
      const allowed = new Set(Object.keys(s.properties));
      for (const k of Object.keys(obj)) {
        if (!allowed.has(k)) errs.push(`Property '${k}' not allowed at '${path}'.`);
      }
    }
  }
  if (schema.type === 'map') {
    const map = value as Record<string, any>;
    const s = schema as AgentMemoryFieldMap;
    const keys = Object.keys(map);
    if (s.minProperties != null && keys.length < s.minProperties) errs.push(`minProperties ${s.minProperties} at '${path}'.`);
    if (s.maxProperties != null && keys.length > s.maxProperties) errs.push(`maxProperties ${s.maxProperties} at '${path}'.`);
    if (s.keyPattern) {
      const re = new RegExp(s.keyPattern);
      for (const k of keys) if (!re.test(k)) errs.push(`Key '${k}' violates keyPattern at '${path}'.`);
    }
  }
  if (schema.type === 'topic') {
    // validated via dedicated topic checks at mutation time
  }

  return errs;
}

/* ------------------------------
 * Value navigation by path
 * ------------------------------ */

function getAtPath(obj: any, path?: string): any {
  if (path == null) return obj;
  const tokens = splitPath(path);
  let cur = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    cur = cur[t];
  }
  return cur;
}

function setAtPath(obj: any, path: string, value: any): { ok: true } | { ok: false; message: string } {
  const tokens = splitPath(path);
  if (!tokens.length) return { ok: false, message: `Cannot set root.` };
  const key = tokens.pop()!;
  const parentPath = joinPath(tokens);
  const parent = parentPath === ROOT ? obj : getAtPath(obj, parentPath);
  if (parent == null || typeof parent !== 'object' || Array.isArray(parent)) {
    return { ok: false, message: `Parent not found at '${parentPath}'. Create it first.` };
  }
  parent[key] = value;
  return { ok: true };
}

function deleteAtPath(obj: any, path: string): { ok: true } | { ok: false; message: string } {
  const tokens = splitPath(path);
  if (!tokens.length) return { ok: false, message: `Cannot delete root.` };
  const key = tokens.pop()!;
  const parentPath = joinPath(tokens);
  const parent = parentPath === ROOT ? obj : getAtPath(obj, parentPath);
  if (parent == null || typeof parent !== 'object') return { ok: false, message: `Parent not found at '${parentPath}'.` };
  if (Array.isArray(parent)) {
    const idx = parseInt(key, 10);
    if (isNaN(idx) || idx < 0 || idx >= parent.length) return { ok: false, message: `Index out of bounds at '${path}'.` };
    parent.splice(idx, 1);
    return { ok: true };
  }
  if (!(key in parent)) return { ok: false, message: `No property '${key}' at '${path}'.` };
  delete parent[key];
  return { ok: true };
}

function renameKeyAtPath(obj: any, containerPath: string, oldKey: string, newKey: string): { ok: true } | { ok: false; message: string } {
  const container = getAtPath(obj, containerPath);
  if (!container || typeof container !== 'object' || Array.isArray(container)) {
    return { ok: false, message: `Container not found at '${containerPath}'.` };
  }
  if (!(oldKey in container)) return { ok: false, message: `Key '${oldKey}' does not exist.` };
  if (newKey in container) return { ok: false, message: `Key '${newKey}' already exists.` };
  container[newKey] = container[oldKey];
  delete container[oldKey];
  return { ok: true };
}

/* ------------------------------
 * Visibility & pagination
 * ------------------------------ */

function ensureState(state?: Partial<MemoryState>): MemoryState {
  return {
    visible: state?.visible ? Array.from(new Set(state.visible.map(normalizePath))) : [],
    page: state?.page ?? {}
  };
}

function pathIsVisible(state: MemoryState, path: string): boolean {
  const p = normalizePath(path);
  return state.visible.includes(p);
}

function parentIsVisible(state: MemoryState, path: string): boolean {
  const tokens = splitPath(path);
  if (tokens.length === 0) return true;
  const parent = joinPath(tokens.slice(0, -1));
  return pathIsVisible(state, parent) || (parent === ROOT); // allow top-level ops on root field
}

function openPath(state: MemoryState, path: string) {
  const p = normalizePath(path);
  if (!state.visible.includes(p)) state.visible.push(p);
}

function openChildren(state: MemoryState, values: any, path: string) {
  const v = getAtPath(values, path);
  if (v && typeof v === 'object') {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) openPath(state, joinPath([...splitPath(path), String(i)]));
    } else {
      for (const k of Object.keys(v)) openPath(state, joinPath([...splitPath(path), k]));
    }
  }
}

function closePathAndDescendants(state: MemoryState, path: string) {
  const p = normalizePath(path);
  state.visible = state.visible.filter(v => !(v === p || v.startsWith(p + '/')));
  for (const k of Object.keys(state.page)) {
    if (k === p || k.startsWith(p + '/')) delete state.page[k];
  }
}

function setPagination(state: MemoryState, path: string, offset?: number, limit?: number) {
  const p = normalizePath(path);
  if (!state.page[p]) state.page[p] = { offset: 0, limit: 50 };
  if (offset != null) state.page[p].offset = Math.max(0, offset);
  if (limit != null) state.page[p].limit = Math.max(1, Math.min(500, limit));
}

/* ------------------------------
 * Wildcard expansion (last seg)
 * ------------------------------ */

function hasTrailingWildcard(path: string): boolean {
  const tokens = splitPath(path);
  return last(tokens) === '*';
}

function expandWildcardOnce(memoryFields: AgentMemoryField[], values: any, path: string): { paths: string[]; error?: string } {
  const tokens = splitPath(path);
  if (tokens.length === 0) return { paths: [ROOT] };
  if (last(tokens) !== '*') return { paths: [normalizePath(path)] };
  const baseTokens = tokens.slice(0, -1);
  const basePath = joinPath(baseTokens);
  const { leaf, error } = resolveSchemaPath(memoryFields, basePath);
  if (error) return { paths: [], error };
  const container = getAtPath(values, basePath);
  if (container == null) return { paths: [], error: `Container '${basePath}' not found.` };

  let keys: string[] = [];
  if (Array.isArray(container)) keys = container.map((_, i) => String(i));
  else if (typeof container === 'object') keys = Object.keys(container);
  else return { paths: [], error: `Wildcard can target arrays/maps/objects/topics only.` };

  // For objects: show direct properties (including 'description' and 'subtopics' on topic nodes)
  // Here we simply expose immediate keys; for TopicTree root we already store nodes as map
  const expanded = keys.map(k => joinPath([...baseTokens, k]));
  return { paths: expanded };
}

/* ------------------------------
 * Topic helpers
 * ------------------------------ */

function getTopicNode(tree: TopicTree, nodePath: string[]): TopicNode | undefined {
  if (!nodePath.length) return undefined as any; // root is the tree itself
  let cur: TopicNode | undefined = tree[nodePath[0]];
  for (let i = 1; i < nodePath.length; i++) {
    if (!cur) return undefined;
    cur = cur.subtopics[nodePath[i]];
  }
  return cur;
}

function ensureTopicNode(tree: TopicTree, nodePath: string[]): TopicNode | undefined {
  if (!nodePath.length) return undefined as any;
  if (!tree[nodePath[0]]) tree[nodePath[0]] = { subtopics: {} };
  let cur = tree[nodePath[0]];
  for (let i = 1; i < nodePath.length; i++) {
    const k = nodePath[i];
    if (!cur.subtopics[k]) cur.subtopics[k] = { subtopics: {} };
    cur = cur.subtopics[k];
  }
  return cur;
}

function topicDepth(nodePath: string[]): number {
  // top-level subtopic depth = 1
  return nodePath.length;
}

function topicBreadth(node: TopicNode): number {
  return Object.keys(node.subtopics).length;
}

function getMemoryToolInstructions(): string {
  
  const pathSyntax = [
    "Use JSON-Pointer-like paths. Examples:",
    "  /profile/name            -> top-level field 'profile' property 'name'",
    "  /todos/0                 -> first item of array 'todos'",
    "  /contacts/John~1Doe      -> map key 'John/Doe' (escape '/' as '~1', '~' as '~0')",
    "  /notes/*                 -> wildcard: all immediate children (view/hide only)",
    "Topic paths:",
    "  /research                -> topic tree root (map of subtopics)",
    "  /research/AI             -> a TopicNode named 'AI'",
    "  /research/AI/description -> the node description",
    "  /research/AI/subtopics/* -> immediate subtopics of 'AI'",
  ].join('\n');

  const desc =
  `=== Section: Memory Management ===

  Use ManageMemory to store and retrieve information from memory.
  View any memory that seems relevant to the conversation. Hide information when it is no longer relevant.
  Any empty memory field should be filled as soon as relevant information becomes available.

  Batch API:
  - Send one or more operations in the 'ops' array. They are applied sequentially.
  - For view/hide you may use 'path' or 'paths' (array) and an optional trailing '*' wildcard.
  - For mutations, use a single 'path'. Do NOT use wildcards with mutations.

  Permissions:
  - You may only mutate targets that are currently visible OR whose parent container is visible.
  - To reveal content, add a 'view' op first. Creating/modifying containers auto-makes them visible.

  Path syntax:
  ${pathSyntax}\n\n
  `;

  return desc;
}

/* ------------------------------
 * buildMemoryTool(agent)
 * ------------------------------ */

export function buildMemoryTool(): GPTFunctionTool {

  const operationSchema: JSONSchema = {
    type: "object",
    description: "One memory operation. Executed in order.",
    properties: {
      action: {
        type: "string",
        enum: ["view","hide","set","upsert","add","insert","delete","clear","rename"],
        description: "Operation to perform."
      },
      path:  { type: "string",  description: "Target path (JSON Pointer). For mutations, must be a single concrete path." },
      paths: { type: "array",   items: { type: "string" }, description: "Multiple targets (allowed only for view/hide)." },
      value: { description: "New value for set/upsert/add/insert. For topics, string sets 'description', or supply a node object {description?, subtopics?}." },
      index: { type: "integer", minimum: 0, description: "Array index for insert/upsert on arrays." },
      key:   { type: "string",  description: "For add to map/topic: new dynamic key." },
      newKey:{ type: "string",  description: "For rename on map/topic: new key." },
      page:  {
        type: "object",
        properties: {
          offset: { type: "integer", minimum: 0 },
          limit:  { type: "integer", minimum: 1, maximum: 500 }
        },
        additionalProperties: false,
        description: "Pagination for 'view' on containers."
      },
      openChildren: {
        type: "boolean",
        description: "For 'view' of a container path (no '*'): if true, also mark immediate children visible."
      }
    },
    required: ["action"],
    additionalProperties: false
  };

  const parameters: JSONSchema & { type: "object" } = {
    type: "object",
    description: "Batch manage-memory request. Top-level MUST be an object with 'ops' array.",
    properties: {
      ops: {
        type: "array",
        minItems: 1,
        description: "Operations to apply sequentially.",
        items: operationSchema
      }
    },
    required: ["ops"],
    additionalProperties: false
  };

  return {
    type: "function",
    function: {
      name: "manageMemory",
      description: "Store or retrieve data from memory.",
      parameters
    }
  };
}


/* ------------------------------
 * renderMemoryVisualization(...)
 * ------------------------------ */

type RenderOptions = {
  defaultLimit?: number;      // default page size
  maxPreviewScalars?: number; // max scalar entries to print inline per container
};

export function renderMemoryVisualization(
  memoryFields: AgentMemoryField[],
  memoryValues: any,
  memoryState: MemoryState | undefined,
  options?: {
    defaultLimit?: number;
    maxPreviewScalars?: number;
    /** If provided, render only these absolute paths (each becomes its own section) */
    onlyRenderPaths?: string[];
    /** Suppress the "instructions" and "=== Current Memory ===" headings */
    suppressHeader?: boolean;
  }
): string {
  const state = ensureState(memoryState);
  const defaultLimit = options?.defaultLimit ?? 50;
  const maxScalars = options?.maxPreviewScalars ?? 24;

  // ---------- visibility helpers ----------
  const openedByDefaultTop: Set<string> = new Set();
  for (const f of memoryFields) {
    if (f.opened) openedByDefaultTop.add('/' + escapeToken(f.id));
  }
  
  function schemaOpenedAt(memoryFields: AgentMemoryField[], path: string): boolean {
    const { leaf } = resolveSchemaPath(memoryFields, path);
    if (!leaf) return false;
    switch (leaf.kind) {
      case 'field':          return !!(leaf.schema as AgentMemoryFieldBase).opened;
      case 'objectProp':     return !!(leaf.propSchema as AgentMemoryFieldBase).opened;
      case 'arrayItem':      return !!(leaf.itemSchema as AgentMemoryFieldBase).opened;
      case 'mapValue':       return !!(leaf.valueSchema as AgentMemoryFieldBase).opened;
      case 'topic':          return !!(leaf.schema as AgentMemoryFieldBase).opened;
      case 'topicDescription':
      case 'topicSubtopics': return false; // not schema nodes
    }
    return false;
  }
  
  function isOpen(path: string): boolean {
    const p = normalizePath(path);
    if (p === ROOT) return true;
  
    // 1) Explicit session visibility wins
    if (pathIsVisible(state, p)) return true;
  
    // 2) For back-compat: top-level fields with opened: true
    if (splitPath(p).length === 1 && openedByDefaultTop.has(p)) return true;
  
    // 3) implicit schema-opened visibility at any depth, gated by parent visibility
    if (schemaOpenedAt(memoryFields, p)) {
      const parent = joinPath(splitPath(p).slice(0, -1));
      return parent ? isOpen(parent) : true;
    }
  
    return false;
  }
  
  
  function pageFor(path: string) {
    const p = normalizePath(path);
    return state.page[p] ?? { offset: 0, limit: defaultLimit };
  }

  // ---------- small helpers for snapshot ----------
  function summarizeValue(schema: AgentMemoryField, value: any): string {
    if (value == null) return "null";
    switch (schema.type) {
      case 'string':  return JSON.stringify(value);
      case 'number':
      case 'integer':
      case 'boolean': return String(value);
      case 'object':
      case 'map':
      case 'array':
      case 'topic':   return `{${schema.type}}`;
      default:        return typeof value;
    }
  }
  function truncArr<T>(arr: T[], limit: number) {
    return arr.length <= limit ? { slice: arr, more: 0 } : { slice: arr.slice(0, limit), more: arr.length - limit };
  }

  // ---------- snapshot renderers ----------
  function renderObject(
    field: AgentMemoryFieldObject,
    value: any,
    basePath: string
  ): string[] {
    const lines: string[] = [];
    const open = isOpen(basePath);
    const keysAtRuntime = Object.keys(value ?? {});
    lines.push(`• ${basePath || '/'} (object)${inlineDesc(field.description)} ${open ? '' : '— hidden; view to list keys'}`);
    if (!open) return lines;
  
    // Show missing schema props only for standalone objects (not array/map items)
    let showMissingProps = true;
    const resolved = resolveSchemaPath(memoryFields, basePath);
    if (!resolved.error && resolved.leaf) {
      showMissingProps = !(resolved.leaf.kind === 'arrayItem' || resolved.leaf.kind === 'mapValue');
    }
  
    const schemaProps = field.properties ?? {};
    const schemaKeys = Object.keys(schemaProps);
    const orderedKeys: string[] = [...schemaKeys, ...keysAtRuntime.filter(k => !schemaProps[k])];
    const requiredSet = new Set(field.required ?? []);
    const shown: string[] = [];
  
    for (const k of orderedKeys) {
      const propSchema = schemaProps[k];
      const p = joinPath([...splitPath(basePath), k]);
      const hasValue = (value ?? {}).hasOwnProperty(k);
  
      // Schema-defined & present at runtime
      if (hasValue && propSchema) {
        const v = value[k];
  
        if (propSchema.type === 'object' || propSchema.type === 'array' || propSchema.type === 'map' || propSchema.type === 'topic') {
          const vis = isOpen(p);
          shown.push(`  - ${k}: {${propSchema.type}}${inlineDesc(propSchema?.description)} ${vis ? '' : '(hidden)'}`);
  
          // If this child container path itself is visible, inline-render the child contents
          if (vis) {
            if (propSchema.type === 'object') {
              const child = renderObject(propSchema as AgentMemoryFieldObject, v, p);
              shown.push(...indent(child.slice(1)));
            } else if (propSchema.type === 'array') {
              const arrVal = Array.isArray(v) ? v : [];
              const child = renderArray(propSchema as AgentMemoryFieldArray, arrVal, p);
              shown.push(...indent(child.slice(1)));
            } else if (propSchema.type === 'map') {
              const mapVal = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
              const child = renderMap(propSchema as AgentMemoryFieldMap, mapVal, p);
              shown.push(...indent(child.slice(1)));
            } else if (propSchema.type === 'topic') {
              const treeVal = (v && typeof v === 'object' && !Array.isArray(v)) ? (v as TopicTree) : {};
              const child = renderTopic(propSchema as AgentMemoryFieldTopic, treeVal, p);
              shown.push(...indent(child.slice(1)));
            }
          }
        } else {
          // Primitive
          // Show enum options for fields with enum constraints
          const enumHint = formatEnumHint(propSchema);
          shown.push(`  - ${k}: ${summarizeValue(propSchema, v)}${inlineDesc(propSchema?.description)}${enumHint}`);
        }
        continue;
      }
  
      // Schema-defined but missing at runtime → show empty slot (only for standalone objects)
      if (!hasValue && propSchema) {
        if (showMissingProps) {
          const req = requiredSet.has(k) ? '; required' : '';
          if (propSchema.type === 'object' || propSchema.type === 'map' || propSchema.type === 'array' || propSchema.type === 'topic') {
            shown.push(`  - ${k}: {${propSchema.type}}${inlineDesc(propSchema?.description)} (empty${req})`);
          } else {
            // Show enum options for empty fields with enums
            const enumHint = formatEnumHint(propSchema);
            shown.push(`  - ${k}: <${propSchema.type}>${inlineDesc(propSchema?.description)} (empty${req})${enumHint}`);
          }
        }
        continue;
      }
  
      // Runtime-only key not in schema
      if (hasValue && !propSchema) {
        shown.push(`  - ${k}: (not in schema)`);
      }
    }
  
    // paginate long lists of lines
    const { slice, more } = (function trunc<T>(arr: T[], limit: number) {
      return arr.length <= maxScalars ? { slice: arr, more: 0 } : { slice: arr.slice(0, maxScalars), more: arr.length - maxScalars };
    })(shown, maxScalars);
  
    lines.push(...slice);
    if (more > 0) lines.push(`  … +${more} more`);
    lines.push(`  ↪ To expand: view "${basePath}/*" or a specific child path.`);
    return lines;
  }  

  function indent(lines: string[], spaces = 4): string[] {
    const pad = ' '.repeat(spaces);
    return lines.map(l => pad + l);
  }

  function inlineDesc(desc?: string): string { return desc ? ` — ${desc}` : ''; }

  function formatEnumHint(schema: AgentMemoryField): string {
    if (!schema || schema.type === 'object' || schema.type === 'array' || 
        schema.type === 'map' || schema.type === 'topic') {
      return '';
    }
    const s = schema as AgentMemoryFieldBase;
    if (!s.enum || !s.enum.length) return '';
    
    const maxEnumShow = 6;
    if (s.enum.length <= maxEnumShow) {
      return ` [options: ${s.enum.map(v => JSON.stringify(v)).join(', ')}]`;
    } else {
      const shown = s.enum.slice(0, maxEnumShow).map(v => JSON.stringify(v)).join(', ');
      return ` [options: ${shown}, ... (+${s.enum.length - maxEnumShow} more)]`;
    }
  }

  function renderArray(field: AgentMemoryFieldArray, value: any[], basePath: string): string[] {
    const lines: string[] = [];
    const open = isOpen(basePath);
    const page = pageFor(basePath);
    lines.push(`• ${basePath || '/'} (array, ${value?.length ?? 0} items)${inlineDesc(field.description)} ${open ? '' : '— hidden; view to list items'}`);
    if (!open) return lines;
  
    const arr = Array.isArray(value) ? value : [];
    const start = Math.min(page.offset, Math.max(0, arr.length - 1));
    const end = Math.min(arr.length, start + page.limit);
  
    for (let i = start; i < end; i++) {
      const itemPath = joinPath([...splitPath(basePath), String(i)]);
      const item = arr[i];
      const s = field.items;
  
      if (s.type === 'object' || s.type === 'map' || s.type === 'array' || s.type === 'topic') {
        const vis = isOpen(itemPath);
        lines.push(`  - [${i}]: {${s.type}} ${vis ? '' : '(hidden)'}`);
        if (vis) {
          // Recursively render the child container when the item itself is visible.
          if (s.type === 'object') {
            const child = renderObject(s as AgentMemoryFieldObject, item, itemPath);
            lines.push(...indent(child.slice(1))); // drop the child's header line; indent the body
          } else if (s.type === 'array') {
            const child = renderArray(s as AgentMemoryFieldArray, Array.isArray(item) ? item : [], itemPath);
            lines.push(...indent(child.slice(1)));
          } else if (s.type === 'map') {
            const child = renderMap(s as AgentMemoryFieldMap, (item && typeof item === 'object' && !Array.isArray(item)) ? item : {}, itemPath);
            lines.push(...indent(child.slice(1)));
          } else if (s.type === 'topic') {
            const child = renderTopic(s as AgentMemoryFieldTopic, (item && typeof item === 'object' && !Array.isArray(item)) ? item as TopicTree : {}, itemPath);
            lines.push(...indent(child.slice(1)));
          }
        }
      } else {
        const enumHint = formatEnumHint(s);
        lines.push(`  - [${i}]: ${summarizeValue(s, item)}${enumHint}`);
      }
    }
  
    if (end < arr.length) lines.push(`  … more items (use view with page.offset=${end})`);
    return lines;
  }
  

  function renderMap(field: AgentMemoryFieldMap, value: Record<string, any>, basePath: string): string[] {
    const lines: string[] = [];
    const open = isOpen(basePath);
    const page = pageFor(basePath);
    const allKeys = Object.keys(value ?? {});
    lines.push(`• ${basePath || '/'} (map, ${allKeys.length} keys)${inlineDesc(field.description)} ${open ? '' : '— hidden; view to list keys'}`);
    if (!open) return lines;
  
    const start = Math.min(page.offset, Math.max(0, allKeys.length));
    const end = Math.min(allKeys.length, start + page.limit);
  
    for (let i = start; i < end; i++) {
      const k = allKeys[i];
      const entryPath = joinPath([...splitPath(basePath), k]);
      const s = field.values;
      const v = value?.[k];
  
      if (s.type === 'object' || s.type === 'map' || s.type === 'array' || s.type === 'topic') {
        const vis = isOpen(entryPath);
        lines.push(`  - ${k}: {${s.type}} ${vis ? '' : '(hidden)'}`);
        if (vis) {
          if (s.type === 'object') {
            const child = renderObject(s as AgentMemoryFieldObject, v, entryPath);
            lines.push(...indent(child.slice(1)));
          } else if (s.type === 'array') {
            const child = renderArray(s as AgentMemoryFieldArray, Array.isArray(v) ? v : [], entryPath);
            lines.push(...indent(child.slice(1)));
          } else if (s.type === 'map') {
            const child = renderMap(s as AgentMemoryFieldMap, (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}, entryPath);
            lines.push(...indent(child.slice(1)));
          } else if (s.type === 'topic') {
            const child = renderTopic(s as AgentMemoryFieldTopic, (v && typeof v === 'object' && !Array.isArray(v)) ? v as TopicTree : {}, entryPath);
            lines.push(...indent(child.slice(1)));
          }
        }
      } else {
        const enumHint = formatEnumHint(s);
        lines.push(`  - ${k}: ${summarizeValue(s, v)}${enumHint}`);
      }
    }
  
    if (end < allKeys.length) lines.push(`  … more keys (use view with page.offset=${end})`);
    lines.push(`  ↪ Add: action "add" at "${basePath}" with key + value. Rename: action "rename" on child path.`);
    return lines;
  }
  

  function renderTopic(field: AgentMemoryFieldTopic, value: TopicTree, basePath: string): string[] {
    const lines: string[] = [];
    const open = isOpen(basePath);
    const page = pageFor(basePath);
    const keys = Object.keys(value ?? {});
    lines.push(`• ${basePath || '/'} (topic, ${keys.length} subtopics)${inlineDesc(field.description)} ${open ? '' : '— hidden; view to list subtopics'}`);
    if (!open) return lines;

    const start = Math.min(page.offset, Math.max(0, keys.length));
    const end = Math.min(keys.length, start + page.limit);
    for (let i = start; i < end; i++) {
      const k = keys[i];
      const nodePath = joinPath([...splitPath(basePath), k]);
      const node = value?.[k] as TopicNode | undefined;
      const desc = node?.description ? ` — ${JSON.stringify(node.description)}` : '';
      lines.push(`  - ${k}${desc} ${isOpen(nodePath) ? '' : '(children hidden)'}`);
    }
    if (end < keys.length) lines.push(`  … more subtopics (use view with page.offset=${end})`);
    lines.push(`  ↪ Add subtopic: action "add" at "${basePath}" with key + optional {description}. Rename/delete under "${basePath}/<key>".`);
    return lines;
  }

  function renderOneTop(field: AgentMemoryField): string[] {
    const idPath = '/' + escapeToken(field.id);
    const v = (memoryValues ?? {})[field.id];
    if (field.type === 'object') return renderObject(field as AgentMemoryFieldObject, v, idPath);
    if (field.type === 'array')  return renderArray(field as AgentMemoryFieldArray, v ?? [], idPath);
    if (field.type === 'map')    return renderMap(field as AgentMemoryFieldMap, v ?? {}, idPath);
    if (field.type === 'topic')  return renderTopic(field as AgentMemoryFieldTopic, v ?? {}, idPath);
    const open = isOpen(idPath);
    const valStr = open ? summarizeValue(field, v) : '(hidden; view to show)';
    return [`• ${idPath} (${field.type})${inlineDesc(field.description)} ${valStr}`];
  }

  function renderOneAtPath(basePath: string): string[] {
    const p = normalizePath(basePath);
    const { leaf, error } = resolveSchemaPath(memoryFields, p);
    if (error || !leaf) return [`• ${p || '/'} — (invalid path)`];
  
    // Determine the schema at this path
    let schema: AgentMemoryField | undefined;
    switch (leaf.kind) {
      case 'field':            schema = leaf.schema as AgentMemoryField; break;
      case 'objectProp':       schema = leaf.propSchema as AgentMemoryField; break;
      case 'arrayItem':        schema = leaf.itemSchema as AgentMemoryField; break;
      case 'mapValue':         schema = leaf.valueSchema as AgentMemoryField; break;
      case 'topic':            schema = leaf.schema as AgentMemoryField; break;
      case 'topicDescription': schema = { type: 'string', id: '', title: '', description: 'Topic description' } as any; break;
      case 'topicSubtopics':   schema = { type: 'topic',  id: '', title: '', description: 'Topic subtopics'   } as any; break;
    }
    if (!schema) return [`• ${p || '/'} — (unrenderable)`];
  
    // Delegate container types to the same renderers as top-level
    if (schema.type === 'object') {
      const v = getAtPath(memoryValues, p);
      return renderObject(schema as AgentMemoryFieldObject, v, p);
    }
    if (schema.type === 'array') {
      const v = getAtPath(memoryValues, p) ?? [];
      return renderArray(schema as AgentMemoryFieldArray, Array.isArray(v) ? v : [], p);
    }
    if (schema.type === 'map') {
      const v = getAtPath(memoryValues, p) ?? {};
      const obj = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
      return renderMap(schema as AgentMemoryFieldMap, obj, p);
    }
    if (schema.type === 'topic') {
      // If caller targeted ".../subtopics", normalize to the node path for correct topic rendering
      const tokens = splitPath(p);
      const isSub = last(tokens) === 'subtopics';
      const base = isSub ? joinPath(tokens.slice(0, -1)) : p;
      const v = getAtPath(memoryValues, base) ?? {};
      const obj = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
      return renderTopic(schema as AgentMemoryFieldTopic, obj as TopicTree, isSub ? base : p);
    }
  
    // Primitive leaf
    const open = isOpen(p);
    const v = getAtPath(memoryValues, p);
    const valStr = open ? summarizeValue(schema, v) : '(hidden; view to show)';
    return [`• ${p || '/'} (${(schema as any).type})${inlineDesc((schema as any).description)} ${valStr}`];
  }
  
  // ---------- build snapshot ----------
  const lines: string[] = [];
  if (!options?.onlyRenderPaths || options.onlyRenderPaths.length === 0) {
    if (!options?.suppressHeader) {
      lines.push(getMemoryToolInstructions());
      lines.push('=== Current Memory ===');
    }
    for (const f of memoryFields) lines.push(...renderOneTop(f));
  } else {
    // Render just the requested paths (each as its own section),
    // using the same per-node renderers & visibility rules.
    const uniq = Array.from(new Set(options.onlyRenderPaths.map(normalizePath)));
    for (const p of uniq) lines.push(...renderOneAtPath(p));
    // Stop here: we don't want the global instructions or schema hints for a focused recall snippet.
    return lines.join('\\n');
  }

  // ---------- concise instructions ----------
  const allowedRoots = memoryFields.map(f => `/${escapeToken(f.id)}{${f.type}}`).join(', ');
  lines.push('');
  lines.push('Allowed roots & types: ' + allowedRoots);
  lines.push('Operate only on visible paths or their parent container. To reveal children:');
  lines.push('  manageMemory { "ops": [ { "action": "view", "path": "/path/*" } ] }');
  lines.push('Pagination: include { "page": { "offset": N, "limit": M } } in a view op on a container.');

  // ---------- SCHEMA HINTS (for creation) ----------
  // We list specs for containers you may modify now:
  // container path is visible, OR its parent is visible; top-level opened=true counts as visible.
  type ContKind = 'array' | 'map' | 'topic';
  type ContSpec = {
    path: string;
    kind: ContKind;
    schema: AgentMemoryFieldArray | AgentMemoryFieldMap | AgentMemoryFieldTopic;
    parentPath: string | null;
  };
  const containerSpecs: ContSpec[] = [];

  // String helpers
  const trim = (s: string, n = 64) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

  function primitiveConstraints(s: AgentMemoryFieldBase & { type: MemoryPrimitiveType }): string {
    const out: string[] = [];
    if (s.type === 'string') {
      if (s.minLength != null || s.maxLength != null) out.push(`len${s.minLength ?? 0}..${s.maxLength ?? '∞'}`);
      if (s.pattern) out.push(`pattern /${trim(s.pattern, 40)}/`);
      if (s.format) out.push(`format ${s.format}`);
    }
    if (s.type === 'integer' || s.type === 'number') {
      if (s.minimum != null) out.push(`min ${s.minimum}`);
      if (s.maximum != null) out.push(`max ${s.maximum}`);
      if (s.exclusiveMinimum != null) out.push(`> ${s.exclusiveMinimum}`);
      if (s.exclusiveMaximum != null) out.push(`< ${s.exclusiveMaximum}`);
      if (s.multipleOf != null) out.push(`×of ${s.multipleOf}`);
    }
    if (s.const !== undefined) out.push(`const ${JSON.stringify(s.const)}`);
    if (s.enum && s.enum.length) {
      // Show actual enum values (truncate if too many)
      const maxEnumShow = 8;
      if (s.enum.length <= maxEnumShow) {
        out.push(`enum: ${s.enum.map(v => JSON.stringify(v)).join(' | ')}`);
      } else {
        const shown = s.enum.slice(0, maxEnumShow).map(v => JSON.stringify(v)).join(' | ');
        out.push(`enum: ${shown} | ... (+${s.enum.length - maxEnumShow} more)`);
      }
    }
    return out.length ? ` [${out.join('; ')}]` : '';
  }

  function typeLabel(s: AgentMemoryField): string {
    switch (s.type) {
      case 'map':   return 'map';
      case 'array': return 'array';
      case 'topic': return 'topic';
      default:      return s.type;
    }
  }

  function objectPropLine(name: string, s: AgentMemoryField): string {
    if (s.type === 'object')  return `${name}:{object}`;
    if (s.type === 'array')   return `${name}:array<${typeLabel((s as AgentMemoryFieldArray).items)}>`;
    if (s.type === 'map')     return `${name}:map<string, ${typeLabel((s as AgentMemoryFieldMap).values)}>`;
    if (s.type === 'topic')   return `${name}:{topic-node}`;
    // primitive + constraints
    return `${name}:${s.type}${primitiveConstraints(s as any)}`;
  }

  function summarizeObjectSchema(s: AgentMemoryFieldObject, maxProps = 10): { req: string[]; propsLine: string; extrasNote?: string } {
    const req = s.required ?? [];
    const keys = Object.keys(s.properties ?? {});
    const shown: string[] = [];
    const limit = Math.max(1, maxProps);
    for (let i = 0; i < keys.length && i < limit; i++) {
      const k = keys[i];
      shown.push(objectPropLine(k, s.properties[k]));
    }
    const extras = keys.length > limit ? ` … +${keys.length - limit} more` : '';
    const addl = s.additionalProperties === false ? 'no extra props' : undefined;
    return { req, propsLine: shown.join(', ') + extras, extrasNote: addl };
  }

  function exampleValueFor(s: AgentMemoryField, depth = 0): any {
    if (depth > 2) return null;
    switch (s.type) {
      case 'string':  return 'text';
      case 'number':  return 0.0;
      case 'integer': return 0;
      case 'boolean': return true;
      case 'null':    return null;
      case 'array':   return []; // keep minimal
      case 'map':     return {}; // keep minimal
      case 'topic':   return { description: '...', subtopics: {} };
      case 'object': {
        const o: any = {};
        for (const r of (s.required ?? [])) {
          o[r] = exampleValueFor((s.properties ?? {})[r], depth + 1);
        }
        return o;
      }
      default:        return null;
    }
  }

  function eligible(path: string): boolean {
    const p = normalizePath(path);
    const tokens = splitPath(p);
    const parent = joinPath(tokens.slice(0, -1));
    const selfOpen = isOpen(p);
    const parentOpen = parent ? isOpen(parent) : false;
    return selfOpen || parentOpen;
  }

  function pushContainer(path: string, kind: ContKind, schema: any) {
    const p = normalizePath(path);
    const parent = splitPath(p).length ? joinPath(splitPath(p).slice(0, -1)) : null;
    if (eligible(p)) containerSpecs.push({ path: p, kind, schema, parentPath: parent });
  }

  // Walk schema to collect eligible containers (by schema, not values, so we show specs even if empty/missing)
  function walkSchema(s: AgentMemoryField, basePath: string) {
    const p = normalizePath(basePath);
    if (s.type === 'array')       { pushContainer(p, 'array', s as AgentMemoryFieldArray); return; }
    if (s.type === 'map')         { pushContainer(p, 'map',   s as AgentMemoryFieldMap);   return; }
    if (s.type === 'topic')       { pushContainer(p, 'topic', s as AgentMemoryFieldTopic); return; }
    if (s.type === 'object') {
      const props = (s as AgentMemoryFieldObject).properties ?? {};
      for (const k of Object.keys(props)) {
        const childPath = joinPath([...splitPath(p), k]);
        // Only descend if object itself or the child path is visible; otherwise we keep instructions scoped
        if (eligible(childPath)) walkSchema(props[k], childPath);
      }
    }
  }
  for (const f of memoryFields) walkSchema(f, '/' + escapeToken(f.id));

  if (containerSpecs.length) {
    lines.push('');
    lines.push('=== Schema Hints (add/insert/upsert in current scope) ===');

    for (const spec of containerSpecs) {
      if (spec.kind === 'array') {
        const s = spec.schema as AgentMemoryFieldArray;
        const head: string[] = [];
        head.push(`• ${spec.path} — ARRAY of ${typeLabel(s.items)}`);
        const arrMeta: string[] = [];
        if (s.minItems != null) arrMeta.push(`minItems=${s.minItems}`);
        if (s.maxItems != null) arrMeta.push(`maxItems=${s.maxItems}`);
        if (s.uniqueItems)      arrMeta.push(`uniqueItems`);
        if (arrMeta.length) head.push(` (${arrMeta.join(', ')})`);
        lines.push(head.join(''));

        if (s.items.type === 'object') {
          const info = summarizeObjectSchema(s.items as AgentMemoryFieldObject, 12);
          if (info.req.length) lines.push(`  item.required: [${info.req.join(', ')}]`);
          if (info.propsLine)  lines.push(`  item.props: ${info.propsLine}${info.extrasNote ? `; ${info.extrasNote}` : ''}`);
        } else {
          const primC = primitiveConstraints(s.items as any);
          if (primC) lines.push(`  item.constraints:${primC}`);
        }
        // Example add
        const skeleton = exampleValueFor(s.items);
        lines.push(`  e.g. add → manageMemory { "ops":[{ "action":"add","path":"${spec.path}","value": ${JSON.stringify(skeleton)} }] }`);
      }

      if (spec.kind === 'map') {
        const s = spec.schema as AgentMemoryFieldMap;
        const head: string[] = [];
        head.push(`• ${spec.path} — MAP<string, ${typeLabel(s.values)}>`);

        const mMeta: string[] = [];
        if (s.keyPattern)         mMeta.push(`keyPattern=/${trim(s.keyPattern, 40)}/`);
        if (s.minProperties != null) mMeta.push(`minProps=${s.minProperties}`);
        if (s.maxProperties != null) mMeta.push(`maxProps=${s.maxProperties}`);
        if (mMeta.length) head.push(` (${mMeta.join(', ')})`);
        lines.push(head.join(''));

        if (s.values.type === 'object') {
          const info = summarizeObjectSchema(s.values as AgentMemoryFieldObject, 12);
          if (info.req.length) lines.push(`  value.required: [${info.req.join(', ')}]`);
          if (info.propsLine)  lines.push(`  value.props: ${info.propsLine}${info.extrasNote ? `; ${info.extrasNote}` : ''}`);
        } else {
          const primC = primitiveConstraints(s.values as any);
          if (primC) lines.push(`  value.constraints:${primC}`);
        }
        const skeleton = exampleValueFor(s.values);
        lines.push(`  e.g. add → manageMemory { "ops":[{ "action":"add","path":"${spec.path}","key":"<key>","value": ${JSON.stringify(skeleton)} }] }`);
      }

      if (spec.kind === 'topic') {
        const s = spec.schema as AgentMemoryFieldTopic;
        const tMeta: string[] = [];
        if (s.maxDepth != null)          tMeta.push(`maxDepth=${s.maxDepth}`);
        if (s.maxBreadthPerNode != null) tMeta.push(`maxBreadthPerNode=${s.maxBreadthPerNode}`);
        lines.push(`• ${spec.path} — TOPIC nodes { description?: string, subtopics: map<string,TopicNode> }${tMeta.length ? ' ('+tMeta.join(', ')+')' : ''}`);
        lines.push(`  e.g. add subtopic → manageMemory { "ops":[{ "action":"add","path":"${spec.path}","key":"NewNode","value":"optional description" }] }`);
      }
    }

    lines.push('');
    lines.push('Notes:');
    lines.push('- When item/value is an OBJECT, include all listed "required" keys when creating it.');
    lines.push('- Arrays/maps may enforce limits (uniqueItems, min/max counts) and map keys may have regex constraints.');
    lines.push('- For topics, "value" may be a string (description) or a full node {description?, subtopics?}.');
  }

  return lines.join('\n');
}

/* ------------------------------
 * processMemoryToolResponse(...)
 * ------------------------------ */

export function processMemoryToolResponse(
  memoryFields: AgentMemoryField[],
  memoryValues: any,
  memoryState: MemoryState | undefined,
  input: MemoryToolCallInput
): MemoryToolResponseProcessed {
  const state = ensureState(memoryState);
  const values = memoryValues ?? {};
  const results: MemoryOperationResult[] = [];

  // Normalize to a batch of ops; tolerate old single-op shape when called directly from app code
  const batch: MemoryToolInput[] = Array.isArray((input as any)?.ops)
    ? (input as any).ops
    : Array.isArray((input as any)?.operations)
      ? (input as any).operations
      : [input as MemoryToolInput];

  // Helpers that do not depend on a single op
  const isMutating = (a: MemoryAction) =>
    a === 'set' || a === 'upsert' || a === 'add' || a === 'insert' || a === 'delete' || a === 'clear' || a === 'rename';

  function checkVisibleForMutation(target: string): string | undefined {
    if (pathIsVisible(state, target) || parentIsVisible(state, target)) return undefined;
    return `Target '${target}' is not visible; add a 'view' op first.`;
  }

  function requireResolved(path: string): { leaf?: SchemaStep; error?: string } {
    const r = resolveSchemaPath(memoryFields, path);
    if (r.error) return { error: r.error };
    return { leaf: r.leaf! };
  }

  function checkTopicBounds(field: AgentMemoryFieldTopic, nodePath: string[], newSiblingCount?: number): string | undefined {
    if (field.maxDepth != null && topicDepth(nodePath) > field.maxDepth) {
      return `Topic depth limit ${field.maxDepth} exceeded.`;
    }
    if (newSiblingCount != null && field.maxBreadthPerNode != null && newSiblingCount > field.maxBreadthPerNode) {
      return `Topic breadth per node limit ${field.maxBreadthPerNode} exceeded.`;
    }
    return undefined;
  }

  // Process one op at a time (mutations update state/values for subsequent ops)
  batch.forEach((op, opIndex) => {
    const action = op.action;
    if (!action) {
      results.push({ target: '', action: 'view', ok: false, message: 'Missing action in op.', mutatedPaths: [], newPath: undefined });
      return;
    }

    // Resolve targets based on 'path' or 'paths'
    const rawTargets: string[] = (Array.isArray(op.paths) && (action === 'view' || action === 'hide'))
      ? op.paths.map(normalizePath)
      : (op.path ? [normalizePath(op.path)] : []);

    if (!rawTargets.length) {
      if (action === 'view' || action === 'hide') {
        results.push({ target: '', action, ok: false, message: "Provide 'path' or 'paths' for view/hide." });
      } else {
        results.push({ target: '', action, ok: false, message: "Provide 'path' for this action." });
      }
      return;
    }

    // Disallow wildcard for mutations
    if (isMutating(action)) {
      for (const t of rawTargets) {
        if (hasTrailingWildcard(t)) {
          results.push({ target: t, action, ok: false, message: "Wildcards are only allowed for 'view'/'hide'." });
          return;
        }
      }
    }

    // VIEW / HIDE (supports wildcard on last segment and multi-targets)
    if (action === 'view' || action === 'hide') {
      const allExpanded: string[] = [];
      for (const t of rawTargets) {
        if (hasTrailingWildcard(t)) {
          const { paths, error } = expandWildcardOnce(memoryFields, values, t);
          if (error) {
            results.push({ target: t, action, ok: false, message: error });
            continue;
          }
          allExpanded.push(...paths);
        } else {
          allExpanded.push(t);
        }
      }

      if (action === 'view') {
          const mutated: string[] = [];
          for (const p of allExpanded) {
            const { leaf, error } = requireResolved(p);
            if (error) { results.push({ target: p, action, ok: false, message: error }); continue; }
            openPath(state, p);
        
            // Default: open immediate children when the viewed target is a CONTAINER node (object/array/map/topic).
            let openKids = op.openChildren;
            if (openKids == null) {
              let nodeType: MemoryType | 'topic-description' | 'topic-subtopics' | undefined;
              switch (leaf?.kind) {
                case 'field':           nodeType = (leaf.schema as AgentMemoryField).type; break;
                case 'objectProp':      nodeType = (leaf.propSchema as AgentMemoryField).type; break;
                case 'arrayItem':       nodeType = (leaf.itemSchema as AgentMemoryField).type; break;
                case 'mapValue':        nodeType = (leaf.valueSchema as AgentMemoryField).type; break;
                case 'topic':           nodeType = 'topic'; break;
                case 'topicSubtopics':  nodeType = 'topic'; break;
                case 'topicDescription':nodeType = 'topic-description'; break;
              }
              openKids = (nodeType === 'object' || nodeType === 'array' || nodeType === 'map' || nodeType === 'topic');
            }
            if (openKids) openChildren(state, values, p);
        
            if (op.page) setPagination(state, p, op.page.offset, op.page.limit);
            mutated.push(p);
          }
          // Also return a rendering of the recalled item(s), matching the full memory visualization style.
          let message: string | undefined;
          if (RETURN_VIEW_DATA){
            // Decide which sections to render:
            // - If a target used a trailing wildcard (e.g., "/foo/*"), render the parent container once.
            // - Otherwise render the explicit paths.
            const displayRoots = new Set<string>();
            for (const t of rawTargets) {
              if (hasTrailingWildcard(t)) {
                const toks = splitPath(t);
                const base = joinPath(toks.slice(0, -1));
                displayRoots.add(base);
              } else {
                displayRoots.add(normalizePath(t));
              }
            }
            let message: string | undefined;
            try {
              const rendered = renderMemoryVisualization(memoryFields, values, state, {
                onlyRenderPaths: Array.from(displayRoots),
                suppressHeader: true,
              });
              if (rendered && rendered.trim()) message = rendered;
            } catch { message = "Data added to instructions." }
          } else {
            message = "Data added to instructions.";
          }
          results.push({ target: rawTargets.join(','), action, ok: true, mutatedPaths: mutated, ...(message ? { message } : {}) });
        } else {
        const mutated: string[] = [];
        for (const p of allExpanded) {
          closePathAndDescendants(state, p);
          mutated.push(p);
        }
        results.push({ target: rawTargets.join(','), action, ok: true, mutatedPaths: mutated });
      }
      return;
    }

    // Mutations from this point onward — enforce visibility per target
    for (const rawTarget of rawTargets) {
      if (REQUIRE_VISIBLE_TO_UPDATE){
        const perm = checkVisibleForMutation(rawTarget);
        if (perm) { results.push({ target: rawTarget, action, ok: false, message: perm }); continue; }
      }

      const { leaf, error } = requireResolved(rawTarget);
      if (error || !leaf) { results.push({ target: rawTarget, action, ok: false, message: error ?? 'Unresolvable path.' }); continue; }

      function autoOpenIfObject(schema: AgentMemoryField, atPath: string) {
        if (schema.type === 'object' || schema.type === 'array' || schema.type === 'map' || schema.type === 'topic') {
          openPath(state, atPath);
        }
      }

      // -- set / upsert
      if (action === 'set' || action === 'upsert') {
        if (op.value === undefined) {
          results.push({ target: rawTarget, action, ok: false, message: `Missing 'value'.` });
          continue;
        }

        if (leaf.kind === 'field') {
          const schema = leaf.schema;
          const errs = validateAgainstSchema(schema, op.value, rawTarget);
          if (errs.length) { results.push({ target: rawTarget, action, ok: false, message: errs.join(' ') }); continue; }
          const s = setAtPath(values, rawTarget, op.value);
          if (!s.ok) { results.push({ target: rawTarget, action, ok: false, message: s.message }); continue; }
          autoOpenIfObject(schema, rawTarget);
          results.push({ target: rawTarget, action, ok: true });
          continue;
        }

        if (leaf.kind === 'objectProp') {
          const schema = leaf.propSchema;
          const errs = validateAgainstSchema(schema, op.value, rawTarget);
          if (errs.length) { results.push({ target: rawTarget, action, ok: false, message: errs.join(' ') }); continue; }

          const objPath = joinPath(splitPath(rawTarget).slice(0, -1));
          const objValue = getAtPath(values, objPath);
          // If parent object is missing, optionally auto-create it when allowed by schema requirements
          if (objValue == null) {
            const parentSchema = leaf.schema; // this is the OBJECT schema that owns the prop
            const req = parentSchema.required ?? [];
            const canAutoCreate = req.length === 0 || (req.length === 1 && req[0] === leaf.propName);
            if (canAutoCreate) {
              const seedObj: any = {};
              seedObj[leaf.propName] = op.value;
              const setObjRes = setAtPath(values, objPath, seedObj);
              if (!setObjRes.ok) { results.push({ target: rawTarget, action, ok: false, message: setObjRes.message }); continue; }
              autoOpenIfObject(parentSchema, objPath);
              autoOpenIfObject(schema, rawTarget);
              results.push({ target: rawTarget, action, ok: true, message: `Auto-created '${objPath}' and set '${leaf.propName}'.` });
              continue;
            } else {
              const hint = req.length ? ` Include required: ${req.map(r => JSON.stringify(r)).join(', ')}.` : '';
              results.push({
                target: rawTarget,
                action,
                ok: false,
                message: `Parent object '${objPath}' does not exist. Set it first with a full object at '${objPath}'.${hint}`
              });
              continue;
            }
          } else if (typeof objValue !== 'object' || Array.isArray(objValue)) {
            results.push({ target: rawTarget, action, ok: false, message: `Parent at '${objPath}' is not an object.` });
            continue;
          }

          const setRes = setAtPath(values, rawTarget, op.value);
          if (!setRes.ok) { results.push({ target: rawTarget, action, ok: false, message: setRes.message }); continue; }
          autoOpenIfObject(schema, rawTarget);
          results.push({ target: rawTarget, action, ok: true });
          continue;
        }

        if (leaf.kind === 'arrayItem') {
          const arrPath = joinPath(splitPath(rawTarget).slice(0, -1));
          const container = getAtPath(values, arrPath);
          if (!Array.isArray(container)) { results.push({ target: rawTarget, action, ok: false, message: 'Array container not found.' }); continue; }
          const schema = leaf.itemSchema;
          const errs = validateAgainstSchema(schema, op.value, rawTarget);
          if (errs.length) { results.push({ target: rawTarget, action, ok: false, message: errs.join(' ') }); continue; }
          const idx = leaf.index;
          if (action === 'upsert') {
            if (idx < 0 || idx > container.length) { results.push({ target: rawTarget, action, ok: false, message: 'Index out of bounds for upsert.' }); continue; }
            if (idx === container.length) container.push(op.value); else container[idx] = op.value;
          } else {
            if (idx < 0 || idx >= container.length) { results.push({ target: rawTarget, action, ok: false, message: 'Index out of bounds.' }); continue; }
            container[idx] = op.value;
          }
          autoOpenIfObject(schema, rawTarget);
          results.push({ target: rawTarget, action, ok: true });
          continue;
        }

        if (leaf.kind === 'mapValue') {
          const contPath = joinPath(splitPath(rawTarget).slice(0, -1));
          const container = getAtPath(values, contPath);
          if (!container || typeof container !== 'object' || Array.isArray(container)) {
            results.push({ target: rawTarget, action, ok: false, message: 'Map container not found.' }); continue;
          }
          const schema = leaf.valueSchema;
          const mapSchema = leaf.schema;
          if (mapSchema.keyPattern) {
            const re = new RegExp(mapSchema.keyPattern);
            if (!re.test(leaf.key)) { results.push({ target: rawTarget, action, ok: false, message: `Key '${leaf.key}' violates keyPattern.` }); continue; }
          }
          const errs = validateAgainstSchema(schema, op.value, rawTarget);
          if (errs.length) { results.push({ target: rawTarget, action, ok: false, message: errs.join(' ') }); continue; }
          container[leaf.key] = op.value;
          autoOpenIfObject(schema, rawTarget);
          results.push({ target: rawTarget, action, ok: true });
          continue;
        }

        if (leaf.kind === 'topicDescription') {
          if (!(typeof op.value === 'string' || op.value === null)) {
            results.push({ target: rawTarget, action, ok: false, message: `Topic description must be string or null.` }); continue;
          }
          const fieldId = splitPath(rawTarget)[0];
          const tree = values[fieldId] ?? (values[fieldId] = {});
          const nodePath = leaf.nodePath;
          if (!nodePath.length) { results.push({ target: rawTarget, action, ok: false, message: 'Set description on a specific node path.' }); continue; }
          const node = ensureTopicNode(tree, nodePath)!;
          node.description = op.value ?? undefined;
          openPath(state, joinPath([fieldId, ...nodePath]));
          results.push({ target: rawTarget, action, ok: true });
          continue;
        }

        if (leaf.kind === 'topic') {
          if (typeof op.value !== 'object' || Array.isArray(op.value)) {
            results.push({ target: rawTarget, action, ok: false, message: `Topic node value must be an object {description?, subtopics?}.` }); continue;
          }
          const fieldId = splitPath(rawTarget)[0];
          const topicField = leaf.schema;
          const nodePath = leaf.nodePath;
          if (!nodePath.length) { results.push({ target: rawTarget, action, ok: false, message: 'Set a concrete node path, not the topic root.' }); continue; }
          const tree: TopicTree = values[fieldId] ?? (values[fieldId] = {});
          const errb = checkTopicBounds(topicField, nodePath);
          if (errb) { results.push({ target: rawTarget, action, ok: false, message: errb }); continue; }
          const parentPath = nodePath.slice(0, -1);
          const nodeName = last(nodePath)!;
          if (!parentPath.length) {
            tree[nodeName] = { description: op.value?.description, subtopics: op.value?.subtopics ?? {} };
          } else {
            const parent = ensureTopicNode(tree, parentPath)!;
            parent.subtopics[nodeName] = { description: op.value?.description, subtopics: op.value?.subtopics ?? {} };
          }
          openPath(state, joinPath([fieldId, ...nodePath]));
          results.push({ target: rawTarget, action, ok: true });
          continue;
        }

        results.push({ target: rawTarget, action, ok: false, message: 'Unsupported set/upsert target.' });
        continue;
      }

      // -- add (array/map/topic root or node)
      if (action === 'add') {
        const { leaf: contLeaf, error: e2 } = requireResolved(rawTarget);
        if (e2 || !contLeaf) { results.push({ target: rawTarget, action, ok: false, message: e2 ?? 'Container not found.' }); continue; }

        if (contLeaf.kind === 'field' && contLeaf.schema.type === 'array') {
          const arr = values[contLeaf.fieldId] ?? (values[contLeaf.fieldId] = []);
          if (!Array.isArray(arr)) { results.push({ target: rawTarget, action, ok: false, message: 'Array container not found.' }); continue; }
          const s = contLeaf.schema as AgentMemoryFieldArray;
          if (op.value === undefined) { results.push({ target: rawTarget, action, ok: false, message: 'add to array requires value.' }); continue; }
          const errs = validateAgainstSchema(s.items, op.value, rawTarget + '/<new>');
          if (errs.length) { results.push({ target: rawTarget, action, ok: false, message: errs.join(' ') }); continue; }
          if (s.maxItems != null && arr.length + 1 > s.maxItems) { results.push({ target: rawTarget, action, ok: false, message: `maxItems ${s.maxItems} exceeded.` }); continue; }
          if (s.uniqueItems) {
            const sv = JSON.stringify(op.value);
            if (arr.some((x: any) => JSON.stringify(x) === sv)) { results.push({ target: rawTarget, action, ok: false, message: 'uniqueItems violated.' }); continue; }
          }
          arr.push(op.value);
          autoOpenIfObject(s.items, joinPath([...splitPath(rawTarget), String(arr.length - 1)]));
          results.push({ target: rawTarget, action, ok: true });
          continue;
        }

        if (contLeaf.kind === 'field' && contLeaf.schema.type === 'map') {
          const map = values[contLeaf.fieldId] ?? (values[contLeaf.fieldId] = {});
          const s = contLeaf.schema as AgentMemoryFieldMap;
          const key = op.key;
          if (!key) { results.push({ target: rawTarget, action, ok: false, message: 'add to map requires key.' }); continue; }
          if (s.keyPattern && !new RegExp(s.keyPattern).test(key)) { results.push({ target: rawTarget, action, ok: false, message: 'keyPattern violation.' }); continue; }
          if (map[key] !== undefined) { results.push({ target: rawTarget, action, ok: false, message: 'Key already exists.' }); continue; }
          const val = op.value;
          const errs = validateAgainstSchema(s.values, val, rawTarget + '/' + key);
          if (errs.length) { results.push({ target: rawTarget, action, ok: false, message: errs.join(' ') }); continue; }
          if (s.maxProperties != null && Object.keys(map).length + 1 > s.maxProperties) { results.push({ target: rawTarget, action, ok: false, message: `maxProperties ${s.maxProperties} exceeded.` }); continue; }
          map[key] = val;
          autoOpenIfObject(s.values, joinPath([...splitPath(rawTarget), key]));
          results.push({ target: rawTarget, action, ok: true });
          continue;
        }

        if (contLeaf.kind === 'field' && contLeaf.schema.type === 'topic') {
          const tree: TopicTree = values[contLeaf.fieldId] ?? (values[contLeaf.fieldId] = {});
          const key = op.key;
          if (!key) { results.push({ target: rawTarget, action, ok: false, message: 'add to topic requires key.' }); continue; }
          const s = contLeaf.schema as AgentMemoryFieldTopic;
          const errb = checkTopicBounds(s, [key], Object.keys(tree).length + 1);
          if (errb) { results.push({ target: rawTarget, action, ok: false, message: errb }); continue; }
          if (tree[key]) { results.push({ target: rawTarget, action, ok: false, message: 'Subtopic already exists.' }); continue; }
          const nodeVal = typeof op.value === 'string' ? { description: op.value } : (op.value ?? {});
          tree[key] = { description: nodeVal.description, subtopics: nodeVal.subtopics ?? {} };
          openPath(state, joinPath([contLeaf.fieldId, key]));
          results.push({ target: joinPath([contLeaf.fieldId, key]), action, ok: true });
          continue;
        }

        if (contLeaf.kind === 'topic') {
          const fieldId = splitPath(rawTarget)[0];
          const s = contLeaf.schema;
          const tree: TopicTree = values[fieldId] ?? (values[fieldId] = {});
          const nodePath = contLeaf.nodePath;
          const parent = nodePath.length ? ensureTopicNode(tree, nodePath)! : undefined;
          const key = op.key;
          if (!key) { results.push({ target: rawTarget, action, ok: false, message: 'add to subtopics requires key.' }); continue; }
          const errb = checkTopicBounds(s, [...nodePath, key], parent ? topicBreadth(parent) + 1 : Object.keys(tree).length + 1);
          if (errb) { results.push({ target: rawTarget, action, ok: false, message: errb }); continue; }
          if (parent) {
            if (parent.subtopics[key]) { results.push({ target: rawTarget, action, ok: false, message: 'Subtopic already exists.' }); continue; }
            const nodeVal = typeof op.value === 'string' ? { description: op.value } : (op.value ?? {});
            parent.subtopics[key] = { description: nodeVal.description, subtopics: nodeVal.subtopics ?? {} };
          } else {
            if (tree[key]) { results.push({ target: rawTarget, action, ok: false, message: 'Subtopic already exists.' }); continue; }
            const nodeVal = typeof op.value === 'string' ? { description: op.value } : (op.value ?? {});
            tree[key] = { description: nodeVal.description, subtopics: nodeVal.subtopics ?? {} };
          }
          openPath(state, joinPath([fieldId, ...nodePath, key]));
          results.push({ target: joinPath([fieldId, ...nodePath, key]), action, ok: true });
          continue;
        }

        // Handle arrays nested inside objects (objectProp with array type)
        if (contLeaf.kind === 'objectProp' && contLeaf.propSchema.type === 'array') {
          const tokens = splitPath(rawTarget);
          const parentPath = joinPath(tokens.slice(0, -1));
          const propName = tokens[tokens.length - 1];
          
          // Get or create parent object
          let parentValue = parentPath === ROOT ? values : getAtPath(values, parentPath);
          if (parentValue == null || typeof parentValue !== 'object' || Array.isArray(parentValue)) {
            results.push({ target: rawTarget, action, ok: false, message: `Parent object not found at '${parentPath}'.` }); 
            continue;
          }
          
          // Get or create the array
          const arr = parentValue[propName] ?? (parentValue[propName] = []);
          if (!Array.isArray(arr)) { 
            results.push({ target: rawTarget, action, ok: false, message: 'Expected array but found non-array.' }); 
            continue; 
          }
          
          const s = contLeaf.propSchema as AgentMemoryFieldArray;
          if (op.value === undefined) { 
            results.push({ target: rawTarget, action, ok: false, message: 'add to array requires value.' }); 
            continue; 
          }
          const errs = validateAgainstSchema(s.items, op.value, rawTarget + '/<new>');
          if (errs.length) { 
            results.push({ target: rawTarget, action, ok: false, message: errs.join(' ') }); 
            continue; 
          }
          if (s.maxItems != null && arr.length + 1 > s.maxItems) { 
            results.push({ target: rawTarget, action, ok: false, message: `maxItems ${s.maxItems} exceeded.` }); 
            continue; 
          }
          if (s.uniqueItems) {
            const sv = JSON.stringify(op.value);
            if (arr.some((x: any) => JSON.stringify(x) === sv)) { 
              results.push({ target: rawTarget, action, ok: false, message: 'uniqueItems violated.' }); 
              continue; 
            }
          }
          arr.push(op.value);
          autoOpenIfObject(s.items, joinPath([...tokens, String(arr.length - 1)]));
          results.push({ target: rawTarget, action, ok: true });
          continue;
        }

        // Handle maps nested inside objects (objectProp with map type)
        if (contLeaf.kind === 'objectProp' && contLeaf.propSchema.type === 'map') {
          const tokens = splitPath(rawTarget);
          const parentPath = joinPath(tokens.slice(0, -1));
          const propName = tokens[tokens.length - 1];
          
          let parentValue = parentPath === ROOT ? values : getAtPath(values, parentPath);
          if (parentValue == null || typeof parentValue !== 'object' || Array.isArray(parentValue)) {
            results.push({ target: rawTarget, action, ok: false, message: `Parent object not found at '${parentPath}'.` }); 
            continue;
          }
          
          const map = parentValue[propName] ?? (parentValue[propName] = {});
          const s = contLeaf.propSchema as AgentMemoryFieldMap;
          const key = op.key;
          if (!key) { 
            results.push({ target: rawTarget, action, ok: false, message: 'add to map requires key.' }); 
            continue; 
          }
          if (s.keyPattern && !new RegExp(s.keyPattern).test(key)) { 
            results.push({ target: rawTarget, action, ok: false, message: 'keyPattern violation.' }); 
            continue; 
          }
          if (map[key] !== undefined) { 
            results.push({ target: rawTarget, action, ok: false, message: 'Key already exists.' }); 
            continue; 
          }
          const val = op.value;
          const errs = validateAgainstSchema(s.values, val, rawTarget + '/' + key);
          if (errs.length) { 
            results.push({ target: rawTarget, action, ok: false, message: errs.join(' ') }); 
            continue; 
          }
          if (s.maxProperties != null && Object.keys(map).length + 1 > s.maxProperties) { 
            results.push({ target: rawTarget, action, ok: false, message: `maxProperties ${s.maxProperties} exceeded.` }); 
            continue; 
          }
          map[key] = val;
          autoOpenIfObject(s.values, joinPath([...tokens, key]));
          results.push({ target: rawTarget, action, ok: true });
          continue;
        }

        console.log('ADD unsupported container kind:', contLeaf);
        results.push({ target: rawTarget, action, ok: false, message: 'Container not addable.' });
        continue;
      }

      // -- insert (array only)
      if (action === 'insert') {
        const idx = op.index;
        if (idx == null) { results.push({ target: rawTarget, action, ok: false, message: 'insert requires index.' }); continue; }
        if (op.value === undefined) { results.push({ target: rawTarget, action, ok: false, message: 'insert requires value.' }); continue; }
        const { leaf: contLeaf, error: e3 } = requireResolved(rawTarget);
        if (e3 || !contLeaf) { results.push({ target: rawTarget, action, ok: false, message: e3 ?? 'Array container not found.' }); continue; }
        if (!(contLeaf.kind === 'field' && contLeaf.schema.type === 'array')) { results.push({ target: rawTarget, action, ok: false, message: 'insert only works on arrays (path must be the array).' }); continue; }
        const arr = values[contLeaf.fieldId] ?? (values[contLeaf.fieldId] = []);
        if (!Array.isArray(arr)) { results.push({ target: rawTarget, action, ok: false, message: 'Array container missing.' }); continue; }
        const s = contLeaf.schema as AgentMemoryFieldArray;
        if (idx < 0 || idx > arr.length) { results.push({ target: rawTarget, action, ok: false, message: 'Index out of bounds.' }); continue; }
        const errs = validateAgainstSchema(s.items, op.value, rawTarget + '/' + idx);
        if (errs.length) { results.push({ target: rawTarget, action, ok: false, message: errs.join(' ') }); continue; }
        if (s.maxItems != null && arr.length + 1 > s.maxItems) { results.push({ target: rawTarget, action, ok: false, message: `maxItems ${s.maxItems} exceeded.` }); continue; }
        arr.splice(idx, 0, op.value);
        autoOpenIfObject(s.items, joinPath([...splitPath(rawTarget), String(idx)]));
        results.push({ target: rawTarget, action, ok: true });
        continue;
      }

      // -- delete
      if (action === 'delete') {
        if (leaf.kind === 'objectProp') {
          const req = new Set(leaf.schema.required ?? []);
          if (req.has(leaf.propName)) { results.push({ target: rawTarget, action, ok: false, message: `Cannot delete required property '${leaf.propName}'.` }); continue; }
          const r = deleteAtPath(values, rawTarget);
          if (!r.ok) { results.push({ target: rawTarget, action, ok: false, message: r.message }); continue; }
          closePathAndDescendants(state, rawTarget);
          results.push({ target: rawTarget, action, ok: true });
          continue;
        }
        if (leaf.kind === 'arrayItem' || leaf.kind === 'mapValue' || leaf.kind === 'field') {
          const r = deleteAtPath(values, rawTarget);
          if (!r.ok) { results.push({ target: rawTarget, action, ok: false, message: r.message }); continue; }
          closePathAndDescendants(state, rawTarget);
          results.push({ target: rawTarget, action, ok: true });
          continue;
        }
        if (leaf.kind === 'topic') {
          const fieldId = splitPath(rawTarget)[0];
          const tree: TopicTree = values[fieldId] ?? (values[fieldId] = {});
          const nodePath = leaf.nodePath;
          if (!nodePath.length) { results.push({ target: rawTarget, action, ok: false, message: 'Cannot delete the topic root.' }); continue; }
          const parentPath = nodePath.slice(0, -1);
          const nodeName = last(nodePath)!;
          if (!parentPath.length) {
            if (!tree[nodeName]) { results.push({ target: rawTarget, action, ok: false, message: 'Node does not exist.' }); continue; }
            delete tree[nodeName];
          } else {
            const parent = getTopicNode(tree, parentPath);
            if (!parent || !parent.subtopics[nodeName]) { results.push({ target: rawTarget, action, ok: false, message: 'Node does not exist.' }); continue; }
            delete parent.subtopics[nodeName];
          }
          closePathAndDescendants(state, rawTarget);
          results.push({ target: rawTarget, action, ok: true });
          continue;
        }
        if (leaf.kind === 'topicDescription') {
          const fieldId = splitPath(rawTarget)[0];
          const tree: TopicTree = values[fieldId] ?? (values[fieldId] = {});
          const node = ensureTopicNode(tree, leaf.nodePath)!;
          node.description = undefined;
          results.push({ target: rawTarget, action, ok: true });
          continue;
        }
        results.push({ target: rawTarget, action, ok: false, message: 'Unsupported delete target.' });
        continue;
      }

      // -- clear
      if (action === 'clear') {
        const { leaf: contLeaf, error: e4 } = requireResolved(rawTarget);
        if (e4 || !contLeaf) { results.push({ target: rawTarget, action, ok: false, message: e4 ?? 'Container not found.' }); continue; }
        if (contLeaf.kind === 'field' && contLeaf.schema.type === 'array') {
          const arr = values[contLeaf.fieldId] ?? (values[contLeaf.fieldId] = []);
          if (Array.isArray(arr)) arr.length = 0;
          closePathAndDescendants(state, rawTarget);
          openPath(state, rawTarget);
          results.push({ target: rawTarget, action, ok: true });
          continue;
        }
        if (contLeaf.kind === 'field' && contLeaf.schema.type === 'map') {
          const map = values[contLeaf.fieldId] ?? (values[contLeaf.fieldId] = {});
          for (const k of Object.keys(map)) delete map[k];
          closePathAndDescendants(state, rawTarget);
          openPath(state, rawTarget);
          results.push({ target: rawTarget, action, ok: true });
          continue;
        }
        if (contLeaf.kind === 'field' && contLeaf.schema.type === 'topic') {
          const tree: TopicTree = values[contLeaf.fieldId] ?? (values[contLeaf.fieldId] = {});
          for (const k of Object.keys(tree)) delete tree[k];
          closePathAndDescendants(state, rawTarget);
          openPath(state, rawTarget);
          results.push({ target: rawTarget, action, ok: true });
          continue;
        }
        if (contLeaf.kind === 'topic') {
          const fieldId = splitPath(rawTarget)[0];
          const tree: TopicTree = values[fieldId] ?? (values[fieldId] = {});
          const node = ensureTopicNode(tree, contLeaf.nodePath)!;
          node.subtopics = {};
          closePathAndDescendants(state, rawTarget);
          openPath(state, rawTarget);
          results.push({ target: rawTarget, action, ok: true });
          continue;
        }
        results.push({ target: rawTarget, action, ok: false, message: 'clear is only for array/map/topic containers.' });
        continue;
      }

      // -- rename
      if (action === 'rename') {
        if (leaf.kind === 'mapValue') {
          const contPath = joinPath(splitPath(rawTarget).slice(0, -1));
          const newKey = op.newKey?.trim();
          if (!newKey) { results.push({ target: rawTarget, action, ok: false, message: 'rename requires newKey.' }); continue; }
          const mapSchema = leaf.schema;
          if (mapSchema.keyPattern && !new RegExp(mapSchema.keyPattern).test(newKey)) { results.push({ target: rawTarget, action, ok: false, message: 'newKey violates keyPattern.' }); continue; }
          const r = renameKeyAtPath(values, contPath, leaf.key, newKey);
          if (!r.ok) { results.push({ target: rawTarget, action, ok: false, message: r.message }); continue; }
          closePathAndDescendants(state, rawTarget);
          const np = joinPath([...splitPath(contPath), newKey]);
          openPath(state, np);
          results.push({ target: rawTarget, action, ok: true, newPath: np });
          continue;
        }
        if (leaf.kind === 'topic') {
          const fieldId = splitPath(rawTarget)[0];
          const newKey = op.newKey?.trim();
          if (!newKey) { results.push({ target: rawTarget, action, ok: false, message: 'rename requires newKey.' }); continue; }
          const tree: TopicTree = values[fieldId] ?? (values[fieldId] = {});
          const nodePath = leaf.nodePath;
          if (!nodePath.length) { results.push({ target: rawTarget, action, ok: false, message: 'Cannot rename the topic root.' }); continue; }
          const parentPath = nodePath.slice(0, -1);
          const oldKey = last(nodePath)!;
          if (!parentPath.length) {
            if (!(oldKey in tree)) { results.push({ target: rawTarget, action, ok: false, message: 'Node not found.' }); continue; }
            if (newKey in tree) { results.push({ target: rawTarget, action, ok: false, message: 'newKey already exists.' }); continue; }
            tree[newKey] = tree[oldKey];
            delete tree[oldKey];
          } else {
            const parent = ensureTopicNode(tree, parentPath)!;
            if (!(oldKey in parent.subtopics)) { results.push({ target: rawTarget, action, ok: false, message: 'Node not found.' }); continue; }
            if (newKey in parent.subtopics) { results.push({ target: rawTarget, action, ok: false, message: 'newKey already exists.' }); continue; }
            parent.subtopics[newKey] = parent.subtopics[oldKey];
            delete parent.subtopics[oldKey];
          }
          const np = joinPath([fieldId, ...parentPath, newKey]);
          closePathAndDescendants(state, rawTarget);
          openPath(state, np);
          results.push({ target: rawTarget, action, ok: true, newPath: np });
          continue;
        }
        results.push({ target: rawTarget, action, ok: false, message: 'rename works on map values or topic nodes only.' });
        continue;
      }

      // default
      results.push({ target: rawTarget, action, ok: false, message: `Unsupported action '${action}'.` });
    }
  });

  return {
    updatedMemoryValues: values,
    updatedMemoryState: state,
    results
  };
}