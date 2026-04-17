/**
 * Split Tee v2.1 - Database Connection & Models
 * PostgreSQL with connection pooling
 */

const { Pool } = require('pg');
const crypto = require('crypto');

// ============================================
// DATABASE CONNECTION
// ============================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
    console.error('Unexpected database error:', err);
});

// Helper for transactions
async function withTransaction(callback) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// ============================================
// COURSES MODEL
// ============================================

const Courses = {
    async create(data) {
        const query = `
            INSERT INTO courses (
                name, slug, email, phone, address, city, state, zip,
                default_green_fee, default_cart_fee, password_hash
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *
        `;
        const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const values = [
            data.name, slug, data.email, data.phone, data.address,
            data.city, data.state, data.zip, data.defaultGreenFee,
            data.defaultCartFee, data.passwordHash
        ];
        const result = await pool.query(query, values);
        return result.rows[0];
    },

    async findById(id) {
        const result = await pool.query('SELECT * FROM courses WHERE id = $1', [id]);
        return result.rows[0];
    },

    async findByEmail(email) {
        const result = await pool.query('SELECT * FROM courses WHERE email = $1', [email]);
        return result.rows[0];
    },

    async findBySlug(slug) {
        const result = await pool.query('SELECT * FROM courses WHERE slug = $1', [slug]);
        return result.rows[0];
    },

    async findByApiKey(apiKeyPrefix) {
        const result = await pool.query(
            'SELECT * FROM courses WHERE api_key_prefix = $1',
            [apiKeyPrefix]
        );
        return result.rows[0];
    },

    async findByStripeAccount(stripeAccountId) {
        const result = await pool.query(
            'SELECT * FROM courses WHERE stripe_account_id = $1',
            [stripeAccountId]
        );
        return result.rows[0];
    },

    async update(id, data) {
        const fields = [];
        const values = [];
        let paramIndex = 1;

        const allowedFields = [
            'name', 'phone', 'address', 'city', 'state', 'zip', 'timezone',
            'logo_url', 'website_url', 'stripe_account_id', 'stripe_onboarding_complete',
            'stripe_payouts_enabled', 'api_key_hash', 'api_key_prefix', 'webhook_url',
            'webhook_secret', 'password_hash', 'magic_link_token', 'magic_link_expires',
            'failed_login_attempts', 'locked_until', 'default_green_fee', 'default_cart_fee',
            'blackout_dates', 'notification_preferences', 'status', 'verified_at'
        ];

        for (const [key, value] of Object.entries(data)) {
            const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
            if (allowedFields.includes(snakeKey)) {
                fields.push(`${snakeKey} = $${paramIndex}`);
                values.push(value);
                paramIndex++;
            }
        }

        if (fields.length === 0) return this.findById(id);

        values.push(id);
        const query = `UPDATE courses SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
        const result = await pool.query(query, values);
        return result.rows[0];
    },

    async incrementFailedLogins(id) {
        const result = await pool.query(`
            UPDATE courses 
            SET failed_login_attempts = failed_login_attempts + 1
            WHERE id = $1
            RETURNING failed_login_attempts
        `, [id]);
        return result.rows[0]?.failed_login_attempts || 0;
    },

    async resetFailedLogins(id) {
        await pool.query(
            'UPDATE courses SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1',
            [id]
        );
    },

    async lockAccount(id, until) {
        await pool.query('UPDATE courses SET locked_until = $1 WHERE id = $1', [until, id]);
    },

    async setMagicLink(id, token, expires) {
        await pool.query(
            'UPDATE courses SET magic_link_token = $1, magic_link_expires = $2 WHERE id = $3',
            [token, expires, id]
        );
    },

    async findByMagicLink(token) {
        const result = await pool.query(`
            SELECT * FROM courses 
            WHERE magic_link_token = $1 AND magic_link_expires > NOW()
        `, [token]);
        return result.rows[0];
    },

    async clearMagicLink(id) {
        await pool.query(
            'UPDATE courses SET magic_link_token = NULL, magic_link_expires = NULL WHERE id = $1',
            [id]
        );
    },

    async generateApiKey(id) {
        const apiKey = crypto.randomBytes(32).toString('hex');
        const prefix = apiKey.substring(0, 8);
        const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
        
        await pool.query(
            'UPDATE courses SET api_key_hash = $1, api_key_prefix = $2 WHERE id = $3',
            [hash, prefix, id]
        );
        
        return { apiKey, prefix };
    },

    async listAll(options = {}) {
        let query = 'SELECT * FROM courses';
        const conditions = [];
        const values = [];

        if (options.status) {
            conditions.push(`status = $${values.length + 1}`);
            values.push(options.status);
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        query += ' ORDER BY created_at DESC';

        if (options.limit) {
            query += ` LIMIT $${values.length + 1}`;
            values.push(options.limit);
        }

        if (options.offset) {
            query += ` OFFSET $${values.length + 1}`;
            values.push(options.offset);
        }

        const result = await pool.query(query, values);
        return result.rows;
    },

    async getDashboardSummary(courseId) {
        const result = await pool.query(
            'SELECT * FROM course_dashboard_summary WHERE course_id = $1',
            [courseId]
        );
        return result.rows[0];
    }
};

// ============================================
// COURSE SESSIONS MODEL
// ============================================

const CourseSessions = {
    async create(courseId, refreshToken, metadata = {}) {
        const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        const result = await pool.query(`
            INSERT INTO course_sessions (course_id, refresh_token_hash, user_agent, ip_address, expires_at)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
        `, [courseId, hash, metadata.userAgent, metadata.ipAddress, expiresAt]);

        // Limit to 5 sessions per course
        await pool.query(`
            DELETE FROM course_sessions 
            WHERE course_id = $1 AND id NOT IN (
                SELECT id FROM course_sessions 
                WHERE course_id = $1 
                ORDER BY last_activity DESC 
                LIMIT 5
            )
        `, [courseId]);

        return result.rows[0];
    },

    async validate(refreshToken) {
        const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
        const result = await pool.query(`
            SELECT cs.*, c.* FROM course_sessions cs
            JOIN courses c ON c.id = cs.course_id
            WHERE cs.refresh_token_hash = $1 AND cs.expires_at > NOW()
        `, [hash]);
        
        if (result.rows[0]) {
            await pool.query(
                'UPDATE course_sessions SET last_activity = NOW() WHERE id = $1',
                [result.rows[0].id]
            );
        }
        
        return result.rows[0];
    },

    async revoke(refreshToken) {
        const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
        await pool.query('DELETE FROM course_sessions WHERE refresh_token_hash = $1', [hash]);
    },

    async revokeAllForCourse(courseId) {
        await pool.query('DELETE FROM course_sessions WHERE course_id = $1', [courseId]);
    }
};

// ============================================
// SPLITS MODEL
// ============================================

const Splits = {
    async create(data, client = pool) {
        // Generate unique short code
        let shortCode;
        let attempts = 0;
        while (attempts < 10) {
            shortCode = await this.generateShortCode();
            const existing = await client.query(
                'SELECT id FROM splits WHERE short_code = $1',
                [shortCode]
            );
            if (existing.rows.length === 0) break;
            attempts++;
        }

        const query = `
            INSERT INTO splits (
                short_code, course_id, course_name, tee_date, tee_time, num_players,
                green_fee, cart_fee, base_price, platform_fee, total_per_player,
                payment_mode, days_until_tee, booker_name, booker_email, booker_phone,
                external_booking_id, integration_mode
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
            RETURNING *
        `;

        const values = [
            shortCode, data.courseId, data.courseName, data.teeDate, data.teeTime,
            data.numPlayers, data.greenFee, data.cartFee, data.basePrice,
            data.platformFee, data.totalPerPlayer, data.paymentMode,
            data.daysUntilTee, data.bookerName, data.bookerEmail, data.bookerPhone,
            data.externalBookingId, data.integrationMode || 'embed'
        ];

        const result = await client.query(query, values);
        return result.rows[0];
    },

    async generateShortCode() {
        const result = await pool.query('SELECT generate_short_code() as code');
        return result.rows[0].code;
    },

    async findById(id) {
        const result = await pool.query('SELECT * FROM splits WHERE id = $1', [id]);
        return result.rows[0];
    },

    async findByShortCode(shortCode) {
        const result = await pool.query(
            'SELECT * FROM splits WHERE short_code = $1',
            [shortCode.toUpperCase()]
        );
        return result.rows[0];
    },

    async findWithPlayers(splitId) {
        const split = await this.findById(splitId);
        if (!split) return null;

        const players = await pool.query(
            'SELECT * FROM players WHERE split_id = $1 ORDER BY position',
            [splitId]
        );
        
        return { ...split, players: players.rows };
    },

    async startTimer(id) {
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
        const result = await pool.query(`
            UPDATE splits 
            SET status = 'timer_active', timer_started_at = NOW(), timer_expires_at = $1
            WHERE id = $2
            RETURNING *
        `, [expiresAt, id]);
        return result.rows[0];
    },

    async updateStatus(id, status, client = pool) {
        const extraFields = {};
        if (status === 'confirmed') extraFields.confirmed_at = new Date();
        if (status === 'expired') extraFields.expired_at = new Date();
        if (status === 'cancelled') extraFields.cancelled_at = new Date();

        let query = `UPDATE splits SET status = $1`;
        const values = [status];
        let paramIndex = 2;

        for (const [key, value] of Object.entries(extraFields)) {
            query += `, ${key} = $${paramIndex}`;
            values.push(value);
            paramIndex++;
        }

        query += ` WHERE id = $${paramIndex} RETURNING *`;
        values.push(id);

        const result = await client.query(query, values);
        return result.rows[0];
    },

    async findExpiredTimers() {
        const result = await pool.query(`
            SELECT * FROM splits 
            WHERE status IN ('timer_active', 'partially_paid')
            AND timer_expires_at < NOW()
        `);
        return result.rows;
    },

    async findByCourse(courseId, options = {}) {
        let query = 'SELECT * FROM splits WHERE course_id = $1';
        const values = [courseId];

        if (options.status) {
            query += ` AND status = $${values.length + 1}`;
            values.push(options.status);
        }

        if (options.teeDate) {
            query += ` AND tee_date = $${values.length + 1}`;
            values.push(options.teeDate);
        }

        if (options.fromDate) {
            query += ` AND tee_date >= $${values.length + 1}`;
            values.push(options.fromDate);
        }

        if (options.toDate) {
            query += ` AND tee_date <= $${values.length + 1}`;
            values.push(options.toDate);
        }

        query += ' ORDER BY tee_date ASC, tee_time ASC';

        if (options.limit) {
            query += ` LIMIT $${values.length + 1}`;
            values.push(options.limit);
        }

        const result = await pool.query(query, values);
        return result.rows;
    },

    async getPaidCount(splitId) {
        const result = await pool.query(`
            SELECT COUNT(*) as count FROM players 
            WHERE split_id = $1 AND payment_status IN ('authorized', 'captured')
        `, [splitId]);
        return parseInt(result.rows[0].count);
    },

    async checkAllPaid(splitId) {
        const result = await pool.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE payment_status IN ('authorized', 'captured')) as paid
            FROM players WHERE split_id = $1
        `, [splitId]);
        
        const { total, paid } = result.rows[0];
        return parseInt(total) === parseInt(paid);
    }
};

