/**
 * Split Tee v2.1 - Payments Service
 * Dual-mode Stripe payments with Connect integration
 */

const Stripe = require('stripe');
const { Splits, Players, Transactions, Courses, withTransaction } = require('../db');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ============================================
// CONSTANTS
// ============================================

const PLATFORM_FEE_PERCENT = 0.03; // 3%
const PLATFORM_FEE_MIN = 2.00;     // $2 minimum
const PLATFORM_FEE_MAX = 5.00;     // $5 maximum
const AUTH_HOLD_THRESHOLD_DAYS = 7; // Use auth hold if tee time is within 6 days
const AUTH_HOLD_VALID_DAYS = 6;     // Stripe auth holds valid for ~7 days

// ============================================
// FEE CALCULATION
// ============================================

function calculatePlatformFee(basePrice) {
    const percentFee = basePrice * PLATFORM_FEE_PERCENT;
    return Math.min(Math.max(percentFee, PLATFORM_FEE_MIN), PLATFORM_FEE_MAX);
}

function calculateTotalPerPlayer(greenFee, cartFee = 0) {
    const basePrice = parseFloat(greenFee) + parseFloat(cartFee);
    const platformFee = calculatePlatformFee(basePrice);
    return {
        basePrice: Math.round(basePrice * 100) / 100,
        platformFee: Math.round(platformFee * 100) / 100,
        totalPerPlayer: Math.round((basePrice + platformFee) * 100) / 100
    };
}

function determinePaymentMode(teeDate) {
    const now = new Date();
    const tee = new Date(teeDate);
    const diffMs = tee - now;
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    
    // If tee time is 7+ days away, use immediate capture (auth would expire)
    // If tee time is within 6 days, use auth hold (capture at tee time)
    return {
        mode: diffDays >= AUTH_HOLD_THRESHOLD_DAYS ? 'immediate_capture' : 'auth_hold',
        daysUntilTee: diffDays
    };
}

// ============================================
// PRICE TAMPERING PREVENTION
// ============================================

function validatePricing(clientPricing, serverPricing) {
    const tolerance = 0.01; // Allow 1 cent tolerance for rounding
    
    const baseMatch = Math.abs(clientPricing.basePrice - serverPricing.basePrice) <= tolerance;
    const feeMatch = Math.abs(clientPricing.platformFee - serverPricing.platformFee) <= tolerance;
    const totalMatch = Math.abs(clientPricing.totalPerPlayer - serverPricing.totalPerPlayer) <= tolerance;
    
    if (!baseMatch || !feeMatch || !totalMatch) {
        return {
            valid: false,
            error: 'PRICE_TAMPERING_DETECTED',
            details: {
                client: clientPricing,
                server: serverPricing
            }
        };
    }
    
    return { valid: true };
}

// ============================================
// SPLIT CREATION
// ============================================

async function createSplit(data) {
    // Server-side price calculation (never trust client)
    const pricing = calculateTotalPerPlayer(data.greenFee, data.cartFee);
    
    // Validate client-provided pricing matches
    if (data.clientPricing) {
        const validation = validatePricing(data.clientPricing, pricing);
        if (!validation.valid) {
            throw new Error(validation.error);
        }
    }
    
    // Determine payment mode based on tee date
    const { mode, daysUntilTee } = determinePaymentMode(data.teeDate);
    
    // Get course info for Stripe Connect
    const course = await Courses.findById(data.courseId);
    if (!course) {
        throw new Error('Course not found');
    }
    
    if (!course.stripe_account_id || !course.stripe_onboarding_complete) {
        throw new Error('Course has not completed payment setup');
    }
    
    // Create split and players in a transaction
    const result = await withTransaction(async (client) => {
        // Create the split
        const split = await Splits.create({
            courseId: data.courseId,
            courseName: course.name,
            teeDate: data.teeDate,
            teeTime: data.teeTime,
            numPlayers: data.players.length,
            greenFee: data.greenFee,
            cartFee: data.cartFee || 0,
            basePrice: pricing.basePrice,
            platformFee: pricing.platformFee,
            totalPerPlayer: pricing.totalPerPlayer,
            paymentMode: mode,
            daysUntilTee,
            bookerName: data.bookerName,
            bookerEmail: data.bookerEmail,
            bookerPhone: data.bookerPhone,
            externalBookingId: data.externalBookingId,
            integrationMode: data.integrationMode || 'embed'
        }, client);
        
        // Create players
        const players = await Players.createBulk(
            data.players.map((player, index) => ({
                splitId: split.id,
                position: index + 1,
                name: player.name,
                email: player.email,
                phone: player.phone,
                isBooker: player.email.toLowerCase() === data.bookerEmail.toLowerCase(),
                amount: pricing.totalPerPlayer
            })),
            client
        );
        
        return { split, players };
    });
    
    return {
        split: result.split,
        players: result.players,
        paymentLinks: result.players.map(p => ({
            email: p.email,
            paymentUrl: `${process.env.BASE_URL}/pay/${p.payment_token}`,
            amount: p.amount
        }))
    };
}

