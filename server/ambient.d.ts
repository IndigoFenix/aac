// Ambient module declarations for optional dependencies (lazy-loaded at runtime)
declare module "@googleapis/gmail" {
  export function gmail(options: any): any;
}

declare module "imapflow" {
  export class ImapFlow {
    constructor(options: any);
    connect(): Promise<void>;
    logout(): Promise<void>;
    getMailboxLock(mailbox: string): Promise<any>;
    download(uid: number): Promise<{ content: AsyncIterable<Buffer> }>;
    search(criteria: any, options?: any): Promise<number[]>;
    fetchOne(uid: number, options: any): Promise<any>;
  }
}

declare module "mailparser" {
  export function simpleParser(source: Buffer | string): Promise<{
    from?: { text: string; value: any[] };
    to?: { text: string; value: any[] };
    subject?: string;
    text?: string;
    html?: string;
    date?: Date;
    messageId?: string;
    attachments?: Array<{
      filename?: string;
      contentType: string;
      content: Buffer;
      size?: number;
      checksum?: string;
      cid?: string;
    }>;
  }>;
}

declare module "@replit/vite-plugin-dev-banner" {
  export function devBanner(): any;
}

declare module "uuid" {
  export function v4(): string;
  export function v1(): string;
  export function v3(name: string, namespace: string): string;
  export function v5(name: string, namespace: string): string;
}
