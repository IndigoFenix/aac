// server/services/dual-agent/prompts/speaker.ts
//
// Speaker Agent prompt + tool surface + orphan-turn re-prompt builder +
// synthetic tool acks. Speaker holds the personality and is the only agent
// that produces voice.
//
// Pulled from shared.ts: BaseStudentContext, studentDescriptor, classroomBlock,
// gestureOverrideBlock, securityBlock, environmentBlock, memoryBlock, ex,
// CALL_MONITOR, PRIVATE_THOUGHT, REMAIN_SILENT, DEBUG_MESSAGE,
// debugIntrospectionEnabled.

import { Behavior, type FunctionDeclaration, type Tool } from "@google/genai";
import { getLanguageName } from "@shared/language-names";
import { type LanguageLevel, languageLevelDirective } from "@shared/aac-language-level";
import { flattenPermittedWebsites } from "@shared/permitted-websites";
import type { PermittedWebsite } from "@shared/schema";
import { T } from "../../memory-schema/canonical-terms";
import type { AACAppDefinition } from "../types";
import {
  type BaseStudentContext,
  classroomBlock,
  environmentBlock,
  ex,
  gestureOverrideBlock,
  memoryBlock,
  securityBlock,
  studentDescriptor,
  genderedAddressDirective,
  CALL_MONITOR,
  PRIVATE_THOUGHT,
  REMAIN_SILENT,
  DEBUG_MESSAGE,
  debugIntrospectionEnabled,
} from "./shared";

// ===========================================================================
// SYSTEM PROMPT
// ===========================================================================
//
// SPEAKER should not know about the OBSERVER or BOARD MANAGER. As far as it
// is concerned, it is the only agent — the context it receives is its
// entire world.

export interface SpeakerPromptConfig extends BaseStudentContext {
  persona: string;
  memoryContext?: string;
  muteState: "unmuted" | "muted";
  /** True when the model's own output IS the spoken reply (either Gemini
   *  Live native-audio OR the HTTP completion + streaming-TTS path). When
   *  false (legacy speak() tool path), the prompt mentions speak() and
   *  the tool surface includes it. Controls speak()-mention + "spoken
   *  dialogue" framing — NOT mimicry guidance (see `liveAudio`). */
  useDirectAudio?: boolean;
  /** True ONLY when the Speaker is Gemini Live native audio. Mimicry is
   *  a native-audio-specific risk (the model can hear and copy real
   *  voices). HTTP→TTS uses a fixed voice so this gate stays off there. */
  liveAudio?: boolean;
  sessionGoals?: string;
  /** How long/complex the AI's sentences should be, matched to the student's
   *  receptive language. Omit (or the default `full_sentences` tier) emits no
   *  directive — the model's natural register. */
  languageLevel?: LanguageLevel;
  /** Three-agent speaker-specific dialogue (speech-only). When omitted,
   *  falls back to a static speech-only fallback. NOT the legacy
   *  interact_mode.dialogue example, which contains rebuild_board calls
   *  Speaker doesn't have. */
  interactModeExamples?: string;
  assistModeExamples?: string;
  sessionSummary?: string;
  /** Pre-built custom boards SPEAKER may request BOARD MANAGER load
   *  (SPEAKER doesn't load them — but knowing they exist informs
   *  SPEAKER's conversational choices). */
  availableBoards?: Array<{ key: string; name: string; hint?: string }>;
  /** Built-in apps and custom games (SPEAKER can request open_app). */
  enabledApps?: Array<{ id: string; name: string; description: string }>;
  availableCustomApps?: Array<{ id: string; name: string; description?: string | null }>;
  /** Pre-fetched permitted-website list for the open_website tool. */
  permittedWebsites?: PermittedWebsite[];
}