// ============================================
// PAYMENT INTENT CREATION
// ============================================

async function createPaymentIntent(paymentToken) {
    // Find player and split
    const data = await Players.findByPaymentToken(paymentToken);
    
    if (!data) {
        throw new Error('Invalid payment link');
    }
    
    const { player, split } = data;
    
    // Validate split is still active
    if (!['pending', 'timer_active', 'partially_paid'].includes(split.status)) {
        throw new Error(`Split is ${split.status}. Payment not allowed.`);
    }
    
    // Check timer hasn't expired
    if (split.timer_expires_at && new Date(split.timer_expires_at) < new Date()) {
        throw new Error('Payment window has expired');
    }
    
    // Check player hasn't already paid
    if (['authorized', 'captured'].includes(player.payment_status)) {
        throw new Error('Already paid');
    }
    
    // Get course for Stripe Connect
    const course = await Courses.findById(split.course_id);
    if (!course || !course.stripe_account_id) {
        throw new Error('Course payment setup incomplete');
    }
    
    // Server recalculates pricing - NEVER trust stored values for payment
    const serverPricing = calculateTotalPerPlayer(split.green_fee, split.cart_fee);
    const validation = validatePricing(
        { basePrice: parseFloat(split.base_price), platformFee: parseFloat(split.platform_fee), totalPerPlayer: parseFloat(split.total_per_player) },
        serverPricing
    );
    
    if (!validation.valid) {
        throw new Error('SPLIT_TAMPERING_DETECTED');
    }
    
    const amountInCents = Math.round(serverPricing.totalPerPlayer * 100);
    const platformFeeInCents = Math.round(serverPricing.platformFee * 100);
    
    // Calculate how much goes to course (total - platform fee)
    const courseAmountInCents = amountInCents - platformFeeInCents;
    
    // Create payment intent with Stripe Connect
    const paymentIntentParams = {
        amount: amountInCents,
        currency: 'usd',
        payment_method_types: ['card'],
        metadata: {
            splitId: split.id,
            playerId: player.id,
            courseId: split.course_id,
            shortCode: split.short_code,
            playerEmail: player.email,
            paymentMode: split.payment_mode
        },
        // Destination charge: course receives funds minus platform fee
        transfer_data: {
            destination: course.stripe_account_id,
            amount: courseAmountInCents // Course gets this amount
        },
        // Platform keeps the rest (platform fee)
        application_fee_amount: platformFeeInCents
    };
    
    // Auth hold vs immediate capture
    if (split.payment_mode === 'auth_hold') {
        paymentIntentParams.capture_method = 'manual';
    }
    
    const paymentIntent = await stripe.paymentIntents.create(paymentIntentParams);
    
    // Update player with payment intent ID
    await Players.updatePaymentStatus(player.id, 'processing', {
        paymentIntentId: paymentIntent.id
    });
    
    return {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount: serverPricing.totalPerPlayer,
        paymentMode: split.payment_mode,
        split: {
            shortCode: split.short_code,
            courseName: split.course_name,
            teeDate: split.tee_date,
            teeTime: split.tee_time,
            timerExpiresAt: split.timer_expires_at
        },
        player: {
            name: player.name,
            email: player.email,
            position: player.position
        }
    };
}

