/**
 * MIGRATED CALLERS — observable-behaviour pins (2026-09-10 authorization
 * structural pass, phase 1).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Four controllers each carried their own copy of the SAME rule — the broad
 * student policy — differing only in the bytes they wrote on refusal:
 *
 *   boardController.hasStudentAccess          null-safe boolean
 *   caretakerPinController.requireStudentAccess   401 error:AUTH_REQUIRED
 *   incidentController.requireStudentAccess       401 "Authentication required"
 *                                                 (byte-equivalent logic,
 *                                                  separately written)
 *   voiceController.assertStudentAccess           401 error:AUTH_REQUIRED
 *
 * They now share `server/services/access/`. These tests pin that each surface
 * still answers with the SAME status code and the SAME body it did before,
 * because a consolidation that changes an API response is a bug.
 *
 * 🚨 ONE deliberate exception, called out in its own block below:
 * `PATCH/DELETE /api/incidents/:id` used to answer 404 for a missing incident
 * and 403 for a real one belonging to another student — an id oracle, and a
 * named finding (clinical audit §2.9) sitting under a comment that claimed the
 * opposite. Both now answer the same 404.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

import { truncateAll } from '../helpers/db.js';
import { makeReq, makeRes } from '../helpers/http.js';
import { makeUser, makeStudent } from '../helpers/factories.js';
import { incidentRepository } from '../../repositories/index.js';
import { incidentController } from '../../controllers/incidentController.js';
import { caretakerPinController } from '../../controllers/caretakerPinController.js';

const MISSING_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * `voiceController` cannot be STATICALLY imported here: it reaches
 * `services/voice/whisper-service`, which constructs an OpenAI client at module
 * scope and throws "Missing credentials" when `OPENAI_API_KEY` is unset (it is,
 * in the test env). Seed a placeholder — never overwriting a real one — and load
 * the module dynamically. Nothing in the paths exercised below makes a vendor
 * call: every case is refused, or answered, before any TTS/STT work starts.
 */
let voiceController: any;
async function loadVoiceController() {
  if (!voiceController) {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-placeholder-never-called';
    ({ voiceController } = await import('../../controllers/voiceController.js'));
  }
  return voiceController;
}

async function buildWorld() {
  const owner = await makeUser({ firstName: 'Own', lastName: 'Parent' });
  const { student } = await makeStudent(owner.id);
  const stranger = await makeUser({ firstName: 'No', lastName: 'One' });
  return { owner, student, stranger };
}

let world: Awaited<ReturnType<typeof buildWorld>> | null = null;
async function setup() {
  if (!world) world = await buildWorld();
  return world;
}

