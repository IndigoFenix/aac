// email-agent-runtime.ts
// Lambda-friendly runtime: dynamic imports, small surface, no heavy libs at top-level.

import crypto from "crypto";

// ──────────────────────────────────────────────────────────────────────────────
// Shared minimal types (no heavy type imports)
// ──────────────────────────────────────────────────────────────────────────────
export type Provider = "gmail-api" | "imap" | "smtp-only";

export type JSONSchema =
  | { $ref: string }
  | ({
      type?: "string" | "number" | "integer" | "boolean" | "null" | "object" | "array" | (string & {});
      description?: string;
      enum?: (string | number | boolean | null)[];
      default?: unknown;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      minimum?: number;
      maximum?: number;
      properties?: Record<string, JSONSchema>;
      required?: string[];
      additionalProperties?: boolean | JSONSchema;
      items?: JSONSchema;
      minItems?: number;
      maxItems?: number;
      oneOf?: JSONSchema[];
      anyOf?: JSONSchema[];
      allOf?: JSONSchema[];
    } & Record<string, unknown>);

export type EmailRules = {
  provider: Provider;
  access: {
    gmail?: { clientId: string; clientSecret: string; refreshToken: string };
    imap?: { host: string; port: number; secure: boolean; username: string; password: string; mailbox?: string };
    smtp?: { host: string; port: number; secure: boolean; username: string; password: string };
  };
  identity: {
    fromAddress: string;
    displayName?: string;
    replyTo?: string;
    dkim?: { domainName: string; keySelector: string; privateKey: string };
  };
  templates: Array<{
    name: string;
    subject: string;
    html?: string;
    text?: string;
    variablesSchema: JSONSchema;
    defaultVars?: Record<string, any>;
    defaultAttachments?: Array<{ filename: string; path?: string; cid?: string; contentType?: string }>;
  }>;
  allowNonTemplated: boolean;
  allowedRecipients: "unrestricted" | string[];
  allowedDomains?: string[];
  autoApprovedRecipients: "all" | string[];
  limits?: { maxSendsPerRun?: number; maxReadsPerRun?: number; rateLimitPerMinute?: number; maxAttachmentMB?: number };
  threading?: { preferThreads: boolean };
  pagination?: { pageSize?: number };
  style?: { signature?: string };
};

type AttachmentInput = {
  filename: string;
  path?: string;
  fileRef?: string;
  contentBase64?: string;
  contentType?: string;
  cid?: string;
  encoding?: string;
};

type DraftEmail = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  template?: { name: string; variables: Record<string, any> };
  attachments?: AttachmentInput[];
  replyToMessageId?: string;
};

// ──────────────────────────────────────────────────────────────────────────────
// App-provided deps
// ──────────────────────────────────────────────────────────────────────────────
export interface ApprovalsService {
  requestApproval(input: {
    draftId?: string;
    draft?: DraftEmail;
    idempotencyKey: string;
    reason?: string;
  }): Promise<{ approvalId: string }>;
  hasApproval?(
    approvalId: string
  ): Promise<"approved" | "rejected" | "pending">;
}

export interface CheckpointStore {
  save(scope: string, data: any): Promise<void>;
  load(scope: string): Promise<any | null>;
}

export interface FileStore {
  save(opts: { filename: string; content: Buffer; contentType?: string }): Promise<{ fileRef: string; size: number }>;
}

export interface Logger {
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
}

export type RuntimeDeps = {
  approvals: ApprovalsService;
  checkpoints: CheckpointStore;
  files?: FileStore;
  now?: () => Date;
  logger?: Logger;
  gmailClientFactory?: (rules: EmailRules) => Promise<{ gmail: any }>;
  imapClientFactory?: (rules: EmailRules) => Promise<any>;
  smtpTransportFactory?: (rules: EmailRules) => Promise<any>;
};

