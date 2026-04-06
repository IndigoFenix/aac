/**
 * Test caching at exactly the app's token count (~4265 tokens).
 */
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
dotenv.config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Aim for ~4200-4300 tokens (similar to app's 4265)
const SYSTEM_PROMPT = `You are a helpful assistant.\n\n${Array(80).fill("The quick brown fox jumps over the lazy dog. This sentence contains every letter of the English alphabet and is commonly used as a pangram for testing fonts and keyboards. It has been used since at least the late 19th century.").join("\n\n")}\n\nRemember to be concise.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "manageMemory",
    description: "Manage memory operations. Use this to store and retrieve data.",
    input_schema: {
      type: "object" as const,
      properties: { ops: { type: "array", items: { type: "object", properties: { action: { type: "string", enum: ["view", "set", "add", "delete", "hide", "clear"] }, path: { type: "string" }, value: {}, key: { type: "string" }, paths: { type: "array", items: { type: "string" } }, page: { type: "object", properties: { offset: { type: "number" }, limit: { type: "number" } } } }, required: ["action", "path"] } } },
      required: ["ops"],
    },
  },
  {
    name: "pruneMessages",
    description: "Remove old messages from conversation history",
    input_schema: {
      type: "object" as const,
      properties: { indices: { type: "array", items: { type: "number" } }, summary: { type: "string" } },
      required: ["indices"],
    },
  },
];

async function main() {
  // First check token count
  const r0 = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 10,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: TOOLS,
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: "hi" }],
  });
  const u0 = r0.usage as any;
  console.log(`Total tokens: input=${u0.input_tokens} creation=${u0.cache_creation_input_tokens} → cached prefix = ${u0.cache_creation_input_tokens || u0.input_tokens} tokens`);
  console.log();

  // Now run 10 calls rapidly
  console.log("Running 10 calls with identical params...");
  for (let i = 0; i < 10; i++) {
    const r = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 15000,
      temperature: 0.7,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: `Say ${i}` }],
    });
    const u = r.usage as any;
    console.log(`  ${i+1}: input=${u.input_tokens} created=${u.cache_creation_input_tokens??0} read=${u.cache_read_input_tokens??0}`);
  }
}

main().catch(console.error);