// ============================================
// PLAYERS MODEL
// ============================================

const Players = {
    async create(data, client = pool) {
        const paymentToken = crypto.randomBytes(32).toString('hex');
        
        const query = `
            INSERT INTO players (
                split_id, position, name, email, phone, is_booker, amount, payment_token
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
        `;

        const values = [
            data.splitId, data.position, data.name, data.email,
            data.phone, data.isBooker || false, data.amount, paymentToken
        ];

        const result = await client.query(query, values);
        return result.rows[0];
    },

    async createBulk(players, client = pool) {
        const results = [];
        for (const player of players) {
            const created = await this.create(player, client);
            results.push(created);
        }
        return results;
    },

    async findById(id) {
        const result = await pool.query('SELECT * FROM players WHERE id = $1', [id]);
        return result.rows[0];
    },

    async findByPaymentToken(token) {
        const result = await pool.query(
            'SELECT p.*, s.* FROM players p JOIN splits s ON s.id = p.split_id WHERE p.payment_token = $1',
            [token]
        );
        
        if (!result.rows[0]) return null;
        
        const row = result.rows[0];
        // Separate player and split data
        return {
            player: {
                id: row.id,
                split_id: row.split_id,
                position: row.position,
                name: row.name,
                email: row.email,
                phone: row.phone,
                is_booker: row.is_booker,
                amount: row.amount,
                payment_status: row.payment_status,
                stripe_payment_intent_id: row.stripe_payment_intent_id,
                payment_token: row.payment_token,
                paid_at: row.paid_at
            },
            split: {
                id: row.split_id,
                short_code: row.short_code,
                course_id: row.course_id,
                course_name: row.course_name,
                tee_date: row.tee_date,
                tee_time: row.tee_time,
                num_players: row.num_players,
                green_fee: row.green_fee,
                cart_fee: row.cart_fee,
                total_per_player: row.total_per_player,
                payment_mode: row.payment_mode,
                status: row.status,
                timer_expires_at: row.timer_expires_at
            }
        };
    },

    async findByStripePaymentIntent(paymentIntentId) {
        const result = await pool.query(
            'SELECT * FROM players WHERE stripe_payment_intent_id = $1',
            [paymentIntentId]
        );
        return result.rows[0];
    },

    async findBySplit(splitId) {
        const result = await pool.query(
            'SELECT * FROM players WHERE split_id = $1 ORDER BY position',
            [splitId]
        );
        return result.rows;
    },

    async updatePaymentStatus(id, status, stripeData = {}, client = pool) {
        const updates = ['payment_status = $1'];
        const values = [status];
        let paramIndex = 2;

        if (stripeData.paymentIntentId) {
            updates.push(`stripe_payment_intent_id = $${paramIndex}`);
            values.push(stripeData.paymentIntentId);
            paramIndex++;
        }

        if (stripeData.chargeId) {
            updates.push(`stripe_charge_id = $${paramIndex}`);
            values.push(stripeData.chargeId);
            paramIndex++;
        }

        if (status === 'authorized' || status === 'captured') {
            updates.push(`paid_at = NOW()`);
        }

        if (status === 'refunded') {
            updates.push(`refunded_at = NOW()`);
        }

        values.push(id);
        const query = `UPDATE players SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
        
        const result = await client.query(query, values);
        return result.rows[0];
    },

    async markInviteSent(id) {
        await pool.query('UPDATE players SET invite_sent_at = NOW() WHERE id = $1', [id]);
    },

    async markReminderSent(id) {
        await pool.query('UPDATE players SET reminder_sent_at = NOW() WHERE id = $1', [id]);
    },

    async getPendingPayments(splitId) {
        const result = await pool.query(`
            SELECT * FROM players 
            WHERE split_id = $1 AND payment_status = 'pending'
            ORDER BY position
        `, [splitId]);
        return result.rows;
    },

    async getAuthorizedPayments(splitId) {
        const result = await pool.query(`
            SELECT * FROM players 
            WHERE split_id = $1 AND payment_status = 'authorized'
            ORDER BY position
        `, [splitId]);
        return result.rows;
    }
};

// ============================================
// TRANSACTIONS MODEL
// ============================================

const Transactions = {
    async create(data, client = pool) {
        const query = `
            INSERT INTO transactions (
                player_id, split_id, course_id, type, amount, platform_fee,
                stripe_fee, course_amount, stripe_payment_intent_id, stripe_charge_id,
                stripe_refund_id, stripe_transfer_id, status, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING *
        `;

        const values = [
            data.playerId, data.splitId, data.courseId, data.type, data.amount,
            data.platformFee, data.stripeFee, data.courseAmount,
            data.stripePaymentIntentId, data.stripeChargeId, data.stripeRefundId,
            data.stripeTransferId, data.status || 'pending', data.metadata || {}
        ];

        const result = await client.query(query, values);
        return result.rows[0];
    },

    async updateStatus(id, status, failureReason = null, client = pool) {
        const result = await client.query(`
            UPDATE transactions SET status = $1, failure_reason = $2 WHERE id = $3 RETURNING *
        `, [status, failureReason, id]);
        return result.rows[0];
    },

    async findByPaymentIntent(paymentIntentId) {
        const result = await pool.query(
            'SELECT * FROM transactions WHERE stripe_payment_intent_id = $1 ORDER BY created_at DESC',
            [paymentIntentId]
        );
        return result.rows;
    },

    async findByCourse(courseId, options = {}) {
        let query = 'SELECT * FROM transactions WHERE course_id = $1';
        const values = [courseId];

        if (options.type) {
            query += ` AND type = $${values.length + 1}`;
            values.push(options.type);
        }

        if (options.status) {
            query += ` AND status = $${values.length + 1}`;
            values.push(options.status);
        }

        if (options.fromDate) {
            query += ` AND created_at >= $${values.length + 1}`;
            values.push(options.fromDate);
        }

        query += ' ORDER BY created_at DESC';

        if (options.limit) {
            query += ` LIMIT $${values.length + 1}`;
            values.push(options.limit);
        }

        const result = await pool.query(query, values);
        return result.rows;
    },

    async getCourseRevenue(courseId, fromDate, toDate) {
        const result = await pool.query(`
            SELECT 
                SUM(course_amount) as total_revenue,
                SUM(platform_fee) as total_platform_fees,
                COUNT(*) as transaction_count
            FROM transactions 
            WHERE course_id = $1 
            AND status = 'succeeded'
            AND type IN ('capture', 'immediate_charge')
            AND created_at >= $2 AND created_at <= $3
        `, [courseId, fromDate, toDate]);
        return result.rows[0];
    }
};

// ============================================
// REFUNDS MODEL
// ============================================

const Refunds = {
    async create(data, client = pool) {
        const query = `
            INSERT INTO refunds (
                transaction_id, player_id, split_id, amount, reason
            ) VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `;

        const result = await client.query(query, [
            data.transactionId, data.playerId, data.splitId, data.amount, data.reason
        ]);
        return result.rows[0];
    },

    async updateStatus(id, status, stripeRefundId = null, failureReason = null) {
        const result = await pool.query(`
            UPDATE refunds 
            SET status = $1, stripe_refund_id = $2, failure_reason = $3,
                last_attempt_at = NOW(), attempts = attempts + 1
            WHERE id = $4 
            RETURNING *
        `, [status, stripeRefundId, failureReason, id]);
        return result.rows[0];
    },

    async scheduleRetry(id, nextRetryAt) {
        await pool.query(
            'UPDATE refunds SET next_retry_at = $1 WHERE id = $2',
            [nextRetryAt, id]
        );
    },

    async escalate(id, notes) {
        await pool.query(`
            UPDATE refunds SET status = 'escalated', escalated_at = NOW(), escalation_notes = $1
            WHERE id = $2
        `, [notes, id]);
    },

    async resolve(id, resolvedBy) {
        await pool.query(`
            UPDATE refunds SET status = 'succeeded', resolved_at = NOW(), resolved_by = $1
            WHERE id = $2
        `, [resolvedBy, id]);
    },

    async findPendingRetries() {
        const result = await pool.query(`
            SELECT r.*, t.stripe_payment_intent_id, t.stripe_charge_id 
            FROM refunds r
            JOIN transactions t ON t.id = r.transaction_id
            WHERE r.status IN ('pending', 'failed')
            AND r.attempts < 3
            AND (r.next_retry_at IS NULL OR r.next_retry_at <= NOW())
        `);
        return result.rows;
    },

    async findEscalated() {
        const result = await pool.query(`
            SELECT * FROM refunds WHERE status = 'escalated' ORDER BY escalated_at ASC
        `);
        return result.rows;
    }
};

// ============================================
// WEBHOOK DELIVERIES MODEL
// ============================================

const WebhookDeliveries = {
    async create(data) {
        const result = await pool.query(`
            INSERT INTO webhook_deliveries (course_id, event_type, payload, url)
            VALUES ($1, $2, $3, $4)
            RETURNING *
        `, [data.courseId, data.eventType, data.payload, data.url]);
        return result.rows[0];
    },

    async markDelivered(id, responseStatus, responseBody) {
        await pool.query(`
            UPDATE webhook_deliveries 
            SET status = 'delivered', delivered_at = NOW(), 
                response_status = $1, response_body = $2,
                attempts = attempts + 1, last_attempt_at = NOW()
            WHERE id = $3
        `, [responseStatus, responseBody, id]);
    },

    async markFailed(id, responseStatus, errorMessage, nextRetryAt) {
        await pool.query(`
            UPDATE webhook_deliveries 
            SET attempts = attempts + 1, last_attempt_at = NOW(),
                response_status = $1, error_message = $2, next_retry_at = $3,
                status = CASE WHEN attempts >= 2 THEN 'failed' ELSE status END
            WHERE id = $4
        `, [responseStatus, errorMessage, nextRetryAt, id]);
    },

    async findPendingRetries() {
        const result = await pool.query(`
            SELECT wd.*, c.webhook_secret 
            FROM webhook_deliveries wd
            JOIN courses c ON c.id = wd.course_id
            WHERE wd.status = 'pending'
            AND wd.attempts < 3
            AND (wd.next_retry_at IS NULL OR wd.next_retry_at <= NOW())
        `);
        return result.rows;
    }
};

// ============================================
// ADMINS MODEL
// ============================================

const Admins = {
    async findByEmail(email) {
        const result = await pool.query('SELECT * FROM admins WHERE email = $1', [email]);
        return result.rows[0];
    },

    async incrementFailedLogins(id) {
        const result = await pool.query(`
            UPDATE admins SET failed_login_attempts = failed_login_attempts + 1
            WHERE id = $1 RETURNING failed_login_attempts
        `, [id]);
        return result.rows[0]?.failed_login_attempts || 0;
    },

    async resetFailedLogins(id) {
        await pool.query(`
            UPDATE admins SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW()
            WHERE id = $1
        `, [id]);
    },

    async lockAccount(id, until) {
        await pool.query('UPDATE admins SET locked_until = $1 WHERE id = $2', [until, id]);
    }
};

// ============================================
// AUDIT LOG MODEL
// ============================================

const AuditLog = {
    async log(data) {
        await pool.query(`
            INSERT INTO audit_log (actor_type, actor_id, action, resource_type, resource_id, details, ip_address, user_agent)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
            data.actorType, data.actorId, data.action, data.resourceType,
            data.resourceId, data.details || {}, data.ipAddress, data.userAgent
        ]);
    },

    async findByResource(resourceType, resourceId, limit = 50) {
        const result = await pool.query(`
            SELECT * FROM audit_log 
            WHERE resource_type = $1 AND resource_id = $2
            ORDER BY created_at DESC LIMIT $3
        `, [resourceType, resourceId, limit]);
        return result.rows;
    }
};