// ──────────────────────────────────────────────────────────────────────────────
// Factory: returns tool handlers (LLM-visible payloads only)
// ──────────────────────────────────────────────────────────────────────────────
export function makeEmailToolRuntime(rules: EmailRules, deps: RuntimeDeps) {
  const logger = deps.logger ?? console;
  const limits = {
    maxSendsPerRun: rules.limits?.maxSendsPerRun ?? 20,
    maxReadsPerRun: rules.limits?.maxReadsPerRun ?? 200,
    rateLimitPerMinute: rules.limits?.rateLimitPerMinute ?? 60,
    maxAttachmentMB: rules.limits?.maxAttachmentMB ?? 20,
  };
  const pageSize = Math.min(Math.max(rules.pagination?.pageSize ?? 25, 1), 200);

  const drafts = new DraftStore(deps.checkpoints, logger);
  const checkpoints = new CheckpointUtil(deps.checkpoints);

  // Choose provider (all heavy modules are loaded lazily inside provider methods)
  const readProvider: ReadProvider =
    rules.provider === "gmail-api"
      ? new GmailProvider(rules, deps, logger)
      : rules.provider === "imap"
      ? new ImapProvider(rules, deps, logger)
      : new NoopReadProvider();

  const sender = new Sender(rules, deps, logger);

  return {
    // Mailboxes/labels
    async email_list_mailboxes_or_labels({ cursor, pageSize: ps }: any) {
      try {
        const size = Math.min(Math.max(ps ?? pageSize, 1), 200);
        const res = await readProvider.listMailboxesOrLabels({ cursor, pageSize: size });
        return ok(res);
      } catch (e) {
        return err("MAILBOX_LIST_FAILED", asMsg(e));
      }
    },

    // Threads
    async email_list_threads(args: any) {
      try {
        const size = Math.min(Math.max(args?.pageSize ?? pageSize, 1), 200);
        const res = await readProvider.listThreads({
          query: args?.query,
          labelOrMailbox: args?.labelOrMailbox,
          since: args?.since,
          cursor: args?.cursor,
          pageSize: size,
          includeSnippet: !!args?.includeSnippet,
          maxReads: limits.maxReadsPerRun,
        });
        return ok(res);
      } catch (e) {
        return err("THREAD_LIST_FAILED", asMsg(e));
      }
    },

    async email_get_thread({ threadId, includeBodies, includeAttachments, maxMessages }: any) {
      try {
        const res = await readProvider.getThread({
          threadId,
          includeBodies: !!includeBodies,
          includeAttachments: !!includeAttachments,
          maxMessages: maxMessages ?? 200,
        });
        return ok(res);
      } catch (e) {
        return err("THREAD_GET_FAILED", asMsg(e));
      }
    },

    // Messages
    async email_list_messages(args: any) {
      try {
        const size = Math.min(Math.max(args?.pageSize ?? pageSize, 1), 200);
        const res = await readProvider.listMessages({
          query: args?.query,
          labelOrMailbox: args?.labelOrMailbox,
          since: args?.since,
          cursor: args?.cursor,
          pageSize: size,
          includeSnippet: !!args?.includeSnippet,
          maxReads: limits.maxReadsPerRun,
        });
        return ok(res);
      } catch (e) {
        return err("MESSAGE_LIST_FAILED", asMsg(e));
      }
    },

    async email_get_message({ messageId, includeBody, includeAttachments }: any) {
      try {
        const res = await readProvider.getMessage({
          messageId,
          includeBody: !!includeBody,
          includeAttachments: !!includeAttachments,
        });
        return ok(res);
      } catch (e) {
        return err("MESSAGE_GET_FAILED", asMsg(e));
      }
    },

    async email_download_attachment({ messageId, attachmentId }: any) {
      try {
        if (!deps.files) return err("NO_FILE_STORE", "Attachment store is not configured.");
        const res = await readProvider.downloadAttachment({ messageId, attachmentId });
        if (!res) return err("ATTACHMENT_NOT_FOUND", "Attachment not found.");
        const saved = await deps.files.save({
          filename: res.filename,
          content: res.content,
          contentType: res.contentType,
        });
        return ok({ fileRef: saved.fileRef, filename: res.filename, size: saved.size, contentType: res.contentType });
      } catch (e) {
        return err("ATTACHMENT_DOWNLOAD_FAILED", asMsg(e));
      }
    },

    // Labels/folders
    async email_mark_read({ messageId }: any) {
      try {
        await readProvider.markRead({ messageId });
        return ok({ messageId, status: "read" });
      } catch (e) {
        return err("MARK_READ_FAILED", asMsg(e));
      }
    },

    async email_move_to({ messageId, mailboxOrLabel }: any) {
      try {
        await readProvider.moveTo({ messageId, mailboxOrLabel });
        return ok({ messageId, movedTo: mailboxOrLabel });
      } catch (e) {
        return err("MOVE_FAILED", asMsg(e));
      }
    },

    async email_add_label({ messageId, label }: any) {
      try {
        await readProvider.addLabel({ messageId, label });
        return ok({ messageId, label, added: true });
      } catch (e) {
        return err("ADD_LABEL_FAILED", asMsg(e));
      }
    },

    async email_remove_label({ messageId, label }: any) {
      try {
        await readProvider.removeLabel({ messageId, label });
        return ok({ messageId, label, removed: true });
      } catch (e) {
        return err("REMOVE_LABEL_FAILED", asMsg(e));
      }
    },

    // Draft/save + approvals + send
    async email_save_draft(input: any) {
      try {
        // Validate template vars (lightweight)
        if (input?.template) {
          const t = findTemplate(rules, input.template.name);
          if (!t) return err("TEMPLATE_NOT_FOUND", `Template '${input.template.name}' not configured.`);
          const v = validateVarsLight(t.variablesSchema, input.template.variables);
          if (!v.ok) return err("TEMPLATE_VARS_INVALID", v.message || "Variables failed validation.");
        }
        const draftId = await drafts.createOrUpdate(input?.draftId, {
          to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject,
          text: input.text, html: input.html, template: input.template,
          attachments: input.attachments, replyToMessageId: input.replyToMessageId, note: input.note,
        });
        return ok({ draftId });
      } catch (e) {
        return err("DRAFT_SAVE_FAILED", asMsg(e));
      }
    },

    async email_compute_idempotency_key(input: any) {
      try {
        const key = computeIdempotencyKey({
          from: rules.identity.fromAddress,
          to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject,
          text: input.text, html: input.html, template: input.template,
          attachments: input.attachments, replyToMessageId: input.replyToMessageId,
        });
        return ok({ idempotencyKey: key });
      } catch (e) {
        return err("IDEMPOTENCY_FAILED", asMsg(e));
      }
    },

    async email_request_approval({ draftId, draft, idempotencyKey, reason }: any) {
      try {
        const res = await deps.approvals.requestApproval({ draftId, draft, idempotencyKey, reason });
        return ok({ approvalId: res.approvalId });
      } catch (e) {
        return err("APPROVAL_REQUEST_FAILED", asMsg(e));
      }
    },

    async email_send_email(input: any) {
      try {
        const sendResult = await sender.send(input, drafts);
        return ok(sendResult);
      } catch (e) {
        return err("SEND_FAILED", asMsg(e));
      }
    },

    // Search
    async email_search({ query, labelOrMailbox, cursor, pageSize: ps }: any) {
      try {
        if (!query || typeof query !== "string" || !query.trim()) return err("BAD_INPUT", "Query is required.");
        const size = Math.min(Math.max(ps ?? pageSize, 1), 200);
        const res = await readProvider.search({
          query, labelOrMailbox, cursor, pageSize: size, includeSnippet: true, maxReads: limits.maxReadsPerRun,
        });
        return ok(res);
      } catch (e) {
        return err("SEARCH_FAILED", asMsg(e));
      }
    },

    // Checkpoints
    async email_save_checkpoint({ data }: any) {
      try { await checkpoints.save("email", data); return ok({ saved: true }); }
      catch (e) { return err("CHECKPOINT_SAVE_FAILED", asMsg(e)); }
    },

    async email_load_checkpoint() {
      try { const data = await checkpoints.load("email"); return ok({ data }); }
      catch (e) { return err("CHECKPOINT_LOAD_FAILED", asMsg(e)); }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Providers (dynamic imports inside methods)
// ──────────────────────────────────────────────────────────────────────────────
type ListArgs = {
  query?: string;
  labelOrMailbox?: string;
  since?: string;
  cursor?: string;
  pageSize: number;
  includeSnippet?: boolean;
  maxReads?: number;
};
type GetThreadArgs = { threadId: string; includeBodies: boolean; includeAttachments: boolean; maxMessages: number };
type GetMsgArgs = { messageId: string; includeBody: boolean; includeAttachments: boolean };
type DownloadArgs = { messageId: string; attachmentId: string };
type ModifyArgs = { messageId: string; label?: string; mailboxOrLabel?: string };

type ReadProvider = {
  listMailboxesOrLabels(args: { cursor?: string; pageSize: number }): Promise<{ items: any[]; nextCursor?: string }>;
  listThreads(args: ListArgs): Promise<{ items: any[]; nextCursor?: string }>;
  getThread(args: GetThreadArgs): Promise<any>;
  listMessages(args: ListArgs): Promise<{ items: any[]; nextCursor?: string }>;
  getMessage(args: GetMsgArgs): Promise<any>;
  downloadAttachment(args: DownloadArgs): Promise<{ filename: string; contentType?: string; content: Buffer } | null>;
  markRead(args: { messageId: string }): Promise<void>;
  moveTo(args: { messageId: string; mailboxOrLabel: string }): Promise<void>;
  addLabel(args: ModifyArgs): Promise<void>;
  removeLabel(args: ModifyArgs): Promise<void>;
  search(args: ListArgs): Promise<{ items: any[]; nextCursor?: string }>;
};

// Gmail provider — uses modular packages and dynamic imports
class GmailProvider implements ReadProvider {
  private rules: EmailRules;
  private deps: RuntimeDeps;
  private logger: Logger;
  private gmail?: any;
  private labelMap: Map<string, string> = new Map();

  constructor(rules: EmailRules, deps: RuntimeDeps, logger: Logger) {
    this.rules = rules; this.deps = deps; this.logger = logger;
  }

  private async api() {
    if (this.gmail) return this.gmail;
    if (this.deps.gmailClientFactory) {
      const { gmail } = await this.deps.gmailClientFactory(this.rules);
      this.gmail = gmail;
    } else {
      // Lazy import modular libs
      const { gmail } = await import("@googleapis/gmail");
      const { OAuth2Client } = await import("google-auth-library");
      if (!this.rules.access.gmail) throw new Error("Gmail credentials are missing.");
      const oauth2 = new OAuth2Client(this.rules.access.gmail.clientId, this.rules.access.gmail.clientSecret);
      oauth2.setCredentials({ refresh_token: this.rules.access.gmail.refreshToken });
      this.gmail = gmail({ version: "v1", auth: oauth2 });
    }
    await this.refreshLabelMap();
    return this.gmail;
  }

  private async refreshLabelMap() {
    const gmail = await this.api();
    const res = await gmail.users.labels.list({ userId: "me" }); // no pagination here
    this.labelMap.clear();
    for (const l of (res.data?.labels ?? [])) if (l?.name && l?.id) this.labelMap.set(l.name, l.id);
  }

  private labelIdsFor(name?: string): string[] | undefined {
    if (!name) return undefined;
    const id = this.labelMap.get(name) ?? name;
    return id ? [id] : undefined;
    }

  async listMailboxesOrLabels(_: { cursor?: string; pageSize: number }) {
    const gmail = await this.api();
    const res = await gmail.users.labels.list({ userId: "me" });
    const items = (res.data?.labels ?? []).map((l: any) => ({ id: l.id, name: l.name, type: l.type }));
    return { items, nextCursor: undefined };
  }

  async listThreads(args: ListArgs) {
    const gmail = await this.api();
    const q = buildGmailQuery(args.query, args.since);
    const { data } = await gmail.users.threads.list({
      userId: "me",
      q,
      labelIds: this.labelIdsFor(args.labelOrMailbox),
      pageToken: args.cursor,
      maxResults: args.pageSize,
    });
    const items = (data.threads ?? []).map((t: any) => ({ threadId: t.id, snippet: t.snippet }));
    return { items, nextCursor: data.nextPageToken ?? undefined };
  }

  async getThread({ threadId, includeBodies, includeAttachments, maxMessages }: GetThreadArgs) {
    const gmail = await this.api();
    const { data } = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: includeBodies ? "full" : "metadata",
      metadataHeaders: ["From","To","Cc","Bcc","Subject","Date","Message-Id","In-Reply-To","References"],
    });
    const msgs = (data.messages ?? []).slice(-maxMessages);
    const normalized = await Promise.all(msgs.map((m: any) => this.normalizeMessage(m, includeBodies, includeAttachments)));
    return { threadId, historyId: data.historyId, messages: normalized };
  }

  async listMessages(args: ListArgs) {
    const gmail = await this.api();
    const q = buildGmailQuery(args.query, args.since);
    const { data } = await gmail.users.messages.list({
      userId: "me",
      q,
      labelIds: this.labelIdsFor(args.labelOrMailbox),
      pageToken: args.cursor,
      maxResults: args.pageSize,
    });
    const items = (data.messages ?? []).map((m: any) => ({ messageId: m.id, threadId: m.threadId }));
    return { items, nextCursor: data.nextPageToken ?? undefined };
  }

  async getMessage({ messageId, includeBody, includeAttachments }: GetMsgArgs) {
    const gmail = await this.api();
    const { data } = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: includeBody ? "full" : "metadata",
      metadataHeaders: ["From","To","Cc","Bcc","Subject","Date","Message-Id","In-Reply-To","References"],
    });
    return this.normalizeMessage(data, includeBody, includeAttachments);
  }

  async downloadAttachment({ messageId, attachmentId }: DownloadArgs) {
    const gmail = await this.api();
    const { data } = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
    const buf = data.data ? Buffer.from(data.data, "base64") : Buffer.alloc(0);
    return { filename: `attachment-${attachmentId}`, contentType: undefined, content: buf };
  }

  async markRead({ messageId }: { messageId: string }) {
    const gmail = await this.api();
    await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: { removeLabelIds: ["UNREAD"] } });
  }

  async moveTo({ messageId, mailboxOrLabel }: { messageId: string; mailboxOrLabel: string }) {
    const gmail = await this.api();
    const labelId = this.labelMap.get(mailboxOrLabel) ?? mailboxOrLabel;
    await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: { addLabelIds: labelId ? [labelId] : undefined } });
  }

  async addLabel({ messageId, label }: ModifyArgs) {
    const gmail = await this.api();
    const labelId = this.labelMap.get(label!) ?? label!;
    await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: { addLabelIds: labelId ? [labelId] : undefined } });
  }

  async removeLabel({ messageId, label }: ModifyArgs) {
    const gmail = await this.api();
    const labelId = this.labelMap.get(label!) ?? label!;
    await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: { removeLabelIds: labelId ? [labelId] : undefined } });
  }

  async search(args: ListArgs) { return this.listMessages(args); }

  private headerValue(headers: any[], name: string): string | undefined {
    const h = headers?.find((x: any) => x.name?.toLowerCase() === name.toLowerCase());
    return h?.value;
  }

  private async normalizeMessage(data: any, includeBody: boolean, includeAttachments: boolean) {
    const headers = data.payload?.headers ?? [];
    const parts = data.payload?.parts ?? [];
    const subject = this.headerValue(headers, "Subject");
    const from = this.headerValue(headers, "From");
    const to = this.headerValue(headers, "To");
    const cc = this.headerValue(headers, "Cc");
    const bcc = this.headerValue(headers, "Bcc");
    const date = this.headerValue(headers, "Date");
    const messageId = this.headerValue(headers, "Message-Id");
    const inReplyTo = this.headerValue(headers, "In-Reply-To");
    const references = this.headerValue(headers, "References");

    let text: string | undefined;
    let html: string | undefined;
    let attachments: any[] | undefined;

    if (includeBody) {
      const { textBody, htmlBody } = extractBodiesFromGmailPayload(data.payload);
      text = textBody; html = htmlBody;
    }
    if (includeAttachments) attachments = collectAttachmentMetaFromGmailPayload(parts, data.id);

    return {
      messageId: data.id,
      threadId: data.threadId,
      subject, from, to, cc, bcc, date,
      headers,
      messageIdHeader: messageId,
      inReplyTo, references,
      snippet: data.snippet,
      text, html, attachments,
    };
  }
}

