// server/services/dual-agent/monitor-agent.ts
// Monitor Agent for thorough processing, memory management, and database access

import { randomBytes } from "crypto";
import { onMessage } from "../sessionService";
import type { ChatMessage, ParsedBoardData, ChatPersona } from "@shared/schema";
import type {
  MonitorResponse,
  PendingMessage,
  DualAgentConfig,
} from "./types";
import { studentRepository, calendarRepository, settingsRepository, locationRepository, instituteRepository, aacSessionPlanRepository } from "../../repositories";
import { calendarService } from "../calendarService";
import {
  matchStudentLocation,
  type GpsReading,
  type EventOccurrence,
  type LocationMatch,
} from "@shared/location-matching";
import type { StudentWithAacSettings } from "@shared/schema";
import type { AACMuteState, AACAppDefinition } from "./types";
import {
  buildMonitorSystemPrompt,
  normalizeAacPromptList,
} from "../memory-schema/aac-memory-schema";
import { presenceContextForSession } from "../memory-schema/presence-context";
import { GPT, type GPTInputItem } from "../chat/gpt";
import { startOfDayInTimezone, formatLocalDateTime } from "../../lib/timezone";
import { getLanguageName } from "@shared/language-names";
import { languageLevelFromInt } from "@shared/aac-language-level";
import { T } from "../memory-schema/canonical-terms";
import type { EnhancedPromptSections } from "./types";
import {
  defangSectionContent,
  buildPlanCall,
  parsePlanCallResponse,
  identityHash,
  situationsHash,
  goalsHash,
  situationsSlot,
  planEntryFresh,
  dayPartForHour,
  localTimeParts,
  isChildAge,
  PLAN_CALLS,
  GROUP_SECTION_KEYS,
  type PlanCallSpec,
  type PlanContext,
  type PlanEventOccurrence,
  type PlanGroupKey,
  type PlanGroupEntry,
} from "./session-plan";
import type { DisclosureContext } from "../processorDisclosure";

/**
 * Monitor Agent
 *
 * Handles complex database operations, memory management, and student context.
 * Uses 4o for better reasoning and memory management.
 * Initializes the Interactive Agent and can inject commands into the conversation.
 */
export class MonitorAgent {
  /**
   * AKIM §18.5 — the Monitor sees the densest PHI in the system (full
   * transcript, memory, notes), so every one of its calls names the student
   * it is about. `aac_moderator` is the use case its LLM config resolves.
   */
  private disclosureContext(): DisclosureContext {
    return {
      studentId: this.studentId,
      sessionId: this.sessionId ?? null,
      userId: this.userId ?? null,
      useCase: "aac_moderator",
    };
  }

  private config: DualAgentConfig;
  private studentId: string;
  private userId?: string;
  private sessionId?: string;
  private student?: StudentWithAacSettings;
  private framework: string | null = null;
  private privacyOptions: { allowReadProgress: boolean; allowReadReports: boolean; allowNotes: boolean } = {
    allowReadProgress: true, allowReadReports: true, allowNotes: true,
  };
  /** Client-reported IANA timezone for this session (for TZ-aware event windows and prompt context). */
  private timezone?: string;
  /** Most recent client-reported GPS reading (transient session context — not persisted). */
  private lastGps?: GpsReading;
  /** Dedup key of the last location match reported to the live agents, so re-checks only inject on change. */
  private lastReportedLocationKey?: string;

  constructor(
    studentId: string,
    config: DualAgentConfig,
    userId?: string,
    sessionId?: string
  ) {
    this.studentId = studentId;
    this.config = config;
    this.userId = userId;
    this.sessionId = sessionId;
  }

  /** Set the client-reported IANA timezone. Relay calls this after init. */
  setTimezone(tz: string | undefined): void {
    this.timezone = tz;
  }

  /** Set the latest client-reported GPS reading. Coordinator calls this on init and on gps_update. */
  setGps(gps: GpsReading | undefined): void {
    this.lastGps = gps;
  }

  getGps(): GpsReading | undefined {
    return this.lastGps;
  }

  /**
   * Resolve the student's current GPS against locations registered to their
   * institutes, cross-referenced with events scheduled around `now`. Returns
   * ranked matches (at_event first), or [] when there's no GPS / no nearby
   * location. Self-contained so it can run at startup AND on monitor re-checks.
   */
  private async resolveLocationMatches(now: Date): Promise<LocationMatch[]> {
    if (!this.lastGps || !this.studentId) return [];

    try {
      const studentInstitutes = await instituteRepository.getInstitutesByStudentId(this.studentId);
      const instituteIds = studentInstitutes.map((r) => r.institute.id);
      if (instituteIds.length === 0) return [];

      const candidateLocations = (await locationRepository.listByInstitutes(instituteIds)).map((l) => ({
        id: l.id,
        title: l.title,
        address: l.address,
        latitude: l.latitude,
        longitude: l.longitude,
      }));
      if (candidateLocations.length === 0) return [];

      // Events around now (±3h covers the ±2h match window plus slack for
      // recurrence expansion at day boundaries).
      const windowStart = new Date(now.getTime() - 3 * 60 * 60 * 1000);
      const windowEnd = new Date(now.getTime() + 3 * 60 * 60 * 1000);
      const rawEvents = await calendarService.getEventsForStudent(this.studentId, windowStart, windowEnd);
      const expanded = calendarRepository.expandRecurringEvents(rawEvents, windowStart, windowEnd);
      const locsByEvent = await locationRepository.getLocationsForEvents([...new Set(rawEvents.map((e) => e.id))]);

      const occurrences: EventOccurrence[] = expanded.map(({ event, date }) => {
        const occStart = new Date(date);
        const evStart = new Date(event.startTime);
        occStart.setHours(evStart.getHours(), evStart.getMinutes(), 0, 0);
        const durationMs = Math.max(0, new Date(event.endTime).getTime() - evStart.getTime());
        return {
          id: event.id,
          title: event.title,
          description: event.description,
          startTime: occStart,
          endTime: new Date(occStart.getTime() + durationMs),
          locationIds: (locsByEvent.get(event.id) || []).map((l) => l.id),
        };
      });

      return matchStudentLocation({ gps: this.lastGps, candidateLocations, events: occurrences, now });
    } catch (err) {
      console.warn("[MonitorAgent] resolveLocationMatches failed:", err);
      return [];
    }
  }

