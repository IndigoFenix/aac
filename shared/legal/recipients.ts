// Static third-party recipient list disclosed in the informed-consent notice.
// Server-computed at sign time and stamped onto the consent record so audit
// can prove what the parent was told.
//
// When this list materially changes (a new vendor added, removed, or repurposed),
// bump the active consent-notice version. Existing consent records remain
// valid for the recipients listed in their snapshot; new processing using a
// newly-added recipient requires re-consent.
//
// See planning-docs/student-consent-onboarding-plan.md.

import type { ConsentRecipientCategory } from "./types.js";

export const DEFAULT_RECIPIENTS: ReadonlyArray<ConsentRecipientCategory> = [
  {
    category: "cloud_hosting",
    name: "Amazon Web Services",
    purpose: "Application hosting and encrypted-at-rest data storage.",
  },
  {
    category: "llm_provider",
    name: "Google Gemini Live",
    purpose:
      "Realtime AAC interaction and clinician chat (when configured). During " +
      "AAC sessions this includes transmitting live microphone audio and camera " +
      "video — which may contain the student's and bystanders' facial imagery — " +
      "for realtime processing.",
  },
  {
    category: "llm_provider",
    name: "OpenAI Realtime / Anthropic Claude",
    purpose:
      "Realtime AAC interaction and clinician chat (when configured). During " +
      "AAC sessions this includes transmitting live microphone audio and camera " +
      "video — which may contain the student's and bystanders' facial imagery — " +
      "for realtime processing.",
  },
  {
    category: "tts_provider",
    name: "Cloud TTS providers (e.g., Google Cloud TTS, ElevenLabs)",
    purpose: "Speech synthesis for AAC voice output.",
  },
  {
    category: "auth_provider",
    name: "Google OAuth (when used)",
    purpose: "Authentication for users who sign in with Google.",
  },
  {
    category: "sub_processor",
    name: "Email and SMS delivery (when configured)",
    purpose: "Transactional notifications, invites, and OTP verification.",
  },
];

export function getDefaultRecipients(): ConsentRecipientCategory[] {
  // Return a copy so callers can't mutate the canonical list.
  return DEFAULT_RECIPIENTS.map((r) => ({ ...r }));
}
