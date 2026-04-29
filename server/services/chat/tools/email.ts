import nodemailer from 'nodemailer';

export async function sendEmail(mailOptions: {
    from: string;
    to: string;
    subject: string;
    html: string;
}, service: string = 'gmail', auth: {
    user: string;
    pass: string;
}) {
    // SMTP creds must be supplied by the caller. The previous behavior fell
    // back to process.env.EMAIL_USER/EMAIL_PASSWORD — i.e. the platform's
    // own outbound mailer — so a prompt-injected agent could phish from
    // Aivota's branded sender with full DKIM/SPF alignment. No silent
    // fallback; refuse if auth is missing.
    if (!auth || !auth.user || !auth.pass) {
        throw new Error("sendEmail: SMTP credentials required (per-agent mail config missing)");
    }
    // Create a transporter object using the default SMTP transport
    const transporter = nodemailer.createTransport({
        service,
        auth,
    });

    // Send mail with defined transport object
    const result = await transporter.sendMail(mailOptions);
    console.log('Message sent successfully');
    return result;
}