/**
 * Publishing, moderation and the class-B image gate (P5).
 *
 * This is the phase where content can leave the owning institute, so the tests
 * are about refusals more than successes:
 *  - class B (staff portraits) is fine inside an institute package, barred from
 *    a public one
 *  - publishing re-validates EVERY board, requires a human attestation, and
 *    lands in a review queue rather than straight into search
 *  - the AI cannot publish; it only gets a read-only readiness report
 *  - symbol IMAGES of people are access-gated, not served to any caller
 *
 * See planning-docs/aac-packages-plan.md §3, §9.3, §10, §11 (P5).
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { truncateAll, db } from '../helpers/db.js';
import { makeReq, makeRes } from '../helpers/http.js';
import {
  makeUser,
  makeInstitute,
  makeStudent,
  addUserToInstitute,
} from '../helpers/factories.js';
import {
  boards,
  customSymbols,
  instituteSymbolAssociations,
  packageBoards,
  packages,
} from '@shared/schema';
import { eq } from 'drizzle-orm';
import { packageController } from '../../controllers/packageController.js';
import { packageRepository } from '../../repositories/packageRepository.js';
import { attachPackageToStudent } from '../../services/packages/packageLinks.js';
import { checkPackageForVisibility } from '../../services/packages/packageContent.js';
import { canReadSymbolImage } from '../../services/packages/symbolImageAccess.js';
import { INSTITUTE_PACKAGES_FIELD } from '../../services/memory-schema/institute-packages-schema.js';
import type { DBOperationContext } from '../../services/chat/memory-types.js';

async function call(
  method: keyof typeof packageController,
  opts: Parameters<typeof makeReq>[0],
) {
  const req = makeReq(opts);
  const { res, capture } = makeRes();
  await (packageController[method] as any)(req, res);
  return { status: capture.statusCode, body: capture.jsonBody as any };
}

function memCtx(userId: string, instituteId: string): DBOperationContext {
  const all = { userId, instituteId };
  return { base: all, inherited: {}, all, path: '/Institute_Packages', pathTokens: [] } as any;
}

const ops = INSTITUTE_PACKAGES_FIELD.db!;

/** A symbol row; `personImage` decides whether it is class A or class B. */
async function makeSymbol(opts: { personImage?: boolean; isPublic?: boolean } = {}) {
  const [row] = await db
    .insert(customSymbols)
    .values({
      s3Key: `test/${Math.random().toString(36).slice(2)}.png`,
      personImage: opts.personImage ?? false,
      isPublic: opts.isPublic ?? false,
    })
    .returning();
  return row;
}

/** A package board whose single button references `symbolId`. */
async function makeBoardWithSymbol(instituteId: string, userId: string, symbolId: string) {
  const [row] = await db
    .insert(boards)
    .values({
      userId,
      instituteId,
      scope: 'package',
      name: 'Staff',
      irData: {
        pages: [{ id: 'main', buttons: [{ id: 'b1', label: 'Teacher', glyph: `symbol:${symbolId}` }] }],
      },
    })
    .returning();
  return row;
}

async function makePackageWithBoard(instituteId: string, userId: string, symbolId: string) {
  const pkg = await packageRepository.createPackage({
    instituteId,
    name: 'Staff Pack',
    createdByUserId: userId,
  });
  const board = await makeBoardWithSymbol(instituteId, userId, symbolId);
  await db.insert(packageBoards).values({ packageId: pkg.id, boardId: board.id });
  return { pkg, board };
}

