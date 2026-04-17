/**
 * Split Tee v2.1 - Security Service
 * Rate limiting, input sanitization, HMAC verification, security headers
 */

const crypto = require('crypto');
const { RateLimits, AuditLog } = require('../db');

// ============================================
// RATE LIMITING
// ============================================

const RATE_LIMITS = {
    // API endpoints
    api_create_split: { max: 30, windowMs: 60000 },      // 30/min
    api_get_split: { max: 100, windowMs: 60000 },        // 100/min
    
    // Payment endpoints
    payment_create: { max: 10, windowMs: 60000 },        // 10/min
    payment_confirm: { max: 20, windowMs: 60000 },       // 20/min
    
    // Auth endpoints
    login: { max: 5, windowMs: 300000 },                 // 5 per 5 min
    magic_link: { max: 3, windowMs: 600000 },            // 3 per 10 min
    password_reset: { max: 3, windowMs: 600000 },        // 3 per 10 min
    register: { max: 3, windowMs: 3600000 },             // 3 per hour
    
    // Webhook endpoints
    webhook_receive: { max: 100, windowMs: 60000 },      // 100/min
    
    // General
    global: { max: 1000, windowMs: 60000 }               // 1000/min global
};

async function checkRateLimit(key, action) {
    const config = RATE_LIMITS[action] || RATE_LIMITS.global;
    return RateLimits.check(key, action, config.max, config.windowMs);
}

function rateLimitMiddleware(action) {
    return async (req, res, next) => {
        // Use IP + action as key
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        const key = `${ip}:${action}`;
        
        const result = await checkRateLimit(key, action);
        
        // Set rate limit headers
        res.set({
            'X-RateLimit-Limit': RATE_LIMITS[action]?.max || 1000,
            'X-RateLimit-Remaining': result.remaining,
            'X-RateLimit-Reset': result.resetAt.toISOString()
        });
        
        if (!result.allowed) {
            await AuditLog.log({
                actorType: 'system',
                action: 'rate_limit_exceeded',
                details: { ip, action, key },
                ipAddress: ip
            });
            
            return res.status(429).json({
                error: 'Too many requests',
                retryAfter: Math.ceil((result.resetAt - new Date()) / 1000)
            });
        }
        
        next();
    };
}

// ============================================
// INPUT SANITIZATION
// ============================================

function sanitizeString(input, maxLength = 1000) {
    if (typeof input !== 'string') return '';
    
    return input
        .trim()
        .substring(0, maxLength)
        .replace(/[<>]/g, '') // Basic XSS prevention
        .replace(/[\x00-\x1F\x7F]/g, ''); // Remove control characters
}

function sanitizeEmail(email) {
    if (typeof email !== 'string') return '';
    
    const sanitized = email.trim().toLowerCase().substring(0, 254);
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    return emailRegex.test(sanitized) ? sanitized : '';
}

function sanitizePhone(phone) {
    if (typeof phone !== 'string') return '';
    
    // Keep only digits, +, -, (, ), and spaces
    return phone.replace(/[^\d+\-() ]/g, '').substring(0, 20);
}

function sanitizeAmount(amount) {
    const num = parseFloat(amount);
    if (isNaN(num) || num < 0 || num > 100000) return null;
    return Math.round(num * 100) / 100; // Round to cents
}

function sanitizeDate(dateStr) {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;
    return date.toISOString().split('T')[0]; // YYYY-MM-DD
}

function sanitizeTime(timeStr) {
    if (typeof timeStr !== 'string') return null;
    
    // Validate HH:MM or HH:MM:SS format
    const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/;
    const match = timeStr.match(timeRegex);
    
    return match ? timeStr : null;
}

function sanitizeShortCode(code) {
    if (typeof code !== 'string') return '';
    return code.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 12);
}

function sanitizeUUID(uuid) {
    if (typeof uuid !== 'string') return '';
    
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid) ? uuid.toLowerCase() : '';
}

// Sanitize player array
function sanitizePlayers(players, maxPlayers = 8) {
    if (!Array.isArray(players)) return [];
    
    return players.slice(0, maxPlayers).map(p => ({
        name: sanitizeString(p.name, 100),
        email: sanitizeEmail(p.email),
        phone: sanitizePhone(p.phone)
    })).filter(p => p.email); // Must have valid email
}

// ============================================
// WEBHOOK SIGNATURE VERIFICATION (HMAC)
// ============================================

function generateWebhookSignature(payload, secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const signaturePayload = `${timestamp}.${payloadString}`;
    
    const signature = crypto
        .createHmac('sha256', secret)
        .update(signaturePayload)
        .digest('hex');
    
    return {
        signature: `t=${timestamp},v1=${signature}`,
        timestamp
    };
}

function verifyWebhookSignature(payload, signature, secret, maxAgeSeconds = 300) {
    if (!signature || !secret) {
        return { valid: false, error: 'Missing signature or secret' };
    }
    
    // Parse signature header: t=timestamp,v1=signature
    const parts = signature.split(',').reduce((acc, part) => {
        const [key, value] = part.split('=');
        acc[key] = value;
        return acc;
    }, {});
    
    if (!parts.t || !parts.v1) {
        return { valid: false, error: 'Invalid signature format' };
    }
    
    const timestamp = parseInt(parts.t);
    const providedSignature = parts.v1;
    
    // Check timestamp is within acceptable range
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > maxAgeSeconds) {
        return { valid: false, error: 'Signature timestamp expired' };
    }
    
    // Compute expected signature
    const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const signaturePayload = `${timestamp}.${payloadString}`;
    
    const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(signaturePayload)
        .digest('hex');
    
    // Timing-safe comparison
    const sigBuffer = Buffer.from(providedSignature);
    const expectedBuffer = Buffer.from(expectedSignature);
    
    if (sigBuffer.length !== expectedBuffer.length) {
        return { valid: false, error: 'Invalid signature' };
    }
    
    const valid = crypto.timingSafeEqual(sigBuffer, expectedBuffer);
    
    return { valid, error: valid ? null : 'Invalid signature' };
}