// ============================================
// RATE LIMITS MODEL
// ============================================

const RateLimits = {
    async check(key, action, maxRequests, windowMs) {
        const windowStart = new Date(Date.now() - windowMs);
        
        const result = await pool.query(`
            INSERT INTO rate_limits (key, action, count, window_start)
            VALUES ($1, $2, 1, NOW())
            ON CONFLICT (key, action) DO UPDATE
            SET count = CASE 
                WHEN rate_limits.window_start < $3 THEN 1
                ELSE rate_limits.count + 1
            END,
            window_start = CASE
                WHEN rate_limits.window_start < $3 THEN NOW()
                ELSE rate_limits.window_start
            END
            RETURNING count, window_start
        `, [key, action, windowStart]);

        const { count, window_start } = result.rows[0];
        const isWithinWindow = new Date(window_start) >= windowStart;
        
        return {
            allowed: !isWithinWindow || count <= maxRequests,
            remaining: Math.max(0, maxRequests - count),
            resetAt: new Date(new Date(window_start).getTime() + windowMs)
        };
    },

    async cleanup() {
        await pool.query('SELECT cleanup_rate_limits()');
    }
};

// ============================================
// PLATFORM STATS
// ============================================

const PlatformStats = {
    async getSummary() {
        const result = await pool.query('SELECT * FROM platform_summary');
        return result.rows[0];
    },

    async getRecentActivity(limit = 20) {
        const result = await pool.query(`
            SELECT 
                'split_created' as type,
                s.id,
                s.course_name,
                s.total_per_player * s.num_players as amount,
                s.created_at as timestamp
            FROM splits s
            ORDER BY s.created_at DESC
            LIMIT $1
        `, [limit]);
        return result.rows;
    }
};

// ============================================
// EXPORTS
// ============================================

module.exports = {
    pool,
    withTransaction,
    Courses,
    CourseSessions,
    Splits,
    Players,
    Transactions,
    Refunds,
    WebhookDeliveries,
    Admins,
    AuditLog,
    RateLimits,
    PlatformStats
};
