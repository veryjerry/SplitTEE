/**
 * Split Tee v2.1 - Notifications Service
 * Email (Nodemailer/SendGrid) and SMS (Twilio) notifications
 */

const nodemailer = require('nodemailer');

// ============================================
// EMAIL CONFIGURATION
// ============================================

let emailTransporter = null;

function getEmailTransporter() {
    if (emailTransporter) return emailTransporter;
    
    if (process.env.SENDGRID_API_KEY) {
        // SendGrid
        emailTransporter = nodemailer.createTransport({
            host: 'smtp.sendgrid.net',
            port: 587,
            auth: {
                user: 'apikey',
                pass: process.env.SENDGRID_API_KEY
            }
        });
    } else if (process.env.SMTP_HOST) {
        // Generic SMTP
        emailTransporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || '587'),
            secure: process.env.SMTP_SECURE === 'true',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });
    } else {
        // Development - log to console
        emailTransporter = {
            sendMail: async (options) => {
                console.log('📧 Email (dev mode):', {
                    to: options.to,
                    subject: options.subject,
                    preview: options.text?.substring(0, 100)
                });
                return { messageId: `dev_${Date.now()}` };
            }
        };
    }
    
    return emailTransporter;
}

// ============================================
// SMS CONFIGURATION
// ============================================

let twilioClient = null;

function getTwilioClient() {
    if (twilioClient) return twilioClient;
    
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
        const twilio = require('twilio');
        twilioClient = twilio(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_AUTH_TOKEN
        );
    } else {
        // Development - log to console
        twilioClient = {
            messages: {
                create: async (options) => {
                    console.log('📱 SMS (dev mode):', {
                        to: options.to,
                        body: options.body?.substring(0, 100)
                    });
                    return { sid: `dev_${Date.now()}` };
                }
            }
        };
    }
    
    return twilioClient;
}

// ============================================
// EMAIL SENDING
// ============================================

async function sendEmail(to, subject, html, text) {
    const transporter = getEmailTransporter();
    
    const result = await transporter.sendMail({
        from: process.env.EMAIL_FROM || 'Split Tee <noreply@splittee.com>',
        to,
        subject,
        html,
        text: text || stripHtml(html)
    });
    
    return { success: true, messageId: result.messageId };
}

// ============================================
// SMS SENDING
// ============================================

async function sendSMS(to, body) {
    const client = getTwilioClient();
    
    // Format phone number
    let formattedPhone = to.replace(/[^\d+]/g, '');
    if (!formattedPhone.startsWith('+')) {
        formattedPhone = '+1' + formattedPhone; // Default to US
    }
    
    const result = await client.messages.create({
        body,
        to: formattedPhone,
        from: process.env.TWILIO_PHONE_NUMBER || '+10000000000'
    });
    
    return { success: true, sid: result.sid };
}

// ============================================
// PAYMENT INVITATION EMAIL
// ============================================