// ============================================
// STRIPE WEBHOOK VERIFICATION
// ============================================

function verifyStripeWebhook(payload, signature, endpointSecret) {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    
    try {
        const event = stripe.webhooks.constructEvent(
            payload,
            signature,
            endpointSecret
        );
        return { valid: true, event };
    } catch (err) {
        return { valid: false, error: err.message };
    }
}

// ============================================
// SECURITY HEADERS
// ============================================

function securityHeadersMiddleware(req, res, next) {
    // Prevent clickjacking
    res.setHeader('X-Frame-Options', 'DENY');
    
    // XSS protection
    res.setHeader('X-XSS-Protection', '1; mode=block');
    
    // Prevent MIME type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    // Referrer policy
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    
    // Content Security Policy
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://js.stripe.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "frame-src https://js.stripe.com https://hooks.stripe.com",
        "img-src 'self' data: https:",
        "connect-src 'self' https://api.stripe.com"
    ].join('; '));
    
    // HSTS (only in production with HTTPS)
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    
    next();
}

// ============================================
// CORS CONFIGURATION
// ============================================

function corsOptions() {
    const allowedOrigins = process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',')
        : ['http://localhost:3000'];
    
    return {
        origin: (origin, callback) => {
            // Allow requests with no origin (mobile apps, curl, etc.)
            if (!origin) return callback(null, true);
            
            if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error('Not allowed by CORS'));
            }
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-SplitTee-Key', 'X-SplitTee-Signature'],
        maxAge: 86400 // 24 hours
    };
}

// ============================================
// REQUEST VALIDATION MIDDLEWARE
// ============================================

function validateCreateSplitRequest(req, res, next) {
    const { courseId, teeDate, teeTime, greenFee, players, bookerName, bookerEmail } = req.body;
    
    const errors = [];
    
    // Required fields
    if (!courseId) errors.push('courseId is required');
    if (!teeDate) errors.push('teeDate is required');
    if (!teeTime) errors.push('teeTime is required');
    if (!greenFee) errors.push('greenFee is required');
    if (!players || !Array.isArray(players) || players.length < 2) {
        errors.push('At least 2 players are required');
    }
    if (!bookerName) errors.push('bookerName is required');
    if (!bookerEmail) errors.push('bookerEmail is required');
    
    // Validate formats
    if (teeDate && !sanitizeDate(teeDate)) errors.push('Invalid teeDate format');
    if (teeTime && !sanitizeTime(teeTime)) errors.push('Invalid teeTime format');
    if (greenFee && sanitizeAmount(greenFee) === null) errors.push('Invalid greenFee');
    if (bookerEmail && !sanitizeEmail(bookerEmail)) errors.push('Invalid bookerEmail');
    
    // Validate players
    if (players && Array.isArray(players)) {
        if (players.length > 8) errors.push('Maximum 8 players allowed');
        
        const invalidPlayers = players.filter((p, i) => {
            if (!p.email || !sanitizeEmail(p.email)) return true;
            return false;
        });
        
        if (invalidPlayers.length > 0) {
            errors.push('All players must have valid email addresses');
        }
        
        // Check for duplicate emails
        const emails = players.map(p => sanitizeEmail(p.email)).filter(Boolean);
        const uniqueEmails = new Set(emails);
        if (emails.length !== uniqueEmails.size) {
            errors.push('Duplicate player emails are not allowed');
        }
    }
    
    // Check tee date is in future
    if (teeDate) {
        const tee = new Date(teeDate);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        if (tee < today) {
            errors.push('Tee date must be in the future');
        }
    }
    
    if (errors.length > 0) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
    }
    
    // Sanitize and attach cleaned data
    req.sanitizedBody = {
        courseId: sanitizeUUID(courseId) || courseId, // Allow if not UUID format
        teeDate: sanitizeDate(teeDate),
        teeTime: sanitizeTime(teeTime),
        greenFee: sanitizeAmount(greenFee),
        cartFee: sanitizeAmount(req.body.cartFee) || 0,
        players: sanitizePlayers(players),
        bookerName: sanitizeString(bookerName, 100),
        bookerEmail: sanitizeEmail(bookerEmail),
        bookerPhone: sanitizePhone(req.body.bookerPhone),
        externalBookingId: sanitizeString(req.body.externalBookingId, 100)
    };
    
    next();
}

// ============================================
// IP EXTRACTION
// ============================================

function getClientIP(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.ip || req.connection.remoteAddress || 'unknown';
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    // Rate limiting
    checkRateLimit,
    rateLimitMiddleware,
    RATE_LIMITS,
    
    // Sanitization
    sanitizeString,
    sanitizeEmail,
    sanitizePhone,
    sanitizeAmount,
    sanitizeDate,
    sanitizeTime,
    sanitizeShortCode,
    sanitizeUUID,
    sanitizePlayers,
    
    // Webhook signatures
    generateWebhookSignature,
    verifyWebhookSignature,
    verifyStripeWebhook,
    
    // Middleware
    securityHeadersMiddleware,
    corsOptions,
    validateCreateSplitRequest,
    
    // Utilities
    getClientIP
};
