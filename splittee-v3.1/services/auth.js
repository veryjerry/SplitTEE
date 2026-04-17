/**
 * Split Tee v2.1 - Authentication Service
 * Handles course and admin authentication with security best practices
 */

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Courses, CourseSessions, Admins, AuditLog } = require('./db');

const SALT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRY = '24h';
const REFRESH_TOKEN_EXPIRY = '7d';
const MAGIC_LINK_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000; // 30 minutes

// ============================================
// PASSWORD HASHING
// ============================================

async function hashPassword(password) {
    return bcrypt.hash(password, SALT_ROUNDS);
}

async function verifyPassword(password, hash) {
    // Timing-safe comparison via bcrypt
    return bcrypt.compare(password, hash);
}

// ============================================
// JWT TOKEN GENERATION
// ============================================

function generateAccessToken(payload, type = 'course') {
    const secret = type === 'admin' 
        ? process.env.ADMIN_JWT_SECRET 
        : process.env.JWT_SECRET;
    
    return jwt.sign(
        { ...payload, type, iat: Math.floor(Date.now() / 1000) },
        secret,
        { expiresIn: ACCESS_TOKEN_EXPIRY }
    );
}

function generateRefreshToken() {
    return crypto.randomBytes(64).toString('hex');
}

function verifyAccessToken(token, type = 'course') {
    const secret = type === 'admin' 
        ? process.env.ADMIN_JWT_SECRET 
        : process.env.JWT_SECRET;
    
    try {
        return jwt.verify(token, secret);
    } catch (error) {
        return null;
    }
}

// ============================================
// MAGIC LINK GENERATION
// ============================================

function generateMagicLinkToken() {
    return crypto.randomBytes(32).toString('hex');
}

async function createMagicLink(courseId, baseUrl) {
    const token = generateMagicLinkToken();
    const expires = new Date(Date.now() + MAGIC_LINK_EXPIRY_MS);
    
    await Courses.setMagicLink(courseId, token, expires);
    
    return {
        token,
        url: `${baseUrl}/auth/magic-link?token=${token}`,
        expiresAt: expires
    };
}

async function verifyMagicLink(token) {
    const course = await Courses.findByMagicLink(token);
    
    if (!course) {
        return { valid: false, error: 'Invalid or expired magic link' };
    }
    
    // Clear the magic link after use (single-use)
    await Courses.clearMagicLink(course.id);
    
    return { valid: true, course };
}

// ============================================
// COURSE AUTHENTICATION
// ============================================

async function courseLogin(email, password, metadata = {}) {
    const course = await Courses.findByEmail(email.toLowerCase());
    
    if (!course) {
        // Timing-safe: still hash something to prevent timing attacks
        await bcrypt.hash('dummy', SALT_ROUNDS);
        return { success: false, error: 'Invalid credentials' };
    }
    
    // Check if account is locked
    if (course.locked_until && new Date(course.locked_until) > new Date()) {
        const remainingMs = new Date(course.locked_until) - new Date();
        const remainingMins = Math.ceil(remainingMs / 60000);
        return { 
            success: false, 
            error: `Account locked. Try again in ${remainingMins} minutes.`,
            locked: true
        };
    }
    
    // Verify password
    const validPassword = await verifyPassword(password, course.password_hash);
    
    if (!validPassword) {
        const attempts = await Courses.incrementFailedLogins(course.id);
        
        await AuditLog.log({
            actorType: 'course',
            actorId: course.id,
            action: 'login_failed',
            resourceType: 'course',
            resourceId: course.id,
            details: { attempt: attempts },
            ipAddress: metadata.ipAddress,
            userAgent: metadata.userAgent
        });
        
        if (attempts >= MAX_FAILED_ATTEMPTS) {
            const lockUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
            await Courses.lockAccount(course.id, lockUntil);
            
            return { 
                success: false, 
                error: 'Too many failed attempts. Account locked for 30 minutes.',
                locked: true
            };
        }
        
        return { 
            success: false, 
            error: 'Invalid credentials',
            attemptsRemaining: MAX_FAILED_ATTEMPTS - attempts
        };
    }
    
    // Successful login
    await Courses.resetFailedLogins(course.id);
    
    const accessToken = generateAccessToken({
        courseId: course.id,
        email: course.email,
        name: course.name
    }, 'course');
    
    const refreshToken = generateRefreshToken();
    await CourseSessions.create(course.id, refreshToken, metadata);
    
    await AuditLog.log({
        actorType: 'course',
        actorId: course.id,
        action: 'login_success',
        resourceType: 'course',
        resourceId: course.id,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent
    });
    
    return {
        success: true,
        accessToken,
        refreshToken,
        course: {
            id: course.id,
            name: course.name,
            email: course.email,
            stripeOnboardingComplete: course.stripe_onboarding_complete
        }
    };
}

