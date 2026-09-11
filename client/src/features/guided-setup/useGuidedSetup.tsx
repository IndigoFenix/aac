// client/src/features/guided-setup/useGuidedSetup.tsx
//
// Guided Setup (Phase B) — the client half of the chat-driven student
// onboarding flow. Plan: planning-docs/student-onboarding-flow-plan.md.
// Contract: @shared/guided-setup (types + routes + constants; never edited here).
//
// The SERVER owns the flow. This provider only:
//   - holds the view as an ordinary react-query query over
//     `GET /api/guided-setup/students/:id`, refetched when a chat turn ends;
//   - parks the chat session's own SIGNAL (`GuidedSetupSignal` — is a flow
//     live in this chat, who did it bind to, any pending roster proposal or
//     refusal) in FeaturePanel sharedState, where useChat writes it;
//   - opens the flow (auto-launch on a zero-student institute, or the
//     "New student" button) and sends the hidden kickoff turn;
//   - picks a student created through the StudentModal form back up.
//
// THE VIEW IS FETCHED, NOT PUSHED — everything in it is derived from rows, so
// a refetch reproduces it. Only what a refetch cannot reproduce rides the
// signal, and is merged over the fetched view below.
//
// Every request is swallowed on failure: Phase A may not be deployed yet, and a
// 404 from /api/guided-setup must never break the dashboard.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '@/lib/queryClient';
import { useChat } from '@/hooks/useChat';
import { useLanguage } from '@/contexts/LanguageContext';
import { useStudent } from '@/hooks/useStudent';
import { useInstitute } from '@/hooks/useInstitute';
import { useFeaturePanel, useSharedState, PATH_TO_FEATURE } from '@/contexts/FeaturePanelContext';

import { shouldAutoLaunchGuidedSetup } from './auto-launch';
import { guidedSetupQueryKey } from './guided-setup-query';

import {
  GUIDED_SETUP_NOT_NOW_KEY,
  GUIDED_SETUP_ROUTES,
  type GuidedSetupConsentBatchItem,
  type GuidedSetupGate,
  type GuidedSetupConsentBatchOutcome,
  type GuidedSetupRecord,
  type GuidedSetupRequest,
  type GuidedSetupRosterConfirmResult,
  type GuidedSetupRosterCreated,
  type GuidedSetupRosterRow,
  type GuidedSetupSignal,
  type GuidedSetupSkippableStep,
  type GuidedSetupView,
} from '@shared/guided-setup';

// ============================================================================
// TYPES
// ============================================================================

interface GuidedSetupContextValue {
  view: GuidedSetupView | null;
  /**
   * A flow is running in THIS chat — the server's session state, straight off
   * `GuidedSetupSignal.active`.
   *
   * NOT `view.active`, which the two mean different things: the server reports
   * `active: !done` on every GET, so ANY student with an unfinished profile
   * has an "active" view whether or not a flow is running. The full rail keys
   * off `live && view.active`; collapsing them would put the whole wizard on
   * screen for every half-filled patient the user selects.
   */
  live: boolean;
  /** A live flow is running right now. */
  isActive: boolean;
  /** A request is in flight (REST call, or a kickoff turn still being answered). */
  isBusy: boolean;
  /**
   * The flow is opening RIGHT NOW: from the click until the assistant's first
   * reply lands. The button that opened it spins on this — the first turn takes
   * 10–20 s and, before this existed, pressing "New student" looked like
   * pressing nothing at all.
   */
  isLaunching: boolean;
  /**
   * A chat turn is in flight (anyone's — the flow's or the user's own typing).
   * Buttons that would send ANOTHER turn disable on this; they must not spin on
   * it, or a "New student" button would appear to be working while the user is
   * simply chatting.
   */
  isChatBusy: boolean;