  /** Human-readable "when" for an event occurrence, in the session timezone. */
  private formatEventWhen(start: Date): string {
    return this.timezone
      ? formatLocalDateTime(start, this.timezone)
      : `${start.toLocaleDateString()} ${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }

  /**
   * A prompt section describing the student's likely location, for the startup
   * enhancer. Title/address are clinician-entered free text, so they're defanged
   * before landing in the system prompt. Returns "" when there's no signal.
   */
  private async buildLocationContextSection(now: Date): Promise<string> {
    const matches = await this.resolveLocationMatches(now);
    const top0 = matches[0];
    // Seed the re-check dedup key so the first gps_update doesn't re-announce
    // the location the startup prompt already described.
    this.lastReportedLocationKey = top0 ? `${top0.location.id}:${top0.confidence}` : "none";
    if (matches.length === 0) return "";

    const top = matches[0];
    const title = defangSectionContent(top.location.title);
    const addr = top.location.address ? ` (${defangSectionContent(top.location.address)})` : "";
    const dist = Math.round(top.distanceM);

    const lines: string[] = [];
    if (top.confidence === "at_event" && top.nearbyEvents.length > 0) {
      const ev = top.nearbyEvents[0];
      lines.push(
        `The user's device GPS places them at **${title}**${addr}, about ${dist}m away. The event "${defangSectionContent(ev.title)}" is scheduled there around ${this.formatEventWhen(ev.startTime)} — the user is very likely attending it right now. Build the session around being at this place and activity.`,
      );
    } else if (top.nearbyEvents.length > 0) {
      // Events ARE scheduled here, but the fix was too coarse to claim the user
      // is at them (a desktop WiFi fix can be ±250m — wider than the match
      // radius itself). Saying "nothing is scheduled" here would be false, and
      // saying "very likely attending" would be unfounded; say what is true and
      // let the AI wait to be told.
      const ev = top.nearbyEvents[0];
      const margin = top.accuracyM ? ` (accurate only to about ${Math.round(top.accuracyM)}m)` : "";
      lines.push(
        `The user's device GPS puts them somewhere around **${title}**${addr}, about ${dist}m away${margin}. The event "${defangSectionContent(ev.title)}" is scheduled there around ${this.formatEventWhen(ev.startTime)}. The reading is too imprecise to be sure they are actually there — treat this as a possibility worth gently checking, not a fact to build the session on.`,
      );
    } else {
      const margin = top.coarse && top.accuracyM ? ` (accurate only to about ${Math.round(top.accuracyM)}m)` : "";
      lines.push(
        `The user's device GPS places them at or near **${title}**${addr}, about ${dist}m away${margin}. Nothing is scheduled there at this time, but the setting is a ${top.coarse ? "rough" : "strong"} clue to where they are.`,
      );
    }
    if (matches.length > 1) {
      const others = matches.slice(1, 3).map((m) => defangSectionContent(m.location.title)).join(", ");
      lines.push(`Other nearby registered places: ${others}.`);
    }

    return `\n\n## Current Location (from device GPS)\n${lines.join("\n")}`;
  }

  /**
   * Re-evaluate the student's location (e.g. after a gps_update or on a monitor
   * cycle). Returns a context-injection string to broadcast to the live agents
   * IF the match has meaningfully changed since the last report; otherwise null.
   */
  async checkLocationContext(now: Date = new Date()): Promise<string | null> {
    const matches = await this.resolveLocationMatches(now);
    const top = matches[0];
    const key = top ? `${top.location.id}:${top.confidence}` : "none";
    if (key === this.lastReportedLocationKey) return null;

    // Skip the very first "none" — startup already covered the initial state.
    const firstReport = this.lastReportedLocationKey === undefined;
    this.lastReportedLocationKey = key;
    if (!top) return firstReport ? null : `[LOCATION] The user no longer appears to be at a registered place.`;

    const title = top.location.title;
    const dist = Math.round(top.distanceM);
    if (top.confidence === "at_event" && top.nearbyEvents.length > 0) {
      const ev = top.nearbyEvents[0];
      return `[LOCATION] The user now appears to be at ${title} (~${dist}m away), where "${ev.title}" is scheduled around ${this.formatEventWhen(ev.startTime)}. They are likely at this event.`;
    }
    // Same hedge as the startup section: a coarse fix may not omit a real event,
    // and may not assert attendance either.
    if (top.nearbyEvents.length > 0) {
      const ev = top.nearbyEvents[0];
      return `[LOCATION] The user may be somewhere near ${title} (~${dist}m away), where "${ev.title}" is scheduled around ${this.formatEventWhen(ev.startTime)}. The reading is too imprecise to be sure.`;
    }
    return `[LOCATION] The user now appears to be ${top.coarse ? "somewhere near" : "at or near"} ${title} (~${dist}m away).`;
  }

  /**
   * Get the loaded student data
   */
  getStudent() {
    return this.student;
  }

  /**
   * Get privacy options for the current session
   */
  getPrivacyOptions() {
    return this.privacyOptions;
  }

  /**
   * Initialize a new session and create the Interactive Agent's prompt
   * This is called when starting a new dual-agent session
   */
  async initializeSession(muteState: AACMuteState = 'unmuted', enabledApps: AACAppDefinition[] = [], onProgress?: (stage: import("./live-relay").StartupStage) => void): Promise<{
    sessionId: string;
    initialContext?: string;
    enhancedSections?: EnhancedPromptSections;
    /** Usage from the thorough-startup enhancer call (unset only when the
     *  enhancer fell back to the no-LLM degraded path). The Coordinator /
     *  dualAgentService charges credits for this — startup is a real,
     *  measurable cost that wasn't being tracked previously. */
    enhancerUsage?: {
      provider: import("@shared/llm-options").LLMProviderKey;
      model: string;
      promptTokens: number;
      completionTokens: number;
      cachedTokens?: number;
      cacheCreationTokens?: number;
    };
  }> {
    console.log("[MonitorAgent] Initializing session for student:", this.studentId);

    // Load student data with AAC settings
    const student = await studentRepository.getStudentWithAacSettings(this.studentId);
    if (!student) {
      throw new Error(`Student not found: ${this.studentId}`);
    }

    // Store for later use in processPendingMessages / respondInThinkingMode
    this.student = student;
    this.framework = student.framework || null;

    const aac = student.aacSettings;

    // Store privacy options from AAC settings
    this.privacyOptions = {
      allowReadProgress: aac?.allowReadProgress ?? true,
      allowReadReports: aac?.allowReadReports ?? true,
      allowNotes: aac?.allowNotes ?? true,
    };

    // Thorough startup with a per-group cache: cached section groups whose
    // input hashes still match are reused instantly; only stale groups fire
    // (parallel) enhancer LLM calls. `startupMode` 0 = quick/cached (default),
    // 1 = always regenerate. `fastInitializeContext` survives only as the
    // degraded fallback inside `thoroughStartup` when the enhancer fails.
    // thoroughStartup emits the "planningSession" progress stage itself, and
    // only when LLM calls actually fire.
    const contextResult = await this.thoroughStartup(student, onProgress);

    // Store the session ID if we created one
    this.sessionId = contextResult.sessionId;

    console.log("[MonitorAgent] Session initialized:", this.sessionId);

    return {
      sessionId: contextResult.sessionId,
      initialContext: contextResult.additionalContext,
      enhancedSections: contextResult.enhancedSections,
      enhancerUsage: (contextResult as any).enhancerUsage,
    };
  }

  /**
   * Build the raw memory-dump string that lands in the live prompt's
   * `<memory>` block — the ground-truth listing of interests, notes,
   * communication profile, preferences. The Interactive Agent uses this
   * as the AUTHORITATIVE source for who the user is; the enhancer's
   * persona / examples are stylistic on top, not a substitute.
   *
   * Used by both fast and thorough startup so the live `<memory>` block is
   * populated identically regardless of mode.
   */
  private buildMemoryDump(student: any): string | undefined {
    const memory = (student.chatMemory as Record<string, any>) || {};
    const parts: string[] = [];

    const now = new Date();
    parts.push(`Date: ${now.toLocaleDateString()} Time: ${now.toLocaleTimeString()}`);

    // Render a memory field that may be a string, an array, or missing.
    // Empty values produce NO line — the prior truthy check (`if (memory.X)`)
    // let empty arrays through and emitted "Previous notes: " with an empty
    // value, which read like data was loaded but blank. Array values render
    // as comma-separated text; objects fall back to JSON.
    const renderListField = (label: string, value: any): void => {
      if (value == null) return;
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) parts.push(`${label}: ${trimmed}`);
        return;
      }
      if (Array.isArray(value)) {
        if (value.length === 0) return;
        const formatted = value
          .map(v => typeof v === "string" ? v : JSON.stringify(v))
          .join(", ");
        parts.push(`${label}: ${formatted}`);
        return;
      }
      parts.push(`${label}: ${JSON.stringify(value)}`);
    };

    // Notes written since 2026-09 carry a `[YYYY-MM-DD]` prefix (the date they
    // were recorded — see student-memory-schema's stampStudentEntry). Saying so
    // is the whole point of stamping them: "she is in the ER" read as a
    // standing fact for 22 days because nothing told the reader how old it was.
    if (this.privacyOptions.allowNotes) {
      renderListField(
        "Previous notes (a leading [YYYY-MM-DD] is the date the note was written — judge it against today)",
        memory.Student_Notes,
      );
    }
    renderListField("Interests", memory.Student_Interests);
    renderListField("Important people", memory.Student_People);

    const commProfile = typeof (student as any).communicationProfile === "string"
      ? (student as any).communicationProfile.trim()
      : "";
    if (commProfile) {
      parts.push(`Communication profile (clinician-set, authoritative): ${commProfile}`);
    }
    if (memory.Student_CommunicationStyle && Object.keys(memory.Student_CommunicationStyle).length > 0) {
      parts.push(`Communication style (legacy, may be stale): ${JSON.stringify(memory.Student_CommunicationStyle)}`);
    }
    if (memory.Student_Preferences && (Array.isArray(memory.Student_Preferences) ? memory.Student_Preferences.length > 0 : true)) {
      parts.push(`Preferences: ${JSON.stringify(memory.Student_Preferences)}`);
    }

    return parts.length > 1 ? parts.join("\n") : undefined;
  }

  /**
   * Degraded-fallback context build: read chatMemory fields directly from the
   * already-loaded student record with no LLM call and no extra DB queries.
   * This is no longer a selectable startup mode — `thoroughStartup` is always
   * used — but it remains the resilient fallback that `thoroughStartup` drops
   * to if the enhancer LLM call throws, so a session still comes up with the
   * raw memory dump even when the enhancer is unavailable.
   */
  private async fastInitializeContext(student: any): Promise<{
    sessionId: string;
    additionalContext?: string;
    enhancedSections?: EnhancedPromptSections;
  }> {
    const sessionId = this.sessionId || `aac-${Date.now()}`;
    return {
      sessionId,
      additionalContext: this.buildMemoryDump(student),
    };
  }

  /**
   * Assemble the PlanContext consumed by the session-plan prompt builders and
   * cache hashes: student data lines (privacy-gated), clinician prompt lists,
   * the expanded event window, the location section, and coarse local time.
   */
  private async buildPlanContext(student: any): Promise<PlanContext> {
    const memory = (student.chatMemory as Record<string, any>) || {};
    const aac = student.aacSettings;
    const language = student.primaryLanguage || "en";
    const languageName = getLanguageName(language);

    // Two per-student prompt fields, each a LIST of rules/notes. The CUSTOM
    // list (chatAgentPrompt) holds behaviors caretakers explicitly requested —
    // directive, highest priority (except safety). The AUTO list (autoAacPrompt)
    // is an AI-generated set of notes about the student — background, not
    // commands. normalizeAacPromptList tolerates legacy single-string values.
    const customRules = normalizeAacPromptList(aac?.chatAgentPrompt);
    const autoNotes = normalizeAacPromptList(aac?.autoAacPrompt);

    // The enhancer needs to know the EXACT listed interests as a typed list
    // (not a stringified blob) so each example section's instructions can
    // quote them verbatim. Without this the LLM degrades "computer programming"
    // into "video games" and "astronomy" disappears entirely.
    const interestList: string[] = (() => {
      const raw = memory.Student_Interests;
      if (!raw) return [];
      if (Array.isArray(raw)) return raw.map(String).map(s => s.trim()).filter(Boolean);
      if (typeof raw === "string") {
        return raw.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
      }
      return [];
    })();

    // ── Student data lines ──
    // Age is computed ONCE here: it feeds both the "Age:" prompt line and the
    // deterministic isChild flag that gates the AUTHORITY DEFERENCE default.
    // Undefined when no birth date is on file or the stored value is unparseable.
    const ageYears: number | undefined = (() => {
      if (!student.birthDate) return undefined;
      const ms = new Date(student.birthDate).getTime();
      if (!Number.isFinite(ms)) return undefined;
      const years = Math.floor((Date.now() - ms) / (365.25 * 24 * 60 * 60 * 1000));
      return Number.isFinite(years) ? years : undefined;
    })();

    const studentDataParts: string[] = [];
    studentDataParts.push(`Name: ${student.name}`);
    studentDataParts.push(ageYears !== undefined ? `Age: ${ageYears}` : `Age: not on file`);
    if (student.gender) studentDataParts.push(`Gender: ${student.gender}`);
    studentDataParts.push(`Primary language: ${languageName} (${language})`);

    if (memory.Student_Notes?.length > 0 && this.privacyOptions.allowNotes) {
      studentDataParts.push(`Notes: ${JSON.stringify(memory.Student_Notes)}`);
    }
    if (memory.Student_Interests?.length > 0) {
      studentDataParts.push(`Interests: ${JSON.stringify(memory.Student_Interests)}`);
    }
    if (memory.Student_People?.length > 0) {
      studentDataParts.push(`Important people: ${JSON.stringify(memory.Student_People)}`);
    }
    // Communication profile — clinician-curated free-text column on the
    // students table. Authoritative for speaker attribution; the enhancer
    // MUST quote or paraphrase it into the persona section verbatim.
    const commProfile = typeof (student as any).communicationProfile === "string"
      ? (student as any).communicationProfile.trim()
      : "";
    if (commProfile) {
      studentDataParts.push(`Communication profile (clinician-set, authoritative): ${commProfile}`);
    } else {
      studentDataParts.push(`Communication profile (clinician-set, authoritative): NOT ON FILE — the persona section MUST state that the user's speech ability is not on file and the Interactive Agent should treat any audible voice as belonging to someone other than the user until evidence proves otherwise.`);
    }
    if (memory.Student_CommunicationStyle && Object.keys(memory.Student_CommunicationStyle).length > 0) {
      studentDataParts.push(`Communication style (legacy, may be stale): ${JSON.stringify(memory.Student_CommunicationStyle)}`);
    }
    if (memory.Student_Preferences && Object.keys(memory.Student_Preferences).length > 0) {
      studentDataParts.push(`Preferences: ${JSON.stringify(memory.Student_Preferences)}`);
    }

    // ── Expanded events, yesterday → +3 days ──
    const events: PlanEventOccurrence[] = [];
    try {
      const now = new Date();
      const todayStart = this.timezone
        ? startOfDayInTimezone(this.timezone, now)
        : (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d; })();
      const yesterday = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
      const threeDaysOut = new Date(todayStart.getTime() + 4 * 24 * 60 * 60 * 1000 - 1);

      const rawEvents = await calendarService.getEventsForStudent(this.studentId, yesterday, threeDaysOut);
      const expanded = calendarRepository.expandRecurringEvents(rawEvents, yesterday, threeDaysOut);

      for (const { event: ev, date } of expanded.slice(0, 10)) {
        const occStart = new Date(date);
        const evStart = new Date(ev.startTime);
        occStart.setHours(evStart.getHours(), evStart.getMinutes());
        const local = localTimeParts(occStart.getTime(), this.timezone);
        events.push({
          title: ev.title,
          description: ev.description,
          weekday: local.weekday,
          startHHMM: local.hhmm,
          whenText: this.timezone
            ? formatLocalDateTime(occStart, this.timezone)
            : `${occStart.toLocaleDateString()} ${occStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
          startMs: occStart.getTime(),
        });
      }
    } catch (err) {
      console.warn("[MonitorAgent] Failed to load calendar events for startup:", err);
    }

    // ── Current location context (from device GPS, if available) ──
    // A confirmed location — especially one with a concurrent event — is a
    // far stronger situational signal than inferring location from the
    // calendar alone. Empty string when there's no GPS / no nearby place.
    // buildLocationContextSection also seeds lastReportedLocationKey, which
    // doubles as the goals-group cache key component.
    const locationSection = await this.buildLocationContextSection(new Date());
    const locationKey = this.lastReportedLocationKey ?? "none";

    const nowMs = Date.now();
    const local = localTimeParts(nowMs, this.timezone);

    return {
      studentName: student.name,
      language,
      languageName,
      studentDataParts,
      isChild: isChildAge(ageYears),
      customRules,
      autoNotes,
      interestList,
      languageLevel: languageLevelFromInt(aac?.languageLevel),
      singleGlyphButtons: !!aac?.singleGlyphButtons,
      events,
      locationSection,
      locationKey,
      timezone: this.timezone,
      nowMs,
      weekday: local.weekday,
      localDate: local.localDate,
      dayPart: dayPartForHour(local.hour),
    };
  }

  /**
   * Run the given enhancer calls in parallel and merge their parsed sections
   * per cache group. Individual call failures degrade to missing sections
   * (the live prompt builders fall back to their static examples); usage is
   * summed across the calls that returned.
   */
  private async runPlanCalls(specs: ReadonlyArray<PlanCallSpec>, ctx: PlanContext): Promise<{
    groupSections: Partial<Record<PlanGroupKey, Partial<EnhancedPromptSections>>>;
    /** Calls that returned at least one parsed section, by group — a group is
     *  cacheable only when ALL of its calls landed (a half-empty identity
     *  group must not get pinned for two weeks). */
    completeGroups: Set<PlanGroupKey>;
    usage?: {
      provider: import("@shared/llm-options").LLMProviderKey;
      model: string;
      promptTokens: number;
      completionTokens: number;
      cachedTokens?: number;
      cacheCreationTokens?: number;
    };
  }> {
    const llmConfig = await settingsRepository.getLLMConfig('aac_moderator');
    const provider = llmConfig?.provider || 'claude';
    const model = llmConfig?.model || 'claude-haiku';
    // Background: the Monitor runs on a heartbeat and its notes shape the NEXT
    // board, not the one a child is waiting for. It must never consume
    // reserved capacity the live path needs.
    const gpt = new GPT({ provider, model, background: true, disclosure: this.disclosureContext() });

    const totals = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheCreationTokens: 0 };
    let anyCallReturned = false;

    const results = await Promise.all(specs.map(async (spec) => {
      const built = buildPlanCall(spec, ctx, {
        outputNonce: randomBytes(8).toString("hex"),
        untrustedNonce: randomBytes(8).toString("hex"),
      });
      const startedAt = Date.now();
      try {
        const response = await gpt.getStructuredResponse(
          [{ type: 'message', role: 'user', content: built.userMessage } as GPTInputItem],
          `startup-${spec.call}`,
          undefined, // no schema — tagged plain text
          [],        // no tools
          spec.maxTokens,
          0,         // intelligence level (cheapest model)
          { temperature: 0.5 },
          false, 1,
          built.systemPrompt,
        );
        anyCallReturned = true;
        totals.promptTokens += response.promptTokens ?? 0;
        totals.completionTokens += response.completionTokens ?? 0;
        totals.cachedTokens += response.cachedTokens ?? 0;
        totals.cacheCreationTokens += response.cacheCreationTokens ?? 0;
        const sections = parsePlanCallResponse(response.content || '', built);
        console.log(`[MonitorAgent] Plan call ${spec.call}: ${Object.keys(sections).length}/${spec.tags.length} sections in ${Date.now() - startedAt}ms (${response.completionTokens ?? 0} out-tokens)`);
        return { spec, sections };
      } catch (err) {
        console.error(`[MonitorAgent] Plan call ${spec.call} failed after ${Date.now() - startedAt}ms:`, err);
        return { spec, sections: {} as Partial<EnhancedPromptSections> };
      }
    }));

    const groupSections: Partial<Record<PlanGroupKey, Partial<EnhancedPromptSections>>> = {};
    const completeGroups = new Set<PlanGroupKey>();
    const failedGroups = new Set<PlanGroupKey>();
    for (const { spec, sections } of results) {
      if (Object.keys(sections).length > 0) {
        groupSections[spec.group] = { ...groupSections[spec.group], ...sections };
      } else {
        failedGroups.add(spec.group);
      }
    }
    for (const group of Object.keys(groupSections) as PlanGroupKey[]) {
      if (!failedGroups.has(group)) completeGroups.add(group);
    }

    return {
      groupSections,
      completeGroups,
      usage: anyCallReturned ? {
        provider: provider as import("@shared/llm-options").LLMProviderKey,
        model,
        ...totals,
      } : undefined,
    };
  }

  /**
   * Thorough startup, cached: build the PlanContext, hash each section GROUP's
   * inputs, reuse cached groups whose hashes still match (startupMode 0 =
   * quick, the default), and regenerate only the stale groups — as parallel
   * LLM calls, each carrying only its own sections' output spec. startupMode 1
   * (thorough) skips cache READS but still writes, so flipping a student back
   * to quick starts warm.
   *
   * The enhancer LLM is also responsible for stripping unsafe content from
   * the clinician-written persona (e.g. instructions to harm/shame/deceive
   * the user, anything unrelated to AAC) and surfacing what was removed
   * under `safety_notes`. The clinician prompt is wrapped in nonced
   * untrusted markers so injection attempts can't escape the parent prompt
   * structure (see [[feedback_untrusted_wrapping_scope]] — this concatenates
   * into a system prompt).
   *
   * Falls back to the raw-memory-dump fast path on any unexpected error.
   */
  private async thoroughStartup(
    student: any,
    onProgress?: (stage: import("./live-relay").StartupStage) => void,
  ): Promise<{
    sessionId: string;
    additionalContext?: string;
    enhancedSections?: EnhancedPromptSections;
  }> {
    try {
      const startedAt = Date.now();
      const sessionId = this.sessionId || `aac-${Date.now()}`;
      const ctx = await this.buildPlanContext(student);
      const useCache = (student.aacSettings?.startupMode ?? 0) === 0;

      const idHash = identityHash(ctx);
      const hashes: Record<PlanGroupKey, string> = {
        identity: idHash,
        situations: situationsHash(ctx, idHash),
        goals: goalsHash(ctx, idHash),
      };

      let cachedPlan: Awaited<ReturnType<typeof aacSessionPlanRepository.getByStudentId>> | undefined;
      if (useCache) {
        try {
          cachedPlan = await aacSessionPlanRepository.getByStudentId(this.studentId);
        } catch (err) {
          console.warn("[MonitorAgent] Session-plan cache read failed (continuing uncached):", err);
        }
      }

      const sections: EnhancedPromptSections = {};
      const cachedGroups: PlanGroupKey[] = [];
      const cacheEntryFor = (group: PlanGroupKey): PlanGroupEntry | undefined => {
        if (group === "situations") {
          return cachedPlan?.situations?.find((e) => planEntryFresh(e, hashes.situations, startedAt));
        }
        const entry = group === "identity" ? cachedPlan?.identity : cachedPlan?.goals;
        return planEntryFresh(entry, hashes[group], startedAt) ? entry! : undefined;
      };

      const neededCalls: PlanCallSpec[] = [];
      for (const group of ["identity", "situations", "goals"] as PlanGroupKey[]) {
        const entry = cacheEntryFor(group);
        if (entry) {
          Object.assign(sections, entry.sections);
          cachedGroups.push(group);
        } else {
          neededCalls.push(...PLAN_CALLS.filter((c) => c.group === group));
        }
      }

      // Always include the raw memory dump too — the enhancer's structured
      // sections are stylistic guidance; the live prompt's `<memory>` block
      // still needs the explicit ground-truth listing of interests, notes,
      // people, communication profile.
      const memoryDump = this.buildMemoryDump(student);

      if (neededCalls.length === 0) {
        console.log(`[MonitorAgent] Session plan fully cached (${cachedGroups.join(", ")}) — no enhancer calls, ${Date.now() - startedAt}ms`);
        return { sessionId, enhancedSections: sections, additionalContext: memoryDump };
      }

      // The enhancer calls are the slowest startup step — flag the client so
      // the waking-up subtitle reads "planning session" (only when calls
      // actually fire; a full cache hit skips the stage entirely).
      onProgress?.("planningSession");

      const { groupSections, completeGroups, usage } = await this.runPlanCalls(neededCalls, ctx);

      for (const group of Object.keys(groupSections) as PlanGroupKey[]) {
        Object.assign(sections, groupSections[group]);
      }

      // Write back the complete fresh groups (even in thorough mode) so the
      // next quick startup hits.
      try {
        const patch: Parameters<typeof aacSessionPlanRepository.upsert>[1] = {};
        for (const group of completeGroups) {
          const entry: PlanGroupEntry = {
            hash: hashes[group],
            sections: groupSections[group]!,
            generatedAt: startedAt,
            ...(group === "situations" ? { slot: situationsSlot(ctx) } : {}),
          };
          if (group === "identity") patch.identity = entry;
          else if (group === "situations") patch.situationsEntry = entry;
          else patch.goals = entry;
        }
        if (Object.keys(patch).length > 0) {
          await aacSessionPlanRepository.upsert(this.studentId, patch);
        }
      } catch (err) {
        console.warn("[MonitorAgent] Session-plan cache write failed (non-fatal):", err);
      }

      const sectionCount = Object.keys(sections).length;
      console.log(`[MonitorAgent] Session plan ready in ${Date.now() - startedAt}ms — cached groups: [${cachedGroups.join(", ") || "none"}], generated: [${[...completeGroups].join(", ") || "none"}], ${sectionCount} sections total`);

      if (sectionCount === 0) {
        console.warn("[MonitorAgent] Thorough startup: no sections parsed from any call, falling back to raw memory dump");
        return { sessionId, additionalContext: memoryDump, enhancerUsage: usage } as any;
      }
      return { sessionId, enhancedSections: sections, additionalContext: memoryDump, enhancerUsage: usage } as any;
    } catch (error) {
      console.error("[MonitorAgent] Thorough startup failed, falling back to fast:", error);
      return this.fastInitializeContext(student);
    }
  }

  /**
   * Session wrap-up hook: after the final Monitor pass has updated
   * Student_Notes (which almost always changes the identity hash), regenerate
   * whatever plan groups have gone stale and store them — so the NEXT session
   * starts on fresh, note-aware sections with no planning wait. The freshly
   * produced session summary (when given) enriches the goals prompt for
   * continuity ("yesterday they were excited about X") without entering the
   * hash. Returns the LLM usage for billing, or undefined when everything was
   * still fresh / the refresh failed.
   */
  async refreshSessionPlanAfterWrapup(lastSessionSummary?: string): Promise<{
    provider: import("@shared/llm-options").LLMProviderKey;
    model: string;
    promptTokens: number;
    completionTokens: number;
    cachedTokens?: number;
    cacheCreationTokens?: number;
  } | undefined> {
    try {
      const student = await studentRepository.getStudentWithAacSettings(this.studentId);
      if (!student) return undefined;
      // Thorough mode never reads the cache at startup — don't spend LLM
      // calls refreshing it.
      if ((student.aacSettings?.startupMode ?? 0) === 1) return undefined;

      const ctx = await this.buildPlanContext(student);
      if (lastSessionSummary) ctx.lastSessionSummary = lastSessionSummary;

      const idHash = identityHash(ctx);
      const hashes: Record<PlanGroupKey, string> = {
        identity: idHash,
        situations: situationsHash(ctx, idHash),
        goals: goalsHash(ctx, idHash),
      };

      let cachedPlan: Awaited<ReturnType<typeof aacSessionPlanRepository.getByStudentId>> | undefined;
      try {
        cachedPlan = await aacSessionPlanRepository.getByStudentId(this.studentId);
      } catch { /* treat as empty */ }

      const now = Date.now();
      const staleGroups: PlanGroupKey[] = [];
      if (!planEntryFresh(cachedPlan?.identity, hashes.identity, now)) staleGroups.push("identity");
      if (!cachedPlan?.situations?.some((e) => planEntryFresh(e, hashes.situations, now))) staleGroups.push("situations");
      // Goals: regenerate whenever a summary was provided (continuity), or on
      // a stale hash.
      if (lastSessionSummary || !planEntryFresh(cachedPlan?.goals, hashes.goals, now)) staleGroups.push("goals");

      if (staleGroups.length === 0) return undefined;

      const specs = PLAN_CALLS.filter((c) => staleGroups.includes(c.group));
      console.log(`[MonitorAgent] Wrap-up plan refresh: regenerating [${staleGroups.join(", ")}]`);
      const { groupSections, completeGroups, usage } = await this.runPlanCalls(specs, ctx);

      const patch: Parameters<typeof aacSessionPlanRepository.upsert>[1] = {};
      for (const group of completeGroups) {
        const entry: PlanGroupEntry = {
          hash: hashes[group],
          sections: groupSections[group]!,
          generatedAt: now,
          ...(group === "situations" ? { slot: situationsSlot(ctx) } : {}),
        };
        if (group === "identity") patch.identity = entry;
        else if (group === "situations") patch.situationsEntry = entry;
        else patch.goals = entry;
      }
      if (Object.keys(patch).length > 0) {
        await aacSessionPlanRepository.upsert(this.studentId, patch);
      }
      return usage;
    } catch (err) {
      console.warn("[MonitorAgent] Wrap-up plan refresh failed (non-fatal):", err);
      return undefined;
    }
  }

  /**
   * Produce a rolling session summary. Folds the previous summary together
   * with the recent conversation turns into a fresh, bounded (~1.5k token)
   * digest in canonical terminology. The relay injects the result as a
   * [SESSION SUMMARY] context message (so it survives Gemini's sliding-window
   * compression) and folds it into the system prompt on reconnect.
   *
   * Rolling: the new summary SUBSUMES the previous one. As older turn-by-turn
   * detail is evicted by compression, the summary (always re-injected recent)
   * carries the important earlier context forward.
   *
   * Cheap single Haiku call, no tools. Returns undefined on failure (caller
   * keeps the prior summary).
   */
  async produceSessionSummary(
    previousSummary: string | undefined,
    recentMessages: Array<{ role: string; content: string }>,
  ): Promise<{
    summary?: string;
    usage?: {
      provider: import("@shared/llm-options").LLMProviderKey;
      model: string;
      promptTokens: number;
      completionTokens: number;
      cachedTokens?: number;
      cacheCreationTokens?: number;
    };
  }> {
    if (recentMessages.length === 0) return { summary: previousSummary };
    try {
      const student = this.student;
      const studentName = student?.name || "the user";
      const language = (student as any)?.primaryLanguage || "en";
      const languageName = getLanguageName(language);

      // Render recent turns compactly. Cap length so a runaway history doesn't
      // blow up the summarizer's own input.
      const transcript = recentMessages
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n")
        .slice(-12000);

      const nonce = randomBytes(8).toString("hex");
      const open = `[SUMMARY-${nonce}]`;
      const close = `[/SUMMARY-${nonce}]`;

      // Presence ledger §6.1: hand the summarizer the ANSWER instead of asking
      // it to infer who was in the room from the transcript. Inferring is what
      // put "a person named X joined and reported her identity" into a
      // permanent summary when only the student was there. Empty string when
      // the feature is off for this session — then the old prose warning
      // stands and this call is byte-identical to before.
      const presenceBlock = presenceContextForSession(this.sessionId);
      const presenceSection = presenceBlock ? `\n\n## Who was present\n${presenceBlock}` : "";
      const presenceRule = presenceBlock
        ? "- Use the [PRESENCE — system verified] block: only people in its verified list were present."
        : "- A [RETRACTION] line voids earlier reports of that person: the retracted presence must NOT appear in the summary (drop it from the previous summary too), and never state a person was present from an UNCERTAIN match or the user's own greeting presses alone.";

      const systemPrompt = `You maintain a rolling SESSION SUMMARY for an AAC (Augmentative and Alternative Communication) session with ${studentName}. The live AI companion reads this summary to remember what happened earlier in the session after the detailed turn-by-turn history is dropped from its context window.

## Canonical terminology
Use the AAC system's exact terms when referring to its parts: ${T.board} (the buttons the user picks from), ${T.button}, ${T.builder}, ${T.symbol}, ${T.glyph}, ${T.sentence}. Refer to the person as "the user". Don't reuse these terms for anything else.

## Your task
Merge the PREVIOUS SUMMARY (if any) with the RECENT CONVERSATION below into a single updated summary. The new summary REPLACES the previous one, so it must carry forward anything still relevant from the previous summary PLUS what's new.

Keep (these are why the summary exists):
- The user's expressed goals, wants, preferences, and interests surfaced this session.
- Topics already covered or discussed (so the AI doesn't re-ask).
- Important observations about the environment / people present.
- Open commitments the AI made ("we'll talk about X later", "I'll help with Y").
- The current activity and who is around, if known.

Drop (recoverable or noise):
- Verbatim turn-by-turn dialogue.
- Routine background chatter and ambient noise.
- Mode-switching history.

Rules:
- Write in ${languageName}.
- Be concise — at most ~250 words. A digest, not a transcript.
- Plain prose or short dashed bullets. No markdown headers.
${presenceRule}
- If nothing meaningful has happened, output a one-line note saying so.

## Output format
Output ONLY the summary between ${open} and ${close} tags (exact strings, with the nonce). Emit nothing outside the tags.${presenceSection}

## Previous summary
${previousSummary?.trim() || "(none yet — this is the first summary)"}

## Recent conversation
${transcript}`;

      const llmConfig = await settingsRepository.getLLMConfig('aac_moderator');
      const gpt = new GPT({
        provider: llmConfig?.provider || 'claude',
        model: llmConfig?.model || 'claude-haiku',
        // Background: moderation of a stored transcript, not a live turn.
        background: true,
        disclosure: this.disclosureContext(),
      });

      const inputItems: GPTInputItem[] = [{
        type: 'message',
        role: 'user',
        content: 'Produce the updated rolling session summary.',
      }];

      const response = await gpt.getStructuredResponse(
        inputItems,
        'session-summary',
        undefined,
        [],
        1024,
        0,
        { temperature: 0.3 },
        false, 1,
        systemPrompt,
      );

      const text = response.content || '';
      const match = text.match(new RegExp(`\\[SUMMARY-${nonce}\\]([\\s\\S]*?)\\[/SUMMARY-${nonce}\\]`));
      const summary = match?.[1]?.trim();
      // Even if parsing fails, the LLM call still happened — bill it.
      // Token counts live on the response root, not under .usage.
      const usage = response.promptTokens || response.completionTokens ? {
        provider: (llmConfig?.provider || "claude") as import("@shared/llm-options").LLMProviderKey,
        model: llmConfig?.model || "claude-haiku",
        promptTokens: response.promptTokens ?? 0,
        completionTokens: response.completionTokens ?? 0,
        cachedTokens: response.cachedTokens ?? 0,
        cacheCreationTokens: response.cacheCreationTokens ?? 0,
      } : undefined;
      if (summary) {
        console.log(`[MonitorAgent] Produced session summary (${summary.length} chars from ${recentMessages.length} new msgs)`);
        return { summary, usage };
      }
      console.warn("[MonitorAgent] Session summary: no tagged output, keeping previous");
      return { summary: previousSummary, usage };
    } catch (err) {
      console.error("[MonitorAgent] produceSessionSummary failed:", err);
      return { summary: previousSummary };
    }
  }

  /**
   * Process pending messages that have accumulated while Monitor was busy
   * This syncs the Interactive Agent's messages with the database
   */
  async processPendingMessages(
    pendingMessages: PendingMessage[],
    currentBoard?: ParsedBoardData,
    muteState: AACMuteState = 'unmuted',
    interactivePrompt?: string,
    availableBoards?: Array<{ id: string; name: string; hint?: string; isGenerated?: boolean }>,
  ): Promise<MonitorResponse> {
    if (pendingMessages.length === 0) {
      return {};
    }

    console.log(
      "[MonitorAgent] Processing",
      pendingMessages.length,
      "pending messages, student:",
      this.student?.name || "NOT LOADED",
      "mode: dual, sessionId:",
      this.sessionId
    );

    // Convert pending messages to ChatMessage format
    const messages: ChatMessage[] = pendingMessages.map((pm) => ({
      role: pm.role,
      content: pm.content,
      timestamp: pm.timestamp,
    }));

    // Build feature context with board if available
    const featureContext: any = {};
    if (currentBoard) {
      featureContext.board = {
        data: currentBoard,
        currentPageId: currentBoard.currentPageId,
      };
    }

    try {
      // Build monitor prompt for dual mode
      // Presence ledger §6.1: the Monitor's durable writes are validated
      // against this session's verified list, so it has to SEE that list —
      // a refusal naming a token it was never shown is unactionable.
      // Appended AFTER the cache-stable prompt rather than built into it: the
      // block changes only when presence actually changes (in a session with
      // only the student it is constant), so the cached prefix survives the
      // ordinary round. Empty when the feature is off for this session.
      const presenceBlock = presenceContextForSession(this.sessionId);
      const systemPromptOverride = this.student
        // `interactivePrompt` is no longer quoted into the Monitor prompt (13k
        // tokens per round for a directive nothing consumed) — see
        // buildMonitorSystemPrompt. The parameter stays for the caller's sake.
        ? buildMonitorSystemPrompt(this.student, muteState, availableBoards) +
          (presenceBlock ? `\n\n${presenceBlock}` : "")
        : undefined;

      // Process through sessionService for memory updates
      const result = await onMessage({
        userId: this.userId,
        studentId: this.studentId,
        sessionId: this.sessionId,
        activeFeature: "aac",
        persona: "aac-assistant" as ChatPersona,
        messages,
        featureContext,
        replyType: "text",
        systemPromptOverride,
        timezone: this.timezone,
        creditCategory: "monitor",
      });

      // Extract any commands or context updates from the response
      const responseContent = result.message?.content;
      const responseText =
        typeof responseContent === "string"
          ? responseContent
          : (responseContent as any)?.text || (responseContent as any)?.html || "";
      console.log(`[MonitorAgent] Response extracted (${responseText.length} chars), hasContext=${responseText.includes("[CONTEXT]")}, hasPrompt=${responseText.includes("[UPDATE_PROMPT]")}`);

      // Check if Monitor wants to inject context or update prompt
      const response: MonitorResponse = {};

      // Check for special directives in the response
      if (responseText.includes("[UPDATE_PROMPT]")) {
        const promptMatch = responseText.match(
          /\[UPDATE_PROMPT\]([\s\S]*?)\[\/UPDATE_PROMPT\]/
        );
        if (promptMatch) {
          response.updatedPrompt = promptMatch[1].trim();
        }
      }

      if (responseText.includes("[CONTEXT]")) {
        const contextMatch = responseText.match(
          /\[CONTEXT\]([\s\S]*?)\[\/CONTEXT\]/
        );
        if (contextMatch) {
          response.contextInjection = contextMatch[1].trim();
        }
      }

      if (responseText.includes("[BOARD]")) {
        const boardMatch = responseText.match(
          /\[BOARD\]([\s\S]*?)\[\/BOARD\]/
        );
        if (boardMatch) {
          try {
            const boardData = JSON.parse(boardMatch[1].trim());
            if (boardData.name && boardData.irData) {
              response.generatedBoard = {
                name: boardData.name,
                boardId: boardData.boardId || undefined,
                irData: boardData.irData,
                hint: boardData.hint || undefined,
              };
            }
          } catch (err) {
            console.warn("[MonitorAgent] Failed to parse [BOARD] JSON:", err);
          }
        }
      }

      return response;
    } catch (error) {
      console.error("[MonitorAgent] Error processing pending messages:", error);
      return {};
    }
  }

  /**
   * Create a command message for the Interactive Agent
   * This will appear as a system message to Interactive
   */
  createCommandMessage(command: string, content: string): ChatMessage {
    return {
      role: "assistant", // Appears as assistant to Monitor
      content: `${command} ${content}`,
      timestamp: Date.now(),
      metadata: {
        isMonitorCommand: true, // Interactive will see this as system
      },
    };
  }

  /**
   * Ensure student data is loaded (for resumed sessions where initializeSession wasn't called)
   */
  async ensureStudentLoaded(): Promise<void> {
    if (this.student) return;
    console.log("[MonitorAgent] Loading student data for resumed session:", this.studentId);
    const student = await studentRepository.getStudentWithAacSettings(this.studentId);
    if (student) {
      this.student = student;
      this.framework = student.framework || null;
    } else {
      console.warn("[MonitorAgent] Student not found on resume:", this.studentId);
    }
  }

  /**
   * Update the session ID (after session creation)
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string | undefined {
    return this.sessionId;
  }
}

/**
 * Create a new Monitor Agent
 */
export function createMonitorAgent(
  studentId: string,
  config: DualAgentConfig,
  userId?: string,
  sessionId?: string
): MonitorAgent {
  return new MonitorAgent(studentId, config, userId, sessionId);
}
