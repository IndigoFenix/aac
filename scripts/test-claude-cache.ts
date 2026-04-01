/**
 * Test: does tool_choice affect caching?
 * Run with: npx tsx scripts/test-claude-cache.ts
 */

import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
dotenv.config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a helpful assistant.\n${Array(100).fill("AAC encompasses all forms of communication other than oral speech used to express thoughts, needs, wants, and ideas. People with severe speech or language problems rely on AAC.").join("\n")}`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "manageMemory",
    description: "Manage memory",
    input_schema: {
      type: "object" as const,
      properties: { ops: { type: "array", items: { type: "object", properties: { action: { type: "string" }, path: { type: "string" } }, required: ["action", "path"] } } },
      required: ["ops"],
    },
  },
];

async function test() {
  console.log(`System prompt: ~${SYSTEM_PROMPT.length} chars\n`);

  // Test A: tools + tool_choice any
  console.log("=== A: tools + tool_choice: any ===");
  for (let i = 0; i < 3; i++) {
    const r = await client.messages.create({
      model: "claude-haiku-4-5-20251001", max_tokens: 50,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: TOOLS, tool_choice: { type: "any" },
      messages: [{ role: "user", content: `Say hello ${i}` }],
    });
    const u = r.usage as any;
    console.log(`  ${i+1}: input=${u.input_tokens} created=${u.cache_creation_input_tokens??0} read=${u.cache_read_input_tokens??0}`);
  }

  // Test B: tools + tool_choice auto
  console.log("\n=== B: tools + tool_choice: auto ===");
  for (let i = 0; i < 3; i++) {
    const r = await client.messages.create({
      model: "claude-haiku-4-5-20251001", max_tokens: 50,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: TOOLS, tool_choice: { type: "auto" },
      messages: [{ role: "user", content: `Say hello ${i}` }],
    });
    const u = r.usage as any;
    console.log(`  ${i+1}: input=${u.input_tokens} created=${u.cache_creation_input_tokens??0} read=${u.cache_read_input_tokens??0}`);
  }

  // Test C: tools + NO tool_choice
  console.log("\n=== C: tools + no tool_choice ===");
  for (let i = 0; i < 3; i++) {
    const r = await client.messages.create({
      model: "claude-haiku-4-5-20251001", max_tokens: 50,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      messages: [{ role: "user", content: `Say hello ${i}` }],
    });
    const u = r.usage as any;
    console.log(`  ${i+1}: input=${u.input_tokens} created=${u.cache_creation_input_tokens??0} read=${u.cache_read_input_tokens??0}`);
  }

  // Test D: NO tools at all
  console.log("\n=== D: no tools ===");
  for (let i = 0; i < 3; i++) {
    const r = await client.messages.create({
      model: "claude-haiku-4-5-20251001", max_tokens: 50,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `Say hello ${i}` }],
    });
    const u = r.usage as any;
    console.log(`  ${i+1}: input=${u.input_tokens} created=${u.cache_creation_input_tokens??0} read=${u.cache_read_input_tokens??0}`);
  }
}

test().catch(console.error);
