/**
 * Split Tee v2.1 - Main Server
 * Express API with Stripe webhooks and scheduled jobs
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

// Services
const { pool } = require('./db');
const auth = require('./services/auth');
const payments = require('./services/payments');
const refunds = require('./services/refunds');
const webhooks = require('./services/webhooks');
const notifications = require('./services/notifications');
const security = require('./services/security');

// Database models
const { Courses, Splits, Players, Transactions, AuditLog, PlatformStats } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// MIDDLEWARE
// ============================================

// Security headers
app.use(security.securityHeadersMiddleware);

// CORS
app.use(cors(security.corsOptions()));

// Stripe webhooks need raw body
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));

// JSON body parser for all other routes
app.use(express.json({ limit: '1mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Request logging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    } catch (error) {
        res.status(503).json({ status: 'unhealthy', error: error.message });
    }
});

// ============================================
// PUBLIC API - EMBED SDK ENDPOINTS
// ============================================

// Get course info for embed
app.get('/api/v1/courses/:slug/embed', async (req, res) => {
    try {
        const course = await Courses.findBySlug(req.params.slug);
        
        if (!course || course.status !== 'active') {
            return res.status(404).json({ error: 'Course not found' });
        }
        
        res.json({
            id: course.id,
            name: course.name,
            slug: course.slug,
            logoUrl: course.logo_url,
            defaultGreenFee: course.default_green_fee,
            defaultCartFee: course.default_cart_fee,
            blackoutDates: course.blackout_dates
        });
    } catch (error) {
        console.error('Error fetching course:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Calculate pricing (public endpoint for embed)
app.post('/api/v1/pricing/calculate', (req, res) => {
    const { greenFee, cartFee } = req.body;
    
    if (!greenFee || isNaN(greenFee)) {
        return res.status(400).json({ error: 'Invalid greenFee' });
    }
    
    const pricing = payments.calculateTotalPerPlayer(greenFee, cartFee || 0);
    res.json(pricing);
});

// ============================================
// API - SPLIT CREATION (API Key or Embed)
// ============================================

app.post('/api/v1/splits',
    security.rateLimitMiddleware('api_create_split'),
    security.validateCreateSplitRequest,
    auth.apiKeyAuthMiddleware,
    async (req, res) => {
        try {
            const data = req.sanitizedBody;
            data.courseId = req.apiCourse.id;
            data.integrationMode = 'api';
            
            const result = await payments.createSplit(data);
            
            // Send invitations
            for (const player of result.players) {
                await notifications.sendPaymentInvitation(player, result.split);
            }
            
            // Send booker notification
            await notifications.sendBookerSplitCreated(result.split, result.players);
            
            // Webhook to course
            await webhooks.notifySplitCreated(result.split, result.players);
            
            res.status(201).json({
                success: true,
                split: {
                    id: result.split.id,
                    shortCode: result.split.short_code,
                    status: result.split.status,
                    paymentMode: result.split.payment_mode,
                    totalPerPlayer: result.split.total_per_player
                },
                paymentLinks: result.paymentLinks
            });
        } catch (error) {
            console.error('Error creating split:', error);
            
            if (error.message === 'PRICE_TAMPERING_DETECTED') {
                return res.status(400).json({ error: 'Price validation failed' });
            }
            
            res.status(500).json({ error: error.message });
        }
    }
);

// Create split from embed (uses course slug)
app.post('/api/v1/embed/splits',
    security.rateLimitMiddleware('api_create_split'),
    security.validateCreateSplitRequest,
    async (req, res) => {
        try {
            const { courseSlug } = req.body;
            const course = await Courses.findBySlug(courseSlug);
            
            if (!course || course.status !== 'active') {
                return res.status(404).json({ error: 'Course not found' });
            }
            
            const data = req.sanitizedBody;
            data.courseId = course.id;
            data.integrationMode = 'embed';
            
            const result = await payments.createSplit(data);
            
            // Send invitations
            for (const player of result.players) {
                await notifications.sendPaymentInvitation(player, result.split);
            }
            
            // Send booker notification
            await notifications.sendBookerSplitCreated(result.split, result.players);
            
            // Webhook to course
            await webhooks.notifySplitCreated(result.split, result.players);
            
            res.status(201).json({
                success: true,
                split: {
                    id: result.split.id,
                    shortCode: result.split.short_code,
                    status: result.split.status,
                    paymentMode: result.split.payment_mode,
                    totalPerPlayer: result.split.total_per_player
                },
                paymentLinks: result.paymentLinks
            });
        } catch (error) {
            console.error('Error creating embed split:', error);
            res.status(500).json({ error: error.message });
        }
    }
);

// Get split status (public - by short code)
app.get('/api/v1/splits/:shortCode',
    security.rateLimitMiddleware('api_get_split'),
    async (req, res) => {
        try {
            const shortCode = security.sanitizeShortCode(req.params.shortCode);
            const split = await Splits.findByShortCode(shortCode);
            
            if (!split) {
                return res.status(404).json({ error: 'Split not found' });
            }
            
            const players = await Players.findBySplit(split.id);
            
            res.json({
                shortCode: split.short_code,
                courseName: split.course_name,
                teeDate: split.tee_date,
                teeTime: split.tee_time,
                numPlayers: split.num_players,
                totalPerPlayer: split.total_per_player,
                status: split.status,
                timerExpiresAt: split.timer_expires_at,
                players: players.map(p => ({
                    position: p.position,
                    name: p.name,
                    email: p.email.replace(/(.{2})(.*)(@.*)/, '$1***$3'), // Mask email
                    paymentStatus: p.payment_status,
                    isBooker: p.is_booker
                }))
            });
        } catch (error) {
            console.error('Error fetching split:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
);

// ============================================
// PAYMENT ENDPOINTS
// ============================================

// Get payment page data
app.get('/api/v1/payments/:token',
    security.rateLimitMiddleware('payment_create'),
    async (req, res) => {
        try {
            const data = await Players.findByPaymentToken(req.params.token);
            
            if (!data) {
                return res.status(404).json({ error: 'Invalid payment link' });
            }
            
            const { player, split } = data;
            
            // Check if already paid
            if (['authorized', 'captured'].includes(player.payment_status)) {
                return res.json({
                    alreadyPaid: true,
                    split: {
                        shortCode: split.short_code,
                        courseName: split.course_name,
                        teeDate: split.tee_date,
                        teeTime: split.tee_time
                    }
                });
            }
            
            // Check split status
            if (!['pending', 'timer_active', 'partially_paid'].includes(split.status)) {
                return res.json({
                    expired: true,
                    status: split.status,
                    split: {
                        shortCode: split.short_code,
                        courseName: split.course_name
                    }
                });
            }
            
            res.json({
                player: {
                    name: player.name,
                    email: player.email,
                    amount: player.amount,
                    position: player.position,
                    isBooker: player.is_booker
                },
                split: {
                    shortCode: split.short_code,
                    courseName: split.course_name,
                    teeDate: split.tee_date,
                    teeTime: split.tee_time,
                    numPlayers: split.num_players,
                    greenFee: split.green_fee,
                    cartFee: split.cart_fee,
                    platformFee: split.platform_fee,
                    status: split.status,
                    timerExpiresAt: split.timer_expires_at,
                    paymentMode: split.payment_mode
                }
            });
        } catch (error) {
            console.error('Error fetching payment data:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
);

// Create payment intent
app.post('/api/v1/payments/:token/intent',
    security.rateLimitMiddleware('payment_create'),
    async (req, res) => {
        try {
            const result = await payments.createPaymentIntent(req.params.token);
            
            // Start timer if this is the first payment
            const split = await Splits.findByShortCode(result.split.shortCode);
            if (split.status === 'pending') {
                await Splits.startTimer(split.id);
                await webhooks.notifyTimerStarted(split);
            }
            
            res.json({
                clientSecret: result.clientSecret,
                amount: result.amount,
                paymentMode: result.paymentMode,
                timerExpiresAt: result.split.timerExpiresAt
            });
        } catch (error) {
            console.error('Error creating payment intent:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

// Confirm payment (called after Stripe.js confirms)
app.post('/api/v1/payments/:token/confirm',
    security.rateLimitMiddleware('payment_confirm'),
    async (req, res) => {
        try {
            const { paymentIntentId } = req.body;
            
            if (!paymentIntentId) {
                return res.status(400).json({ error: 'paymentIntentId required' });
            }
            
            const result = await payments.handlePaymentSuccess(paymentIntentId);
            
            // Send confirmation email
            await notifications.sendPaymentConfirmation(result.player, result.split);
            
            // Get updated counts
            const paidCount = await Splits.getPaidCount(result.split.id);
            
            // Webhook to course
            await webhooks.notifyPaymentReceived(result.split, result.player, paidCount, result.split.num_players);
            
            // If all paid
            if (result.allPaid) {
                const players = await Players.findBySplit(result.split.id);
                await notifications.sendBookerAllPaid(result.split, players);
                await webhooks.notifyFullyPaid(result.split, players);
                
                // If immediate capture, also send confirmed webhook
                if (result.split.payment_mode === 'immediate_capture') {
                    await webhooks.notifySplitConfirmed(result.split, players);
                }
            }
            
            res.json({
                success: true,
                allPaid: result.allPaid,
                paidCount,
                total: result.split.num_players
            });
        } catch (error) {
            console.error('Error confirming payment:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

// ============================================
// STRIPE WEBHOOKS
// ============================================

app.post('/webhooks/stripe', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    
    const verification = security.verifyStripeWebhook(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
    );
    
    if (!verification.valid) {
        console.error('Stripe webhook verification failed:', verification.error);
        return res.status(400).send(`Webhook Error: ${verification.error}`);
    }
    
    const event = verification.event;
    
    try {
        switch (event.type) {
            case 'payment_intent.succeeded':
                await handlePaymentIntentSucceeded(event.data.object);
                break;
                
            case 'payment_intent.payment_failed':
                await handlePaymentIntentFailed(event.data.object);
                break;
                
            case 'account.updated':
                await handleAccountUpdated(event.data.object);
                break;
                
            default:
                console.log(`Unhandled event type: ${event.type}`);
        }
        
        res.json({ received: true });
    } catch (error) {
        console.error(`Error handling webhook ${event.type}:`, error);
        res.status(500).json({ error: 'Webhook handler error' });
    }
});

async function handlePaymentIntentSucceeded(paymentIntent) {
    // This is a backup - primary confirmation happens via client
    const player = await Players.findByStripePaymentIntent(paymentIntent.id);
    
    if (player && player.payment_status === 'processing') {
        await payments.handlePaymentSuccess(paymentIntent.id);
    }
}

async function handlePaymentIntentFailed(paymentIntent) {
    const player = await Players.findByStripePaymentIntent(paymentIntent.id);
    
    if (player) {
        await Players.updatePaymentStatus(player.id, 'failed');
        
        await AuditLog.log({
            actorType: 'system',
            action: 'payment_failed',
            resourceType: 'player',
            resourceId: player.id,
            details: { 
                paymentIntentId: paymentIntent.id,
                error: paymentIntent.last_payment_error?.message 
            }
        });
    }
}

async function handleAccountUpdated(account) {
    const course = await Courses.findByStripeAccount(account.id);
    
    if (course) {
        await payments.checkConnectStatus(course.id);
    }
}

// ============================================
// COURSE AUTHENTICATION
// ============================================

app.post('/api/v1/courses/register',
    security.rateLimitMiddleware('register'),
    async (req, res) => {
        try {
            const { name, email, password, phone, address, city, state, zip } = req.body;
            
            if (!name || !email || !password) {
                return res.status(400).json({ error: 'Name, email, and password required' });
            }
            
            if (password.length < 8) {
                return res.status(400).json({ error: 'Password must be at least 8 characters' });
            }
            
            const result = await auth.registerCourse({
                name: security.sanitizeString(name, 200),
                email: security.sanitizeEmail(email),
                password,
                phone: security.sanitizePhone(phone),
                address: security.sanitizeString(address, 500),
                city: security.sanitizeString(city, 100),
                state: security.sanitizeString(state, 50),
                zip: security.sanitizeString(zip, 20)
            });
            
            if (!result.success) {
                return res.status(400).json({ error: result.error });
            }
            
            // Create magic link for immediate login
            const magicLink = await auth.createMagicLink(
                result.course.id,
                process.env.BASE_URL
            );
            
            // Send welcome email
            await notifications.sendCourseWelcome(result.course, magicLink.url);
            
            res.status(201).json({
                success: true,
                course: result.course,
                message: 'Check your email to complete setup'
            });
        } catch (error) {
            console.error('Registration error:', error);
            res.status(500).json({ error: 'Registration failed' });
        }
    }
);

app.post('/api/v1/courses/login',
    security.rateLimitMiddleware('login'),
    async (req, res) => {
        try {
            const { email, password } = req.body;
            
            const result = await auth.courseLogin(email, password, {
                ipAddress: security.getClientIP(req),
                userAgent: req.headers['user-agent']
            });
            
            if (!result.success) {
                return res.status(401).json({ error: result.error, locked: result.locked });
            }
            
            res.json({
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
                course: result.course
            });
        } catch (error) {
            console.error('Login error:', error);
            res.status(500).json({ error: 'Login failed' });
        }
    }
);

app.post('/api/v1/courses/magic-link',
    security.rateLimitMiddleware('magic_link'),
    async (req, res) => {
        try {
            const { email } = req.body;
            
            const result = await auth.initiatePasswordReset(email, process.env.BASE_URL);
            
            // Always return success to prevent email enumeration
            res.json({ success: true, message: result.message });
            
            // Send email if course exists (done async)
            if (result._internal) {
                // TODO: Send magic link email
            }
        } catch (error) {
            console.error('Magic link error:', error);
            res.json({ success: true, message: 'If the email exists, a link has been sent.' });
        }
    }
);

app.get('/api/v1/auth/magic-link',
    async (req, res) => {
        try {
            const { token } = req.query;
            
            const result = await auth.courseMagicLinkLogin(token, {
                ipAddress: security.getClientIP(req),
                userAgent: req.headers['user-agent']
            });
            
            if (!result.success) {
                return res.redirect('/login?error=invalid_link');
            }
            
            // Redirect to dashboard with tokens
            res.redirect(`/dashboard?access_token=${result.accessToken}&refresh_token=${result.refreshToken}`);
        } catch (error) {
            console.error('Magic link login error:', error);
            res.redirect('/login?error=login_failed');
        }
    }
);

app.post('/api/v1/courses/refresh',
    async (req, res) => {
        try {
            const { refreshToken } = req.body;
            
            const result = await auth.refreshCourseToken(refreshToken);
            
            if (!result.success) {
                return res.status(401).json({ error: result.error });
            }
            
            res.json({ accessToken: result.accessToken });
        } catch (error) {
            console.error('Token refresh error:', error);
            res.status(500).json({ error: 'Refresh failed' });
        }
    }
);

app.post('/api/v1/courses/logout',
    auth.courseAuthMiddleware,
    async (req, res) => {
        try {
            const { refreshToken } = req.body;
            await auth.courseLogout(refreshToken);
            res.json({ success: true });
        } catch (error) {
            res.json({ success: true }); // Always succeed
        }
    }
);

// ============================================
// COURSE DASHBOARD API
// ============================================

app.get('/api/v1/courses/me',
    auth.courseAuthMiddleware,
    async (req, res) => {
        try {
            const course = await Courses.findById(req.courseAuth.courseId);
            const summary = await Courses.getDashboardSummary(course.id);
            
            res.json({
                course: {
                    id: course.id,
                    name: course.name,
                    email: course.email,
                    slug: course.slug,
                    stripeOnboardingComplete: course.stripe_onboarding_complete,
                    stripePayoutsEnabled: course.stripe_payouts_enabled,
                    status: course.status,
                    webhookUrl: course.webhook_url,
                    hasApiKey: !!course.api_key_hash
                },
                summary
            });
        } catch (error) {
            console.error('Error fetching course:', error);
            res.status(500).json({ error: 'Failed to fetch course data' });
        }
    }
);

app.get('/api/v1/courses/me/splits',
    auth.courseAuthMiddleware,
    async (req, res) => {
        try {
            const { status, fromDate, toDate, limit = 50 } = req.query;
            
            const splits = await Splits.findByCourse(req.courseAuth.courseId, {
                status,
                fromDate,
                toDate,
                limit: Math.min(parseInt(limit), 100)
            });
            
            res.json({ splits });
        } catch (error) {
            console.error('Error fetching splits:', error);
            res.status(500).json({ error: 'Failed to fetch splits' });
        }
    }
);

app.get('/api/v1/courses/me/splits/:id',
    auth.courseAuthMiddleware,
    async (req, res) => {
        try {
            const split = await Splits.findWithPlayers(req.params.id);
            
            if (!split || split.course_id !== req.courseAuth.courseId) {
                return res.status(404).json({ error: 'Split not found' });
            }
            
            res.json({ split });
        } catch (error) {
            console.error('Error fetching split:', error);
            res.status(500).json({ error: 'Failed to fetch split' });
        }
    }
);

app.get('/api/v1/courses/me/transactions',
    auth.courseAuthMiddleware,
    async (req, res) => {
        try {
            const { type, status, fromDate, limit = 50 } = req.query;
            
            const transactions = await Transactions.findByCourse(req.courseAuth.courseId, {
                type,
                status,
                fromDate,
                limit: Math.min(parseInt(limit), 100)
            });
            
            res.json({ transactions });
        } catch (error) {
            console.error('Error fetching transactions:', error);
            res.status(500).json({ error: 'Failed to fetch transactions' });
        }
    }
);

// ============================================
// STRIPE CONNECT ONBOARDING
// ============================================

app.post('/api/v1/courses/me/stripe/onboard',
    auth.courseAuthMiddleware,
    async (req, res) => {
        try {
            const accountLink = await payments.createConnectOnboardingLink(
                req.courseAuth.courseId,
                `${process.env.BASE_URL}/dashboard/stripe/refresh`,
                `${process.env.BASE_URL}/dashboard/stripe/complete`
            );
            
            res.json({ url: accountLink.url });
        } catch (error) {
            console.error('Stripe onboarding error:', error);
            res.status(500).json({ error: 'Failed to create onboarding link' });
        }
    }
);

app.get('/api/v1/courses/me/stripe/status',
    auth.courseAuthMiddleware,
    async (req, res) => {
        try {
            const status = await payments.checkConnectStatus(req.courseAuth.courseId);
            res.json(status);
        } catch (error) {
            console.error('Stripe status error:', error);
            res.status(500).json({ error: 'Failed to check status' });
        }
    }
);

app.get('/api/v1/courses/me/stripe/dashboard',
    auth.courseAuthMiddleware,
    async (req, res) => {
        try {
            const loginLink = await payments.createConnectLoginLink(req.courseAuth.courseId);
            res.json({ url: loginLink.url });
        } catch (error) {
            console.error('Stripe dashboard link error:', error);
            res.status(500).json({ error: 'Failed to create dashboard link' });
        }
    }
);

// ============================================
// API KEY MANAGEMENT
// ============================================

app.post('/api/v1/courses/me/api-key',
    auth.courseAuthMiddleware,
    async (req, res) => {
        try {
            const result = await Courses.generateApiKey(req.courseAuth.courseId);
            
            await AuditLog.log({
                actorType: 'course',
                actorId: req.courseAuth.courseId,
                action: 'api_key_generated',
                resourceType: 'course',
                resourceId: req.courseAuth.courseId
            });
            
            // Only show full key once
            res.json({
                apiKey: result.apiKey,
                prefix: result.prefix,
                warning: 'Save this key securely. It will not be shown again.'
            });
        } catch (error) {
            console.error('API key generation error:', error);
            res.status(500).json({ error: 'Failed to generate API key' });
        }
    }
);

// ============================================
// WEBHOOK CONFIGURATION
// ============================================

app.put('/api/v1/courses/me/webhook',
    auth.courseAuthMiddleware,
    async (req, res) => {
        try {
            const { webhookUrl } = req.body;
            
            // Generate webhook secret
            const webhookSecret = require('crypto').randomBytes(32).toString('hex');
            
            await Courses.update(req.courseAuth.courseId, {
                webhookUrl: webhookUrl || null,
                webhookSecret: webhookUrl ? webhookSecret : null
            });
            
            res.json({
                webhookUrl,
                webhookSecret: webhookUrl ? webhookSecret : null,
                warning: 'Save the webhook secret securely. It will not be shown again.'
            });
        } catch (error) {
            console.error('Webhook config error:', error);
            res.status(500).json({ error: 'Failed to update webhook' });
        }
    }
);

app.post('/api/v1/courses/me/webhook/test',
    auth.courseAuthMiddleware,
    async (req, res) => {
        try {
            const result = await webhooks.sendTestWebhook(req.courseAuth.courseId);
            res.json(result);
        } catch (error) {
            console.error('Webhook test error:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

// ============================================
// ADMIN API
// ============================================

app.post('/api/v1/admin/login',
    security.rateLimitMiddleware('login'),
    async (req, res) => {
        try {
            const { email, password } = req.body;
            
            const result = await auth.adminLogin(email, password, {
                ipAddress: security.getClientIP(req),
                userAgent: req.headers['user-agent']
            });
            
            if (!result.success) {
                return res.status(401).json({ error: result.error });
            }
            
            res.json({
                accessToken: result.accessToken,
                admin: result.admin
            });
        } catch (error) {
            console.error('Admin login error:', error);
            res.status(500).json({ error: 'Login failed' });
        }
    }
);

app.get('/api/v1/admin/summary',
    auth.adminAuthMiddleware,
    async (req, res) => {
        try {
            const summary = await PlatformStats.getSummary();
            res.json(summary);
        } catch (error) {
            console.error('Admin summary error:', error);
            res.status(500).json({ error: 'Failed to fetch summary' });
        }
    }
);

app.get('/api/v1/admin/courses',
    auth.adminAuthMiddleware,
    async (req, res) => {
        try {
            const { status, limit = 50 } = req.query;
            const courses = await Courses.listAll({ status, limit: Math.min(parseInt(limit), 100) });
            res.json({ courses });
        } catch (error) {
            console.error('Admin courses error:', error);
            res.status(500).json({ error: 'Failed to fetch courses' });
        }
    }
);

app.get('/api/v1/admin/refunds/escalated',
    auth.adminAuthMiddleware,
    async (req, res) => {
        try {
            const escalated = await refunds.getEscalatedRefunds();
            res.json({ refunds: escalated });
        } catch (error) {
            console.error('Admin refunds error:', error);
            res.status(500).json({ error: 'Failed to fetch refunds' });
        }
    }
);

app.post('/api/v1/admin/refunds/:id/resolve',
    auth.adminAuthMiddleware,
    async (req, res) => {
        try {
            const { resolution } = req.body;
            const result = await refunds.resolveEscalatedRefund(
                req.params.id,
                resolution,
                req.adminAuth.adminId
            );
            res.json(result);
        } catch (error) {
            console.error('Refund resolution error:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

// ============================================
// SCHEDULED JOBS
// ============================================

// Check for expired timers every minute
setInterval(async () => {
    try {
        const expiredSplits = await Splits.findExpiredTimers();
        
        for (const split of expiredSplits) {
            console.log(`Processing expired split: ${split.short_code}`);
            
            // Refund all paid players
            await refunds.refundSplit(split.id, 'timer_expired');
            
            // Update split status
            await Splits.updateStatus(split.id, 'expired');
            
            // Send notifications
            const players = await Players.findBySplit(split.id);
            for (const player of players) {
                if (['authorized', 'captured'].includes(player.payment_status)) {
                    await notifications.sendRefundNotification(player, split, 'timer_expired');
                }
            }
            
            // Webhook to course
            await webhooks.notifySplitExpired(split);
        }
    } catch (error) {
        console.error('Timer check job error:', error);
    }
}, 60000);

// Process pending refunds every 5 minutes
setInterval(async () => {
    try {
        await refunds.processPendingRetries();
    } catch (error) {
        console.error('Refund retry job error:', error);
    }
}, 300000);

// Process pending webhooks every 2 minutes
setInterval(async () => {
    try {
        await webhooks.processPendingWebhooks();
    } catch (error) {
        console.error('Webhook retry job error:', error);
    }
}, 120000);

// Capture authorized payments on tee date (run at midnight)
// In production, use a proper scheduler like node-cron

// ============================================
// ERROR HANDLER
// ============================================

app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    
    await AuditLog.log({
        actorType: 'system',
        action: 'unhandled_error',
        details: { 
            error: err.message, 
            stack: err.stack,
            path: req.path 
        }
    }).catch(() => {});
    
    res.status(500).json({ error: 'Internal server error' });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
    console.log(`🏌️ Split Tee v2.1 running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
