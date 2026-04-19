export const sendEmail = async ({ to, subject, text, html }) => {
    // In a real application, you would use Nodemailer, Resend, or AWS SES.
    // Since no credentials are provided, we'll log the email to the console.
    console.log("-----------------------------------------");
    console.log(`Sending Email To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body: ${text}`);
    if (html) console.log(`HTML: ${html}`);
    console.log("-----------------------------------------");
    
    return true; // Simulate success
};
