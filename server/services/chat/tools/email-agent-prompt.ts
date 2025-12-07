// email-agent-prompt.ts
// Build an email-managing toolbelt for your LLM with strong guardrails.
// Drop this into your codebase. If you already define PromptBuild/JSONSchema/GPTFunctionTool elsewhere,
// delete the local type re-decls below and import from your existing modules.

// ──────────────────────────────────────────────────────────────────────────────
// Types (local fallback; replace with imports from your project if you have them)
// ──────────────────────────────────────────────────────────────────────────────
export interface PromptBuild {
    instructions: string;          // startPrompt
    endInstructions?: string;      // endPrompt (optional)
    tools: GPTFunctionTool[];
    schema?: JSONSchema;
  }
  
  export type JSONSchema =
    | { $ref: string }
    | ({
        type?: "string" | "number" | "integer" | "boolean" | "null"
             | "object" | "array" | (string & {});
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
        // Non-standard keywords allowed by your tool API:
        oneOf?: JSONSchema[];
        anyOf?: JSONSchema[];
        allOf?: JSONSchema[];
      } & Record<string, unknown>);
  
  export type GPTFunctionTool = {
    type: "function";
    function: {
      name: string; // ≤64 chars
      description?: string;
      parameters: JSONSchema & { type: "object" };
    };
  };
  
  // ──────────────────────────────────────────────────────────────────────────────
  // Email rules & helper types
  // ──────────────────────────────────────────────────────────────────────────────
  
  export type Provider = "gmail-api" | "imap" | "smtp-only";
  
  export type EmailRules = {
    provider: Provider;
    access: {
      // For Gmail API (read/search/threads)
      gmail?: { clientId: string; clientSecret: string; refreshToken: string };
      // For IMAP (read/search) — e.g., via imapflow
      imap?: { host: string; port: number; secure: boolean; username: string; password: string; mailbox?: string };
      // For SMTP (send) — nodemailer transport config
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
      // JSON Schema describing variables required by this template
      variablesSchema: JSONSchema;
      defaultVars?: Record<string, any>;
      // Optional fixed attachments referenced by cid or filename
      defaultAttachments?: Array<{ filename: string; path?: string; cid?: string; contentType?: string }>;
    }>;
    allowNonTemplated: boolean;
    allowedRecipients: "unrestricted" | string[]; // concrete emails
    allowedDomains?: string[];                    // e.g., ["example.com"]
    autoApprovedRecipients: "all" | string[];
    limits?: {
      maxSendsPerRun?: number;
      maxReadsPerRun?: number;
      rateLimitPerMinute?: number;
      maxAttachmentMB?: number; // default ~20MB typical SMTP
    };
    threading?: { preferThreads: boolean };       // true: favor thread APIs
    pagination?: { pageSize?: number };           // default 25
    // Optional UX hints for the assistant
    style?: { signature?: string };
  };
  
  type AttachmentInput = {
    filename: string;
    // Choose ONE of:
    path?: string;          // server path/URL (runtime must fetch safely)
    fileRef?: string;       // handle returned by downloadAttachment
    contentBase64?: string; // only for small content; avoid large payloads
    contentType?: string;
    cid?: string;           // for inline images
    encoding?: string;      // nodemailer-compatible (e.g., 'base64')
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
    replyToMessageId?: string; // reply in-thread
  };
  
  // ──────────────────────────────────────────────────────────────────────────────
  // Builder
  // ──────────────────────────────────────────────────────────────────────────────
  
  const EMAIL_TOOLSET_VERSION = "1.0.0";
  
  export function buildEmailAgentPrompt(rules: EmailRules): PromptBuild {
    const pageSize = rules.pagination?.pageSize ?? 25;
    const limits = {
      maxSendsPerRun: rules.limits?.maxSendsPerRun ?? 20,
      maxReadsPerRun: rules.limits?.maxReadsPerRun ?? 200,
      rateLimitPerMinute: rules.limits?.rateLimitPerMinute ?? 60,
      maxAttachmentMB: rules.limits?.maxAttachmentMB ?? 20,
    };
  
    const policyLines: string[] = [];
    policyLines.push(`• Provider: ${rules.provider} (reading/search via provider runtime; sending via nodemailer transport).`);
    policyLines.push(`• From: ${rules.identity.displayName ? `${rules.identity.displayName} <${rules.identity.fromAddress}>` : rules.identity.fromAddress}`);
    if (rules.identity.replyTo) policyLines.push(`• Reply-To: ${rules.identity.replyTo}`);
    policyLines.push(`• Templates: ${rules.templates.length ? rules.templates.map(t => t.name).join(", ") : "none"}.`);
    policyLines.push(`• Non-templated sends allowed: ${rules.allowNonTemplated ? "YES" : "NO"}.`);
    policyLines.push(`• Allowed recipients: ${
      rules.allowedRecipients === "unrestricted" ? "UNRESTRICTED" : rules.allowedRecipients.join(", ")
    }.`);
    if (rules.allowedDomains?.length) policyLines.push(`• Allowed domains: ${rules.allowedDomains.join(", ")}.`);
    policyLines.push(`• Auto-approved recipients: ${rules.autoApprovedRecipients === "all" ? "ALL" : rules.autoApprovedRecipients.join(", ")}.`);
    policyLines.push(`• Limits: reads/run=${limits.maxReadsPerRun}, sends/run=${limits.maxSendsPerRun}, rate/min=${limits.rateLimitPerMinute}, maxAttachmentMB=${limits.maxAttachmentMB}.`);
    policyLines.push(`• Threading preference: ${rules.threading?.preferThreads ? "PREFER THREAD APIs" : "MESSAGE-LEVEL APIs OK"}.`);
    policyLines.push(`• Default page size: ${pageSize}.`);
  
    const templateHints = rules.templates.map(t => {
      const varNames =
        (t.variablesSchema as any)?.properties
          ? Object.keys((t.variablesSchema as any).properties!)
          : [];
      const subj = t.subject.replace(/\s+/g, " ").trim();
      return `- ${t.name}: subject="${subj}" vars=[${varNames.join(", ")}]`;
    });
  
    const instructions = [
      `You are an **email-managing agent** running in an automated context (version ${EMAIL_TOOLSET_VERSION}).`,
      `You can read, search, classify, draft, and send emails, working safely within strict policies.`,
      ``,
      `POLICY SNAPSHOT`,
      ...policyLines,
      ``,
      `BEHAVIORAL RULES`,
      `1) **Never expose secrets** (tokens, passwords, API keys) in messages or tool arguments. You do not need them; the runtime tools own credentials.`,
      `2) **Recipient safety**: You may only send if recipient is in policy.`,
      `   • If recipient ∈ autoApprovedRecipients: you may send.`,
      `   • Else: call **email_request_approval** and wait for approval before calling **email_send_email**.`,
      `   • If non-templated sends are disallowed, you must use a template.`,
      `   • If allowedDomains is configured, every recipient must match it.`,
      `3) **Idempotency**: Always include an **idempotencyKey** when sending. Compute it by calling **email_compute_idempotency_key**.`,
      `4) **Templates first**: Prefer a template when it fits. Validate variables; if missing, ask for approval with a clearly written draft.`,
      `5) **Pagination & checkpoints**: Use cursors and **email_save_checkpoint** to avoid re-reading the same items. Respect page size ${pageSize}.`,
      `6) **Attachments**: Keep under ${limits.maxAttachmentMB} MB total. Use attachment fileRefs returned by **email_download_attachment** when forwarding.`,
      `7) **Threading**: ${rules.threading?.preferThreads ? "Use thread tools to fetch and reply in-thread." : "Thread tools are available; message tools are fine too."}`,
      `8) **Safety**: Do not click links or execute attachments. Summarize suspicious content; defer to approval.`,
      `9) **Logging**: Keep summaries concise. Do not include raw PII unless strictly needed.`,
      `10) **Memory**: If the host environment exposes memory tools, prefer emitting structured facts (contacts, dates, intents).`,
      ``,
      `TEMPLATES AVAILABLE`,
      ...(templateHints.length ? templateHints : ["(no templates configured)"]),
      ``,
      `TOOL SELECTION GUIDANCE`,
      `• To list recent items: use **email_list_threads** (preferred) or **email_list_messages** with a query and cursor.`,
      `• To read a full thread: **email_get_thread** (includeBodies=false unless needed).`,
      `• To draft: **email_save_draft** (with template or explicit text/html).`,
      `• To send: **email_compute_idempotency_key** → (auto-approved? send) : **email_request_approval**.`,
      `• To move/label/mark read: use the dedicated tools.`,
      ``,
      `OUTPUT STYLE`,
      `• Be terse and action-oriented. When a send is queued for approval, include a one-line summary.`,
    ].join("\n");
  
    const endInstructions = `Remember: never include secrets in tool calls or responses. Always use idempotency keys for sends.`;
  
    // ────────────────────────────────────────────────────────────────────────────
    // Tool specs (LLM-facing). Implement matching runtime handlers for each name.
    // ────────────────────────────────────────────────────────────────────────────
    const tools: GPTFunctionTool[] = [
      {
        type: "function",
        function: {
          name: "email_list_mailboxes_or_labels",
          description:
            "List available mailboxes/labels for the account (e.g., INBOX, Sent, custom labels).",
          parameters: {
            type: "object",
            properties: {
              cursor: { type: "string", description: "Opaque page cursor." },
              pageSize: { type: "integer", minimum: 1, maximum: 200, default: pageSize },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "email_list_threads",
          description:
            "List threads matching an optional query since a checkpoint. Use cursor for pagination.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Provider-native search query (e.g., Gmail search syntax or IMAP criteria)." },
              labelOrMailbox: { type: "string", description: "Optional label/mailbox (e.g., 'INBOX')." },
              since: { type: "string", description: "ISO 8601 timestamp OR provider checkpoint (e.g., Gmail historyId)." },
              cursor: { type: "string" },
              pageSize: { type: "integer", minimum: 1, maximum: 200, default: pageSize },
              includeSnippet: { type: "boolean", default: true },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "email_get_thread",
          description:
            "Fetch a single thread by id. Optionally include bodies and attachments metadata.",
          parameters: {
            type: "object",
            properties: {
              threadId: { type: "string", minLength: 1 },
              includeBodies: { type: "boolean", default: false },
              includeAttachments: { type: "boolean", default: false },
              maxMessages: { type: "integer", minimum: 1, maximum: 500 },
            },
            required: ["threadId"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "email_list_messages",
          description:
            "List individual messages matching a query since a checkpoint. Use cursor for pagination.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              labelOrMailbox: { type: "string" },
              since: { type: "string", description: "ISO 8601 timestamp OR provider checkpoint (historyId/UID)." },
              cursor: { type: "string" },
              pageSize: { type: "integer", minimum: 1, maximum: 200, default: pageSize },
              includeSnippet: { type: "boolean", default: true },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "email_get_message",
          description:
            "Fetch a single message by id. Optionally include body and attachments metadata.",
          parameters: {
            type: "object",
            properties: {
              messageId: { type: "string", minLength: 1 },
              includeBody: { type: "boolean", default: false },
              includeAttachments: { type: "boolean", default: false },
            },
            required: ["messageId"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "email_download_attachment",
          description:
            "Download an attachment by message and attachment id. Returns a stable fileRef handle.",
          parameters: {
            type: "object",
            properties: {
              messageId: { type: "string" },
              attachmentId: { type: "string" },
            },
            required: ["messageId", "attachmentId"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "email_mark_read",
          description: "Mark a message as read.",
          parameters: {
            type: "object",
            properties: {
              messageId: { type: "string" },
            },
            required: ["messageId"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "email_move_to",
          description: "Move a message to a mailbox or add a label (provider-dependent).",
          parameters: {
            type: "object",
            properties: {
              messageId: { type: "string" },
              mailboxOrLabel: { type: "string" },
            },
            required: ["messageId", "mailboxOrLabel"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "email_add_label",
          description: "Add a label to a message (Gmail) or flag (IMAP equivalent).",
          parameters: {
            type: "object",
            properties: {
              messageId: { type: "string" },
              label: { type: "string" },
            },
            required: ["messageId", "label"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "email_remove_label",
          description: "Remove a label from a message.",
          parameters: {
            type: "object",
            properties: {
              messageId: { type: "string" },
              label: { type: "string" },
            },
            required: ["messageId", "label"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "email_save_draft",
          description:
            "Create or update a draft. Use template+variables when possible; runtime will validate variables against the template schema.",
          parameters: {
            type: "object",
            properties: {
              // If updating an existing draft:
              draftId: { type: "string", description: "Optional: update existing draft instead of creating a new one." },
  
              // Compose fields (nodemailer-compatible)
              to: { type: "array", items: { type: "string" }, minItems: 1 },
              cc: { type: "array", items: { type: "string" } },
              bcc: { type: "array", items: { type: "string" } },
              subject: { type: "string", minLength: 1 },
              text: { type: "string" },
              html: { type: "string" },
              template: {
                type: "object",
                properties: {
                  name: { type: "string", minLength: 1 },
                  variables: { type: "object", additionalProperties: true },
                },
                required: ["name", "variables"],
              },
              attachments: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    filename: { type: "string" },
                    path: { type: "string" },
                    fileRef: { type: "string" },
                    contentBase64: { type: "string" },
                    contentType: { type: "string" },
                    cid: { type: "string" },
                    encoding: { type: "string" },
                  },
                  required: ["filename"],
                },
              },
              replyToMessageId: { type: "string" },
              // Audit
              note: { type: "string", description: "Short rationale for this draft (for approval/audit UI)." },
            },
            required: ["to", "subject"],
            oneOf: [
              { properties: { template: { type: "object" } } },
              { properties: { html: { type: "string" } } },
              { properties: { text: { type: "string" } } },
            ],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "email_compute_idempotency_key",
          description:
            "Compute a deterministic idempotency key for a send intent. Runtime will hash normalized fields.",
          parameters: {
            type: "object",
            properties: {
              fromAddress: { type: "string", default: rules.identity.fromAddress },
              to: { type: "array", items: { type: "string" }, minItems: 1 },
              cc: { type: "array", items: { type: "string" } },
              bcc: { type: "array", items: { type: "string" } },
              subject: { type: "string" },
              text: { type: "string" },
              html: { type: "string" },
              template: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  variables: { type: "object", additionalProperties: true },
                },
              },
              attachments: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    filename: { type: "string" },
                    contentType: { type: "string" },
                    cid: { type: "string" },
                  },
                  required: ["filename"],
                },
              },
              replyToMessageId: { type: "string" },
            },
            required: ["to", "subject"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "email_request_approval",
          description:
            "Request human approval to send a draft. Returns an approvalId that can be polled or used by the host.",
          parameters: {
            type: "object",
            properties: {
              // Either reference an existing draft...
              draftId: { type: "string" },
              // ...or include draft content to allow approval UIs to render it:
              draft: {
                type: "object",
                properties: {
                  to: { type: "array", items: { type: "string" }, minItems: 1 },
                  cc: { type: "array", items: { type: "string" } },
                  bcc: { type: "array", items: { type: "string" } },
                  subject: { type: "string" },
                  text: { type: "string" },
                  html: { type: "string" },
                  template: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      variables: { type: "object", additionalProperties: true },
                    },
                  },
                  attachments: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        filename: { type: "string" },
                        fileRef: { type: "string" },
                        contentType: { type: "string" },
                        cid: { type: "string" },
                      },
                      required: ["filename"],
                    },
                  },
                  replyToMessageId: { type: "string" },
                },
                required: ["to", "subject"],
              },
              idempotencyKey: { type: "string", minLength: 8 },
              reason: { type: "string", description: "Why approval is needed or prudent." },
            },
            oneOf: [
              { required: ["draftId", "idempotencyKey"] },
              { required: ["draft", "idempotencyKey"] },
            ],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "email_send_email",
          description:
            "Send an email (or a saved draft). Only allowed if the recipient is auto-approved OR approval has been granted by the host.",
          parameters: {
            type: "object",
            properties: {
              // Preferred: send a saved draft by id
              draftId: { type: "string", description: "Send this draft as-is." },
  
              // Direct send (auto-approved recipients only)
              to: { type: "array", items: { type: "string" }, minItems: 1 },
              cc: { type: "array", items: { type: "string" } },
              bcc: { type: "array", items: { type: "string" } },
              subject: { type: "string" },
              text: { type: "string" },
              html: { type: "string" },
              template: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  variables: { type: "object", additionalProperties: true },
                },
              },
              attachments: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    filename: { type: "string" },
                    path: { type: "string" },
                    fileRef: { type: "string" },
                    contentBase64: { type: "string" },
                    contentType: { type: "string" },
                    cid: { type: "string" },
                    encoding: { type: "string" },
                  },
                  required: ["filename"],
                },
              },
              replyToMessageId: { type: "string" },
  
              // Required for all sends:
              idempotencyKey: { type: "string", minLength: 8 },
            },
            oneOf: [
              { required: ["draftId", "idempotencyKey"] },
              { required: ["to", "subject", "idempotencyKey"] },
            ],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "email_search",
          description:
            "Search mail using provider-native operators (Gmail search/IMAP criteria). Use cursor for pagination.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 1 },
              labelOrMailbox: { type: "string" },
              cursor: { type: "string" },
              pageSize: { type: "integer", minimum: 1, maximum: 200, default: pageSize },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "email_save_checkpoint",
          description:
            "Persist a checkpoint (e.g., cursor, since timestamp, historyId) to avoid reprocessing on next run.",
          parameters: {
            type: "object",
            properties: {
              data: { type: "object", additionalProperties: true, description: "Opaque payload the runtime will store." },
            },
            required: ["data"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "email_load_checkpoint",
          description:
            "Load the last saved checkpoint for this automation/instance.",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      },
    ];
  
    // ────────────────────────────────────────────────────────────────────────────
    // Optional structured run summary schema (returned as plain text by the model
    // unless your runtime reads it). Keep it simple and short.
    // ────────────────────────────────────────────────────────────────────────────
    const schema: JSONSchema = {
      type: "object",
      description: "Run summary",
      properties: {
        processedThreads: { type: "integer" },
        processedMessages: { type: "integer" },
        draftsCreated: { type: "integer" },
        approvalsRequested: { type: "integer" },
        emailsSent: { type: "integer" },
        nextCursorHint: { type: "string" },
        notes: { type: "string" },
      },
      additionalProperties: false,
    };
  
    return { instructions, endInstructions, tools, schema };
  }
  