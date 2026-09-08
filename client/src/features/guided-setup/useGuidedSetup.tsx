// client/src/features/guided-setup/useGuidedSetup.tsx
//
// Guided Setup (Phase B) — the client half of the chat-driven student
// onboarding flow. Plan: planning-docs/student-onboarding-flow-plan.md.
// Contract: @shared/guided-setup (types + routes + constants; never edited here).
//
// The SERVER owns the flow. This provider only:
//   - calls the REST surface and parks the returned view in FeaturePanel
//     sharedState (`guidedSetup: { view, live }`), where the rail reads it;
//   - opens the flow (auto-launch on a zero-student institute, or the
//     "New student" button) and sends the hidden kickoff turn;
//   - picks a student created through the StudentModal form back up.
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

import { apiRequest } from '@/lib/queryClient';
import { useChat } from '@/hooks/useChat';
import { useLanguage } from '@/contexts/LanguageContext';
import { useStudent } from '@/hooks/useStudent';
import { useInstitute } from '@/hooks/useInstitute';
import { useFeaturePanel, useSharedState, PATH_TO_FEATURE } from '@/contexts/FeaturePanelContext';

import { shouldAutoLaunchGuidedSetup } from './auto-launch';

import {
  GUIDED_SETUP_NOT_NOW_KEY,
  GUIDED_SETUP_ROUTES,
  type GuidedSetupConsentBatchItem,
  type GuidedSetupConsentBatchOutcome,
  type GuidedSetupRecord,
  type GuidedSetupRequest,
  type GuidedSetupRosterConfirmResult,
  type GuidedSetupRosterCreated,
  type GuidedSetupRosterRow,
  type GuidedSetupSkippableStep,
  type GuidedSetupView,
} from '@shared/guided-setup';

// ============================================================================
// TYPES
// ============================================================================

/** What lives at `sharedState.guidedSetup`. `live` = it came from a chat turn. */
export interface GuidedSetupSharedState {
  view: GuidedSetupView;
  live: boolean;
}

interface GuidedSetupContextValue {
  view: GuidedSetupView | null;
  /** True when the view arrived on a chat turn (as opposed to a GET on load). */
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
  /** GET the persisted view for a student (resume detection; not a live turn). */
  refresh: (studentId: string) => Promise<void>;
  /**
   * The student id whose guided-setup view has actually settled — either the
   * resume-detection GET returned (with or without a record) or a live view
   * for exactly this student is already in hand, so there is nothing left to
   * learn right now. `null` (or any other student's id) means "don't know
   * yet": a consumer rendering a stable footprint (no second layout shift)
   * should hold its placeholder until this equals the student it cares about.
   *
   * It is a SETTLE signal, not a freshness one, and it is guaranteed to
   * arrive: the resume-detection effect marks the selected student probed on
   * every path it can take (fetched, empty, failed, no institute to ask, a
   * live flow already showing, a view already in hand) and never clears it
   * out from under a consumer. Anything that leaves a placeholder waiting on
   * a fetch that will never happen is a bar that pulses forever.
   */
  probedStudentId: string | null;
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

/**
 * Last-resort settle for `probedStudentId`. `refresh` swallows its own
 * failures, so this only fires for a request that never comes back at all —
 * and the whole point of the signal is that it terminates.
 */
const PROBE_SETTLE_TIMEOUT_MS = 8000;

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