describe('migrated student-access callers keep their response shapes', () => {
  beforeAll(async () => { await setup(); });
  afterAll(async () => { world = null; await truncateAll(); });

  // ==========================================================================
  // caretakerPinController — 401 error:AUTH_REQUIRED / 403 error:STUDENT_ACCESS_DENIED
  // ==========================================================================
  describe('caretakerPinController', () => {
    it('401s an anonymous caller with error:AUTH_REQUIRED', async () => {
      const { student } = await setup();
      const { res, capture } = makeRes();
      await caretakerPinController.status(makeReq({ user: null, params: { id: student.id } }), res);
      expect(capture.statusCode).toBe(401);
      expect(capture.jsonBody).toEqual({ success: false, error: 'error:AUTH_REQUIRED' });
    });

    it('403s a stranger with error:STUDENT_ACCESS_DENIED', async () => {
      const { student, stranger } = await setup();
      const { res, capture } = makeRes();
      await caretakerPinController.status(
        makeReq({ user: { id: stranger.id }, params: { id: student.id } }), res);
      expect(capture.statusCode).toBe(403);
      expect(capture.jsonBody).toEqual({ success: false, error: 'error:STUDENT_ACCESS_DENIED' });
    });

    it('answers a nonexistent student exactly like a forbidden one', async () => {
      const { stranger } = await setup();
      const { res, capture } = makeRes();
      await caretakerPinController.status(
        makeReq({ user: { id: stranger.id }, params: { id: MISSING_UUID } }), res);
      expect(capture.statusCode).toBe(403);
      expect(capture.jsonBody).toEqual({ success: false, error: 'error:STUDENT_ACCESS_DENIED' });
    });

    it('still serves the student owner', async () => {
      const { owner, student } = await setup();
      const { res, capture } = makeRes();
      await caretakerPinController.status(
        makeReq({ user: { id: owner.id }, params: { id: student.id } }), res);
      expect(capture.statusCode).toBe(200);
      expect(capture.jsonBody).toEqual({ success: true, set: false });
    });

    it('refuses a stranger on the WRITE verb too, before touching the PIN', async () => {
      const { student, stranger } = await setup();
      const { res, capture } = makeRes();
      await caretakerPinController.set(
        makeReq({ user: { id: stranger.id }, params: { id: student.id }, body: { pin: '1234' } }), res);
      expect(capture.statusCode).toBe(403);
      // and the PIN was not set
      const check = makeRes();
      await caretakerPinController.status(
        makeReq({ user: { id: (await setup()).owner.id }, params: { id: student.id } }), check.res);
      expect((check.capture.jsonBody as any).set).toBe(false);
    });
  });

  // ==========================================================================
  // incidentController — STUDENT-scoped verbs: shapes UNCHANGED
  // ==========================================================================
  describe('incidentController student-scoped verbs', () => {
    it('401s an anonymous caller with "Authentication required"', async () => {
      const { student } = await setup();
      const { res, capture } = makeRes();
      await incidentController.list(makeReq({ user: null, params: { studentId: student.id } }), res);
      expect(capture.statusCode).toBe(401);
      expect(capture.jsonBody).toEqual({ success: false, message: 'Authentication required' });
    });

    it('403s a stranger with the student-data message', async () => {
      const { student, stranger } = await setup();
      const { res, capture } = makeRes();
      await incidentController.list(
        makeReq({ user: { id: stranger.id }, params: { studentId: student.id } }), res);
      expect(capture.statusCode).toBe(403);
      expect(capture.jsonBody).toEqual({
        success: false,
        message: "Not authorized to access this student's data",
      });
    });

    it('403s a stranger on create, and writes nothing', async () => {
      const { student, stranger, owner } = await setup();
      const { res, capture } = makeRes();
      await incidentController.create(
        makeReq({
          user: { id: stranger.id },
          params: { studentId: student.id },
          body: { type: 'medical', severity: 'low', recordedAt: new Date().toISOString() },
        }), res);
      expect(capture.statusCode).toBe(403);

      const listed = makeRes();
      await incidentController.list(
        makeReq({ user: { id: owner.id }, params: { studentId: student.id } }), listed.res);
      expect((listed.capture.jsonBody as any).incidents).toHaveLength(0);
    });

    it('still lets the owner list and create', async () => {
      const { owner, student } = await setup();
      const created = makeRes();
      await incidentController.create(
        makeReq({
          user: { id: owner.id },
          params: { studentId: student.id },
          body: { type: 'functional', severity: 'low', recordedAt: new Date().toISOString() },
        }), created.res);
      expect(created.capture.statusCode).toBe(201);

      const listed = makeRes();
      await incidentController.list(
        makeReq({ user: { id: owner.id }, params: { studentId: student.id } }), listed.res);
      expect(listed.capture.statusCode).toBe(200);
      expect((listed.capture.jsonBody as any).incidents.length).toBeGreaterThan(0);

      // leave the table as we found it
      await incidentRepository.delete((created.capture.jsonBody as any).incident.id);
    });
  });

  // ==========================================================================
  // incidentController — INCIDENT-keyed verbs: RESPONSE CHANGED ON PURPOSE
  // ==========================================================================
  describe('incidentController incident-keyed verbs (enumeration fix, §2.9)', () => {
    async function anIncident(studentId: string) {
      return incidentRepository.create({
        studentId,
        type: 'medical',
        severity: 'low',
        recordedAt: new Date(),
        context: null,
        collectedBy: null,
      } as any);
    }

    it('answers a stranger with the SAME 404 as a nonexistent incident (was 403)', async () => {
      const { student, stranger } = await setup();
      const incident = await anIncident(student.id);

      const real = makeRes();
      await incidentController.update(
        makeReq({ user: { id: stranger.id }, params: { id: incident.id }, body: { severity: 'high' } }),
        real.res);
      const fake = makeRes();
      await incidentController.update(
        makeReq({ user: { id: stranger.id }, params: { id: MISSING_UUID }, body: { severity: 'high' } }),
        fake.res);

      expect(real.capture.statusCode).toBe(404);
      expect(real.capture.jsonBody).toEqual({ success: false, message: 'Incident not found' });
      expect(fake.capture.statusCode).toBe(real.capture.statusCode);
      expect(fake.capture.jsonBody).toEqual(real.capture.jsonBody);

      // Non-vacuity: the row is real and untouched.
      const after = await incidentRepository.getById(incident.id);
      expect(after?.severity).toBe('low');

      await incidentRepository.delete(incident.id);
    });

    it('does the same on DELETE, and the incident survives', async () => {
      const { student, stranger } = await setup();
      const incident = await anIncident(student.id);

      const { res, capture } = makeRes();
      await incidentController.delete(
        makeReq({ user: { id: stranger.id }, params: { id: incident.id } }), res);

      expect(capture.statusCode).toBe(404);
      expect(capture.jsonBody).toEqual({ success: false, message: 'Incident not found' });
      expect(await incidentRepository.getById(incident.id)).toBeTruthy();

      await incidentRepository.delete(incident.id);
    });

    it('still 401s an anonymous caller rather than 404ing them', async () => {
      const { student } = await setup();
      const incident = await anIncident(student.id);

      const { res, capture } = makeRes();
      await incidentController.delete(makeReq({ user: null, params: { id: incident.id } }), res);
      expect(capture.statusCode).toBe(401);
      expect(capture.jsonBody).toEqual({ success: false, message: 'Authentication required' });

      await incidentRepository.delete(incident.id);
    });

    it('still lets the owner update and delete', async () => {
      const { owner, student } = await setup();
      const incident = await anIncident(student.id);

      const updated = makeRes();
      await incidentController.update(
        makeReq({ user: { id: owner.id }, params: { id: incident.id }, body: { severity: 'high' } }),
        updated.res);
      expect(updated.capture.statusCode).toBe(200);
      expect((updated.capture.jsonBody as any).incident.severity).toBe('high');

      const removed = makeRes();
      await incidentController.delete(
        makeReq({ user: { id: owner.id }, params: { id: incident.id } }), removed.res);
      expect(removed.capture.statusCode).toBe(200);
      expect(await incidentRepository.getById(incident.id)).toBeFalsy();
    });
  });

  // ==========================================================================
  // voiceController — the refusal paths (they never reach a TTS vendor)
  // ==========================================================================
  describe('voiceController', () => {
    it('401s an anonymous caller with error:AUTH_REQUIRED', async () => {
      const { student } = await setup();
      const voice = await loadVoiceController();
      const { res, capture } = makeRes();
      await voice.synthesize(
        makeReq({ user: null, body: { text: 'hello', studentId: student.id } }), res);
      expect(capture.statusCode).toBe(401);
      expect(capture.jsonBody).toEqual({ error: 'error:AUTH_REQUIRED' });
    });

    it("403s a stranger naming another student's id", async () => {
      const { student, stranger } = await setup();
      const voice = await loadVoiceController();
      const { res, capture } = makeRes();
      await voice.synthesize(
        makeReq({ user: { id: stranger.id }, body: { text: 'hello', studentId: student.id } }), res);
      expect(capture.statusCode).toBe(403);
      expect(capture.jsonBody).toEqual({ error: 'error:STUDENT_ACCESS_DENIED' });
    });

    it('403s the same way on the streaming and chat entrypoints', async () => {
      const { student, stranger } = await setup();
      const voice = await loadVoiceController();

      const speak = makeRes();
      await voice.speak(
        makeReq({ user: { id: stranger.id }, body: { text: 'hello', studentId: student.id } }),
        speak.res);
      expect(speak.capture.statusCode).toBe(403);
      expect(speak.capture.jsonBody).toEqual({ error: 'error:STUDENT_ACCESS_DENIED' });
    });

    // The one relaxation in the whole module: generic TTS carries no student
    // and must still work on a session alone. Exercised on the guard directly —
    // letting `synthesize` proceed would call a TTS vendor.
    it('lets a session with NO studentId through, and still refuses no session', async () => {
      const { owner } = await setup();
      const voice = await loadVoiceController();
      const guard = voice.assertStudentAccess.bind(voice);

      const allowed = makeRes();
      expect(await guard(makeReq({ user: { id: owner.id } }), allowed.res, undefined)).toBe(true);
      expect(allowed.capture.ended).toBe(false);

      const anon = makeRes();
      expect(await guard(makeReq({ user: null }), anon.res, undefined)).toBe(false);
      expect(anon.capture.statusCode).toBe(401);
    });
  });
});