  /** Open the flow for the current institute and send the opening message. */
  start: () => Promise<void>;
  /** Put an existing student into the flow (form path, or resuming from the rail). */
  adopt: (studentId: string, source: GuidedSetupRecord['source']) => Promise<void>;
  skip: (step: GuidedSetupSkippableStep) => Promise<void>;
  dismiss: () => Promise<void>;
  ackAac: () => Promise<void>;
  /**
   * Look at a DIFFERENT student than the one the chat's flow is about: drop
   * the live flag (so the selected student's own view is the one on screen)
   * and re-fetch their view. Used by the rail's parked list and by anything
   * that just wrote a fact the view is derived from (a guardian contact flips
   * the consent gate).
   */
  refresh: (studentId: string) => Promise<void>;
  /**
   * The view for the student ON SCREEN has not settled yet — a consumer
   * rendering a stable footprint holds its placeholder while this is true.
   *
   * This is react-query's own per-key loading state, so it terminates by
   * construction: there is no request it can be waiting on that will not
   * resolve or error. (It replaces a hand-rolled `probedStudentId` that
   * needed an 8-second timeout to guarantee the same thing, and still hung a
   * skeleton forever when a view arrived for somebody else.)
   */
  isViewPending: boolean;
  /**
   * Institution step 1: create the reviewed roster rows. The rows are sent back
   * WITH the user's edits — the server re-validates every cell, so this is a
   * submission, not an instruction.
   */
  confirmRoster: (
    proposalId: string,
    rows: GuidedSetupRosterRow[],
  ) => Promise<Omit<GuidedSetupRosterConfirmResult, 'view'> | null>;
  /**
   * What THIS session's roster import created, or null before one has run.
   *
   * The rail's parked list is scoped to it: `view.parked` is every unfinished
   * student in the institute, so rendering it whole advertised one patient's
   * consent state while the user was setting up another. What the flow just did
   * is the only thing the flow may show.
   */
  rosterCreated: GuidedSetupRosterCreated[] | null;
  /** Send one consent magic link per item. Always an explicit user click. */
  requestConsentBatch: (
    items: GuidedSetupConsentBatchItem[],
  ) => Promise<GuidedSetupConsentBatchOutcome[] | null>;
  /** "Not now" on the zero-student auto-launch — remembered for the session. */
  notNow: () => Promise<void>;
  /**
   * Re-enter a flow: the rail's compact banner (no argument — the view in hand
   * names the student) or the patient viewer's own button, which passes the
   * student it is showing.
   */
  continueSetup: (studentId?: string) => Promise<void>;
  /**
   * The rail is about to open the real StudentModal ("use a form instead").
   * Arms the pick-up: the student the form creates is adopted with `source: 'form'`.
   */
  beginFormPath: () => void;
}

const GuidedSetupContext = createContext<GuidedSetupContextValue | null>(null);