async function sendPaymentInvitation(player, split) {
    const paymentUrl = `${process.env.BASE_URL}/pay/${player.payment_token}`;
    const teeDateFormatted = formatDate(split.tee_date);
    const teeTimeFormatted = formatTime(split.tee_time);
    
    const subject = `🏌️ ${split.booker_name} invited you to split a round at ${split.course_name}`;
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #1B4332; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .details { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
        .amount { font-size: 32px; color: #1B4332; font-weight: bold; }
        .btn { display: inline-block; background: #1B4332; color: white; padding: 15px 40px; text-decoration: none; border-radius: 8px; font-weight: bold; margin: 20px 0; }
        .footer { text-align: center; padding: 20px; color: #666; font-size: 14px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="margin:0;">⛳ Split Tee</h1>
            <p style="margin:10px 0 0;">You're invited to the group!</p>
        </div>
        <div class="content">
            <p>Hey${player.name ? ' ' + player.name : ''},</p>
            <p><strong>${split.booker_name}</strong> is organizing a round of golf and wants you to join!</p>
            
            <div class="details">
                <p style="margin:0;"><strong>📍 ${split.course_name}</strong></p>
                <p style="margin:5px 0;">📅 ${teeDateFormatted} at ${teeTimeFormatted}</p>
                <p style="margin:5px 0;">👥 ${split.num_players} players total</p>
                <hr style="border:none;border-top:1px solid #eee;margin:15px 0;">
                <p style="margin:0;">Your share:</p>
                <p class="amount">$${parseFloat(player.amount).toFixed(2)}</p>
                <p style="margin:0;color:#666;font-size:14px;">
                    Green fee: $${parseFloat(split.green_fee).toFixed(2)}
                    ${parseFloat(split.cart_fee) > 0 ? ` + Cart: $${parseFloat(split.cart_fee).toFixed(2)}` : ''}
                    + $${parseFloat(split.platform_fee).toFixed(2)} convenience fee
                </p>
            </div>
            
            <div style="text-align:center;">
                <a href="${paymentUrl}" class="btn">Pay Now →</a>
            </div>
            
            <p style="color:#666;font-size:14px;text-align:center;">
                ⏱️ Everyone needs to pay within 10 minutes once the first payment is made, or all payments will be refunded.
            </p>
        </div>
        <div class="footer">
            <p>Split Tee makes group golf easy.<br>Questions? Reply to this email.</p>
        </div>
    </div>
</body>
</html>
    `;
    
    return sendEmail(player.email, subject, html);
}

// ============================================
// PAYMENT CONFIRMATION EMAIL
// ============================================

async function sendPaymentConfirmation(player, split) {
    const teeDateFormatted = formatDate(split.tee_date);
    const teeTimeFormatted = formatTime(split.tee_time);
    
    const subject = `✅ Payment confirmed for ${split.course_name}`;
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #1B4332; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .success { background: #D8F3DC; border: 2px solid #1B4332; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0; }
        .details { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
        .footer { text-align: center; padding: 20px; color: #666; font-size: 14px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="margin:0;">⛳ Split Tee</h1>
        </div>
        <div class="content">
            <div class="success">
                <h2 style="margin:0;color:#1B4332;">✅ You're all set!</h2>
                <p style="margin:10px 0 0;">Your payment of <strong>$${parseFloat(player.amount).toFixed(2)}</strong> was successful.</p>
            </div>
            
            <div class="details">
                <h3 style="margin:0 0 15px;">Tee Time Details</h3>
                <p style="margin:5px 0;"><strong>📍 ${split.course_name}</strong></p>
                <p style="margin:5px 0;">📅 ${teeDateFormatted}</p>
                <p style="margin:5px 0;">⏰ ${teeTimeFormatted}</p>
                <p style="margin:5px 0;">👥 ${split.num_players} players</p>
                <p style="margin:5px 0;">🎫 Confirmation: <strong>${split.short_code}</strong></p>
            </div>
            
            <p style="color:#666;font-size:14px;">
                ${split.payment_mode === 'auth_hold' 
                    ? '💳 Your card has been authorized. The charge will be finalized on the day of play.'
                    : '💳 Your payment has been processed.'}
            </p>
        </div>
        <div class="footer">
            <p>Have a great round! 🏌️‍♂️</p>
        </div>
    </div>
</body>
</html>
    `;
    
    return sendEmail(player.email, subject, html);
}

// ============================================
// BOOKER NOTIFICATIONS
// ============================================

async function sendBookerSplitCreated(split, players) {
    const teeDateFormatted = formatDate(split.tee_date);
    const teeTimeFormatted = formatTime(split.tee_time);
    
    const subject = `🏌️ Your split payment for ${split.course_name} is ready`;
    
    const playerList = players.map(p => 
        `<li>${p.name || p.email} - ${p.is_booker ? '(You)' : 'Invited'}</li>`
    ).join('');
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #1B4332; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .details { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
        .footer { text-align: center; padding: 20px; color: #666; font-size: 14px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="margin:0;">⛳ Split Tee</h1>
            <p style="margin:10px 0 0;">Your split is ready!</p>
        </div>
        <div class="content">
            <p>Hey ${split.booker_name},</p>
            <p>Great news! Your group payment split has been created. Payment invitations have been sent to everyone.</p>
            
            <div class="details">
                <p style="margin:0;"><strong>📍 ${split.course_name}</strong></p>
                <p style="margin:5px 0;">📅 ${teeDateFormatted} at ${teeTimeFormatted}</p>
                <p style="margin:5px 0;">💰 $${parseFloat(split.total_per_player).toFixed(2)} per player</p>
                <p style="margin:5px 0;">🎫 Code: <strong>${split.short_code}</strong></p>
            </div>
            
            <h3>Players:</h3>
            <ul>${playerList}</ul>
            
            <p style="color:#666;font-size:14px;">
                📧 Everyone has been sent a payment link. Once the first person pays, a 10-minute timer starts for everyone else.
            </p>
        </div>
        <div class="footer">
            <p>We'll notify you as players complete their payments.</p>
        </div>
    </div>
</body>
</html>
    `;
    
    return sendEmail(split.booker_email, subject, html);
}

async function sendBookerAllPaid(split, players) {
    const teeDateFormatted = formatDate(split.tee_date);
    
    const subject = `🎉 Everyone paid! ${split.course_name} on ${teeDateFormatted}`;
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #1B4332; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .success { background: #D8F3DC; border: 2px solid #1B4332; padding: 30px; border-radius: 8px; text-align: center; }
        .footer { text-align: center; padding: 20px; color: #666; font-size: 14px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="margin:0;">⛳ Split Tee</h1>
        </div>
        <div class="content">
            <div class="success">
                <h2 style="margin:0;color:#1B4332;">🎉 Everyone's Paid!</h2>
                <p style="margin:15px 0 0;font-size:18px;">All ${split.num_players} players have completed payment.</p>
                <p style="margin:10px 0 0;font-size:14px;color:#666;">Total collected: $${(parseFloat(split.total_per_player) * split.num_players).toFixed(2)}</p>
            </div>
            
            <p style="margin-top:20px;">Your tee time at <strong>${split.course_name}</strong> on <strong>${teeDateFormatted}</strong> is confirmed! Have a great round! ⛳</p>
        </div>
        <div class="footer">
            <p>Confirmation code: <strong>${split.short_code}</strong></p>
        </div>
    </div>
</body>
</html>
    `;
    
    return sendEmail(split.booker_email, subject, html);
}

// ============================================
// REMINDER EMAILS
// ============================================

async function sendPaymentReminder(player, split, minutesRemaining) {
    const paymentUrl = `${process.env.BASE_URL}/pay/${player.payment_token}`;
    
    const subject = `⏰ ${minutesRemaining} minutes left to pay for ${split.course_name}`;
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #DC3545; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .btn { display: inline-block; background: #1B4332; color: white; padding: 15px 40px; text-decoration: none; border-radius: 8px; font-weight: bold; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="margin:0;">⏰ Time is running out!</h1>
        </div>
        <div class="content">
            <p>Hey${player.name ? ' ' + player.name : ''},</p>
            <p>The payment window for your group golf round at <strong>${split.course_name}</strong> closes in <strong>${minutesRemaining} minutes</strong>.</p>
            <p>If you don't pay in time, the entire split will be cancelled and everyone's payments will be refunded.</p>
            
            <div style="text-align:center;margin:30px 0;">
                <a href="${paymentUrl}" class="btn">Pay $${parseFloat(player.amount).toFixed(2)} Now →</a>
            </div>
        </div>
    </div>
</body>
</html>
    `;
    
    return sendEmail(player.email, subject, html);
}

// ============================================
// REFUND NOTIFICATION
// ============================================

async function sendRefundNotification(player, split, reason) {
    const reasonText = {
        'timer_expired': 'the payment window expired before everyone completed their payment',
        'split_cancelled': 'the booking was cancelled',
        'course_cancelled': 'the course cancelled the tee time',
        'player_request': 'you requested a refund',
        'admin_initiated': 'an administrator initiated the refund'
    }[reason] || 'the split was cancelled';
    
    const subject = `💳 Refund processed for ${split.course_name}`;
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #1B4332; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .refund-box { background: white; border: 2px solid #1B4332; padding: 20px; border-radius: 8px; text-align: center; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="margin:0;">⛳ Split Tee</h1>
        </div>
        <div class="content">
            <p>Hey${player.name ? ' ' + player.name : ''},</p>
            <p>We've processed a refund for your payment because ${reasonText}.</p>
            
            <div class="refund-box">
                <p style="margin:0;font-size:14px;color:#666;">Refund Amount</p>
                <p style="margin:5px 0;font-size:28px;font-weight:bold;color:#1B4332;">$${parseFloat(player.amount).toFixed(2)}</p>
                <p style="margin:0;font-size:14px;color:#666;">This should appear on your statement within 5-10 business days.</p>
            </div>
            
            <p style="margin-top:20px;">We hope to see you on the course soon!</p>
        </div>
    </div>
</body>
</html>
    `;
    
    return sendEmail(player.email, subject, html);
}

// ============================================
// COURSE NOTIFICATIONS
// ============================================

async function sendCourseWelcome(course, magicLinkUrl) {
    const subject = `Welcome to Split Tee, ${course.name}!`;
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #1B4332; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .btn { display: inline-block; background: #1B4332; color: white; padding: 15px 40px; text-decoration: none; border-radius: 8px; font-weight: bold; }
        .steps { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
        .step { margin: 15px 0; padding-left: 30px; position: relative; }
        .step:before { content: attr(data-step); position: absolute; left: 0; font-weight: bold; color: #1B4332; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="margin:0;">⛳ Welcome to Split Tee!</h1>
        </div>
        <div class="content">
            <p>Hi ${course.name} team,</p>
            <p>Thanks for signing up! Let's get you set up to accept split payments from your golfers.</p>
            
            <div class="steps">
                <h3 style="margin:0 0 15px;">Getting Started:</h3>
                <div class="step" data-step="1.">Complete your Stripe Connect setup to receive payments</div>
                <div class="step" data-step="2.">Add your embed code to your booking page</div>
                <div class="step" data-step="3.">Start accepting split payments!</div>
            </div>
            
            <div style="text-align:center;">
                <a href="${magicLinkUrl}" class="btn">Access Your Dashboard →</a>
            </div>
            
            <p style="color:#666;font-size:14px;margin-top:20px;">This link expires in 15 minutes. You can always request a new one from the login page.</p>
        </div>
    </div>
</body>
</html>
    `;
    
    return sendEmail(course.email, subject, html);
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function formatDate(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
    });
}

function formatTime(timeStr) {
    const [hours, minutes] = timeStr.split(':');
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour % 12 || 12;
    return `${hour12}:${minutes} ${ampm}`;
}

function stripHtml(html) {
    return html
        .replace(/<style[^>]*>.*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    // Core
    sendEmail,
    sendSMS,
    
    // Player notifications
    sendPaymentInvitation,
    sendPaymentConfirmation,
    sendPaymentReminder,
    sendRefundNotification,
    
    // Booker notifications
    sendBookerSplitCreated,
    sendBookerAllPaid,
    
    // Course notifications
    sendCourseWelcome
};
