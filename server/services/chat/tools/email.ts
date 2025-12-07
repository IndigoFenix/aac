import nodemailer from 'nodemailer';

export async function sendEmail(mailOptions: {
    from: string;
    to: string;
    subject: string;
    html: string;
}, service: string = 'gmail', auth: {
    user: string;
    pass: string;
} | null) {
    if (!auth) {
        auth = {
            user: process.env.EMAIL_USER!,
            pass: process.env.EMAIL_PASSWORD!,
        };
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