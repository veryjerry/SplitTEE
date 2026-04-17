/**
 * Split Tee v2.1 - Refunds Service
 * Handles refunds with retry logic and escalation
 */

const Stripe = require('stripe');
const { Refunds, Transactions, Players, Splits, Courses, AuditLog, withTransaction } = require('../db');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ============================================
// CONSTANTS
// ============================================

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAYS = [
    60000,      // 1 minute
    300000,     // 5 minutes
    900000      // 15 minutes
];

// ============================================
// REFUND CREATION
// ============================================

async function initiateRefund(playerId, reason, initiatedBy = 'system') {
    const player = await Players.findById(playerId);
    
    if (!player) {
        throw new Error('Player not found');
    }
    
    if (!['authorized', 'captured'].includes(player.payment_status)) {
        throw new Error(`Cannot refund: payment status is ${player.payment_status}`);
    }
    
    // Get the original transaction
    const transactions = await Transactions.findByPaymentIntent(player.stripe_payment_intent_id);
    const originalTx = transactions.find(t => 
        t.status === 'succeeded' && ['authorization', 'capture', 'immediate_charge'].includes(t.type)
    );
    
    if (!originalTx) {
        throw new Error('Original transaction not found');
    }
    
    // Create refund record
    const refund = await Refunds.create({
        transactionId: originalTx.id,
        playerId: player.id,
        splitId: player.split_id,
        amount: parseFloat(player.amount),
        reason
    });
    
    await AuditLog.log({
        actorType: initiatedBy === 'system' ? 'system' : 'admin',
        actorId: initiatedBy === 'system' ? null : initiatedBy,
        action: 'refund_initiated',
        resourceType: 'refund',
        resourceId: refund.id,
        details: { playerId, reason, amount: player.amount }
    });
    
    // Attempt refund immediately
    return processRefund(refund.id);
}

// ============================================
// REFUND PROCESSING
// ============================================

async function processRefund(refundId) {
    const refund = await getRefundWithDetails(refundId);
    
    if (!refund) {
        throw new Error('Refund not found');
    }
    
    if (refund.status === 'succeeded') {
        return { success: true, alreadyProcessed: true };
    }
    
    if (refund.attempts >= MAX_RETRY_ATTEMPTS) {
        // Escalate instead of retrying
        await escalateRefund(refundId, 'Max retry attempts reached');
        return { success: false, escalated: true };
    }
    
    try {
        let stripeRefund;
        
        // If payment was only authorized (not captured), cancel instead of refund
        if (refund.player_payment_status === 'authorized') {
            // Cancel the payment intent
            await stripe.paymentIntents.cancel(refund.stripe_payment_intent_id);
            stripeRefund = { id: `cancel_${refund.stripe_payment_intent_id}` };
        } else {
            // Process actual refund
            stripeRefund = await stripe.refunds.create({
                payment_intent: refund.stripe_payment_intent_id,
                amount: Math.round(refund.amount * 100), // Convert to cents
                reason: mapReasonToStripe(refund.reason),
                metadata: {
                    refundId: refund.id,
                    splitId: refund.split_id,
                    playerId: refund.player_id,
                    originalReason: refund.reason
                }
            });
        }
        
        // Update refund record
        await Refunds.updateStatus(refundId, 'succeeded', stripeRefund.id);
        
        // Update player status
        await Players.updatePaymentStatus(refund.player_id, 'refunded');
        
        // Record refund transaction
        await Transactions.create({
            playerId: refund.player_id,
            splitId: refund.split_id,
            courseId: refund.course_id,
            type: 'refund',
            amount: refund.amount,
            stripeRefundId: stripeRefund.id,
            stripePaymentIntentId: refund.stripe_payment_intent_id,
            status: 'succeeded',
            metadata: { reason: refund.reason }
        });
        
        await AuditLog.log({
            actorType: 'system',
            action: 'refund_succeeded',
            resourceType: 'refund',
            resourceId: refundId,
            details: { stripeRefundId: stripeRefund.id }
        });
        
        return { success: true, stripeRefundId: stripeRefund.id };
        
    } catch (error) {
        console.error(`Refund ${refundId} failed:`, error.message);
        
        // Calculate next retry time
        const nextRetryDelay = RETRY_DELAYS[refund.attempts] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
        const nextRetryAt = new Date(Date.now() + nextRetryDelay);
        
        await Refunds.updateStatus(refundId, 'failed', null, error.message);
        await Refunds.scheduleRetry(refundId, nextRetryAt);
        
        await AuditLog.log({
            actorType: 'system',
            action: 'refund_failed',
            resourceType: 'refund',
            resourceId: refundId,
            details: { error: error.message, attempt: refund.attempts + 1, nextRetryAt }
        });
        
        // Check if should escalate
        if (refund.attempts + 1 >= MAX_RETRY_ATTEMPTS) {
            await escalateRefund(refundId, `Failed after ${MAX_RETRY_ATTEMPTS} attempts: ${error.message}`);
            return { success: false, escalated: true, error: error.message };
        }
        
        return { success: false, willRetry: true, nextRetryAt, error: error.message };
    }
}

// ============================================
// BULK REFUNDS (Timer Expired / Split Cancelled)
// ============================================