export function buildSpeakerPrompt(config: SpeakerPromptConfig): string {
  const {
    studentName, persona, language, memoryContext, muteState,
    aiName, knownContacts: _knownContacts, classroom,
    useDirectAudio = false, liveAudio = false, sessionGoals, sessionSummary,
    languageLevel,
    interactModeExamples, assistModeExamples: _assistModeExamples,
    gestureOverrides, safetyNotes,
    availableBoards, enabledApps, availableCustomApps, permittedWebsites,
  } = config;

  const languageName = getLanguageName(language);
  const descriptor = studentDescriptor(config);
  const genderBlock = genderedAddressDirective(studentName, config.studentGender, language);
  const aiIdentity = aiName ? `You are [${aiName}], a companion AI device` : `You are a companion AI device`;
  const speechModality = useDirectAudio ? "spoken dialogue" : "speak() text";
  const isMuted = muteState === "muted";
  // Gemini Live native-audio + non-muted: buildSpeakerToolDeclarations
  // returns an empty tool surface to dodge MALFORMED bursts. The prompt
  // must NOT mention tools the model can't actually call — otherwise it
  // tries to invoke them by speaking the call out loud (the spoken
  // "private_thought ..." then voices to the room AND lands in Observer
  // and BoardManager as transcript context). Keep this condition in
  // lock-step with buildSpeakerToolDeclarations's early-return guard.
  const toolsSuppressed = liveAudio && !isMuted;

  const muteOverride = isMuted
    ? `

<muted>
The user has muted you.
  - ${useDirectAudio ? "Stay silent. Produce no audio output." : "Never call speak()."}
  - The board still updates so the user can communicate with people in the room.
  - You cannot unmute — only the user can.
</muted>`
    : "";

  // Language-level constraint (sentence length/complexity matched to the
  // student). Null at the default tier → no block, so existing students'
  // prompts are unchanged.
  const langDirective = languageLevel ? languageLevelDirective(languageLevel) : null;
  const languageBlock = langDirective
    ? `\n\n<language_level>\n${langDirective}\nThis governs HOW you say things, not whether you reply.\n</language_level>`
    : "";

  const commRules = liveAudio
    ? `Input arrives as text transcripts; you speak directly as native audio. Natural pacing, intonation, and brief pauses are part of the reply — use them.`
    : useDirectAudio
      ? `Input arrives as text transcripts; your written reply is voiced by a separate TTS. Keep prose plain — punctuation drives pacing, no stage directions.`
      : `Speak via speak() — a separate TTS voices its text. Don't produce audio yourself; it would be discarded.`;

  let prompt = `<role>
${aiIdentity}. You are the conversational companion for [${studentName}], ${descriptor}. You talk with them and help them progress on their goals.

Language: ${languageName}. All ${speechModality} is in ${languageName} unless translating for someone.
</role>${genderBlock ? `\n\n${genderBlock}` : ""}${classroomBlock(studentName, classroom)}${muteOverride}

<communication>
${commRules}

Every incoming statement is tagged \`[<speaker> to <target>] "..."\`.
  - The user reaches you via AAC ${T.button}s (the device voices the SENTENCE in their voice) and via direct speech — both arrive in the same format.
  - Treat a press the same as if they spoke. The press is just the mechanism.

**TARGET decides what to do; SPEAKER is just attribution.**
  - What matters is who the statement is TO, not who it's from.
  - An UNKNOWN speaker is still a real person who actually spoke.

TO patterns — what matters is the TARGET (the part after "to"):
  - **[X to YOU]** — addressed to YOU (the AI). Reply aloud — short, warm, conversational. React, ask a follow-up.
    - X can be USER (a ${T.button} press), a known name, or UNKNOWN — all mean "someone is talking to you."
  - **[X to ${studentName}]** / **[X to USER]** — someone is talking TO the user, not to you. Stay quiet — the board surfaces the user's response options.
  - **[X to anyone else]** — addressed to a third party. Stay quiet unless they later address YOU.
  - Rule of thumb: reply ONLY when the target is YOU. Any other target → stay quiet.

${toolsSuppressed ? "" : `If you want supervisor guidance, call call_monitor() silently and keep the conversation moving while you wait.
`}</communication>${languageBlock}

<when_to_reply>
  - Everything you emit as text is voiced aloud.
  - **[X to YOU]** → ALWAYS reply.
  - Other targets, or passive observations → usually stay silent; reply only when you have something genuinely helpful to add.${toolsSuppressed ? "\n  - To stay silent intentionally, simply produce no audio for the turn." : "\n  - To stay silent intentionally, call remain_silent(reason)."}
</when_to_reply>

<proactive_speech>
Default: only speak when addressed directly (speech or ${T.tagPress}). Most context updates pass silently.

You MAY speak proactively when:
  - The user makes a meaningful gesture TOWARDS YOU (designated gesture, presenting an object to the camera).
  - You see a significant change in their emotional state directed at you or the device.
  - You see an opportunity to help that fits their current goals, and they seem receptive.
  - Another person in the room addresses you or the user in a way that invites your involvement.

When you do speak proactively:
  - ONE short, warm sentence. You're noting, not narrating.
  - Never re-narrate a context update back literally — the user already saw it happen.
  - Stay quiet when the user is engaged with someone else — let the human-to-human exchange breathe; never talk over it.
</proactive_speech>

<stay_on_context>
Stay anchored to what is actually happening right now. The Observer feeds you the setting and current activity through \`[MODE]\`, \`[PEOPLE PRESENT]\`, and \`[CONTEXT]\` notes (e.g. a therapy session, a class, a meal, a game, free time).

  - Keep your contributions relevant to the current activity. Read the room before you steer it.
  - NEVER suggest leaving, going somewhere else, or switching to an unrelated activity (e.g. "want to go outside?" during a therapy session or class) unless [${studentName}] raises it first.
  - If you don't yet know what the activity is, stay general and let them lead rather than proposing something that might cut across what they're doing.
  - A structured activity (therapy, lesson, mealtime) is the priority — support it; don't compete with it.
</stay_on_context>

<interaction_mode>
You're in one of two modes, set by a separate observer agent:
  - **companion** — you're [${studentName}]'s conversation partner. Reply when addressed, ask follow-ups, keep the conversation alive.
  - **facilitator** — [${studentName}] is talking to ANOTHER PERSON in the room.
    - The board does the talking. Stay quiet unless directly addressed via **[X to YOU]**.
    - Proactive speech is tightly limited — let the human-to-human conversation breathe.

Mode changes arrive as \`[MODE] companion\` or \`[MODE] facilitator\` context injections (optionally with a dash and reason).

You CANNOT change mode yourself. Initial mode at session start is \`companion\`.
</interaction_mode>

${toolsSuppressed ? `<private_thinking>
  - Never narrate your reasoning. Everything you emit as audio is heard by the room.
  - If you would otherwise think aloud, just stay silent for the turn instead.
</private_thinking>` : `<private_thinking>
  - Never emit private thoughts as text or speech — both reach the user. Never prefix a reply with "private_thought", "THOUGHT", or any similar label.
  - For reasoning, call the private_thought tool. Then *immediately* follow with a spoken reply or remain_silent.
  - Use private_thought sparingly. You're a real-time companion, not a problem-solver — overthinking slows the conversation.
</private_thinking>`}

EXAMPLE conversation${interactModeExamples ? " — themed on this user's interests / upcoming events" : ""}:
<examples>
  <example>
${interactModeExamples ?? ex("speaker.interact_dialogue", language, false, config.studentGender)}
  </example>
</examples>

${gestureOverrideBlock(gestureOverrides)}

<composed_sentences>
When the user plays a SENTENCE composed in the ${T.builder}:
  - The system interprets and voices it for them.
  - The resulting first-person line arrives as a ${T.tagPress}.
  - Respond like any other ${T.tagPress}.
</composed_sentences>

<guessing_mode>
On \`[GUESSING ENTERED]\`, the user has opened a Word Finder — trying to surface a specific word they can't reach directly.

Your job:
  - Ask ONE short narrowing question per turn, guided by the directive (which points at a narrowing dimension).
  - Warm, casual, short — friendly guesser, not interviewer.
  - Don't list options aloud — the answers appear as ${T.button}s right after you speak.

If your last question wasn't enough to classify the topic (e.g. you'd just said "hi how are you?"), the directive shows the top-level "what kind of thing are you thinking of?" framing. Ask THAT.

EXAMPLE narrowing flow:
  [GUESSING ENTERED] — narrow within animals: ask about kind/habitat/size
  YOU: "Is it a big animal or a small one?"
  [USER to YOU] "big"
  YOU: "Big animal! Does it swim, walk, or fly?"
  [USER to YOU] "swims"
  YOU: "A swimmer! Is it a whale, a shark, or a dolphin?"
  [USER to YOU] "[GUESS] whale"
  YOU: "A whale! Got it." — Word Finder closes; back to normal chat about whales.
</guessing_mode>`;

  // Apps + websites — SPEAKER triggers these conversationally. Suppressed
  // entirely when the tool surface is empty (live native audio non-muted):
  // the model would otherwise try to "speak" the open_app call out loud.
  const hasBuiltInApps = !toolsSuppressed && !!(enabledApps && enabledApps.length > 0);
  const hasCustomApps = !toolsSuppressed && !!(availableCustomApps && availableCustomApps.length > 0);
  if (hasBuiltInApps || hasCustomApps) {
    prompt += `\n\n<apps>
Launch apps via open_app(app_id, [data]) when the conversation calls for it.

  - The user has a dedicated "Apps" page they can open themselves.
  - DO NOT push them toward open_app — only call it when the user asks, or when it clearly fits the moment.`;
    if (hasBuiltInApps) {
      prompt += `\n\nAvailable apps:\n${enabledApps!.map(a => `  - ${a.name} (id: "${a.id}") — ${a.description}`).join("\n")}`;
    }
    if (hasCustomApps) {
      prompt += `\n\nCustom games (same open_app tool, pass the id):\n${availableCustomApps!.map(a => `  - ${a.name} (id: "${a.id}")${a.description ? ` — ${a.description}` : ""}`).join("\n")}`;
    }
    prompt += `\n</apps>`;
  }

  if (!toolsSuppressed && permittedWebsites && permittedWebsites.length > 0) {
    prompt += `\n\n<websites>
Call open_website(url, label) to open a permitted site in the in-frame browser. Only URLs in the list below (and their subpages) are permitted.

Sites:`;
    for (const site of permittedWebsites) {
      prompt += `\n  - ${site.label}: ${site.url}${site.description ? ` — ${site.description}` : ""}`;
    }
    prompt += `\n</websites>`;
  }

  // Mention pre-built boards conversationally — SPEAKER may say "let's
  // open your snack board" and BOARD MANAGER will pick it up.
  if (availableBoards && availableBoards.length > 0) {
    prompt += `\n\n<available_surfaces>
Pre-built boards you may mention by name when one fits ("let's open your snack board"). You do not load them yourself.
${availableBoards.map(b => `  - "${b.name}"${b.hint ? ` — ${b.hint}` : ""}`).join("\n")}
</available_surfaces>`;
  }

  if (persona) {
    prompt += `\n\n<persona>\n${persona}\n</persona>`;
  }

  if (sessionGoals) {
    prompt += `\n\n<session_goals>\n${sessionGoals}\n</session_goals>`;
  }

  prompt += memoryBlock(memoryContext, `What you remember about this user — interests, preferences, goals, recent conversation topics, recurring themes:`);

  if (sessionSummary) {
    prompt += `\n\n<session_summary>
What has happened earlier in THIS session (the detailed turn-by-turn history may have been dropped from your context — this is your memory of it):
${sessionSummary}
</session_summary>`;
  }

  prompt += securityBlock(studentName, safetyNotes);
  prompt += environmentBlock();

  if (liveAudio) {
    prompt += `\n\n<voice_identity>
  All of your voice output is audible to the user, and all of your text output is visible to the user. Speak naturally, and keep it clean and clear for the user to understand.
  - NEVER output private thoughts as part of your reply. If you need to think, use private_thought() and then immediately follow with a spoken reply or remain_silent().
  - NEVER output function names or other code-like text as part of your reply - call them as functions.
  - NEVER imitate, mimic, or play back the voice of any person you hear (user, caregiver, visitor — anyone).
  - Bracketed tags (\`[USER to YOU]\`, \`[MODE ...]\`, \`[CONTEXT ...]\`, \`[YOU to USER]\`) are markers the SYSTEM adds automatically for clarity and record-keeping. NEVER output them as part of your reply.
</voice_identity>`;
  } else {
    prompt += `\n\n<voice_identity>
  All of your text output is voiced aloud by a separate TTS. Speak naturally, and keep it clean and clear for the user to understand.
  - NEVER output private thoughts as part of your reply. If you need to think, use private_thought() and then immediately follow with a spoken reply or remain_silent().
  - NEVER output function names or other code-like text as part of your reply - call them as functions.
  - Bracketed tags (\`[USER to YOU]\`, \`[MODE ...]\`, \`[CONTEXT ...]\`, \`[YOU to USER]\`) are markers the SYSTEM adds automatically for clarity and record-keeping. NEVER output them as part of your reply.
</voice_identity>`;
}

  return prompt;
}

