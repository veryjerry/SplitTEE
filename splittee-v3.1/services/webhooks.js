/**
 * Split Tee v2.1 - Webhooks Service
 * Outbound webhook delivery to course partners
 */

const fetch = require('node-fetch');
const { WebhookDeliveries, Courses, AuditLog } = require('../db');
const { generateWebhookSignature } = require('./security');

// ============================================
// CONSTANTS
// ============================================

const WEBHOOK_TIMEOUT_MS = 10000; // 10 seconds
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAYS = [
    60000,      // 1 minute
    300000,     // 5 minutes  
    900000      // 15 minutes
];

// ============================================
// EVENT TYPES
// ============================================

const EVENT_TYPES = {
    SPLIT_CREATED: 'split.created',
    SPLIT_TIMER_STARTED: 'split.timer_started',
    SPLIT_PAYMENT_RECEIVED: 'split.payment_received',
    SPLIT_FULLY_PAID: 'split.fully_paid',
    SPLIT_CONFIRMED: 'split.confirmed',
    SPLIT_EXPIRED: 'split.expired',
    SPLIT_CANCELLED: 'split.cancelled',
    SPLIT_REFUNDED: 'split.refunded',
    PLAYER_PAID: 'player.paid',
    PLAYER_REFUNDED: 'player.refunded'
};

// ============================================
// WEBHOOK SENDING
// ============================================

async function sendWebhook(courseId, eventType, data) {
    const course = await Courses.findById(courseId);
    
    if (!course || !course.webhook_url) {
        // No webhook configured - silently skip
        return { skipped: true, reason: 'No webhook URL configured' };
    }
    
    // Build payload
    const payload = {
        id: generateEventId(),
        type: eventType,
        created: new Date().toISOString(),
        data
    };
    
    // Create delivery record
    const delivery = await WebhookDeliveries.create({
        courseId,
        eventType,
        payload,
        url: course.webhook_url
    });
    
    // Attempt delivery
    return deliverWebhook(delivery.id, course.webhook_url, payload, course.webhook_secret);
}

async function deliverWebhook(deliveryId, url, payload, secret) {
    const payloadString = JSON.stringify(payload);
    
    // Generate signature if secret is configured
    let headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'SplitTee-Webhook/2.1'
    };
    
    if (secret) {
        const { signature } = generateWebhookSignature(payloadString, secret);
        headers['X-SplitTee-Signature'] = signature;
    }
    
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
        
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: payloadString,
            signal: controller.signal
        });
        
        clearTimeout(timeout);
        
        const responseBody = await response.text().catch(() => '');
        
        if (response.ok) {
            // Success
            await WebhookDeliveries.markDelivered(deliveryId, response.status, responseBody.substring(0, 1000));
            
            return { success: true, status: response.status };
        } else {
            // HTTP error
            await handleDeliveryFailure(deliveryId, response.status, `HTTP ${response.status}: ${responseBody.substring(0, 500)}`);
            
            return { success: false, status: response.status, error: responseBody.substring(0, 200) };
        }
        
    } catch (error) {
        // Network error or timeout
        const errorMessage = error.name === 'AbortError' ? 'Request timeout' : error.message;
        
        await handleDeliveryFailure(deliveryId, null, errorMessage);
        
        return { success: false, error: errorMessage };
    }
}

async function handleDeliveryFailure(deliveryId, responseStatus, errorMessage) {
    // Get current delivery to check attempt count
    const deliveries = await WebhookDeliveries.findPendingRetries();
    const delivery = deliveries.find(d => d.id === deliveryId);
    
    const attempts = delivery ? delivery.attempts : 0;
    
    if (attempts >= MAX_RETRY_ATTEMPTS - 1) {
        // Mark as permanently failed
        await WebhookDeliveries.markFailed(deliveryId, responseStatus, errorMessage, null);
        
        await AuditLog.log({
            actorType: 'system',
            action: 'webhook_permanently_failed',
            resourceType: 'webhook_delivery',
            resourceId: deliveryId,
            details: { error: errorMessage, attempts: attempts + 1 }
        });
    } else {
        // Schedule retry
        const nextRetryDelay = RETRY_DELAYS[attempts] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
        const nextRetryAt = new Date(Date.now() + nextRetryDelay);
        
        await WebhookDeliveries.markFailed(deliveryId, responseStatus, errorMessage, nextRetryAt);
    }
}

// ============================================
// RETRY PROCESSING
// ============================================

async function processPendingWebhooks() {
    const pendingDeliveries = await WebhookDeliveries.findPendingRetries();
    
    const results = [];
    
    for (const delivery of pendingDeliveries) {
        const result = await deliverWebhook(
            delivery.id,
            delivery.url,
            delivery.payload,
            delivery.webhook_secret
        );
        
        results.push({ deliveryId: delivery.id, ...result });
    }
    
    return results;
}