describe('Packages — publishing and person imagery (P5)', () => {
  afterEach(truncateAll);

  // ============================================================
  // Class B
  // ============================================================
  describe('person imagery (class B)', () => {
    it('ALLOWS a staff portrait inside an institute-visible package', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);
      const symbol = await makeSymbol({ personImage: true });
      const { pkg } = await makePackageWithBoard(institute.id, user.id, symbol.id);

      expect(await checkPackageForVisibility(pkg.id, 'institute')).toEqual([]);
    });

    it('BARS the same portrait from a public package', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);
      const symbol = await makeSymbol({ personImage: true });
      const { pkg, board } = await makePackageWithBoard(institute.id, user.id, symbol.id);

      const findings = await checkPackageForVisibility(pkg.id, 'public');
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        reason: 'person_image_in_public',
        buttonId: 'b1',
        boardId: board.id,
        boardName: 'Staff',
      });
    });

    it('lets ordinary art through at every visibility', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);
      const symbol = await makeSymbol({ personImage: false });
      const { pkg } = await makePackageWithBoard(institute.id, user.id, symbol.id);

      expect(await checkPackageForVisibility(pkg.id, 'institute')).toEqual([]);
      expect(await checkPackageForVisibility(pkg.id, 'public')).toEqual([]);
    });
  });

  // ============================================================
  // Publishing
  // ============================================================
  describe('publish', () => {
    it('REFUSES without the attestation', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);
      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'P',
        createdByUserId: user.id,
      });

      const { status } = await call('publish', {
        user: { id: user.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: {},
      });

      expect(status).toBe(400);
      const [row] = await db.select().from(packages).where(eq(packages.id, pkg.id));
      expect(row.visibility).toBe('institute');
    });

    it('REFUSES when a board carries person imagery, naming the board', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);
      const symbol = await makeSymbol({ personImage: true });
      const { pkg } = await makePackageWithBoard(institute.id, user.id, symbol.id);

      const { status, body } = await call('publish', {
        user: { id: user.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { attestation: { noPersonImages: true } },
      });

      expect(status).toBe(409);
      expect(body.findings[0].reason).toBe('person_image_in_public');
      expect(body.findings[0].boardName).toBe('Staff');
      const [row] = await db.select().from(packages).where(eq(packages.id, pkg.id));
      expect(row.visibility).toBe('institute');
    });

    it('publishes into REVIEW, not straight into search, and records who attested', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);
      const symbol = await makeSymbol({ personImage: false });
      const { pkg } = await makePackageWithBoard(institute.id, user.id, symbol.id);

      const { status, body } = await call('publish', {
        user: { id: user.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { attestation: { noPersonImages: true } },
      });

      expect(status).toBe(200);
      expect(body.visibility).toBe('public');
      // Public but NOT yet listed — a reviewer decides that.
      expect(body.approvalStatus).toBe('pending');
      expect(body.publishedByUserId).toBe(user.id);
      expect(body.publishAttestation).toMatchObject({ noPersonImages: true, byUserId: user.id });

      // Not discoverable while pending.
      expect(await packageRepository.searchPublicPackages({})).toEqual([]);
    });

    it('unpublish returns it to the institute and clears the attestation', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);
      const symbol = await makeSymbol();
      const { pkg } = await makePackageWithBoard(institute.id, user.id, symbol.id);
      const args = { user: { id: user.id }, query: { instituteId: institute.id }, params: { id: pkg.id } };
      await call('publish', { ...args, body: { attestation: { noPersonImages: true } } });

      const { body } = await call('unpublish', args);

      expect(body.visibility).toBe('institute');
      expect(body.approvalStatus).toBe('none');
      expect(body.publishAttestation).toBeNull();
    });

    it('publish-check reports the blockers without changing anything', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);
      const symbol = await makeSymbol({ personImage: true });
      const { pkg } = await makePackageWithBoard(institute.id, user.id, symbol.id);

      const { body } = await call('publishCheck', {
        user: { id: user.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
      });

      expect(body.ok).toBe(false);
      expect(body.findings).toHaveLength(1);
      const [row] = await db.select().from(packages).where(eq(packages.id, pkg.id));
      expect(row.visibility).toBe('institute');
    });

    it('refuses a publish from a use-only member', async () => {
      const admin = await makeUser();
      const member = await makeUser();
      const { institute } = await makeInstitute(admin.id);
      await addUserToInstitute(institute.id, member.id);
      const pkg = await packageRepository.createPackage({
        instituteId: institute.id,
        name: 'P',
        createdByUserId: admin.id,
      });

      const { status } = await call('publish', {
        user: { id: member.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { attestation: { noPersonImages: true } },
      });

      expect(status).toBe(403);
    });
  });

  // ============================================================
  // Moderation + search
  // ============================================================
  describe('moderation', () => {
    async function publishedPackage() {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);
      const symbol = await makeSymbol();
      const { pkg, board } = await makePackageWithBoard(institute.id, user.id, symbol.id);
      await call('publish', {
        user: { id: user.id },
        query: { instituteId: institute.id },
        params: { id: pkg.id },
        body: { attestation: { noPersonImages: true } },
      });
      return { user, institute, pkg, board };
    }

    it('queues a published package for review', async () => {
      const { pkg } = await publishedPackage();
      const { body } = await call('listPending', { user: { id: 'admin' } });
      expect(body.map((p: any) => p.id)).toEqual([pkg.id]);
    });

    it('approval puts it into search', async () => {
      const { pkg } = await publishedPackage();
      const admin = await makeUser({ isSystemAdmin: true });

      const { status } = await call('approve', { user: { id: admin.id }, params: { id: pkg.id } });
      expect(status).toBe(200);

      const found = await packageRepository.searchPublicPackages({});
      expect(found.map((p) => p.id)).toEqual([pkg.id]);
    });

    it('REFUSES approval when the content changed since publishing', async () => {
      const { pkg, board } = await publishedPackage();
      const admin = await makeUser({ isSystemAdmin: true });
      // A person portrait slipped in after the attestation was signed.
      const portrait = await makeSymbol({ personImage: true });
      await db
        .update(boards)
        .set({
          irData: {
            pages: [{ id: 'main', buttons: [{ id: 'b9', label: 'Head', glyph: `symbol:${portrait.id}` }] }],
          },
        })
        .where(eq(boards.id, board.id));

      const { status, body } = await call('approve', {
        user: { id: admin.id },
        params: { id: pkg.id },
      });

      expect(status).toBe(409);
      expect(body.findings[0].reason).toBe('person_image_in_public');
      expect(await packageRepository.searchPublicPackages({})).toEqual([]);
    });

    it('rejection returns the package to institute-only', async () => {
      const { pkg } = await publishedPackage();
      const admin = await makeUser({ isSystemAdmin: true });

      const { body } = await call('reject', {
        user: { id: admin.id },
        params: { id: pkg.id },
        body: { reason: 'shows a child' },
      });

      expect(body.approvalStatus).toBe('rejected');
      expect(body.visibility).toBe('institute');
      expect(await packageRepository.searchPublicPackages({})).toEqual([]);
    });
  });

  describe('search', () => {
    it('matches on name and description, and never leaks unapproved packages', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);
      const mk = async (name: string, extra = {}) =>
        packageRepository.createPackage({
          instituteId: institute.id,
          name,
          createdByUserId: user.id,
          ...extra,
        });

      await mk('Kindergarten Core', {
        visibility: 'public',
        approvalStatus: 'approved',
        description: 'snack and play',
      });
      await mk('Pending Pack', { visibility: 'public', approvalStatus: 'pending' });
      await mk('Institute Only');

      expect((await packageRepository.searchPublicPackages({})).map((p) => p.name)).toEqual([
        'Kindergarten Core',
      ]);
      expect(
        (await packageRepository.searchPublicPackages({ q: 'snack' })).map((p) => p.name),
      ).toEqual(['Kindergarten Core']);
      expect(await packageRepository.searchPublicPackages({ q: 'pending' })).toEqual([]);
    });
  });

  // ============================================================
  // The AI cannot publish
  // ============================================================
  describe('Clinician AI', () => {
    it('gets a read-only readiness report instead of a publish action', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);
      const symbol = await makeSymbol({ personImage: true });
      const { pkg } = await makePackageWithBoard(institute.id, user.id, symbol.id);

      const view = await ops.get!(memCtx(user.id, institute.id), pkg.id);
      expect(view.publishBlockers).toHaveLength(1);
      expect(view.publishBlockers[0]).toMatch(/photo of a real person/);
      expect(view.visibility).toBe('institute');
    });

    it('reports NO blockers for a clean package but still cannot publish it', async () => {
      const user = await makeUser();
      const { institute } = await makeInstitute(user.id);
      const symbol = await makeSymbol({ personImage: false });
      const { pkg } = await makePackageWithBoard(institute.id, user.id, symbol.id);
      const ctx = memCtx(user.id, institute.id);

      expect((await ops.get!(ctx, pkg.id)).publishBlockers).toEqual([]);

      await expect(ops.update!(ctx, pkg.id, { visibility: 'public' })).rejects.toThrow(
        /not something you can do/i,
      );
      const [row] = await db.select().from(packages).where(eq(packages.id, pkg.id));
      expect(row.visibility).toBe('institute');
    });
  });

  // ============================================================
  // Symbol image gate
  // ============================================================
  describe('symbol image access', () => {
    it('serves ordinary and public symbols to anyone, cacheably', async () => {
      const stranger = await makeUser();
      const ordinary = await makeSymbol({ personImage: false });
      const publicArt = await makeSymbol({ personImage: true, isPublic: true });

      expect(await canReadSymbolImage(ordinary.id, stranger.id)).toEqual({
        allowed: true,
        cache: 'public',
      });
      expect(await canReadSymbolImage(publicArt.id, stranger.id)).toEqual({
        allowed: true,
        cache: 'public',
      });
    });

    it('REFUSES a staff portrait to an unrelated user', async () => {
      const owner = await makeUser();
      const stranger = await makeUser();
      const { institute } = await makeInstitute(owner.id);
      const portrait = await makeSymbol({ personImage: true });
      await db
        .insert(instituteSymbolAssociations)
        .values({ symbolId: portrait.id, instituteId: institute.id });

      expect(await canReadSymbolImage(portrait.id, stranger.id)).toEqual({ allowed: false });
      expect(await canReadSymbolImage(portrait.id, undefined)).toEqual({ allowed: false });
    });

    it('serves it to a member of the owning institute, privately cached', async () => {
      const owner = await makeUser();
      const colleague = await makeUser();
      const { institute } = await makeInstitute(owner.id);
      await addUserToInstitute(institute.id, colleague.id);
      const portrait = await makeSymbol({ personImage: true });
      await db
        .insert(instituteSymbolAssociations)
        .values({ symbolId: portrait.id, instituteId: institute.id });

      expect(await canReadSymbolImage(portrait.id, colleague.id)).toEqual({
        allowed: true,
        cache: 'private',
      });
    });

    it('serves it through a package attached to the callers student', async () => {
      const author = await makeUser();
      const caregiver = await makeUser();
      const { institute } = await makeInstitute(author.id);
      const { student } = await makeStudent(caregiver.id);
      const portrait = await makeSymbol({ personImage: true });
      const { pkg } = await makePackageWithBoard(institute.id, author.id, portrait.id);
      await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });

      // The caregiver is in no institute holding the symbol — reachability comes
      // purely from their student's attached package.
      expect(await canReadSymbolImage(portrait.id, caregiver.id)).toEqual({
        allowed: true,
        cache: 'private',
      });
    });

    it('stops serving it once the package is detached', async () => {
      const author = await makeUser();
      const caregiver = await makeUser();
      const { institute } = await makeInstitute(author.id);
      const { student } = await makeStudent(caregiver.id);
      const portrait = await makeSymbol({ personImage: true });
      const { pkg } = await makePackageWithBoard(institute.id, author.id, portrait.id);
      await attachPackageToStudent({ packageId: pkg.id, studentId: student.id });
      expect(await canReadSymbolImage(portrait.id, caregiver.id)).toMatchObject({ allowed: true });

      const { detachPackageFromStudent } = await import(
        '../../services/packages/packageLinks.js'
      );
      await detachPackageFromStudent(pkg.id, student.id);

      expect(await canReadSymbolImage(portrait.id, caregiver.id)).toEqual({ allowed: false });
    });

    it('returns not-allowed for an unknown symbol rather than throwing', async () => {
      const user = await makeUser();
      expect(await canReadSymbolImage('00000000-0000-0000-0000-000000000000', user.id)).toEqual({
        allowed: false,
      });
    });
  });
});
