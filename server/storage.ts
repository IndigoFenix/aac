/**
 * Storage facade that maintains backwards compatibility
 * while delegating to the new repository layer.
 * 
 * This file can be used during migration to gradually move
 * code to use repositories directly.
 */

import { userRepository } from "./repositories/userRepository";
import { studentRepository } from "./repositories/studentRepository";
import { interpretationRepository } from "./repositories/interpretationRepository";
import { creditRepository } from "./repositories/creditRepository";
import { inviteCodeRepository } from "./repositories/inviteCodeRepository";
import { apiProviderRepository } from "./repositories/apiProviderRepository";
import { savedLocationRepository } from "./repositories/savedLocationRepository";
import { boardRepository } from "./repositories/boardRepository";
import { settingsRepository } from "./repositories/settingsRepository";
import { chatRepository } from "./repositories/chatRepository";
import { programRepository } from "./repositories/programRepository";

// Re-export all types
export * from "@shared/schema";

/**
 * Storage object that delegates to individual repositories.
 * Maintains the same interface as the original storage for backwards compatibility.
 */
export const storage = {
  // User operations
  getUser: userRepository.getUser.bind(userRepository),
  getUserByEmail: userRepository.getUserByEmail.bind(userRepository),
  getUserByGoogleId: userRepository.getUserByGoogleId.bind(userRepository),
  getUserByReferralCode: userRepository.getUserByReferralCode.bind(userRepository),
  createUser: userRepository.createUser.bind(userRepository),
  createGoogleUser: userRepository.createGoogleUser.bind(userRepository),
  getAllUsers: userRepository.getAllUsers.bind(userRepository),
  updateUser: userRepository.updateUser.bind(userRepository),
  updateUserOnboardingStep: userRepository.updateUserOnboardingStep.bind(userRepository),
  deleteUser: userRepository.deleteUser.bind(userRepository),
  getUsersStats: userRepository.getUsersStats.bind(userRepository),
  generateReferralCode: userRepository.generateReferralCode.bind(userRepository),

  // Admin user operations
  getAdminUser: settingsRepository.getAdminUser.bind(settingsRepository),
  upsertAdminUser: settingsRepository.upsertAdminUser.bind(settingsRepository),

  // AAC user (student) operations
  createStudent: studentRepository.createStudent.bind(studentRepository),
  getStudentsByUserId: studentRepository.getStudentsByUserId.bind(studentRepository),
  getStudentById: studentRepository.getStudentById.bind(studentRepository),
  getStudentByStudentId: studentRepository.getStudentByStudentId.bind(studentRepository),
  updateStudent: studentRepository.updateStudent.bind(studentRepository),
  deleteStudent: studentRepository.deleteStudent.bind(studentRepository),

  // User-Student link operations
  createUserStudentLink: studentRepository.createUserStudentLink.bind(studentRepository),
  getUserStudentLink: studentRepository.getUserStudentLink.bind(studentRepository),
  getUsersByStudentId: studentRepository.getUsersByStudentId.bind(studentRepository),
  updateUserStudentLink: studentRepository.updateUserStudentLink.bind(studentRepository),
  deactivateUserStudentLink: studentRepository.deactivateUserStudentLink.bind(studentRepository),
  userHasAccessToStudent: studentRepository.userHasAccessToStudent.bind(studentRepository),

  // Interpretation operations
  createInterpretation: interpretationRepository.createInterpretation.bind(interpretationRepository),
  getInterpretations: interpretationRepository.getInterpretations.bind(interpretationRepository),
  getInterpretationsByUser: interpretationRepository.getInterpretationsByUser.bind(interpretationRepository),
  getInterpretation: interpretationRepository.getInterpretation.bind(interpretationRepository),
  getAllInterpretationsWithUsers: interpretationRepository.getAllInterpretationsWithUsers.bind(interpretationRepository),
  deleteInterpretation: interpretationRepository.deleteInterpretation.bind(interpretationRepository),
  getInterpretationsStats: interpretationRepository.getInterpretationsStats.bind(interpretationRepository),
  getClinicalData: interpretationRepository.getClinicalData.bind(interpretationRepository),
  getClinicalMetrics: interpretationRepository.getClinicalMetrics.bind(interpretationRepository),
  getStudentHistory: interpretationRepository.getStudentHistory.bind(interpretationRepository),
  analyzeHistoricalPatterns: interpretationRepository.analyzeHistoricalPatterns.bind(interpretationRepository),

  // Credit operations
  createCreditTransaction: creditRepository.createCreditTransaction.bind(creditRepository),
  getUserCreditTransactions: creditRepository.getUserCreditTransactions.bind(creditRepository),
  updateUserCredits: creditRepository.updateUserCredits.bind(creditRepository),
  setUserCredits: creditRepository.setUserCredits.bind(creditRepository),
  rewardReferralBonus: creditRepository.rewardReferralBonus.bind(creditRepository),

  // Credit package operations
  createCreditPackage: creditRepository.createCreditPackage.bind(creditRepository),
  getAllCreditPackages: creditRepository.getAllCreditPackages.bind(creditRepository),
  getCreditPackage: creditRepository.getCreditPackage.bind(creditRepository),
  updateCreditPackage: creditRepository.updateCreditPackage.bind(creditRepository),
  deleteCreditPackage: creditRepository.deleteCreditPackage.bind(creditRepository),

  // Invite code operations
  createInviteCode: inviteCodeRepository.createInviteCode.bind(inviteCodeRepository),
  getInviteCode: inviteCodeRepository.getInviteCode.bind(inviteCodeRepository),
  getInviteCodesByUserId: inviteCodeRepository.getInviteCodesByUserId.bind(inviteCodeRepository),
  redeemInviteCode: inviteCodeRepository.redeemInviteCode.bind(inviteCodeRepository),
  getInviteCodeRedemptions: inviteCodeRepository.getInviteCodeRedemptions.bind(inviteCodeRepository),
  deactivateInviteCode: inviteCodeRepository.deactivateInviteCode.bind(inviteCodeRepository),

  // API provider operations
  createApiProvider: apiProviderRepository.createApiProvider.bind(apiProviderRepository),
  getApiProviders: apiProviderRepository.getApiProviders.bind(apiProviderRepository),
  getApiProvider: apiProviderRepository.getApiProvider.bind(apiProviderRepository),
  updateApiProvider: apiProviderRepository.updateApiProvider.bind(apiProviderRepository),
  createApiCall: apiProviderRepository.createApiCall.bind(apiProviderRepository),
  getApiCalls: apiProviderRepository.getApiCalls.bind(apiProviderRepository),
  getApiCallsByProvider: apiProviderRepository.getApiCallsByProvider.bind(apiProviderRepository),
  getApiCallsCount: apiProviderRepository.getApiCallsCount.bind(apiProviderRepository),
  getUserApiCalls: apiProviderRepository.getUserApiCalls.bind(apiProviderRepository),
  getApiCallsByDateRange: apiProviderRepository.getApiCallsByDateRange.bind(apiProviderRepository),
  getApiUsageStats: apiProviderRepository.getApiUsageStats.bind(apiProviderRepository),
  createApiProviderPricing: apiProviderRepository.createApiProviderPricing.bind(apiProviderRepository),
  getApiProviderPricing: apiProviderRepository.getApiProviderPricing.bind(apiProviderRepository),
  getAllActiveApiProviderPricing: apiProviderRepository.getAllActiveApiProviderPricing.bind(apiProviderRepository),
  updateApiProviderPricing: apiProviderRepository.updateApiProviderPricing.bind(apiProviderRepository),
  deactivateApiProviderPricing: apiProviderRepository.deactivateApiProviderPricing.bind(apiProviderRepository),

  // Saved location operations
  createSavedLocation: savedLocationRepository.createSavedLocation.bind(savedLocationRepository),
  getUserSavedLocations: savedLocationRepository.getUserSavedLocations.bind(savedLocationRepository),
  deleteSavedLocation: savedLocationRepository.deleteSavedLocation.bind(savedLocationRepository),

  // Board operations
  createBoard: boardRepository.createBoard.bind(boardRepository),
  getUserBoards: boardRepository.getUserBoards.bind(boardRepository),
  getBoard: boardRepository.getBoard.bind(boardRepository),
  updateBoard: boardRepository.updateBoard.bind(boardRepository),
  deleteBoard: boardRepository.deleteBoard.bind(boardRepository),

  // Settings operations
  getSetting: settingsRepository.getSetting.bind(settingsRepository),
  updateSetting: settingsRepository.updateSetting.bind(settingsRepository),
  getSystemPrompt: settingsRepository.getSystemPrompt.bind(settingsRepository),
  updateSystemPrompt: settingsRepository.updateSystemPrompt.bind(settingsRepository),

  // Password reset operations
  createPasswordResetToken: settingsRepository.createPasswordResetToken.bind(settingsRepository),
  getPasswordResetToken: settingsRepository.getPasswordResetToken.bind(settingsRepository),
  markTokenAsUsed: settingsRepository.markTokenAsUsed.bind(settingsRepository),
  cleanupExpiredTokens: settingsRepository.cleanupExpiredTokens.bind(settingsRepository),

  // Subscription plan operations
  createSubscriptionPlan: settingsRepository.createSubscriptionPlan.bind(settingsRepository),
  getAllSubscriptionPlans: settingsRepository.getAllSubscriptionPlans.bind(settingsRepository),
  updateSubscriptionPlan: settingsRepository.updateSubscriptionPlan.bind(settingsRepository),

  // ============================================================================
  // CHAT OPERATIONS
  // ============================================================================

  // Session operations
  createChatSession: chatRepository.createSession.bind(chatRepository),
  getChatSession: chatRepository.getSession.bind(chatRepository),
  getChatSessionsByUserId: chatRepository.getSessionsByUserId.bind(chatRepository),
  getChatSessionsByStudentId: chatRepository.getSessionsByStudentId.bind(chatRepository),
  getChatSessionsByUserStudentId: chatRepository.getSessionsByUserStudentId.bind(chatRepository),
  getOpenChatSessions: chatRepository.getOpenSessions.bind(chatRepository),
  updateChatSession: chatRepository.updateSession.bind(chatRepository),
  deleteChatSession: chatRepository.deleteSession.bind(chatRepository),
  updateChatSessionState: chatRepository.updateSessionState.bind(chatRepository),
  updateChatSessionCredits: chatRepository.updateSessionCredits.bind(chatRepository),
  updateChatSessionLast: chatRepository.updateSessionLast.bind(chatRepository),
  updateChatSessionStatus: chatRepository.updateSessionStatus.bind(chatRepository),
  getRecentChatSessionsForContext: chatRepository.getRecentSessionsForContext.bind(chatRepository),

  // ============================================================================
  // IEP/TALA PROGRAM OPERATIONS
  // ============================================================================

  // Program operations
  createProgram: programRepository.createProgram.bind(programRepository),
  getProgramById: programRepository.getProgramById.bind(programRepository),
  getProgramsByStudentId: programRepository.getProgramsByStudentId.bind(programRepository),
  getCurrentProgram: programRepository.getCurrentProgram.bind(programRepository),
  updateProgram: programRepository.updateProgram.bind(programRepository),
  deleteProgram: programRepository.deleteProgram.bind(programRepository),
  getProgramWithDetails: programRepository.getProgramWithDetails.bind(programRepository),

  // Profile domain operations
  createProfileDomain: programRepository.createProfileDomain.bind(programRepository),
  getProfileDomainById: programRepository.getProfileDomainById.bind(programRepository),
  getProfileDomainsByProgramId: programRepository.getProfileDomainsByProgramId.bind(programRepository),
  updateProfileDomain: programRepository.updateProfileDomain.bind(programRepository),
  deleteProfileDomain: programRepository.deleteProfileDomain.bind(programRepository),

  // Baseline measurement operations
  createBaselineMeasurement: programRepository.createBaselineMeasurement.bind(programRepository),
  getBaselineMeasurementsByDomainId: programRepository.getBaselineMeasurementsByDomainId.bind(programRepository),
  deleteBaselineMeasurement: programRepository.deleteBaselineMeasurement.bind(programRepository),

  // Assessment source operations
  createAssessmentSource: programRepository.createAssessmentSource.bind(programRepository),
  getAssessmentSourcesByDomainId: programRepository.getAssessmentSourcesByDomainId.bind(programRepository),
  deleteAssessmentSource: programRepository.deleteAssessmentSource.bind(programRepository),

  // Goal operations
  createGoal: programRepository.createGoal.bind(programRepository),
  getGoalById: programRepository.getGoalById.bind(programRepository),
  getGoalsByProgramId: programRepository.getGoalsByProgramId.bind(programRepository),
  getGoalsByDomainId: programRepository.getGoalsByDomainId.bind(programRepository),
  updateGoal: programRepository.updateGoal.bind(programRepository),
  deleteGoal: programRepository.deleteGoal.bind(programRepository),
  getGoalWithContext: programRepository.getGoalWithContext.bind(programRepository),

  // Objective operations
  createObjective: programRepository.createObjective.bind(programRepository),
  getObjectiveById: programRepository.getObjectiveById.bind(programRepository),
  getObjectivesByGoalId: programRepository.getObjectivesByGoalId.bind(programRepository),
  updateObjective: programRepository.updateObjective.bind(programRepository),
  deleteObjective: programRepository.deleteObjective.bind(programRepository),

  // Service operations
  createService: programRepository.createService.bind(programRepository),
  getServiceById: programRepository.getServiceById.bind(programRepository),
  getServicesByProgramId: programRepository.getServicesByProgramId.bind(programRepository),
  updateService: programRepository.updateService.bind(programRepository),
  deleteService: programRepository.deleteService.bind(programRepository),
  linkServiceToGoal: programRepository.linkServiceToGoal.bind(programRepository),
  unlinkServiceFromGoal: programRepository.unlinkServiceFromGoal.bind(programRepository),

  // Accommodation operations
  createAccommodation: programRepository.createAccommodation.bind(programRepository),
  getAccommodationsByServiceId: programRepository.getAccommodationsByServiceId.bind(programRepository),
  getAccommodationsByProgramId: programRepository.getAccommodationsByProgramId.bind(programRepository),
  updateAccommodation: programRepository.updateAccommodation.bind(programRepository),
  deleteAccommodation: programRepository.deleteAccommodation.bind(programRepository),

  // Progress report operations
  createProgressReport: programRepository.createProgressReport.bind(programRepository),
  getProgressReportById: programRepository.getProgressReportById.bind(programRepository),
  getProgressReportsByProgramId: programRepository.getProgressReportsByProgramId.bind(programRepository),
  updateProgressReport: programRepository.updateProgressReport.bind(programRepository),
  deleteProgressReport: programRepository.deleteProgressReport.bind(programRepository),

  // Goal progress entry operations
  createGoalProgressEntry: programRepository.createGoalProgressEntry.bind(programRepository),
  getGoalProgressEntriesByReportId: programRepository.getGoalProgressEntriesByReportId.bind(programRepository),
  getGoalProgressEntriesByGoalId: programRepository.getGoalProgressEntriesByGoalId.bind(programRepository),

  // Data point operations
  createDataPoint: programRepository.createDataPoint.bind(programRepository),
  getDataPointsByGoalId: programRepository.getDataPointsByGoalId.bind(programRepository),
  getDataPointsByObjectiveId: programRepository.getDataPointsByObjectiveId.bind(programRepository),
  deleteDataPoint: programRepository.deleteDataPoint.bind(programRepository),

  // Transition plan operations
  createTransitionPlan: programRepository.createTransitionPlan.bind(programRepository),
  getTransitionPlanByProgramId: programRepository.getTransitionPlanByProgramId.bind(programRepository),
  updateTransitionPlan: programRepository.updateTransitionPlan.bind(programRepository),
  deleteTransitionPlan: programRepository.deleteTransitionPlan.bind(programRepository),

  // Transition goal operations
  createTransitionGoal: programRepository.createTransitionGoal.bind(programRepository),
  getTransitionGoalsByPlanId: programRepository.getTransitionGoalsByPlanId.bind(programRepository),
  updateTransitionGoal: programRepository.updateTransitionGoal.bind(programRepository),
  deleteTransitionGoal: programRepository.deleteTransitionGoal.bind(programRepository),

  // Team member operations
  createTeamMember: programRepository.createTeamMember.bind(programRepository),
  getTeamMemberById: programRepository.getTeamMemberById.bind(programRepository),
  getTeamMembersByProgramId: programRepository.getTeamMembersByProgramId.bind(programRepository),
  updateTeamMember: programRepository.updateTeamMember.bind(programRepository),
  deleteTeamMember: programRepository.deleteTeamMember.bind(programRepository),

  // Meeting operations
  createMeeting: programRepository.createMeeting.bind(programRepository),
  getMeetingById: programRepository.getMeetingById.bind(programRepository),
  getMeetingsByProgramId: programRepository.getMeetingsByProgramId.bind(programRepository),
  updateMeeting: programRepository.updateMeeting.bind(programRepository),
  deleteMeeting: programRepository.deleteMeeting.bind(programRepository),

  // Consent form operations
  createConsentForm: programRepository.createConsentForm.bind(programRepository),
  getConsentFormById: programRepository.getConsentFormById.bind(programRepository),
  getConsentFormsByProgramId: programRepository.getConsentFormsByProgramId.bind(programRepository),
  updateConsentForm: programRepository.updateConsentForm.bind(programRepository),
  deleteConsentForm: programRepository.deleteConsentForm.bind(programRepository),

  // Aggregate operations
  calculateProgramProgress: programRepository.calculateProgramProgress.bind(programRepository),
  getProgramsWithUpcomingDeadlines: programRepository.getProgramsWithUpcomingDeadlines.bind(programRepository),
  getGoalStatusCounts: programRepository.getGoalStatusCounts.bind(programRepository),
};

export type Storage = typeof storage;