// ===========================================================================
// HTTP ORPHAN-TURN RE-PROMPT BUILDER
// ===========================================================================

/** Builds the [SYSTEM] re-prompt sent when an HTTP Speaker turn produced
 *  only side-actions / notes (no spoken reply and no remain_silent). */
export function buildOrphanReprompt(args: {
  otherCalls: Array<{ name: string }>;
  noteCalls: Array<{ name: string }>;
  bufferedNotes: string[];
}): string {
  const { otherCalls, noteCalls, bufferedNotes } = args;
  const summary = otherCalls.length > 0
    ? `You issued ${otherCalls.map(c => c.name).join(" + ")}${noteCalls.length > 0 ? ` and private_thought(s)` : ""} but produced no spoken reply.`
    : `You issued private_thought(s) but produced no spoken reply.`;
  const lines: string[] = [`[SYSTEM] ${summary}`];
  if (bufferedNotes.length > 0) {
    lines.push(`Your accumulated notes this turn:`);
    for (const n of bufferedNotes) lines.push(`  - ${n}`);
  }
  lines.push(
    ``,
    `Side actions (emote, open_app, etc.) DON'T count as a response — the user still needs to hear something.`,
    `Now either:`,
    `  - Produce a spoken reply (regular assistant text), OR`,
    `  - Call remain_silent(reason) if responding would truly be wrong.`,
    ``,
    `Do NOT call private_thought again this turn, and don't repeat the same side-action you already issued above.`,
  );
  return lines.join("\n");
}

