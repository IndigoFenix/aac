/**
 * Storage facade that maintains backwards compatibility
 * while delegating to the new repository layer.
 * 
 * This file can be used during migration to gradually move
 * code to use repositories directly.
 */

import { userRepository } from "./repositories/userRepository";
import { aacUserRepository } from "./repositories/aacUserRepository";
import { interpretationRepository } from "./repositories/interpretationRepository";
import { creditRepository } from "./repositories/creditRepository";
import { inviteCodeRepository } from "./repositories/inviteCodeRepository";
import { apiProviderRepository } from "./repositories/apiProviderRepository";
import { savedLocationRepository } from "./repositories/savedLocationRepository";
import { boardRepository } from "./repositories/boardRepository";
import { settingsRepository } from "./repositories/settingsRepository";
import { chatRepository } from "./repositories/chatRepository";

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

  // AAC user operations
  createAacUser: aacUserRepository.createAacUser.bind(aacUserRepository),
  getAacUsersByUserId: aacUserRepository.getAacUsersByUserId.bind(aacUserRepository),
  getAacUserByAacUserId: aacUserRepository.getAacUserByAacUserId.bind(aacUserRepository),
  updateAacUser: aacUserRepository.updateAacUser.bind(aacUserRepository),
  deleteAacUser: aacUserRepository.deleteAacUser.bind(aacUserRepository),

  // AAC schedule operations
  createScheduleEntry: aacUserRepository.createScheduleEntry.bind(aacUserRepository),
  getSchedulesByAacUserId: aacUserRepository.getSchedulesByAacUserId.bind(aacUserRepository),
  getScheduleEntry: aacUserRepository.getScheduleEntry.bind(aacUserRepository),
  updateScheduleEntry: aacUserRepository.updateScheduleEntry.bind(aacUserRepository),
  deleteScheduleEntry: aacUserRepository.deleteScheduleEntry.bind(aacUserRepository),
  getCurrentScheduleContext: aacUserRepository.getCurrentScheduleContext.bind(aacUserRepository),

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
  getAacUserHistory: interpretationRepository.getAacUserHistory.bind(interpretationRepository),
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
  getPlan: boardRepository.getPlan.bind(boardRepository),
  createOrUpdatePlan: boardRepository.createOrUpdatePlan.bind(boardRepository),
  getOrCreateUsageWindow: boardRepository.getOrCreateUsageWindow.bind(boardRepository),
  incrementUsage: boardRepository.incrementUsage.bind(boardRepository),
  logPrompt: boardRepository.logPrompt.bind(boardRepository),
  getUserPromptHistory: boardRepository.getUserPromptHistory.bind(boardRepository),
  markPromptAsDownloaded: boardRepository.markPromptAsDownloaded.bind(boardRepository),
  createPromptEvent: boardRepository.createPromptEvent.bind(boardRepository),
  getAnalyticsData: boardRepository.getAnalyticsData.bind(boardRepository),

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
  getChatSessionsByAacUserId: chatRepository.getSessionsByAacUserId.bind(chatRepository),
  getChatSessionsByUserAacUserId: chatRepository.getSessionsByUserAacUserId.bind(chatRepository),
  getOpenChatSessions: chatRepository.getOpenSessions.bind(chatRepository),
  updateChatSession: chatRepository.updateSession.bind(chatRepository),
  deleteChatSession: chatRepository.deleteSession.bind(chatRepository),
  updateChatSessionState: chatRepository.updateSessionState.bind(chatRepository),
  updateChatSessionCredits: chatRepository.updateSessionCredits.bind(chatRepository),
  updateChatSessionLast: chatRepository.updateSessionLast.bind(chatRepository),
  updateChatSessionStatus: chatRepository.updateSessionStatus.bind(chatRepository),
  getRecentChatSessionsForContext: chatRepository.getRecentSessionsForContext.bind(chatRepository),
};

export type Storage = typeof storage;