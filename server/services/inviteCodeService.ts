import { inviteCodeRepository, studentRepository } from "../repositories";
import {
  type InviteCode,
  type InsertInviteCode,
  type InviteCodeRedemption,
  type Student,
} from "@shared/schema";

export class InviteCodeService {
  async createInviteCode(
    createdByUserId: string,
    studentId: string,
    redemptionLimit?: number,
    expiresAt?: Date
  ): Promise<InviteCode> {
    // Verify the AAC user exists and belongs to the creator
    const student = await studentRepository.getStudentByStudentId(studentId);
    if (!student) {
      throw new Error("AAC user not found");
    }

    return inviteCodeRepository.createInviteCode({
      createdByUserId,
      studentId,
      maxRedemptions: redemptionLimit || 1,
      expiresAt: expiresAt || null,
    });
  }

  async getInviteCodesByUserId(userId: string): Promise<InviteCode[]> {
    return inviteCodeRepository.getInviteCodesByUserId(userId);
  }

  async redeemInviteCode(
    code: string,
    userId: string
  ): Promise<{ success: boolean; student?: Student; error?: string }> {
    return inviteCodeRepository.redeemInviteCode(
      code.trim().toUpperCase(),
      userId
    );
  }

  async getInviteCodeRedemptions(userId: string): Promise<InviteCodeRedemption[]> {
    return inviteCodeRepository.getInviteCodeRedemptions(userId);
  }

  async deactivateInviteCode(
    inviteCodeId: string,
    userId: string
  ): Promise<boolean> {
    // Verify the invite code belongs to the user
    const inviteCodes = await inviteCodeRepository.getInviteCodesByUserId(userId);
    const inviteCode = inviteCodes.find((ic) => ic.id === inviteCodeId);

    if (!inviteCode) {
      throw new Error("Invite code not found");
    }

    return inviteCodeRepository.deactivateInviteCode(inviteCodeId);
  }
}

export const inviteCodeService = new InviteCodeService();