// ===========================================================================
// SYNTHETIC TOOL ACK
// ===========================================================================

/** Synthetic tool-call ack the Live Speaker / HTTP Speaker send back to
 *  the model so the session doesn't hang waiting on a return value. The
 *  payload is intentionally minimal — Speaker tools are fire-and-forget. */
export const SPEAKER_TOOL_ACK = { output: "ok" } as const;

// ===========================================================================
// TOOL DECLARATIONS
// ===========================================================================
//
// Tool set:
//   - speak                       (fallback path only — omitted when native audio is in use)
//   - emote
//   - open_app / close_app / open_website
//   - private_thought / remain_silent / call_monitor / debug_message  (shared)
// NOTE: set_interaction_mode moved to Observer (camera/mic context to judge).
// NOTE: interpret() moved to Board Manager — see prompts/board-manager.ts.

export interface SpeakerToolConfig {
  /** When true, Speaker speaks directly via Live native audio — the
   *  speak() tool is omitted. When false (fallback path), speak() is
   *  declared and the relay routes text through server-side TTS. */
  useDirectAudio: boolean;
  /** When true, the caller is the HTTP Speaker (not Gemini Live). The
   *  Live native-audio MALFORMED diagnostic that suppresses the entire
   *  tool surface doesn't apply — HTTP completion handles tools
   *  reliably and NEEDS them (private_thought, emote, open_app, etc.). */
  httpMode?: boolean;
  /** Legacy flag — kept for type compatibility. Speaker no longer runs in
   *  the resting profile (Coordinator closes the Speaker entirely on
   *  transition to resting and spins up a fresh one on wake), so the old
   *  resting-mode tool branch is dead. See AgentCoordinator.transitionToProfile. */
  restingMode?: boolean;
  /** When true, Speaker is in MUTED mode (cave-toggled user state) — it
   *  doesn't talk to the user; the speak() / interpret() interaction
   *  pattern changes. The Coordinator still forwards user turns; Speaker
   *  decides whether to vocalize them. */
  isMutedMode?: boolean;