// IMAP provider — loaded only when used
class ImapProvider implements ReadProvider {
  private rules: EmailRules;
  private deps: RuntimeDeps;
  private logger: Logger;
  private client?: any;

  constructor(rules: EmailRules, deps: RuntimeDeps, logger: Logger) {
    this.rules = rules; this.deps = deps; this.logger = logger;
  }

  private async api() {
    if (this.client) return this.client;
    if (!this.rules.access.imap) throw new Error("IMAP settings missing.");
    if (this.deps.imapClientFactory) {
      this.client = await this.deps.imapClientFactory(this.rules);
    } else {
      const { ImapFlow } = await import("imapflow");
      this.client = new ImapFlow({
        host: this.rules.access.imap.host,
        port: this.rules.access.imap.port,
        secure: this.rules.access.imap.secure,
        auth: { user: this.rules.access.imap.username, pass: this.rules.access.imap.password },
      });
      await this.client.connect();
    }
    return this.client;
  }

  async listMailboxesOrLabels(_: { cursor?: string; pageSize: number }) {
    const imap = await this.api();
    const boxes: any[] = [];
    for await (const mailbox of imap.list()) boxes.push({ name: mailbox.path, flags: mailbox.flags ?? [] });
    return { items: boxes, nextCursor: undefined };
  }

