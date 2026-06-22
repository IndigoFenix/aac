// Stub push notifier. Wired up via HTTP endpoint so a future mobile app can
// register tokens; actual delivery is a no-op until that app exists.
//
// `recipients` are person ids. Real delivery (when implemented) resolves each
// recipient person to its delivery targets — the user facet's device tokens, or
// for a student-person the tokens of whichever users are fronting it.

import type { PersonChat } from "@shared/schema";

export interface PushNotifier {
  notifyNewMessage(recipientPersonIds: string[], message: PersonChat, senderName: string): Promise<void>;
  registerToken(userId: string, token: string, platform: string): Promise<void>;
  unregisterToken(userId: string, token: string): Promise<void>;
}

class NoopPushNotifier implements PushNotifier {
  async notifyNewMessage(recipientPersonIds: string[], message: PersonChat, _senderName: string): Promise<void> {
    console.log(
      `[pushNotifier] (stub) would notify ${recipientPersonIds.length} recipient(s) about message ${message.id}`,
    );
  }

  async registerToken(userId: string, _token: string, platform: string): Promise<void> {
    console.log(`[pushNotifier] (stub) registered ${platform} token for user ${userId}`);
  }

  async unregisterToken(userId: string, _token: string): Promise<void> {
    console.log(`[pushNotifier] (stub) unregistered token for user ${userId}`);
  }
}

export const pushNotifier: PushNotifier = new NoopPushNotifier();