// ============================================
// PAYMENT CONFIRMATION HANDLING
// ============================================

async function handlePaymentSuccess(paymentIntentId) {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    const { splitId, playerId, courseId, paymentMode } = paymentIntent.metadata;
    
    const player = await Players.findById(playerId);
    const split = await Splits.findById(splitId);
    
    if (!player || !split) {
        throw new Error('Invalid payment reference');
    }
    
    // Update player status
    const newStatus = paymentMode === 'auth_hold' ? 'authorized' : 'captured';
    await Players.updatePaymentStatus(playerId, newStatus, {
        paymentIntentId,
        chargeId: paymentIntent.latest_charge
    });
    
    // Record transaction
    const platformFee = parseFloat(split.platform_fee);
    const stripeFee = (parseFloat(split.total_per_player) * 0.029) + 0.30; // Approximate Stripe fee
    const courseAmount = parseFloat(split.base_price);
    
    await Transactions.create({
        playerId,
        splitId,
        courseId,
        type: paymentMode === 'auth_hold' ? 'authorization' : 'immediate_charge',
        amount: parseFloat(split.total_per_player),
        platformFee,
        stripeFee,
        courseAmount,
        stripePaymentIntentId: paymentIntentId,
        stripeChargeId: paymentIntent.latest_charge,
        status: 'succeeded'
    });
    
    // Check if all players have paid
    const allPaid = await Splits.checkAllPaid(splitId);
    
    if (allPaid) {
        await Splits.updateStatus(splitId, 'fully_paid');
        
        // If immediate capture mode, mark as confirmed
        if (paymentMode === 'immediate_capture') {
            await Splits.updateStatus(splitId, 'confirmed');
        }
    } else {
        await Splits.updateStatus(splitId, 'partially_paid');
    }
    
    return {
        success: true,
        allPaid,
        split,
        player
    };
}

// ============================================
// CAPTURE AUTHORIZED PAYMENTS
// ============================================

async function captureAuthorizedPayment(playerId) {
    const player = await Players.findById(playerId);
    
    if (!player) {
        throw new Error('Player not found');
    }
    
    if (player.payment_status !== 'authorized') {
        throw new Error(`Cannot capture: status is ${player.payment_status}`);
    }
    
    if (!player.stripe_payment_intent_id) {
        throw new Error('No payment intent to capture');
    }
    
    // Capture the payment
    const paymentIntent = await stripe.paymentIntents.capture(player.stripe_payment_intent_id);
    
    // Update player status
    await Players.updatePaymentStatus(playerId, 'captured', {
        chargeId: paymentIntent.latest_charge
    });
    
    // Update transaction
    const transactions = await Transactions.findByPaymentIntent(player.stripe_payment_intent_id);
    if (transactions.length > 0) {
        await Transactions.updateStatus(transactions[0].id, 'succeeded');
        
        // Create capture transaction record
        await Transactions.create({
            playerId: player.id,
            splitId: player.split_id,
            courseId: transactions[0].course_id,
            type: 'capture',
            amount: transactions[0].amount,
            platformFee: transactions[0].platform_fee,
            stripeFee: transactions[0].stripe_fee,
            courseAmount: transactions[0].course_amount,
            stripePaymentIntentId: player.stripe_payment_intent_id,
            stripeChargeId: paymentIntent.latest_charge,
            status: 'succeeded'
        });
    }
    
    return { success: true, paymentIntent };
}

async function captureAllAuthorized(splitId) {
    const players = await Players.getAuthorizedPayments(splitId);
    const results = [];
    
    for (const player of players) {
        try {
            const result = await captureAuthorizedPayment(player.id);
            results.push({ playerId: player.id, success: true });
        } catch (error) {
            results.push({ playerId: player.id, success: false, error: error.message });
        }
    }
    
    // Check if all captured successfully
    const allSuccess = results.every(r => r.success);
    if (allSuccess && results.length > 0) {
        await Splits.updateStatus(splitId, 'confirmed');
    }
    
    return { results, allSuccess };
}