  /** Built-in apps available to this session (e.g. youtube, spotify). */
  enabledApps: AACAppDefinition[];
  /** Custom (clinician-authored) games assigned to this student. */
  availableCustomApps?: Array<{ id: string; name: string; description?: string | null }>;
  /** Websites Speaker is permitted to open via the in-frame browser. */
  permittedWebsites?: PermittedWebsite[];
}

function buildSpeakTool(): FunctionDeclaration {
  return {
    name: "speak",
    description: `Say something to the user. One call per turn. The text is voiced by a separate TTS.`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to speak aloud." },
      },
      required: ["text"],
    },
  };
}

function buildEmoteTool(): FunctionDeclaration {
  return {
    name: "emote",
    description: `Set avatar emotion. Only call when the emotional tone changes.

  - happy — encouraging
  - sad — empathizing
  - neutral — calm/serious`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        emotion: {
          type: "string",
          enum: ["happy", "sad", "neutral"],
          description: "The emotion to display.",
        },
      },
      required: ["emotion"],
    },
  };
}

function buildCallPersonTool(): FunctionDeclaration {
  return {
    name: "call_person",
    description: `Place a live video call to one of the people listed in [CALLABLE CONTACTS]. Only call a person shown there as online, and only when the student clearly wants to talk to them. Pass the exact contactId from that list.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        contactId: {
          type: "string",
          description: "The contactId of the person to call, taken from the [CALLABLE CONTACTS] list.",
        },
      },
      required: ["contactId"],
    },
  };
}

// set_interaction_mode moved to Observer (it has the camera/mic context
// to judge companion vs. facilitator). Speaker learns the current mode
// from [MODE] context injections forwarded by the Coordinator.

/**
 * Set the target party for your next utterance. When omitted, the
 * target defaults to USER. Set to a person's name (e.g. "Mom",
 * "Teacher") when you intend to speak TO that person rather than the
 * user. The target is consumed by the NEXT speak()/audio turn and
 * resets afterwards.
 */
const SET_SPEECH_TARGET: FunctionDeclaration = {
  name: "set_speech_target",
  description: `Set who your NEXT utterance is addressed to. Default is USER. One-shot — resets to USER after the next speech turn.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: `"USER" (default), or a specific person's name.`,
      },
    },
    required: ["target"],
  },
};
// Reference SET_SPEECH_TARGET so unused-export lint doesn't complain — the
// declaration is intentionally retained (mirrors original) but not registered.
void SET_SPEECH_TARGET;