  async listThreads(args: ListArgs) { return this.listMessages(args); }

  async getThread({ threadId, includeBodies, includeAttachments, maxMessages }: GetThreadArgs) {
    const msg = await this.getMessage({ messageId: threadId, includeBody: includeBodies, includeAttachments });
    return { threadId, messages: [msg] };
  }

  async listMessages(args: ListArgs) {
    const imap = await this.api();
    const mailbox = args.labelOrMailbox ?? this.rules.access.imap?.mailbox ?? "INBOX";
    await imap.mailboxOpen(mailbox);

    const criteria: any = {};
    if (args.since && !isNaN(Date.parse(args.since))) criteria.since = new Date(args.since);
    if (args.query) criteria.text = args.query;

    const uids: number[] = await imap.search(criteria, { uid: true });
    const slice = uids.slice(Math.max(0, uids.length - args.pageSize));
    const items = slice.map(uid => ({ messageId: String(uid) }));
    return { items, nextCursor: undefined };
  }

  async getMessage({ messageId, includeBody, includeAttachments }: GetMsgArgs) {
    const imap = await this.api();
    const mailbox = this.rules.access.imap?.mailbox ?? "INBOX";
    await imap.mailboxOpen(mailbox);
    const uid = Number(messageId);
    const msg = await imap.fetchOne(uid, { source: includeBody, envelope: true, flags: true, uid: true });
    if (!msg) throw new Error(`Message ${messageId} not found`);

    let parsed: any | undefined;
    if (includeBody) {
      const dl = await imap.download(uid);
      const chunks: Buffer[] = [];
      for await (const ch of dl.content) chunks.push(ch);
      const { simpleParser } = await import("mailparser"); // lazy
      parsed = await simpleParser(Buffer.concat(chunks));
    }

    const attachments = includeAttachments && parsed
      ? (parsed.attachments ?? []).map((a: any) => ({
          attachmentId: `${uid}:${a.checksum || a.filename || a.cid}`,
          filename: a.filename || "attachment",
          mimeType: a.contentType,
          size: Buffer.isBuffer(a.content) ? a.content.length : undefined,
        }))
      : undefined;

    return {
      messageId: String(msg.uid),
      threadId: String(msg.uid),
      subject: parsed?.subject ?? msg.envelope?.subject,
      from: parsed ? mailparserAddressToString(parsed.from) ?? addressToString(msg.envelope?.from)
                   : addressToString(msg.envelope?.from),
      to:   parsed ? mailparserAddressToString(parsed.to)   ?? addressToString(msg.envelope?.to)
                   : addressToString(msg.envelope?.to),
      cc:   parsed ? mailparserAddressToString(parsed.cc)   ?? addressToString(msg.envelope?.cc)
                   : addressToString(msg.envelope?.cc),
      bcc:  parsed ? mailparserAddressToString(parsed.bcc)  ?? addressToString(msg.envelope?.bcc)
                   : addressToString(msg.envelope?.bcc),
      date: parsed?.date?.toISOString() ?? msg.envelope?.date?.toISOString(),
      snippet: parsed?.text?.slice(0, 200),
      text: parsed?.text || undefined,
      html: parsed?.html ? (typeof parsed.html === "string" ? parsed.html : undefined) : undefined,
      attachments,
    };
  }