// ============================================
// CANCEL PAYMENT INTENT
// ============================================

async function cancelPaymentIntent(paymentIntentId, reason = 'abandoned') {
    const paymentIntent = await stripe.paymentIntents.cancel(paymentIntentId, {
        cancellation_reason: reason
    });
    
    // Update player status
    const player = await Players.findByStripePaymentIntent(paymentIntentId);
    if (player) {
        await Players.updatePaymentStatus(player.id, 'cancelled');
    }
    
    return paymentIntent;
}

// ============================================
// STRIPE CONNECT ONBOARDING
// ============================================

async function createConnectAccount(courseId) {
    const course = await Courses.findById(courseId);
    if (!course) {
        throw new Error('Course not found');
    }
    
    // Create Stripe Connect Express account
    const account = await stripe.accounts.create({
        type: 'express',
        country: 'US',
        email: course.email,
        capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true }
        },
        business_type: 'company',
        business_profile: {
            name: course.name,
            mcc: '7941', // Golf courses and country clubs
            url: course.website_url || undefined
        },
        metadata: {
            courseId: course.id,
            courseName: course.name
        }
    });
    
    // Save account ID
    await Courses.update(courseId, {
        stripeAccountId: account.id,
        stripeOnboardingComplete: false
    });
    
    return account;
}

async function createConnectOnboardingLink(courseId, refreshUrl, returnUrl) {
    const course = await Courses.findById(courseId);
    if (!course) {
        throw new Error('Course not found');
    }
    
    let accountId = course.stripe_account_id;
    
    // Create account if doesn't exist
    if (!accountId) {
        const account = await createConnectAccount(courseId);
        accountId = account.id;
    }
    
    // Create account link for onboarding
    const accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: 'account_onboarding'
    });
    
    return accountLink;
}

async function checkConnectStatus(courseId) {
    const course = await Courses.findById(courseId);
    if (!course || !course.stripe_account_id) {
        return { onboarded: false, payoutsEnabled: false };
    }
    
    const account = await stripe.accounts.retrieve(course.stripe_account_id);
    
    const onboarded = account.details_submitted;
    const payoutsEnabled = account.payouts_enabled;
    
    // Update course if status changed
    if (onboarded !== course.stripe_onboarding_complete || payoutsEnabled !== course.stripe_payouts_enabled) {
        await Courses.update(courseId, {
            stripeOnboardingComplete: onboarded,
            stripePayoutsEnabled: payoutsEnabled,
            status: onboarded && payoutsEnabled ? 'active' : course.status
        });
    }
    
    return {
        onboarded,
        payoutsEnabled,
        chargesEnabled: account.charges_enabled,
        requirements: account.requirements
    };
}

async function createConnectLoginLink(courseId) {
    const course = await Courses.findById(courseId);
    if (!course || !course.stripe_account_id) {
        throw new Error('Course has no Stripe account');
    }
    
    const loginLink = await stripe.accounts.createLoginLink(course.stripe_account_id);
    return loginLink;
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    // Fee calculation
    calculatePlatformFee,
    calculateTotalPerPlayer,
    determinePaymentMode,
    
    // Price validation
    validatePricing,
    
    // Split operations
    createSplit,
    
    // Payment operations
    createPaymentIntent,
    handlePaymentSuccess,
    captureAuthorizedPayment,
    captureAllAuthorized,
    cancelPaymentIntent,
    
    // Stripe Connect
    createConnectAccount,
    createConnectOnboardingLink,
    checkConnectStatus,
    createConnectLoginLink,
    
    // Constants
    PLATFORM_FEE_PERCENT,
    PLATFORM_FEE_MIN,
    PLATFORM_FEE_MAX,
    AUTH_HOLD_THRESHOLD_DAYS
};