async function refundSplit(splitId, reason) {
    const split = await Splits.findById(splitId);
    if (!split) {
        throw new Error('Split not found');
    }
    
    const players = await Players.findBySplit(splitId);
    const paidPlayers = players.filter(p => 
        ['authorized', 'captured'].includes(p.payment_status)
    );
    
    if (paidPlayers.length === 0) {
        return { success: true, refunded: 0, message: 'No payments to refund' };
    }
    
    const results = [];
    
    for (const player of paidPlayers) {
        try {
            const result = await initiateRefund(player.id, reason);
            results.push({ playerId: player.id, ...result });
        } catch (error) {
            results.push({ playerId: player.id, success: false, error: error.message });
        }
    }
    
    // Update split status
    await Splits.updateStatus(splitId, 'refunded');
    
    const successCount = results.filter(r => r.success).length;
    
    await AuditLog.log({
        actorType: 'system',
        action: 'split_refunded',
        resourceType: 'split',
        resourceId: splitId,
        details: { reason, totalPlayers: paidPlayers.length, successfulRefunds: successCount }
    });
    
    return {
        success: successCount === paidPlayers.length,
        total: paidPlayers.length,
        refunded: successCount,
        failed: paidPlayers.length - successCount,
        results
    };
}

// ============================================
// ESCALATION
// ============================================

async function escalateRefund(refundId, notes) {
    await Refunds.escalate(refundId, notes);
    
    await AuditLog.log({
        actorType: 'system',
        action: 'refund_escalated',
        resourceType: 'refund',
        resourceId: refundId,
        details: { notes }
    });
    
    // TODO: Send notification to admin
    // await sendAdminNotification('refund_escalated', { refundId, notes });
    
    return { escalated: true };
}

async function resolveEscalatedRefund(refundId, resolution, resolvedBy) {
    const refund = await getRefundWithDetails(refundId);
    
    if (!refund) {
        throw new Error('Refund not found');
    }
    
    if (refund.status !== 'escalated') {
        throw new Error('Refund is not escalated');
    }
    
    if (resolution === 'retry') {
        // Reset attempts and retry
        await Refunds.updateStatus(refundId, 'pending');
        return processRefund(refundId);
    }
    
    if (resolution === 'manual_refund') {
        // Mark as resolved - admin processed manually
        await Refunds.resolve(refundId, resolvedBy);
        await Players.updatePaymentStatus(refund.player_id, 'refunded');
        
        await AuditLog.log({
            actorType: 'admin',
            actorId: resolvedBy,
            action: 'refund_manually_resolved',
            resourceType: 'refund',
            resourceId: refundId
        });
        
        return { success: true, manuallyResolved: true };
    }
    
    if (resolution === 'no_refund') {
        // Close without refund
        await Refunds.resolve(refundId, resolvedBy);
        
        await AuditLog.log({
            actorType: 'admin',
            actorId: resolvedBy,
            action: 'refund_closed_no_refund',
            resourceType: 'refund',
            resourceId: refundId
        });
        
        return { success: true, closed: true };
    }
    
    throw new Error('Invalid resolution type');
}

// ============================================
// RETRY PROCESSING (Called by scheduler)
// ============================================

async function processPendingRetries() {
    const pendingRefunds = await Refunds.findPendingRetries();
    
    const results = [];
    for (const refund of pendingRefunds) {
        const result = await processRefund(refund.id);
        results.push({ refundId: refund.id, ...result });
    }
    
    return results;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

async function getRefundWithDetails(refundId) {
    // This would ideally be a JOIN query, but for clarity:
    const refunds = await Refunds.findPendingRetries();
    let refund = refunds.find(r => r.id === refundId);
    
    if (!refund) {
        // Try to get from DB directly
        const result = await require('../db').pool.query(`
            SELECT r.*, t.stripe_payment_intent_id, t.course_id, p.payment_status as player_payment_status
            FROM refunds r
            JOIN transactions t ON t.id = r.transaction_id
            JOIN players p ON p.id = r.player_id
            WHERE r.id = $1
        `, [refundId]);
        refund = result.rows[0];
    }
    
    return refund;
}

function mapReasonToStripe(reason) {
    const mapping = {
        'timer_expired': 'requested_by_customer',
        'split_cancelled': 'requested_by_customer',
        'course_cancelled': 'requested_by_customer',
        'player_request': 'requested_by_customer',
        'duplicate_payment': 'duplicate',
        'admin_initiated': 'requested_by_customer'
    };
    return mapping[reason] || 'requested_by_customer';
}

// ============================================
// ADMIN FUNCTIONS
// ============================================

async function getEscalatedRefunds() {
    return Refunds.findEscalated();
}

async function getRefundStats() {
    const result = await require('../db').pool.query(`
        SELECT 
            COUNT(*) FILTER (WHERE status = 'pending') as pending,
            COUNT(*) FILTER (WHERE status = 'succeeded') as succeeded,
            COUNT(*) FILTER (WHERE status = 'failed') as failed,
            COUNT(*) FILTER (WHERE status = 'escalated') as escalated,
            SUM(amount) FILTER (WHERE status = 'succeeded') as total_refunded
        FROM refunds
    `);
    return result.rows[0];
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    // Core refund operations
    initiateRefund,
    processRefund,
    refundSplit,
    
    // Escalation
    escalateRefund,
    resolveEscalatedRefund,
    
    // Batch processing
    processPendingRetries,
    
    // Admin
    getEscalatedRefunds,
    getRefundStats,
    
    // Constants
    MAX_RETRY_ATTEMPTS,
    RETRY_DELAYS
};
