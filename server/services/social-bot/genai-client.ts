// server/services/social-bot/genai-client.ts
//
// GoogleGenAI client construction for the social-bot HTTP paths (the
// DirectedSession forced-tool calls). Shared by the standalone
// SocialBotRelay and the AAC-integrated SocialPeerSpeakerAgent.

import { GoogleGenAI } from "@google/genai";

export function buildSocialBotGenAIClient(): GoogleGenAI {
  const useVertex = !!(process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT);
  if (useVertex) {
    const project = process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "";
    const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    const googleAuthOptions = credentialsJson ? { credentials: JSON.parse(credentialsJson) } : undefined;
    return new GoogleGenAI({ vertexai: true, project, location, ...(googleAuthOptions ? { googleAuthOptions } : {}) });
  }
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
}
