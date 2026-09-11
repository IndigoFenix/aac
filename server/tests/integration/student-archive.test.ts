/**
 * Student archive / restore (2026-09-11).
 *
 * The Students panel's "Archive" menu item was wired to nothing: its click
 * bubbled to the card and merely opened the student. The only existing
 * endpoint, DELETE, also wipes the externally stored fields — deletion, not
 * archiving. These tests pin the new pair:
 *
 *   POST /api/students/:id/archive   → isActive=false, nothing else touched
 *   POST /api/students/:id/restore   → isActive=true
 *   GET  /api/students/archived      → the roster query over inactive rows
 *
 * and WHO may do it: the owner of a direct link, a member of a family
 * institute, or an admin of a school/clinic the student is enrolled in. A
 * plain staff link is not enough, and a stranger gets nothing.
 */

import { describe, it, expect, afterEach } from '@jest/globals';

import { truncateAll } from '../helpers/db.js';
import { makeReq, makeRes } from '../helpers/http.js';
import {
  makeUser,
  makeStudent,
  makeInstitute,
  addUserToInstitute,
  enrollStudent,
} from '../helpers/factories.js';
import { studentController } from '../../controllers/studentController.js';
import { studentRepository } from '../../repositories/studentRepository.js';

async function setupWorld() {
  const owner = await makeUser({ firstName: 'Owner', lastName: 'Parent' });
  const { student } = await makeStudent(owner.id);

  const { institute: clinic } = await makeInstitute(owner.id, { type: 'clinic' });
  await enrollStudent(clinic.id, student.id, owner.id);

  const clinicAdmin = await makeUser({ firstName: 'Clinic', lastName: 'Admin' });
  await addUserToInstitute(clinic.id, clinicAdmin.id, { isAdmin: true });

  const staff = await makeUser({ firstName: 'Clinic', lastName: 'Staff' });
  await addUserToInstitute(clinic.id, staff.id);

  const stranger = await makeUser({ firstName: 'No', lastName: 'One' });

  return { owner, student, clinic, clinicAdmin, staff, stranger };
}

async function call(
  method: 'archive' | 'restore',
  callerId: string,
  studentId: string,
): Promise<{ status: number; body: any }> {
  const req = makeReq({ user: { id: callerId }, params: { id: studentId } });
  const { res, capture } = makeRes();
  if (method === 'archive') await studentController.archiveStudent(req, res);
  else await studentController.restoreStudent(req, res);
  return { status: capture.statusCode, body: capture.jsonBody };
}

async function listArchived(callerId: string, instituteId: string): Promise<any[]> {
  const req = makeReq({ user: { id: callerId }, query: { instituteId } });
  const { res, capture } = makeRes();
  await studentController.getArchivedStudents(req, res);
  return ((capture.jsonBody as any)?.students ?? []) as any[];
}

async function listActive(callerId: string, instituteId: string): Promise<any[]> {
  const req = makeReq({ user: { id: callerId }, query: { instituteId } });
  const { res, capture } = makeRes();
  await studentController.getStudents(req, res);
  return ((capture.jsonBody as any)?.students ?? []) as any[];
}

describe('student archive / restore', () => {
  afterEach(async () => {
    await truncateAll();
  });

  it('the owner archives: the student leaves the roster, appears in the archived list, and comes back on restore', async () => {
    const w = await setupWorld();

    expect((await listActive(w.owner.id, w.clinic.id)).map((s) => s.id)).toEqual([w.student.id]);

    const archived = await call('archive', w.owner.id, w.student.id);
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ success: true, archived: true });

    const row = await studentRepository.getStudentById(w.student.id);
    expect(row?.isActive).toBe(false);
    // Nothing else moved — same name, same row.
    expect(row?.firstName).toBe(w.student.firstName);

    expect(await listActive(w.owner.id, w.clinic.id)).toEqual([]);
    expect((await listArchived(w.owner.id, w.clinic.id)).map((s) => s.id)).toEqual([w.student.id]);

    const restored = await call('restore', w.owner.id, w.student.id);
    expect(restored.status).toBe(200);
    expect((await studentRepository.getStudentById(w.student.id))?.isActive).toBe(true);
    expect((await listActive(w.owner.id, w.clinic.id)).map((s) => s.id)).toEqual([w.student.id]);
    expect(await listArchived(w.owner.id, w.clinic.id)).toEqual([]);
  });

  it('a clinic admin with no link may archive (the chat-created-patient case)', async () => {
    const w = await setupWorld();
    const r = await call('archive', w.clinicAdmin.id, w.student.id);
    expect(r.status).toBe(200);
    expect((await studentRepository.getStudentById(w.student.id))?.isActive).toBe(false);
    // …and sees them in the archived list, so restore is reachable.
    expect((await listArchived(w.clinicAdmin.id, w.clinic.id)).map((s) => s.id)).toEqual([w.student.id]);
  });

  it('plain staff and strangers are refused, and the student stays active', async () => {
    const w = await setupWorld();
    for (const caller of [w.staff, w.stranger]) {
      const r = await call('archive', caller.id, w.student.id);
      expect(r.status).toBe(403);
    }
    expect((await studentRepository.getStudentById(w.student.id))?.isActive).toBe(true);
  });

  it('a family member archives and restores without any link', async () => {
    const owner = await makeUser({ firstName: 'Family', lastName: 'Admin' });
    const { student } = await makeStudent(owner.id);
    const { institute: family } = await makeInstitute(owner.id, { type: 'family' });
    await enrollStudent(family.id, student.id, owner.id);
    const relative = await makeUser({ firstName: 'Family', lastName: 'Member' });
    await addUserToInstitute(family.id, relative.id);

    expect((await call('archive', relative.id, student.id)).status).toBe(200);
    expect((await studentRepository.getStudentById(student.id))?.isActive).toBe(false);
    expect((await call('restore', relative.id, student.id)).status).toBe(200);
    expect((await studentRepository.getStudentById(student.id))?.isActive).toBe(true);
  });

  it('the archived list is empty without an instituteId, like the roster', async () => {
    const w = await setupWorld();
    await call('archive', w.owner.id, w.student.id);
    const req = makeReq({ user: { id: w.owner.id }, query: {} });
    const { res, capture } = makeRes();
    await studentController.getArchivedStudents(req, res);
    expect((capture.jsonBody as any).students).toEqual([]);
  });
});