  async downloadAttachment({ messageId, attachmentId }: DownloadArgs) {
    const imap = await this.api();
    const uid = Number(messageId);
    const dl = await imap.download(uid);
    const chunks: Buffer[] = [];
    for await (const ch of dl.content) chunks.push(ch);
    const { simpleParser } = await import("mailparser");
    const parsed = await simpleParser(Buffer.concat(chunks));
    const target = (parsed.attachments || []).find((a: any) =>
      `${uid}:${a.checksum || a.filename || a.cid}` === attachmentId
    );
    if (!target) return null;
    const content = Buffer.isBuffer(target.content) ? target.content : Buffer.from(target.content as any);
    return { filename: target.filename || "attachment", contentType: target.contentType, content };
  }

  async markRead({ messageId }: { messageId: string }) {
    const imap = await this.api();
    await imap.messageFlagsAdd(Number(messageId), ["\\Seen"]);
  }

  async moveTo({ messageId, mailboxOrLabel }: { messageId: string; mailboxOrLabel: string }) {
    const imap = await this.api();
    await imap.messageMove(Number(messageId), mailboxOrLabel);
  }

  async addLabel(_: ModifyArgs) { throw new Error("Labels are not supported for generic IMAP."); }
  async removeLabel(_: ModifyArgs) { throw new Error("Labels are not supported for generic IMAP."); }
  async search(args: ListArgs) { return this.listMessages(args); }
}

