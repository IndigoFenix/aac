/**
 * Deletion certificate (AKIM appendix §8.4).
 *
 * The properties worth pinning are the two that make the document honest: a
 * certificate is only ever derived from a logged completion, and it states the
 * residual-backup window rather than claiming the data is already
 * unrecoverable on the day it is signed.
 */

import { describe, it, expect, afterEach } from "@jest/globals";
import { truncateAll } from "../helpers/db.js";
import { makeUser, makeStudent } from "../helpers/factories.js";
import { activityLogService } from "../../services/activityLogService.js";
import {
  buildErasureCertificate,
  renderErasureCertificate,
  ErasureCertificateNotAvailable,
  PITR_RETENTION_DAYS,
  S3_NONCURRENT_RETENTION_DAYS,
} from "../../services/erasureCertificateService.js";

const DAY = 24 * 60 * 60 * 1000;

/** activityLogService.log is fire-and-forget; give the insert a moment to land. */
async function settle() {
  await new Promise((r) => setTimeout(r, 250));
}

async function seedErasure(studentId: string, opts: { requested?: boolean } = {}) {
  if (opts.requested !== false) {
    activityLogService.log({
      eventType: "student_erasure_requested",
      subjectType1: "student",
      subjectId1: studentId,
    });
    await settle();
  }
  activityLogService.log({
    eventType: "student_erasure_completed",
    subjectType1: "student",
    subjectId1: studentId,
    details: { s3KeysQueued: 3 },
  });
  await settle();
}

describe("buildErasureCertificate", () => {
  afterEach(truncateAll);

  it("refuses to certify an erasure that was never completed", async () => {
    // The whole point: no evidence, no document. A certificate asserting a
    // deletion that did not happen is worse than having no certificate.
    const user = await makeUser();
    const { student } = await makeStudent(user.id);

    await expect(buildErasureCertificate(student.id)).rejects.toBeInstanceOf(
      ErasureCertificateNotAvailable,
    );
  });

  it("refuses when only a REQUEST was logged", async () => {
    const user = await makeUser();
    const { student } = await makeStudent(user.id);
    activityLogService.log({
      eventType: "student_erasure_requested",
      subjectType1: "student",
      subjectId1: student.id,
    });
    await settle();

    await expect(buildErasureCertificate(student.id)).rejects.toBeInstanceOf(
      ErasureCertificateNotAvailable,
    );
  });

  it("derives the certificate from the logged events", async () => {
    const user = await makeUser();
    const { student } = await makeStudent(user.id);
    await seedErasure(student.id);

    const cert = await buildErasureCertificate(student.id);

    expect(cert.studentId).toBe(student.id);
    expect(cert.completedAt).toBeInstanceOf(Date);
    expect(cert.requestedAt).toBeInstanceOf(Date);
    expect(cert.s3KeysQueued).toBe(3);
    // Requested must not come after completed.
    expect(cert.requestedAt!.getTime()).toBeLessThanOrEqual(cert.completedAt.getTime());
  });

  it("works when only the completion was logged", async () => {
    const user = await makeUser();
    const { student } = await makeStudent(user.id);
    await seedErasure(student.id, { requested: false });

    const cert = await buildErasureCertificate(student.id);
    expect(cert.requestedAt).toBeNull();
    expect(cert.completedAt).toBeInstanceOf(Date);
  });

  it("quotes the LONGER of the two residual-copy windows", async () => {
    // Quoting the shorter window would overstate our position: the data is not
    // fully gone until both the database and object-storage windows elapse.
    const user = await makeUser();
    const { student } = await makeStudent(user.id);
    await seedErasure(student.id);

    const cert = await buildErasureCertificate(student.id);
    const expected =
      cert.completedAt.getTime() +
      Math.max(PITR_RETENTION_DAYS, S3_NONCURRENT_RETENTION_DAYS) * DAY;
    expect(cert.residualCopiesClearAt.getTime()).toBe(expected);
    expect(cert.residualCopiesClearAt.getTime()).toBeGreaterThan(cert.completedAt.getTime());
  });
});

describe("renderErasureCertificate", () => {
  afterEach(truncateAll);

  async function certFor() {
    const user = await makeUser();
    const { student } = await makeStudent(user.id);
    await seedErasure(student.id);
    return buildErasureCertificate(student.id);
  }

  it("discloses the residual-backup window in English", async () => {
    const doc = renderErasureCertificate(await certFor(), "en");
    expect(doc.text).toMatch(/RESIDUAL COPIES/);
    expect(doc.text).toMatch(/Encrypted backups may retain/);
    // A fresh certificate must say the window has NOT yet elapsed.
    expect(doc.text).toMatch(/has not yet elapsed/);
  });

  it("discloses the residual-backup window in Hebrew", async () => {
    const doc = renderErasureCertificate(await certFor(), "he");
    expect(doc.text).toMatch(/עותקים שיוריים/);
    expect(doc.text).toMatch(/טרם חלפה/);
  });

  it("never claims an unqualified permanent deletion", async () => {
    // If this ever renders "permanently deleted" with no residual-copy
    // qualification, the certificate has become a false statement.
    const doc = renderErasureCertificate(await certFor(), "en");
    const permanentIdx = doc.text.indexOf("permanently deleted");
    expect(permanentIdx).toBeGreaterThan(-1);
    expect(doc.text.indexOf("RESIDUAL COPIES")).toBeGreaterThan(permanentIdx);
  });

  it("reports the window as elapsed once it has", async () => {
    const cert = await certFor();
    const past = {
      ...cert,
      completedAt: new Date(Date.now() - 400 * DAY),
      residualCopiesClearAt: new Date(Date.now() - 300 * DAY),
    };
    expect(renderErasureCertificate(past, "en").text).toMatch(/no copy remains/);
    expect(renderErasureCertificate(past, "he").text).toMatch(/לא נותר כל עותק/);
  });

  it("carries the record identifier in the subject line", async () => {
    const cert = await certFor();
    expect(renderErasureCertificate(cert, "en").subject).toContain(cert.studentId);
    expect(renderErasureCertificate(cert, "he").subject).toContain(cert.studentId);
  });
});