  const [isBusy, setIsBusy] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);
  /** What this session's roster import created. Null until one runs. */
  const [rosterCreated, setRosterCreated] = useState<GuidedSetupRosterCreated[] | null>(null);
  /** See `GuidedSetupContextValue.probedStudentId`. Set in `store()`. */
  const [probedStudentId, setProbedStudentId] = useState<string | null>(null);

  const entry: GuidedSetupSharedState | null = sharedState.guidedSetup ?? null;
  const view = entry?.view ?? null;
  const live = Boolean(entry?.live);
  const isActive = Boolean(live && view?.active);

  const instituteId = currentInstitute?.id ?? null;

  // --------------------------------------------------------------------------
  // Resume-detection guard. Declared up here (ahead of `store`) so `store` can
  // clear it — see the comment inside `store` below for why.
  // --------------------------------------------------------------------------

  const refreshedForRef = useRef<string | null>(null);

  // --------------------------------------------------------------------------
  // Transport — every call is best-effort. Phase A may be missing entirely.
  // --------------------------------------------------------------------------

  const call = useCallback(
    async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<GuidedSetupView | null> => {
      setIsBusy(true);
      try {
        const res = await apiRequest(method, path, body);
        const data = await res.json();
        if (data?.success && data.view) return data.view as GuidedSetupView;
        return null;
      } catch (err) {
        console.warn('[GuidedSetup] request failed:', method, path, err);
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

  const store = useCallback(
    (next: GuidedSetupView | null, isLive: boolean, probedFor?: string) => {
      // The resume-detection effect below fetches a student's view once per
      // `${instituteId}:${studentId}` token and remembers that in
      // `refreshedForRef`, so it doesn't refetch on every render. That guard
      // goes stale the moment the view it "guards" is cleared or replaced by
      // a DIFFERENT student's view (e.g. "New Patient" then "Not now"): the
      // token stays set, but there is no longer a matching view for that
      // student, so reselecting them would silently short-circuit forever.
      // Clearing the token here — whenever we store nothing, or store a view
      // for someone else — makes the next selection of that student a real
      // refetch, while a genuinely-failed GET (which also stores null) still
      // only retries on the next actual re-render trigger, not in a loop.
      const trackedStudentId = refreshedForRef.current?.split(':')[1];
      if (!next || next.studentId !== trackedStudentId) {
        refreshedForRef.current = null;
      }
      // `probedStudentId` is a SETTLE signal, never a freshness one: it says
      // "we have finished finding out about this student", and a consumer
      // holds a loading placeholder until it names the student on screen. So
      // it only ever moves FORWARD here — `probedFor` (passed by `refresh`,
      // the one caller that knows who was checked) marks that student
      // settled, and every other store leaves it alone.
      //
      // It used to be cleared whenever a store carried nothing, or someone
      // else's view — mirroring `refreshedForRef` above. That is what hung
      // the placeholder: clearing it does not, by itself, schedule anything
      // that would set it again, and the resume-detection effect below only
      // re-runs when one of its deps changes. A live view arriving for a
      // student the user is not looking at (a roster confirm, a flow bound to
      // a freshly-created child) cleared the flag with no dep change behind
      // it, and the skeleton pulsed forever. Re-probing is the effect's job,
      // and it now marks the student settled on every path it can take.
      if (probedFor) setProbedStudentId(probedFor);
      setSharedState({ guidedSetup: next ? { view: next, live: isLive } : undefined });
    },
    [setSharedState],
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

      const next = await call('POST', GUIDED_SETUP_ROUTES.start, { instituteId });
      if (!next) return;

      store(next, true);
      revealChat();
      if (next.panel) setActiveFeature(next.panel);
      await sendKickoff(t('guidedSetup.kickoff.new'), { start: true }, { withoutStudent: true });
    } finally {
      setIsLaunching(false);
    }
  }, [instituteId, selectStudent, call, store, revealChat, setActiveFeature, sendKickoff, t]);

  const adopt = useCallback(
    async (studentId: string, source: GuidedSetupRecord['source']) => {
      if (!instituteId) return;
      const next = await call('POST', GUIDED_SETUP_ROUTES.adopt(studentId), { instituteId, source });
      if (next) store(next, true);
    },
    [instituteId, call, store],
  );

  const skip = useCallback(
    async (step: GuidedSetupSkippableStep) => {
      const studentId = view?.studentId;
      if (!studentId || !instituteId) return;
      const next = await call('POST', GUIDED_SETUP_ROUTES.skip(studentId), { instituteId, step });
      if (next) store(next, true);
    },
    [view?.studentId, instituteId, call, store],
  );

  const dismiss = useCallback(async () => {
    const studentId = view?.studentId;
    if (!studentId || !instituteId) {
      store(null, false);
      try {
        await startNewSession();
      } catch (err) {
        console.warn('[GuidedSetup] startNewSession failed after dismiss (no student):', err);
      }
      return;
    }
    const next = await call('POST', GUIDED_SETUP_ROUTES.dismiss(studentId), { instituteId });
    // A dismissed record renders neither the rail nor the banner; keeping the
    // returned view lets the server stay the single source of truth.
    store(next, false);
    // The dismiss request only marks the record dismissed — the chat session's
    // guidedSetup state (which is what actually drives the system prompt) is
    // still live until the next turn starts a fresh session.
    try {
      await startNewSession();
    } catch (err) {
      console.warn('[GuidedSetup] startNewSession failed after dismiss:', err);
    }
  }, [view?.studentId, instituteId, call, store, startNewSession]);

  const ackAac = useCallback(async () => {
    const studentId = view?.studentId;
    if (!studentId || !instituteId) return;
    const next = await call('POST', GUIDED_SETUP_ROUTES.ackAac(studentId), { instituteId });
    if (next) store(next, true);
  }, [view?.studentId, instituteId, call, store]);

  const refresh = useCallback(
    async (studentId: string) => {
      if (!instituteId) return;
      const next = await call(
        'GET',
        `${GUIDED_SETUP_ROUTES.student(studentId)}?instituteId=${encodeURIComponent(instituteId)}`,
      );
      // Pass the probed student explicitly: `next` (or its absence) alone
      // can't say WHO was just checked, and "checked, nothing there" is the
      // whole point of this signal.
      store(next, false, studentId);
    },
    [instituteId, call, store],
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
      if (data.view) store(data.view as GuidedSetupView, true);
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
    [instituteId, callFull, store],
  );

  const requestConsentBatch = useCallback(
    async (items: GuidedSetupConsentBatchItem[]) => {
      if (!instituteId || items.length === 0) return null;
      const data = await callFull(GUIDED_SETUP_ROUTES.consentRequestBatch, {
        instituteId,
        items,
      });
      if (!data) return null;
      if (data.view) store(data.view as GuidedSetupView, true);
      return (data.results ?? []) as GuidedSetupConsentBatchOutcome[];
    },
    [instituteId, callFull, store],
  );

  const notNow = useCallback(async () => {
    writeNotNow();
    store(null, false);
    // The rail hides, but the server's chat_sessions.state.guidedSetup stays
    // live until a fresh session starts — otherwise the very next turn still
    // carries the guided-setup system-prompt section.
    try {
      await startNewSession();
    } catch (err) {
      console.warn('[GuidedSetup] startNewSession failed after notNow:', err);
    }
  }, [store, startNewSession]);

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

  // --------------------------------------------------------------------------
  // Resume detection: selecting a student with an unfinished record shows the
  // compact banner. Never while a live flow is running — that view is fresher.
  // --------------------------------------------------------------------------

  useEffect(() => {
    const studentId = student?.id;
    // Nothing selected: there is no student for the signal to be about, and
    // consumers key their placeholder off having one.
    if (!studentId) return;

    // EVERY path from here marks this student probed. `probedStudentId` is
    // what a consumer holds a placeholder on, so a path that returns without
    // marking is a placeholder that never resolves — the bar at the top of
    // Patient Info that pulsed forever. The paths are: no institute to ask,
    // a live view already on screen, a view for this student already in
    // hand, the GET landing (with or without a record), and the GET failing.
    if (!instituteId) {
      // No institute selected → no request to make, so this is as settled as
      // it gets. If one resolves a moment later this effect runs again and
      // does the real fetch; the worst case is a card that fills in, against
      // a placeholder that never would.
      setProbedStudentId(studentId);
      return;
    }

    if (live) {
      // A live view is already the freshest possible answer for whoever it's
      // about. If that's this student, we have it. If it's someone else,
      // resume detection deliberately does not run while a flow is live
      // elsewhere (unchanged behaviour) — and won't learn anything new about
      // THIS student until `live` clears, so there is nothing to wait on.
      setProbedStudentId(studentId);
      return;
    }

    const token = `${instituteId}:${studentId}`;
    if (refreshedForRef.current === token) {
      // Already fetched for this (institute, student) and still holding that
      // answer: no request is coming, so settle rather than wait for one.
      setProbedStudentId(studentId);
      return;
    }
    refreshedForRef.current = token;

    let cancelled = false;
    const settle = () => {
      if (!cancelled) setProbedStudentId(studentId);
    };
    // `refresh` settles through `store(..., probedFor)` on every path that
    // stores something (including "checked, nothing there" and a failed
    // request, which `call` swallows into null). `finally` covers the rest —
    // an early return inside `refresh`, or a rejection nobody expected.
    void refresh(studentId).finally(settle);
    // …and a request that never comes back at all — a fetch left pending by a
    // dropped connection resolves NOTHING, and this signal must terminate.
    const failsafe = window.setTimeout(settle, PROBE_SETTLE_TIMEOUT_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(failsafe);
    };
  }, [student?.id, instituteId, live, refresh]);

  // --------------------------------------------------------------------------
  // The flow retires itself when it is done.
  //
  // The rail renders while `live && view.active`, and the server's per-turn
  // resolve does report `active: false` (plus `record.completedAt`) once the
  // flow reaches `done`. But the turn that FINISHES the flow publishes its
  // view from the tool action instead — `applyFlowAction`/`resolveView`, which
  // pass no `active` and so always say `true`, on a record that has not been
  // stamped completed yet. So the last thing the client is handed says
  // "active, step: done", and the rail sat there — with a Finish later button
  // as the only way out — until the user pressed it.
  //
  // `step === 'done'` is the signal both server paths agree on. Downgrading
  // `live` (rather than dropping the view) is what retires the rail: the
  // compact banner requires a resumable record, and a finished flow is not
  // resumable, so it renders nothing — and keeping the view in hand means the
  // resume-detection effect above finds its answer already there instead of
  // firing another GET.
  // --------------------------------------------------------------------------

  const retiredForRef = useRef<string | null>(null);

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
      // republishes the finished view (the session state only flips on the
      // NEXT turn's resolve), and putting the banner back on screen — where
      // nothing would ever clear it again — is the bug, not the fix.
      store(view, false);
      return;
    }
    const timer = window.setTimeout(() => {
      retiredForRef.current = token;
      store(view, false);
    }, GUIDED_SETUP_COMPLETE_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [view, live, store]);

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
      probedStudentId,
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
      probedStudentId,
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