// No-op provider for smtp-only
class NoopReadProvider implements ReadProvider {
  async listMailboxesOrLabels(_args: { cursor?: string; pageSize: number }): Promise<{ items: any[]; nextCursor?: string }> {
    throw new Error("Read operations are unavailable (smtp-only).");
  }
  async listThreads(_args: ListArgs): Promise<{ items: any[]; nextCursor?: string }> {
    throw new Error("Read operations are unavailable (smtp-only).");
  }
  async getThread(_args: GetThreadArgs): Promise<any> {
    throw new Error("Read operations are unavailable (smtp-only).");
  }
  async listMessages(_args: ListArgs): Promise<{ items: any[]; nextCursor?: string }> {
    throw new Error("Read operations are unavailable (smtp-only).");
  }
  async getMessage(_args: GetMsgArgs): Promise<any> {
    throw new Error("Read operations are unavailable (smtp-only).");
  }
  async downloadAttachment(_args: DownloadArgs): Promise<{ filename: string; contentType?: string; content: Buffer } | null> {
    throw new Error("Read operations are unavailable (smtp-only).");
  }
  async markRead(_args: { messageId: string }): Promise<void> {
    throw new Error("Read operations are unavailable (smtp-only).");
  }
  async moveTo(_args: { messageId: string; mailboxOrLabel: string }): Promise<void> {
    throw new Error("Read operations are unavailable (smtp-only).");
  }
  async addLabel(_args: ModifyArgs): Promise<void> {
    throw new Error("Read operations are unavailable (smtp-only).");
  }
  async removeLabel(_args: ModifyArgs): Promise<void> {
    throw new Error("Read operations are unavailable (smtp-only).");
  }
  async search(_args: ListArgs): Promise<{ items: any[]; nextCursor?: string }> {
    throw new Error("Read operations are unavailable (smtp-only).");
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Sender (lazy nodemailer)
// ──────────────────────────────────────────────────────────────────────────────
class Sender {
  private rules: EmailRules; private deps: RuntimeDeps; private logger: Logger;
  constructor(rules: EmailRules, deps: RuntimeDeps, logger: Logger) {
    this.rules = rules; this.deps = deps; this.logger = logger;
  }

  private enforceRecipientPolicy(to: string[]) {
    const allowedR = this.rules.allowedRecipients;
    const allowedD = this.rules.allowedDomains;
    if (allowedR !== "unrestricted") {
      for (const r of to) if (!allowedR.includes(normalizeEmail(r))) throw new Error(`Recipient ${r} is not in allowedRecipients.`);
    }
    if (allowedD?.length) {
      for (const r of to) {
        const d = (r.split("@")[1] || "").toLowerCase();
        if (!allowedD.includes(d)) throw new Error(`Recipient domain ${d} is not allowed.`);
      }
    }
  }
  private isAutoApproved(to: string[]): boolean {
    if (this.rules.autoApprovedRecipients === "all") return true;
    const set = new Set(this.rules.autoApprovedRecipients.map(normalizeEmail));
    return to.every(r => set.has(normalizeEmail(r)));
  }

  private renderWithTemplate(templateSpec: { name: string; variables: Record<string, any> }) {
    const tpl = findTemplate(this.rules, templateSpec.name);
    if (!tpl) throw new Error(`Template '${templateSpec.name}' not found.`);
    const v = validateVarsLight(tpl.variablesSchema, templateSpec.variables);
    if (!v.ok) throw new Error(`Template validation failed: ${v.message || "invalid variables"}`);
    const subject = renderString(tpl.subject, templateSpec.variables);
    let html = tpl.html ? renderString(tpl.html, templateSpec.variables) : undefined;
    let text = tpl.text ? renderString(tpl.text, templateSpec.variables) : undefined;
    if (this.rules.style?.signature) {
      if (html) html += `\n\n${this.rules.style.signature}`;
      if (text) text += `\n\n${stripHtml(this.rules.style.signature)}`;
    }
    const attachments: any[] = [];
    for (const a of tpl.defaultAttachments ?? []) attachments.push({ filename: a.filename, path: a.path, cid: a.cid, contentType: a.contentType });
    return { subject, html, text, attachments };
  }

  private async transporter(): Promise<any> {
    if (this.deps.smtpTransportFactory) return this.deps.smtpTransportFactory(this.rules);

    // Lazy import nodemailer only when needed
    const nodemailer = await import("nodemailer");
    if (this.rules.access.smtp) {
      return nodemailer.createTransport({
        host: this.rules.access.smtp.host,
        port: this.rules.access.smtp.port,
        secure: this.rules.access.smtp.secure,
        auth: { user: this.rules.access.smtp.username, pass: this.rules.access.smtp.password },
        dkim: this.rules.identity.dkim ? {
          domainName: this.rules.identity.dkim.domainName,
          keySelector: this.rules.identity.dkim.keySelector,
          privateKey: this.rules.identity.dkim.privateKey,
        } : undefined,
      } as any);
    }
    if (this.rules.provider === "gmail-api" && this.rules.access.gmail) {
      // OAuth2 via nodemailer (still lazy-loaded)
      const { OAuth2Client } = await import("google-auth-library");
      const oauth2 = new OAuth2Client(this.rules.access.gmail.clientId, this.rules.access.gmail.clientSecret);
      oauth2.setCredentials({ refresh_token: this.rules.access.gmail.refreshToken });
      const accessToken = await oauth2.getAccessToken();
      return nodemailer.createTransport({
        service: "gmail",
        auth: {
          type: "OAuth2",
          user: this.rules.identity.fromAddress,
          clientId: this.rules.access.gmail.clientId,
          clientSecret: this.rules.access.gmail.clientSecret,
          refreshToken: this.rules.access.gmail.refreshToken,
          accessToken: accessToken?.token,
        },
        dkim: this.rules.identity.dkim ? {
          domainName: this.rules.identity.dkim.domainName,
          keySelector: this.rules.identity.dkim.keySelector,
          privateKey: this.rules.identity.dkim.privateKey,
        } : undefined,
      } as any);
    }
    throw new Error("No SMTP or Gmail OAuth2 configuration available for sending.");
  }

  async send(input: any, drafts: DraftStore) {
    const idempotencyKey: string | undefined = input?.idempotencyKey;
    if (!idempotencyKey || idempotencyKey.length < 8) throw new Error("idempotencyKey is required for send.");

    // Build draft (either by id or inline)
    let draft: DraftEmail | undefined;
    if (input?.draftId) {
      draft = await drafts.get(input.draftId);
      if (!draft) throw new Error(`Draft '${input.draftId}' not found.`);
    } else {
      draft = {
        to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject,
        text: input.text, html: input.html, template: input.template,
        attachments: input.attachments, replyToMessageId: input.replyToMessageId,
      };
    }

    if (!this.rules.allowNonTemplated && !draft.template) throw new Error("Non-templated sends are disabled by policy.");

    const to = (draft.to ?? []).map(String);
    if (!to.length) throw new Error("At least one recipient is required.");

    this.enforceRecipientPolicy(to);

    const autoApproved = this.isAutoApproved(to);
    if (!autoApproved && !input.draftId) {
      throw new Error("Recipient not auto-approved. Request approval and send the approved draft.");
    }

    // Render (template or direct)
    let subject = draft.subject;
    let html = draft.html;
    let text = draft.text;
    const attachments: any[] = [];

    if (draft.template) {
      const rendered = this.renderWithTemplate(draft.template);
      subject = subject ?? rendered.subject;
      html = html ?? rendered.html;
      text = text ?? rendered.text;
      attachments.push(...rendered.attachments);
    }

    // Attachment cap and mapping
    let totalBytes = 0;
    for (const a of draft.attachments ?? []) {
      if (a.contentBase64) {
        const buf = Buffer.from(a.contentBase64, "base64");
        totalBytes += buf.length;
        attachments.push({ filename: a.filename, content: buf, contentType: a.contentType, cid: a.cid, encoding: a.encoding });
      } else if (a.fileRef) {
        attachments.push({ filename: a.filename, path: a.fileRef, contentType: a.contentType, cid: a.cid });
      } else if (a.path) {
        attachments.push({ filename: a.filename, path: a.path, contentType: a.contentType, cid: a.cid });
      }
    }
    const cap = (this.rules.limits?.maxAttachmentMB ?? 20) * 1024 * 1024;
    if (totalBytes > cap) throw new Error(`Attachments exceed size cap (${this.rules.limits?.maxAttachmentMB ?? 20} MB).`);

    // Signature for non-template sends
    if (!draft.template && this.rules.style?.signature) {
      if (html) html += `\n\n${this.rules.style.signature}`;
      if (text) text += `\n\n${stripHtml(this.rules.style.signature)}`;
    }

    const from = this.rules.identity.displayName
      ? `"${this.rules.identity.displayName}" <${this.rules.identity.fromAddress}>`
      : this.rules.identity.fromAddress;

    const transporter = await this.transporter();
    const info = await transporter.sendMail({
      from, to, cc: draft.cc, bcc: draft.bcc, subject, text, html,
      inReplyTo: draft.replyToMessageId,
      references: draft.replyToMessageId ? [draft.replyToMessageId] : undefined,
      replyTo: this.rules.identity.replyTo,
      attachments,
    });

    return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected, envelope: info.envelope, response: info.response, idempotencyKey };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Drafts, checkpoints, helpers (no heavy deps)
// ──────────────────────────────────────────────────────────────────────────────
class DraftStore {
  private scope = "email:drafts";
  constructor(private cp: CheckpointStore, private logger: Logger) {}
  async createOrUpdate(draftId: string | undefined, draft: DraftEmail & { note?: string }) {
    const state = (await this.cp.load(this.scope)) ?? { drafts: {} as Record<string, any> };
    const id = draftId ?? `draft_${crypto.randomUUID()}`;
    state.drafts[id] = draft;
    await this.cp.save(this.scope, state);
    return id;
  }
  async get(draftId: string): Promise<DraftEmail | undefined> {
    const state = (await this.cp.load(this.scope)) ?? { drafts: {} };
    return state.drafts?.[draftId];
  }
}

class CheckpointUtil {
  constructor(private cp: CheckpointStore) {}
  async save(scope: string, data: any) { await this.cp.save(`email:checkpoint:${scope}`, data); }
  async load(scope: string) { return this.cp.load(`email:checkpoint:${scope}`); }
}

// Gmail helpers (no extra imports)
function buildGmailQuery(query?: string, since?: string) {
  let q = (query || "").trim();
  if (since && !/^\d+$/.test(since)) {
    const d = new Date(since);
    if (!isNaN(d.getTime())) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      q = `${q} after:${y}/${m}/${day}`.trim();
    }
  }
  return q || undefined;
}

function extractBodiesFromGmailPayload(payload: any): { textBody?: string; htmlBody?: string } {
  const result: { textBody?: string; htmlBody?: string } = {};
  const stack = [payload];
  while (stack.length) {
    const p = stack.pop()!;
    if (!p) continue;
    if (p.mimeType === "text/plain" && p.body?.data) result.textBody = Buffer.from(p.body.data, "base64").toString("utf8");
    else if (p.mimeType === "text/html" && p.body?.data) result.htmlBody = Buffer.from(p.body.data, "base64").toString("utf8");
    for (const child of p.parts ?? []) stack.push(child);
  }
  return result;
}

function collectAttachmentMetaFromGmailPayload(parts: any[], messageId: string) {
  const out: any[] = [];
  const stack = [...(parts ?? [])];
  while (stack.length) {
    const p = stack.pop()!;
    if (!p) continue;
    if (p.filename && p.body?.attachmentId) out.push({ attachmentId: p.body.attachmentId, filename: p.filename, mimeType: p.mimeType, size: p.body.size, messageId });
    for (const child of p.parts ?? []) stack.push(child);
  }
  return out;
}

// Address helpers
function addressToString(addrs: any): string | undefined {
  if (!addrs) return undefined;
  const arr = Array.isArray(addrs) ? addrs : [addrs];
  return arr.map((a: any) => (a?.name ? `"${a.name}" <${a.address}>` : a?.address || "")).filter(Boolean).join(", ");
}
function mailparserAddressToString(a: any): string | undefined {
  if (!a) return undefined;
  if (Array.isArray(a)) return a.map(mailparserAddressToString).filter(Boolean).join(", ");
  if (typeof a.text === "string") return a.text;
  if (Array.isArray(a.value)) {
    return a.value.map((v: any) => (v?.address ? (v?.name ? `"${v.name}" <${v.address}>` : v.address) : "")).filter(Boolean).join(", ");
  }
  return undefined;
}

// Templates / tiny validation / misc helpers
function findTemplate(rules: EmailRules, name: string) { return rules.templates.find(t => t.name === name); }

function validateVarsLight(schema: JSONSchema, vars: Record<string, any>): { ok: boolean; message?: string } {
  // Minimal check: required props + basic type checks for properties.type
  try {
    if (!schema || typeof schema !== "object") return { ok: true };
    const req = (schema as any).required as string[] | undefined;
    if (req) {
      for (const k of req) if (!(k in vars)) return { ok: false, message: `Missing required variable '${k}'` };
    }
    const props = (schema as any).properties as Record<string, JSONSchema> | undefined;
    if (props) {
      for (const [k, def] of Object.entries(props)) {
        if (vars[k] == null) continue;
        const expected = (def as any).type;
        if (!expected) continue;
        const t = typeof vars[k];
        if (expected === "string" && t !== "string") return { ok: false, message: `Variable '${k}' must be string` };
        if (expected === "number" && t !== "number") return { ok: false, message: `Variable '${k}' must be number` };
        if (expected === "integer" && !(Number.isInteger(vars[k]))) return { ok: false, message: `Variable '${k}' must be integer` };
        if (expected === "boolean" && t !== "boolean") return { ok: false, message: `Variable '${k}' must be boolean` };
        if (expected === "object" && (t !== "object" || Array.isArray(vars[k]))) return { ok: false, message: `Variable '${k}' must be object` };
        if (expected === "array" && !Array.isArray(vars[k])) return { ok: false, message: `Variable '${k}' must be array` };
      }
    }
    return { ok: true };
  } catch (e) { return { ok: false, message: `Validation error: ${asMsg(e)}` }; }
}

function renderString(tpl: string, vars: Record<string, any>) {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key) => {
    const v = key.split(".").reduce((acc: any, k: string) => (acc ? acc[k] : undefined), vars);
    return v == null ? "" : String(v);
  });
}
function stripHtml(s: string) { return s.replace(/<[^>]*>/g, ""); }
function normalizeEmail(e: string) { return e.trim().toLowerCase(); }