// ============================================
// CONVENIENCE FUNCTIONS FOR COMMON EVENTS
// ============================================

async function notifySplitCreated(split, players) {
    return sendWebhook(split.course_id, EVENT_TYPES.SPLIT_CREATED, {
        split: formatSplitForWebhook(split),
        players: players.map(formatPlayerForWebhook),
        paymentLinks: players.map(p => ({
            email: p.email,
            url: `${process.env.BASE_URL}/pay/${p.payment_token}`
        }))
    });
}

async function notifyTimerStarted(split) {
    return sendWebhook(split.course_id, EVENT_TYPES.SPLIT_TIMER_STARTED, {
        split: formatSplitForWebhook(split),
        timerExpiresAt: split.timer_expires_at
    });
}

async function notifyPaymentReceived(split, player, paidCount, totalPlayers) {
    return sendWebhook(split.course_id, EVENT_TYPES.SPLIT_PAYMENT_RECEIVED, {
        split: formatSplitForWebhook(split),
        player: formatPlayerForWebhook(player),
        progress: {
            paid: paidCount,
            total: totalPlayers,
            percentComplete: Math.round((paidCount / totalPlayers) * 100)
        }
    });
}

async function notifyFullyPaid(split, players) {
    return sendWebhook(split.course_id, EVENT_TYPES.SPLIT_FULLY_PAID, {
        split: formatSplitForWebhook(split),
        players: players.map(formatPlayerForWebhook),
        totalAmount: players.reduce((sum, p) => sum + parseFloat(p.amount), 0)
    });
}

async function notifySplitConfirmed(split, players) {
    return sendWebhook(split.course_id, EVENT_TYPES.SPLIT_CONFIRMED, {
        split: formatSplitForWebhook(split),
        players: players.map(formatPlayerForWebhook),
        confirmedAt: split.confirmed_at
    });
}

async function notifySplitExpired(split) {
    return sendWebhook(split.course_id, EVENT_TYPES.SPLIT_EXPIRED, {
        split: formatSplitForWebhook(split),
        expiredAt: split.expired_at
    });
}

async function notifySplitCancelled(split, reason) {
    return sendWebhook(split.course_id, EVENT_TYPES.SPLIT_CANCELLED, {
        split: formatSplitForWebhook(split),
        reason,
        cancelledAt: split.cancelled_at
    });
}

async function notifySplitRefunded(split, refundResults) {
    return sendWebhook(split.course_id, EVENT_TYPES.SPLIT_REFUNDED, {
        split: formatSplitForWebhook(split),
        refunds: refundResults
    });
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function generateEventId() {
    return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}

function formatSplitForWebhook(split) {
    return {
        id: split.id,
        shortCode: split.short_code,
        teeDate: split.tee_date,
        teeTime: split.tee_time,
        numPlayers: split.num_players,
        greenFee: split.green_fee,
        cartFee: split.cart_fee,
        totalPerPlayer: split.total_per_player,
        status: split.status,
        bookerName: split.booker_name,
        bookerEmail: split.booker_email,
        externalBookingId: split.external_booking_id,
        createdAt: split.created_at
    };
}

function formatPlayerForWebhook(player) {
    return {
        id: player.id,
        position: player.position,
        name: player.name,
        email: player.email,
        amount: player.amount,
        paymentStatus: player.payment_status,
        isBooker: player.is_booker,
        paidAt: player.paid_at
    };
}

// ============================================
// TEST WEBHOOK
// ============================================

async function sendTestWebhook(courseId) {
    const course = await Courses.findById(courseId);
    
    if (!course || !course.webhook_url) {
        throw new Error('No webhook URL configured');
    }
    
    const testPayload = {
        id: generateEventId(),
        type: 'test',
        created: new Date().toISOString(),
        data: {
            message: 'This is a test webhook from Split Tee',
            courseId,
            courseName: course.name
        }
    };
    
    const delivery = await WebhookDeliveries.create({
        courseId,
        eventType: 'test',
        payload: testPayload,
        url: course.webhook_url
    });
    
    return deliverWebhook(delivery.id, course.webhook_url, testPayload, course.webhook_secret);
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    // Core
    sendWebhook,
    deliverWebhook,
    processPendingWebhooks,
    
    // Event notifications
    notifySplitCreated,
    notifyTimerStarted,
    notifyPaymentReceived,
    notifyFullyPaid,
    notifySplitConfirmed,
    notifySplitExpired,
    notifySplitCancelled,
    notifySplitRefunded,
    
    // Testing
    sendTestWebhook,
    
    // Constants
    EVENT_TYPES,
    MAX_RETRY_ATTEMPTS
};