export function useGuidedSetup(): GuidedSetupContextValue {
  const ctx = useContext(GuidedSetupContext);
  if (!ctx) {
    throw new Error('useGuidedSetup must be used within a GuidedSetupProvider');
  }
  return ctx;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * How long the finished rail stays on screen before it retires itself. Long
 * enough to read "setup complete", short enough that nobody has to dismiss it.
 */
const GUIDED_SETUP_COMPLETE_LINGER_MS = 4000;

function readNotNow(): boolean {
  try {
    return window.sessionStorage.getItem(GUIDED_SETUP_NOT_NOW_KEY) === '1';
  } catch {
    return false;
  }
}

function writeNotNow(): void {
  try {
    window.sessionStorage.setItem(GUIDED_SETUP_NOT_NOW_KEY, '1');
  } catch {
    /* storage unavailable — the offer simply comes back on the next render */
  }
}

/** The dashboard shell only. A logged-in user on a marketing route is left alone. */
function isDashboardPath(path: string): boolean {
  const base = '/' + (path.split('/')[1] || '');
  return Object.prototype.hasOwnProperty.call(PATH_TO_FEATURE, base);
}

// ============================================================================
// PROVIDER
// ============================================================================

export function GuidedSetupProvider({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { sharedState, setSharedState } = useSharedState();
  const {
    setActiveFeature,
    chatMode,
    setChatMode,
    isFullScreenFeature,
    mobileChatMode,
    setMobileChatMode,
  } = useFeaturePanel();
  const { currentInstitute } = useInstitute();
  const {
    student,
    students,
    isLoading: studentsLoading,
    studentsInstituteId,
    selectStudent,
  } = useStudent();
  const { sendMessage, startNewSession, isSending } = useChat();
  const { t } = useLanguage();

  const queryClient = useQueryClient();

  const [isBusy, setIsBusy] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);
  /** What this session's roster import created. Null until one runs. */
  const [rosterCreated, setRosterCreated] = useState<GuidedSetupRosterCreated[] | null>(null);

  /** The chat session's flow state, written by useChat on every turn. */
  const signal: GuidedSetupSignal | null = sharedState.guidedSetup ?? null;
  const live = Boolean(signal?.active);

  const instituteId = currentInstitute?.id ?? null;

  // --------------------------------------------------------------------------
  // THE VIEW — one query per (institute, student).
  //
  // A live flow owns the slot outright, including while it is still UNBOUND:
  // it may be about a student the user has not selected (the server can bind
  // it mid-turn to one the model just created), and clicking a patient during
  // "New student" must not swap the rail over to them. With no flow it
  // follows the selection, which is what shows a parked patient's banner.
  //
  // An unbound flow has no GET to make, so that key is disabled and holds only
  // what the POST that opened the flow wrote into it.
  // --------------------------------------------------------------------------

  const viewStudentId = live ? (signal?.studentId ?? null) : (student?.id ?? null);

  const viewQuery = useQuery<GuidedSetupView | null>({
    queryKey: guidedSetupQueryKey(instituteId, viewStudentId),
    queryFn: async () => {
      const res = await apiRequest(
        'GET',
        `${GUIDED_SETUP_ROUTES.student(viewStudentId as string)}?instituteId=${encodeURIComponent(
          instituteId as string,
        )}`,
      );
      const data = await res.json();
      // Phase A may not be deployed, and a 404 must never break the dashboard.
      return data?.success && data.view ? (data.view as GuidedSetupView) : null;
    },
    enabled: !!instituteId && !!viewStudentId,
    // A failed probe is not worth three round trips; the next invalidation
    // (or student switch) asks again.
    retry: false,
  });

  /**
   * The fetched view plus the two things a fetch cannot reproduce: `refused`
   * (persisted NOWHERE, so it lives only on the turn that caused it — exactly
   * how the banner should behave) and `roster` (chat-session state; the GET
   * always answers null, so without this the review table would vanish the
   * moment the user typed anything).
   */
  const view = useMemo<GuidedSetupView | null>(() => {
    const base = viewQuery.data ?? null;
    // Only ever onto the view the signal is ABOUT. A refusal or a proposal
    // from the flow's own student must never be painted onto somebody else's
    // view — which is reachable, because dropping `live` hands the slot back
    // to the selection while the signal is still in hand.
    if (!base || !signal || (signal.studentId ?? null) !== (base.studentId ?? null)) return base;
    const merged = { ...base };
    if (signal.refused !== undefined) merged.refused = signal.refused;
    if (signal.roster !== undefined) merged.roster = signal.roster;
    return merged;
  }, [viewQuery.data, signal]);

  const isActive = Boolean(live && view?.active);

  // Only ever about the student ON SCREEN: a flow live for somebody else has
  // no request pending for the selection, so a consumer must not hold a
  // placeholder for one — that is the case that used to pulse forever.
  const isViewPending = viewQuery.isLoading && viewStudentId === student?.id;

  // --------------------------------------------------------------------------
  // Transport — every call is best-effort. Phase A may be missing entirely.
  // --------------------------------------------------------------------------

  const call = useCallback(
    async (path: string, body?: unknown): Promise<GuidedSetupView | null> => {
      setIsBusy(true);
      try {
        const res = await apiRequest('POST', path, body);
        const data = await res.json();
        if (data?.success && data.view) return data.view as GuidedSetupView;
        return null;
      } catch (err) {
        console.warn('[GuidedSetup] request failed: POST', path, err);
        return null;
      } finally {
        setIsBusy(false);
      }
    },
    [],
  );

  /**
   * The same transport, but handing back the WHOLE payload. The roster and
   * consent-batch endpoints return per-row outcomes next to the view, and the
   * table has to report "3 created, 1 failed" — a view alone cannot say that.
   */
  const callFull = useCallback(
    async (path: string, body: unknown): Promise<Record<string, unknown> | null> => {
      setIsBusy(true);
      try {
        const res = await apiRequest('POST', path, body);
        const data = await res.json();
        return data?.success ? (data as Record<string, unknown>) : null;
      } catch (err) {
        console.warn('[GuidedSetup] request failed: POST', path, err);
        return null;
      } finally {
        setIsBusy(false);
      }
    },
    [],
  );

  /**
   * Take the view a REST action just handed back: the server already resolved
   * it, so it goes straight into the cache rather than costing a second round
   * trip. `isLive` is whether that action left a flow running in this chat.
   */
  const publish = useCallback(
    (next: GuidedSetupView | null, isLive: boolean) => {
      if (!next) {
        setSharedState({ guidedSetup: undefined });
        return;
      }
      queryClient.setQueryData(guidedSetupQueryKey(next.instituteId, next.studentId), next);
      setSharedState({
        guidedSetup: {
          active: isLive && next.active !== false,
          instituteId: next.instituteId,
          studentId: next.studentId,
          panel: next.panel,
          roster: next.roster ?? null,
          refused: next.refused ?? null,
        } satisfies GuidedSetupSignal,
      });
    },
    [queryClient, setSharedState],
  );

  /** Make sure the user can actually see the conversation the flow is about to open. */
  const revealChat = useCallback(() => {
    if (chatMode === 'minimized') {
      setChatMode(isFullScreenFeature ? 'popup' : 'expanded');
    }
    if (mobileChatMode === 'hidden') {
      setMobileChatMode('half');
    }
  }, [chatMode, setChatMode, isFullScreenFeature, mobileChatMode, setMobileChatMode]);

  /**
   * The turn that opens the flow. The REQUEST SHAPE is the whole message:
   * `{ start: true }` means a new student and deliberately begins unbound, while
   * `{ resumeStudentId }` names the student to pick back up. Sending `start` for
   * a resume is what made "Continue setup" on a parked patient open a fresh
   * step-1 flow that asked the clinic for its patient list.
   *
   * The TEXT is free — the server keys the flow off the request body's
   * `guidedSetup` field and never off the message (sessionService, "Active when
   * the client opened the flow"). So it is a real, localized sentence the user
   * can see, rather than the old hidden `[GUIDED SETUP] start` marker: the first
   * reply takes 10–20 s, and until it arrived the screen showed nothing at all.
   */
  const sendKickoff = useCallback(
    async (
      text: string,
      request: GuidedSetupRequest = { start: true },
      opts: { withoutStudent?: boolean } = {},
    ) => {
      await sendMessage(text, {
        guidedSetup: request,
        ...(opts.withoutStudent ? { withoutStudent: true } : {}),
      });
    },
    [sendMessage],
  );

  // --------------------------------------------------------------------------
  // Actions
  // --------------------------------------------------------------------------

  const start = useCallback(async () => {
    if (!instituteId) {
      console.warn('[GuidedSetup] start ignored: no institute selected');
      return;
    }
    setIsLaunching(true);
    try {
      // UNSELECT FIRST. "New student" means a NEW one: with a patient still
      // selected, the chat request carries their id and the whole turn is built
      // around their context (the server's `ignoreStudentId` only stops the flow
      // from BINDING to them). Clearing the selection is the visible half; the
      // `withoutStudent` flag on the kickoff below is the half that actually
      // holds, because `sendMessage` closes over the student of THIS render.
      await selectStudent(null);

      const next = await call(GUIDED_SETUP_ROUTES.start, { instituteId });
      if (!next) return;

      publish(next, true);
      revealChat();
      if (next.panel) setActiveFeature(next.panel);
      await sendKickoff(t('guidedSetup.kickoff.new'), { start: true }, { withoutStudent: true });
    } finally {
      setIsLaunching(false);
    }
  }, [instituteId, selectStudent, call, publish, revealChat, setActiveFeature, sendKickoff, t]);

  const adopt = useCallback(
    async (studentId: string, source: GuidedSetupRecord['source']) => {
      if (!instituteId) return;
      const next = await call(GUIDED_SETUP_ROUTES.adopt(studentId), { instituteId, source });
      if (next) publish(next, true);
    },
    [instituteId, call, publish],
  );

  const skip = useCallback(
    async (step: GuidedSetupSkippableStep) => {
      const studentId = view?.studentId;
      if (!studentId || !instituteId) return;
      const next = await call(GUIDED_SETUP_ROUTES.skip(studentId), { instituteId, step });
      if (next) publish(next, true);
    },
    [view?.studentId, instituteId, call, publish],
  );

  const dismiss = useCallback(async () => {
    const studentId = view?.studentId;
    if (!studentId || !instituteId) {
      publish(null, false);
      try {
        await startNewSession();
      } catch (err) {
        console.warn('[GuidedSetup] startNewSession failed after dismiss (no student):', err);
      }
      return;
    }
    const next = await call(GUIDED_SETUP_ROUTES.dismiss(studentId), { instituteId });
    // A dismissed record renders neither the rail nor the banner; keeping the
    // returned view lets the server stay the single source of truth.
    publish(next, false);
    // The dismiss request only marks the record dismissed — the chat session's
    // guidedSetup state (which is what actually drives the system prompt) is
    // still live until the next turn starts a fresh session.
    try {
      await startNewSession();
    } catch (err) {
      console.warn('[GuidedSetup] startNewSession failed after dismiss:', err);
    }
  }, [view?.studentId, instituteId, call, publish, startNewSession]);

  const ackAac = useCallback(async () => {
    const studentId = view?.studentId;
    if (!studentId || !instituteId) return;
    const next = await call(GUIDED_SETUP_ROUTES.ackAac(studentId), { instituteId });
    if (next) publish(next, true);
  }, [view?.studentId, instituteId, call, publish]);

  const refresh = useCallback(
    async (studentId: string) => {
      if (!instituteId) return;
      // Dropping `active` is the half that puts THIS student's view on screen:
      // while a flow is live the query follows the flow's own student, not the
      // selection. (That is also what the old GET did — it stored a non-live
      // view, replacing the running flow's.) The invalidation is the other
      // half; react-query refetches the key it lands on.
      setSharedState({
        guidedSetup: signal ? { ...signal, active: false } : undefined,
      });
      await queryClient.invalidateQueries({
        queryKey: guidedSetupQueryKey(instituteId, studentId),
      });
    },
    [instituteId, signal, setSharedState, queryClient],
  );

  const confirmRoster = useCallback(
    async (proposalId: string, rows: GuidedSetupRosterRow[]) => {
      if (!instituteId) return null;
      const data = await callFull(GUIDED_SETUP_ROUTES.rosterConfirm, {
        instituteId,
        proposalId,
        rows,
      });
      if (!data) return null;
      // The returned view carries roster:null and a refreshed parked list —
      // storing it is what makes the table disappear and the list appear.
      if (data.view) publish(data.view as GuidedSetupView, true);
      const created = (data.created ?? []) as GuidedSetupRosterConfirmResult['created'];
      // Remembered here rather than in the review table, which unmounts the
      // moment the view comes back with roster:null. The rail's parked list is
      // scoped to these names.
      setRosterCreated(created);
      return {
        success: true,
        created,
        skipped: (data.skipped ?? []) as string[],
        failed: (data.failed ?? []) as GuidedSetupRosterConfirmResult['failed'],
      };
    },
    [instituteId, callFull, publish],
  );

  const requestConsentBatch = useCallback(
    async (items: GuidedSetupConsentBatchItem[]) => {
      if (!instituteId || items.length === 0) return null;
      const data = await callFull(GUIDED_SETUP_ROUTES.consentRequestBatch, {
        instituteId,
        items,
      });
      if (!data) return null;
      if (data.view) publish(data.view as GuidedSetupView, true);
      return (data.results ?? []) as GuidedSetupConsentBatchOutcome[];
    },
    [instituteId, callFull, publish],
  );

  const notNow = useCallback(async () => {
    writeNotNow();
    publish(null, false);
    // The rail hides, but the server's chat_sessions.state.guidedSetup stays
    // live until a fresh session starts — otherwise the very next turn still
    // carries the guided-setup system-prompt section.
    try {
      await startNewSession();
    } catch (err) {
      console.warn('[GuidedSetup] startNewSession failed after notNow:', err);
    }
  }, [publish, startNewSession]);

  const continueSetup = useCallback(
    async (explicitStudentId?: string) => {
      revealChat();
      const studentId = explicitStudentId ?? view?.studentId;
      if (!studentId) {
        await start();
        return;
      }
      setIsLaunching(true);
      try {
        // The patient viewer can call this for somebody who is not the current
        // selection; the flow is about THEM, so select them before the turn
        // (the request body is assembled from the selection).
        const switched = student?.id !== studentId;
        if (switched) {
          await selectStudent(studentId);
        }
        // `adopt` first: it creates the record for a student who was never in
        // the flow (the REST call is the only thing that can), lifts a previous
        // "not now", and the resume the kickoff asks for needs a live record.
        await adopt(studentId, 'chat');
        const name =
          students.find((s) => s.id === studentId)?.name ??
          (student?.id === studentId ? student?.name : undefined) ??
          '';
        await sendKickoff(
          t('guidedSetup.kickoff.resume', { name }),
          { resumeStudentId: studentId },
          // Selecting takes a render to reach `sendMessage`, so a turn sent
          // right after a switch would still carry the PREVIOUS student's id.
          // The resume binds by `resumeStudentId` regardless, so dropping the
          // stale id costs nothing and keeps the wrong patient out of the prompt.
          { withoutStudent: switched },
        );
      } finally {
        setIsLaunching(false);
      }
    },
    [revealChat, view?.studentId, start, adopt, sendKickoff, selectStudent, student, students, t],
  );

  // --------------------------------------------------------------------------
  // Consent opened the gate — carry the conversation on.
  //
  // Consent is granted OUTSIDE the chat: the wizard is a dialog, and the
  // in-person attest and magic-link paths never produce a turn at all. So the
  // rail correctly unlocked step 2 the moment the gate opened, and the guide
  // that had been walking the user through it went silent — leaving them
  // looking at an unlocked checklist with nothing telling them what happens
  // next, right after the card promised "the remaining steps open on their own
  // the moment the approval is signed".
  //
  // Fires only on the TRANSITION into `active` for the student the live flow is
  // about. The first observation of a gate never fires (a flow resumed on an
  // already-consented patient must not open with "let's carry on" out of
  // nowhere), and each student fires at most once per mount — the guard the
  // 2026-09-08 auto-launch race taught us to write, where a settling value read
  // one render early started a whole flow nobody asked for.
  // --------------------------------------------------------------------------

  const prevGateRef = useRef<Record<string, GuidedSetupGate>>({});
  const consentResumedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const studentId = view?.studentId;
    const gate = view?.gate;
    if (!studentId || !gate) return;

    const prev = prevGateRef.current[studentId];
    prevGateRef.current[studentId] = gate;

    if (!live) return;
    if (prev === undefined) return;          // first sighting: nothing to compare
    if (prev === gate) return;               // no transition
    if (gate !== 'active') return;           // only the gate OPENING matters
    if (consentResumedRef.current.has(studentId)) return;

    consentResumedRef.current.add(studentId);
    void continueSetup(studentId);
  }, [live, view?.studentId, view?.gate, continueSetup]);

  // --------------------------------------------------------------------------
  // The "use a form instead" pick-up
  //
  // StudentModal posts to REST and refreshes StudentProvider's list; it fires no
  // event of its own beyond the list refresh, so watch the list for the id that
  // was not there when the form was opened.
  // --------------------------------------------------------------------------

  const formSnapshotRef = useRef<Set<string> | null>(null);

  const beginFormPath = useCallback(() => {
    formSnapshotRef.current = new Set(students.map((s) => s.id));
  }, [students]);

  useEffect(() => {
    const snapshot = formSnapshotRef.current;
    if (!snapshot) return;
    const created = students.find((s) => !snapshot.has(s.id));
    if (!created) return;
    formSnapshotRef.current = null;
    void adopt(created.id, 'form');
  }, [students, adopt]);

  // --------------------------------------------------------------------------
  // Auto-launch: a freshly-provisioned institute with nobody in it.
  //
  // NOTE: `!studentsLoading` alone is NOT positive evidence the list is
  // loaded for THIS institute — isLoading can go false with a stale, empty
  // list while the institute is still resolving, and child effects (this one)
  // run before the parent StudentProvider effect that would refresh it.
  // `studentsInstituteId === instituteId` is the positive signal. Restricted
  // to the FIRST settle this session — switching institutes mid-session is
  // not a login; "New student" covers a later empty institute.
  // --------------------------------------------------------------------------

  const autoLaunchedRef = useRef<string | null>(null);
  // True once the student list has settled (for ANY institute) this session.
  // Auto-launch is a login-time affordance, not something a later institute
  // switch should re-trigger — see shouldAutoLaunchGuidedSetup's isFirstSettle.
  const firstSettleSeenRef = useRef(false);

  useEffect(() => {
    const settledNow = studentsInstituteId === instituteId && !studentsLoading;
    const isFirstSettle = settledNow && !firstSettleSeenRef.current;

    const shouldLaunch = shouldAutoLaunchGuidedSetup({
      instituteId,
      studentsInstituteId,
      studentsLoading,
      studentCount: students.length,
      isDashboard: isDashboardPath(location),
      hasFlow: isActive || !!view,
      notNow: readNotNow(),
      alreadyLaunchedFor: autoLaunchedRef.current,
      isFirstSettle,
    });

    if (settledNow) firstSettleSeenRef.current = true;

    if (!shouldLaunch || !instituteId) return;

    autoLaunchedRef.current = instituteId;
    void start();
  }, [instituteId, studentsInstituteId, location, studentsLoading, students.length, isActive, view, start]);

  // Resume detection — selecting a student with an unfinished record shows the
  // compact banner — needs no effect at all: `viewStudentId` follows the
  // selection whenever no flow is live, and the query does the rest.

  // --------------------------------------------------------------------------
  // The flow retires itself when it is done.
  //
  // The rail renders while `live && view.active`. `step === 'done'` (or a
  // stamped `record.completedAt`) is the signal every server path agrees on,
  // including the tool action that FINISHES the flow — the completing turn's
  // own view is the one the client has in hand, and it must not leave the
  // wizard on screen with "Finish later" as the only way out.
  //
  // Downgrading `live` (rather than dropping the view) is what retires the
  // rail: the compact banner requires a resumable record, and a finished flow
  // is not resumable, so it renders nothing.
  // --------------------------------------------------------------------------

  const retiredForRef = useRef<string | null>(null);

  const retire = useCallback(() => {
    setSharedState({ guidedSetup: signal ? { ...signal, active: false } : undefined });
  }, [signal, setSharedState]);

  useEffect(() => {
    if (!view || !live) return;
    const token = `${view.studentId ?? 'unbound'}:${view.instituteId}`;
    if (view.step !== 'done' && !view.record?.completedAt) {
      // A flow running again for the same student (a re-opened setup) must be
      // allowed to retire itself a second time.
      if (retiredForRef.current === token) retiredForRef.current = null;
      return;
    }
    if (retiredForRef.current === token) {
      // The "all done" banner has had its moment for this flow. A later turn
      // can report the flow live again (the session state only flips on the
      // NEXT turn's resolve), and putting the banner back on screen — where
      // nothing would ever clear it again — is the bug, not the fix.
      retire();
      return;
    }
    const timer = window.setTimeout(() => {
      retiredForRef.current = token;
      retire();
    }, GUIDED_SETUP_COMPLETE_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [view, live, retire]);

  // --------------------------------------------------------------------------

  const value = useMemo<GuidedSetupContextValue>(
    () => ({
      view,
      live,
      isActive,
      // A launch is "busy" for every control in the rail: the opening turn is
      // in flight and nothing else should be pressed until it lands.
      isBusy: isBusy || isLaunching,
      isLaunching,
      isChatBusy: isSending,
      start,
      adopt,
      skip,
      dismiss,
      ackAac,
      refresh,
      isViewPending,
      confirmRoster,
      rosterCreated,
      requestConsentBatch,
      notNow,
      continueSetup,
      beginFormPath,
    }),
    [
      view,
      live,
      isActive,
      isBusy,
      isLaunching,
      start,
      adopt,
      skip,
      dismiss,
      ackAac,
      refresh,
      isViewPending,
      confirmRoster,
      rosterCreated,
      requestConsentBatch,
      notNow,
      continueSetup,
      beginFormPath,
      isSending,
    ],
  );

  return <GuidedSetupContext.Provider value={value}>{children}</GuidedSetupContext.Provider>;
}