async function courseMagicLinkLogin(token, metadata = {}) {
    const result = await verifyMagicLink(token);
    
    if (!result.valid) {
        return { success: false, error: result.error };
    }
    
    const course = result.course;
    
    // Reset any lockouts
    await Courses.resetFailedLogins(course.id);
    
    const accessToken = generateAccessToken({
        courseId: course.id,
        email: course.email,
        name: course.name
    }, 'course');
    
    const refreshToken = generateRefreshToken();
    await CourseSessions.create(course.id, refreshToken, metadata);
    
    await AuditLog.log({
        actorType: 'course',
        actorId: course.id,
        action: 'magic_link_login',
        resourceType: 'course',
        resourceId: course.id,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent
    });
    
    return {
        success: true,
        accessToken,
        refreshToken,
        course: {
            id: course.id,
            name: course.name,
            email: course.email,
            stripeOnboardingComplete: course.stripe_onboarding_complete
        }
    };
}

async function refreshCourseToken(refreshToken, metadata = {}) {
    const session = await CourseSessions.validate(refreshToken);
    
    if (!session) {
        return { success: false, error: 'Invalid or expired session' };
    }
    
    const course = await Courses.findById(session.course_id);
    
    if (!course || course.status !== 'active') {
        await CourseSessions.revoke(refreshToken);
        return { success: false, error: 'Account not active' };
    }
    
    const accessToken = generateAccessToken({
        courseId: course.id,
        email: course.email,
        name: course.name
    }, 'course');
    
    return {
        success: true,
        accessToken,
        course: {
            id: course.id,
            name: course.name,
            email: course.email
        }
    };
}

async function courseLogout(refreshToken) {
    await CourseSessions.revoke(refreshToken);
    return { success: true };
}

async function courseLogoutAll(courseId) {
    await CourseSessions.revokeAllForCourse(courseId);
    return { success: true };
}

// ============================================
// ADMIN AUTHENTICATION
// ============================================

async function adminLogin(email, password, metadata = {}) {
    const admin = await Admins.findByEmail(email.toLowerCase());
    
    if (!admin) {
        await bcrypt.hash('dummy', SALT_ROUNDS);
        return { success: false, error: 'Invalid credentials' };
    }
    
    if (!admin.is_active) {
        return { success: false, error: 'Account disabled' };
    }
    
    // Check lockout
    if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
        const remainingMs = new Date(admin.locked_until) - new Date();
        const remainingMins = Math.ceil(remainingMs / 60000);
        return { 
            success: false, 
            error: `Account locked. Try again in ${remainingMins} minutes.`
        };
    }
    
    const validPassword = await verifyPassword(password, admin.password_hash);
    
    if (!validPassword) {
        const attempts = await Admins.incrementFailedLogins(admin.id);
        
        await AuditLog.log({
            actorType: 'admin',
            actorId: admin.id,
            action: 'admin_login_failed',
            resourceType: 'admin',
            resourceId: admin.id,
            details: { attempt: attempts },
            ipAddress: metadata.ipAddress,
            userAgent: metadata.userAgent
        });
        
        if (attempts >= MAX_FAILED_ATTEMPTS) {
            const lockUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
            await Admins.lockAccount(admin.id, lockUntil);
        }
        
        return { success: false, error: 'Invalid credentials' };
    }
    
    await Admins.resetFailedLogins(admin.id);
    
    const accessToken = generateAccessToken({
        adminId: admin.id,
        email: admin.email,
        role: admin.role
    }, 'admin');
    
    await AuditLog.log({
        actorType: 'admin',
        actorId: admin.id,
        action: 'admin_login_success',
        resourceType: 'admin',
        resourceId: admin.id,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent
    });
    
    return {
        success: true,
        accessToken,
        admin: {
            id: admin.id,
            name: admin.name,
            email: admin.email,
            role: admin.role
        }
    };
}

// ============================================
// API KEY AUTHENTICATION
// ============================================

async function verifyApiKey(apiKey) {
    if (!apiKey || apiKey.length < 10) {
        return { valid: false };
    }
    
    const prefix = apiKey.substring(0, 8);
    const course = await Courses.findByApiKey(prefix);
    
    if (!course) {
        return { valid: false };
    }
    
    // Verify full key hash
    const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
    
    if (hash !== course.api_key_hash) {
        return { valid: false };
    }
    
    if (course.status !== 'active') {
        return { valid: false, error: 'Course not active' };
    }
    
    return {
        valid: true,
        course: {
            id: course.id,
            name: course.name,
            stripeAccountId: course.stripe_account_id
        }
    };
}

// ============================================
// COURSE REGISTRATION
// ============================================