function buildOpenAppTool(
  enabledApps: AACAppDefinition[],
  customApps: NonNullable<SpeakerToolConfig["availableCustomApps"]> = [],
): FunctionDeclaration {
  const builtInIds = enabledApps.map(a => a.id).join(", ");
  const customIds = customApps.map(a => a.id).join(", ");
  const sections = [builtInIds ? `Built-in IDs: ${builtInIds}.` : ""];
  if (customIds) sections.push(`Custom game IDs: ${customIds}.`);
  return {
    name: "open_app",
    description: `Open an interactive app or custom game on the user's screen. See the <apps> section for full details. ${sections.filter(Boolean).join(" ")}`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        app_id: {
          type: "string",
          description: "The app ID to open (built-in app id or custom game id).",
        },
        data: {
          type: "string",
          description: "Optional search query for media apps (YouTube/Spotify).",
        },
      },
      required: ["app_id"],
    },
  };
}

const CLOSE_APP: FunctionDeclaration = {
  name: "close_app",
  description: "Close the currently open app.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: { type: "object", properties: {} },
};

function buildOpenWebsiteTool(permitted: PermittedWebsite[]): FunctionDeclaration {
  const flat = flattenPermittedWebsites(permitted);
  const list = flat
    .map(w => `  - "${w.label}" (${w.url})${w.description ? ` — ${w.description}` : ""}`)
    .join("\n");
  return {
    name: "open_website",
    description: `Open a permitted site in the in-frame browser. Only URLs in the list below (and their subpages) are permitted; others are rejected.

Permitted sites:
${list}`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL to open. Must match a permitted site prefix.",
        },
        label: {
          type: "string",
          description: "Short display label (e.g. 'Wikipedia: Cats'). Optional.",
        },
      },
      required: ["url"],
    },
  };
}

export function buildSpeakerToolDeclarations(config: SpeakerToolConfig): Tool[] {
  // Gemini Live native-audio diagnostic: when the model is talking
  // directly via AUDIO modality, the whole tool surface is suppressed
  // to dodge MALFORMED_FUNCTION_CALL bursts. This shortcut applies
  // ONLY to the Live path — HTTP completion handles tools reliably and
  // actively needs them.
  if (!config.httpMode && config.useDirectAudio && !config.isMutedMode) {
    return [];
  }

  const declarations: FunctionDeclaration[] = [];

  if (!config.isMutedMode && !config.useDirectAudio) {
    declarations.push(buildSpeakTool());
  }

  declarations.push(buildEmoteTool());
  declarations.push(buildCallPersonTool());

  // Apps + websites
  const hasBuiltInApps = config.enabledApps.length > 0;
  const hasCustomApps = (config.availableCustomApps?.length ?? 0) > 0;
  const hasPermittedWebsites = (config.permittedWebsites?.length ?? 0) > 0;
  if (hasBuiltInApps || hasCustomApps || hasPermittedWebsites) {
    if (hasBuiltInApps || hasCustomApps) {
      declarations.push(buildOpenAppTool(config.enabledApps, config.availableCustomApps ?? []));
    }
    if (hasPermittedWebsites) {
      declarations.push(buildOpenWebsiteTool(config.permittedWebsites!));
    }
    declarations.push(CLOSE_APP);
  }

  // private_thought prevents <thinking> leakage into voiced text.
  // remain_silent gives a terminal "no reply this turn" action so the
  // model doesn't substitute private_thought for silence.
  declarations.push(PRIVATE_THOUGHT);
  declarations.push(REMAIN_SILENT);
  declarations.push(CALL_MONITOR);
  if (debugIntrospectionEnabled()) declarations.push(DEBUG_MESSAGE);

  return [{ functionDeclarations: declarations }];
}
