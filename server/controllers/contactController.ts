import type { Request, Response } from "express";
import { db } from "../db";
import { contactInquiries, insertContactInquirySchema } from "@shared/schema";
import { emailService } from "../services/emailService";
import { desc, eq, and } from "drizzle-orm";

const ROLE_LABELS: Record<string, string> = {
  district_administrator: "District Administrator",
  special_education_director: "Special Education Director",
  speech_language_pathologist: "Speech-Language Pathologist",
  educator: "Educator",
  other: "Other",
};

const TYPE_LABELS: Record<string, string> = {
  contact: "Contact Inquiry",
  bug_report: "Bug Report",
  support_request: "Support Request",
};

export class ContactController {
  async submit(req: Request, res: Response): Promise<void> {
    try {
      const data = insertContactInquirySchema.parse(req.body);

      // Attach userId if the user is authenticated
      const userId = req.isAuthenticated?.() ? (req.user as any)?.id : undefined;

      const [inquiry] = await db
        .insert(contactInquiries)
        .values({ ...data, userId: userId || null })
        .returning();

      // Send notification email. Must await before responding: under the
      // Lambda Web Adapter the invocation is frozen as soon as the HTTP
      // response is committed, so a fire-and-forget send gets suspended
      // mid-handshake and the email never goes out.
      const notifyEmail = process.env.CONTACT_NOTIFY_EMAIL;
      if (notifyEmail && emailService.isReady()) {
        const roleLabel = ROLE_LABELS[data.role] || data.role;
        const typeLabel = TYPE_LABELS[data.messageType || "contact"] || data.messageType;
        try {
          await emailService.sendEmail({
            to: notifyEmail,
            subject: `[${typeLabel}] from ${data.firstName} ${data.lastName}`,
            text: [
              `New ${typeLabel}:`,
              ``,
              `Name: ${data.firstName} ${data.lastName}`,
              `Email: ${data.email}`,
              `Organization: ${data.organization}`,
              `Role: ${roleLabel}`,
              data.message ? `Message: ${data.message}` : "",
              ``,
              `Submitted: ${new Date().toISOString()}`,
            ]
              .filter(Boolean)
              .join("\n"),
            html: `
<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
  <h2 style="color: #2D6A4F;">${typeLabel}</h2>
  <table style="width: 100%; border-collapse: collapse;">
    <tr><td style="padding: 8px 0; color: #666;">Name</td><td style="padding: 8px 0; font-weight: 600;">${data.firstName} ${data.lastName}</td></tr>
    <tr><td style="padding: 8px 0; color: #666;">Email</td><td style="padding: 8px 0;"><a href="mailto:${data.email}">${data.email}</a></td></tr>
    <tr><td style="padding: 8px 0; color: #666;">Organization</td><td style="padding: 8px 0;">${data.organization}</td></tr>
    <tr><td style="padding: 8px 0; color: #666;">Role</td><td style="padding: 8px 0;">${roleLabel}</td></tr>
    ${data.message ? `<tr><td style="padding: 8px 0; color: #666; vertical-align: top;">Message</td><td style="padding: 8px 0;">${data.message}</td></tr>` : ""}
  </table>
</div>`.trim(),
          });
        } catch (err) {
          // The inquiry is already persisted to the DB, so a failed
          // notification shouldn't fail the user-facing request.
          console.error("Failed to send contact notification:", err);
        }
      }

      res.status(201).json({ success: true, id: inquiry.id });
    } catch (error: any) {
      if (error.name === "ZodError") {
        res.status(400).json({ error: "Validation failed", details: error.errors });
        return;
      }
      console.error("Contact form submission failed:", error);
      res.status(500).json({ error: "Failed to submit contact form" });
    }
  }

  async list(req: Request, res: Response): Promise<void> {
    try {
      const messageType = req.query.messageType as string | undefined;
      const conditions = [];
      if (messageType) {
        conditions.push(eq(contactInquiries.messageType, messageType as any));
      }

      const inquiries = await db
        .select()
        .from(contactInquiries)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(contactInquiries.createdAt));
      res.json(inquiries);
    } catch (error: any) {
      console.error("Failed to list contact inquiries:", error);
      res.status(500).json({ error: "Failed to list contact inquiries" });
    }
  }

  async remove(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      await db.delete(contactInquiries).where(eq(contactInquiries.id, id));
      res.json({ success: true });
    } catch (error: any) {
      console.error("Failed to delete contact inquiry:", error);
      res.status(500).json({ error: "Failed to delete contact inquiry" });
    }
  }
}

export const contactController = new ContactController();