async function registerCourse(data) {
    // Validate email not already registered
    const existing = await Courses.findByEmail(data.email.toLowerCase());
    if (existing) {
        return { success: false, error: 'Email already registered' };
    }
    
    const passwordHash = await hashPassword(data.password);
    
    const course = await Courses.create({
        ...data,
        email: data.email.toLowerCase(),
        passwordHash
    });
    
    await AuditLog.log({
        actorType: 'course',
        actorId: course.id,
        action: 'course_registered',
        resourceType: 'course',
        resourceId: course.id,
        details: { name: course.name, email: course.email }
    });
    
    return {
        success: true,
        course: {
            id: course.id,
            name: course.name,
            email: course.email,
            slug: course.slug
        }
    };
}

// ============================================
// PASSWORD RESET
// ============================================

async function initiatePasswordReset(email, baseUrl) {
    const course = await Courses.findByEmail(email.toLowerCase());
    
    // Always return success to prevent email enumeration
    if (!course) {
        return { success: true, message: 'If the email exists, a reset link has been sent.' };
    }
    
    const magicLink = await createMagicLink(course.id, baseUrl);
    
    // Return the link - the calling code should send the email
    return {
        success: true,
        message: 'If the email exists, a reset link has been sent.',
        // Only include these in development or for email sending
        _internal: {
            courseId: course.id,
            token: magicLink.token,
            url: magicLink.url,
            expiresAt: magicLink.expiresAt
        }
    };
}

async function resetPassword(token, newPassword) {
    const result = await verifyMagicLink(token);
    
    if (!result.valid) {
        return { success: false, error: result.error };
    }
    
    const passwordHash = await hashPassword(newPassword);
    await Courses.update(result.course.id, { passwordHash });
    
    // Revoke all sessions
    await CourseSessions.revokeAllForCourse(result.course.id);
    
    await AuditLog.log({
        actorType: 'course',
        actorId: result.course.id,
        action: 'password_reset',
        resourceType: 'course',
        resourceId: result.course.id
    });
    
    return { success: true };
}

// ============================================
// MIDDLEWARE HELPERS
// ============================================

function extractBearerToken(authHeader) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
    }
    return authHeader.substring(7);
}

function courseAuthMiddleware(req, res, next) {
    const token = extractBearerToken(req.headers.authorization);
    
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    const payload = verifyAccessToken(token, 'course');
    
    if (!payload) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
    
    if (payload.type !== 'course') {
        return res.status(403).json({ error: 'Invalid token type' });
    }
    
    req.courseAuth = payload;
    next();
}

function adminAuthMiddleware(req, res, next) {
    const token = extractBearerToken(req.headers.authorization);
    
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    const payload = verifyAccessToken(token, 'admin');
    
    if (!payload) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
    
    if (payload.type !== 'admin') {
        return res.status(403).json({ error: 'Invalid token type' });
    }
    
    req.adminAuth = payload;
    next();
}

async function apiKeyAuthMiddleware(req, res, next) {
    const apiKey = req.headers['x-splittee-key'];
    
    if (!apiKey) {
        return res.status(401).json({ error: 'API key required' });
    }
    
    const result = await verifyApiKey(apiKey);
    
    if (!result.valid) {
        return res.status(401).json({ error: result.error || 'Invalid API key' });
    }
    
    req.apiCourse = result.course;
    next();
}

// Combined middleware that accepts either JWT or API key
async function courseOrApiKeyAuth(req, res, next) {
    // Try JWT first
    const token = extractBearerToken(req.headers.authorization);
    if (token) {
        const payload = verifyAccessToken(token, 'course');
        if (payload && payload.type === 'course') {
            req.courseAuth = payload;
            return next();
        }
    }
    
    // Try API key
    const apiKey = req.headers['x-splittee-key'];
    if (apiKey) {
        const result = await verifyApiKey(apiKey);
        if (result.valid) {
            req.apiCourse = result.course;
            req.courseAuth = { courseId: result.course.id };
            return next();
        }
    }
    
    return res.status(401).json({ error: 'Authentication required' });
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    // Password utilities
    hashPassword,
    verifyPassword,
    
    // Token utilities
    generateAccessToken,
    generateRefreshToken,
    verifyAccessToken,
    
    // Magic links
    createMagicLink,
    verifyMagicLink,
    
    // Course auth
    courseLogin,
    courseMagicLinkLogin,
    refreshCourseToken,
    courseLogout,
    courseLogoutAll,
    registerCourse,
    
    // Admin auth
    adminLogin,
    
    // API key auth
    verifyApiKey,
    
    // Password reset
    initiatePasswordReset,
    resetPassword,
    
    // Middleware
    courseAuthMiddleware,
    adminAuthMiddleware,
    apiKeyAuthMiddleware,
    courseOrApiKeyAuth,
    extractBearerToken
};
