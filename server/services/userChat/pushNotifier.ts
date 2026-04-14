// Stub push notifier. Wired up via HTTP endpoint so a future mobile app can
// register tokens; actual delivery is a no-op until that app exists.

import type { UserChat } from "@shared/schema";

export interface PushNotifier {
  notifyNewMessage(recipients: string[], message: UserChat, senderName: string): Promise<void>;
  registerToken(userId: string, token: string, platform: string): Promise<void>;
  unregisterToken(userId: string, token: string): Promise<void>;
}

class NoopPushNotifier implements PushNotifier {
  async notifyNewMessage(recipients: string[], message: UserChat, _senderName: string): Promise<void> {
    console.log(
      `[pushNotifier] (stub) would notify ${recipients.length} recipient(s) about message ${message.id}`,
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