function computeIdempotencyKey(input: {
  from: string; to: string[]; cc?: string[]; bcc?: string[]; subject: string;
  text?: string; html?: string; template?: { name: string; variables: Record<string, any> };
  attachments?: AttachmentInput[]; replyToMessageId?: string;
}) {
  const base = {
    from: normalizeEmail(input.from),
    to: (input.to || []).map(normalizeEmail).sort(),
    cc: (input.cc || []).map(normalizeEmail).sort(),
    bcc: (input.bcc || []).map(normalizeEmail).sort(),
    subject: (input.subject || "").trim(),
    body: input.template
      ? `T:${input.template.name}:${stableStringify(input.template.variables)}`
      : `H:${(input.html || "").trim()}|T:${(input.text || "").trim()}`,
    attachments: (input.attachments || []).map(a => `${a.filename}:${a.cid || ""}`).sort(),
    replyTo: input.replyToMessageId || "",
  };
  return crypto.createHash("sha256").update(stableStringify(base)).digest("hex");
}
function stableStringify(obj: any) {
  const seen = new WeakSet();
  const replacer = (_k: string, v: any) => {
    if (v && typeof v === "object") {
      if (seen.has(v)) return;
      seen.add(v);
      return Object.keys(v).sort().reduce((acc: any, k) => { acc[k] = v[k]; return acc; }, {});
    }
    return v;
  };
  return JSON.stringify(obj, replacer);
}

function ok<T>(data: T) { return { ok: true, data }; }
function err(code: string, message: string, retryable?: boolean) { return { ok: false, error: { code, message, retryable } }; }
function asMsg(e: unknown) { return e instanceof Error ? e.message : String(e); }
