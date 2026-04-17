-- Split Tee v2.1 Database Schema
-- PostgreSQL for Supabase / Railway / Neon

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================
-- COURSES (Partner golf courses)
-- ============================================
CREATE TABLE courses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone VARCHAR(20),
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(50),
    zip VARCHAR(20),
    country VARCHAR(50) DEFAULT 'US',
    timezone VARCHAR(50) DEFAULT 'America/New_York',
    logo_url TEXT,
    website_url TEXT,
    
    -- Stripe Connect
    stripe_account_id VARCHAR(255),
    stripe_onboarding_complete BOOLEAN DEFAULT FALSE,
    stripe_payouts_enabled BOOLEAN DEFAULT FALSE,
    
    -- API Access
    api_key_hash VARCHAR(255),
    api_key_prefix VARCHAR(10),
    webhook_url TEXT,
    webhook_secret VARCHAR(255),
    
    -- Authentication
    password_hash VARCHAR(255),
    magic_link_token VARCHAR(255),
    magic_link_expires TIMESTAMPTZ,
    failed_login_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMPTZ,
    
    -- Settings
    default_green_fee DECIMAL(10,2),
    default_cart_fee DECIMAL(10,2),
    blackout_dates JSONB DEFAULT '[]',
    notification_preferences JSONB DEFAULT '{"email": true, "sms": false}',
    
    -- Status
    status VARCHAR(20) DEFAULT 'pending_verification',
    verified_at TIMESTAMPTZ,
    
    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_courses_email ON courses(email);
CREATE INDEX idx_courses_slug ON courses(slug);
CREATE INDEX idx_courses_stripe_account ON courses(stripe_account_id);
CREATE INDEX idx_courses_status ON courses(status);

-- ============================================
-- COURSE SESSIONS (JWT refresh tokens)
-- ============================================
CREATE TABLE course_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    refresh_token_hash VARCHAR(255) NOT NULL,
    user_agent TEXT,
    ip_address VARCHAR(45),
    last_activity TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_course_sessions_course ON course_sessions(course_id);
CREATE INDEX idx_course_sessions_expires ON course_sessions(expires_at);

-- ============================================
-- SPLITS (Group payment requests)
-- ============================================
CREATE TABLE splits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    short_code VARCHAR(12) UNIQUE NOT NULL,
    
    -- Course reference
    course_id UUID NOT NULL REFERENCES courses(id),
    course_name VARCHAR(255) NOT NULL,
    
    -- Tee time details
    tee_date DATE NOT NULL,
    tee_time TIME NOT NULL,
    num_players INTEGER NOT NULL CHECK (num_players >= 2 AND num_players <= 8),
    
    -- Pricing (immutable after creation)
    green_fee DECIMAL(10,2) NOT NULL,
    cart_fee DECIMAL(10,2) DEFAULT 0,
    base_price DECIMAL(10,2) NOT NULL,
    platform_fee DECIMAL(10,2) NOT NULL,
    total_per_player DECIMAL(10,2) NOT NULL,
    
    -- Payment mode
    payment_mode VARCHAR(20) NOT NULL CHECK (payment_mode IN ('auth_hold', 'immediate_capture')),
    days_until_tee INTEGER NOT NULL,
    
    -- Timer
    timer_started_at TIMESTAMPTZ,
    timer_expires_at TIMESTAMPTZ,
    
    -- Status
    status VARCHAR(30) DEFAULT 'pending' CHECK (status IN (
        'pending',
        'timer_active',
        'partially_paid',
        'fully_paid',
        'confirmed',
        'expired',
        'cancelled',
        'refunded'
    )),
    
    -- Booker info
    booker_name VARCHAR(255) NOT NULL,
    booker_email VARCHAR(255) NOT NULL,
    booker_phone VARCHAR(20),
    
    -- Integration metadata
    external_booking_id VARCHAR(255),
    integration_mode VARCHAR(20) DEFAULT 'embed' CHECK (integration_mode IN ('embed', 'api')),
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    confirmed_at TIMESTAMPTZ,
    expired_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ
);

CREATE INDEX idx_splits_course ON splits(course_id);
CREATE INDEX idx_splits_short_code ON splits(short_code);
CREATE INDEX idx_splits_status ON splits(status);
CREATE INDEX idx_splits_tee_date ON splits(tee_date);
CREATE INDEX idx_splits_timer_expires ON splits(timer_expires_at);
CREATE INDEX idx_splits_booker_email ON splits(booker_email);

-- ============================================
-- PLAYERS (Individual split participants)
-- ============================================
CREATE TABLE players (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    split_id UUID NOT NULL REFERENCES splits(id) ON DELETE CASCADE,
    
    -- Player info
    position INTEGER NOT NULL CHECK (position >= 1 AND position <= 8),
    name VARCHAR(255),
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    is_booker BOOLEAN DEFAULT FALSE,
    
    -- Payment
    amount DECIMAL(10,2) NOT NULL,
    payment_status VARCHAR(20) DEFAULT 'pending' CHECK (payment_status IN (
        'pending',
        'processing',
        'authorized',
        'captured',
        'failed',
        'refunded',
        'cancelled'
    )),
    
    -- Stripe
    stripe_payment_intent_id VARCHAR(255),
    stripe_charge_id VARCHAR(255),
    
    -- Payment token (for secure link)
    payment_token VARCHAR(64) UNIQUE NOT NULL,
    
    -- Notifications
    invite_sent_at TIMESTAMPTZ,
    reminder_sent_at TIMESTAMPTZ,
    
    -- Timestamps
    paid_at TIMESTAMPTZ,
    refunded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(split_id, position),
    UNIQUE(split_id, email)
);

CREATE INDEX idx_players_split ON players(split_id);
CREATE INDEX idx_players_email ON players(email);
CREATE INDEX idx_players_payment_token ON players(payment_token);
CREATE INDEX idx_players_payment_status ON players(payment_status);
CREATE INDEX idx_players_stripe_pi ON players(stripe_payment_intent_id);

-- ============================================
-- TRANSACTIONS (Payment audit trail)
-- ============================================
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    player_id UUID NOT NULL REFERENCES players(id),
    split_id UUID NOT NULL REFERENCES splits(id),
    course_id UUID NOT NULL REFERENCES courses(id),
    
    -- Type
    type VARCHAR(30) NOT NULL CHECK (type IN (
        'authorization',
        'capture',
        'immediate_charge',
        'refund',
        'partial_refund',
        'payout'
    )),
    
    -- Amounts
    amount DECIMAL(10,2) NOT NULL,
    platform_fee DECIMAL(10,2),
    stripe_fee DECIMAL(10,2),
    course_amount DECIMAL(10,2),
    
    -- Stripe references
    stripe_payment_intent_id VARCHAR(255),
    stripe_charge_id VARCHAR(255),
    stripe_refund_id VARCHAR(255),
    stripe_transfer_id VARCHAR(255),
    
    -- Status
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN (
        'pending',
        'succeeded',
        'failed',
        'cancelled'
    )),
    failure_reason TEXT,
    
    -- Metadata
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_transactions_player ON transactions(player_id);
CREATE INDEX idx_transactions_split ON transactions(split_id);
CREATE INDEX idx_transactions_course ON transactions(course_id);
CREATE INDEX idx_transactions_stripe_pi ON transactions(stripe_payment_intent_id);
CREATE INDEX idx_transactions_type ON transactions(type);
CREATE INDEX idx_transactions_created ON transactions(created_at);

-- ============================================
-- REFUNDS (Refund tracking with retry logic)
-- ============================================
CREATE TABLE refunds (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID NOT NULL REFERENCES transactions(id),
    player_id UUID NOT NULL REFERENCES players(id),
    split_id UUID NOT NULL REFERENCES splits(id),
    
    -- Refund details
    amount DECIMAL(10,2) NOT NULL,
    reason VARCHAR(50) NOT NULL CHECK (reason IN (
        'timer_expired',
        'split_cancelled',
        'course_cancelled',
        'player_request',
        'duplicate_payment',
        'admin_initiated'
    )),
    
    -- Status
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN (
        'pending',
        'processing',
        'succeeded',
        'failed',
        'escalated'
    )),
    
    -- Retry tracking
    attempts INTEGER DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    next_retry_at TIMESTAMPTZ,
    
    -- Stripe
    stripe_refund_id VARCHAR(255),
    failure_reason TEXT,
    
    -- Escalation
    escalated_at TIMESTAMPTZ,
    escalation_notes TEXT,
    resolved_at TIMESTAMPTZ,
    resolved_by VARCHAR(255),
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_refunds_status ON refunds(status);
CREATE INDEX idx_refunds_next_retry ON refunds(next_retry_at);
CREATE INDEX idx_refunds_split ON refunds(split_id);

-- ============================================
-- WEBHOOKS (Outbound webhook delivery)
-- ============================================
CREATE TABLE webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    course_id UUID NOT NULL REFERENCES courses(id),
    
    -- Event
    event_type VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    
    -- Delivery
    url TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN (
        'pending',
        'delivered',
        'failed'
    )),
    
    -- Retry tracking
    attempts INTEGER DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    next_retry_at TIMESTAMPTZ,
    
    -- Response
    response_status INTEGER,
    response_body TEXT,
    error_message TEXT,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    delivered_at TIMESTAMPTZ
);

CREATE INDEX idx_webhook_deliveries_course ON webhook_deliveries(course_id);
CREATE INDEX idx_webhook_deliveries_status ON webhook_deliveries(status);
CREATE INDEX idx_webhook_deliveries_next_retry ON webhook_deliveries(next_retry_at);

-- ============================================
-- PLATFORM ADMINS
-- ============================================
CREATE TABLE admins (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'admin' CHECK (role IN ('admin', 'super_admin')),
    
    -- Authentication
    failed_login_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ,
    
    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_admins_email ON admins(email);

-- ============================================
-- AUDIT LOG
-- ============================================
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Actor
    actor_type VARCHAR(20) NOT NULL CHECK (actor_type IN ('course', 'admin', 'system', 'player')),
    actor_id UUID,
    
    -- Action
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50),
    resource_id UUID,
    
    -- Details
    details JSONB DEFAULT '{}',
    ip_address VARCHAR(45),
    user_agent TEXT,
    
    -- Timestamp
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_log_actor ON audit_log(actor_type, actor_id);
CREATE INDEX idx_audit_log_resource ON audit_log(resource_type, resource_id);
CREATE INDEX idx_audit_log_action ON audit_log(action);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);

-- ============================================
-- RATE LIMITING
-- ============================================
CREATE TABLE rate_limits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key VARCHAR(255) NOT NULL,
    action VARCHAR(50) NOT NULL,
    count INTEGER DEFAULT 1,
    window_start TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(key, action)
);

CREATE INDEX idx_rate_limits_key_action ON rate_limits(key, action);
CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);

-- ============================================
-- FUNCTIONS & TRIGGERS
-- ============================================

-- Update timestamp trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to tables
CREATE TRIGGER update_courses_updated_at BEFORE UPDATE ON courses
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_splits_updated_at BEFORE UPDATE ON splits
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_players_updated_at BEFORE UPDATE ON players
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_refunds_updated_at BEFORE UPDATE ON refunds
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_admins_updated_at BEFORE UPDATE ON admins
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Generate short code for splits
CREATE OR REPLACE FUNCTION generate_short_code()
RETURNS VARCHAR(12) AS $$
DECLARE
    chars TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    result VARCHAR(12) := '';
    i INTEGER;
BEGIN
    FOR i IN 1..8 LOOP
        result := result || substr(chars, floor(random() * length(chars) + 1)::int, 1);
    END LOOP;
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Generate payment token
CREATE OR REPLACE FUNCTION generate_payment_token()
RETURNS VARCHAR(64) AS $$
BEGIN
    RETURN encode(gen_random_bytes(32), 'hex');
END;
$$ LANGUAGE plpgsql;

-- Clean up expired rate limits (run periodically)
CREATE OR REPLACE FUNCTION cleanup_rate_limits()
RETURNS void AS $$
BEGIN
    DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL '1 hour';
END;
$$ LANGUAGE plpgsql;

-- Clean up expired sessions
CREATE OR REPLACE FUNCTION cleanup_expired_sessions()
RETURNS void AS $$
BEGIN
    DELETE FROM course_sessions WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- VIEWS
-- ============================================

-- Course dashboard summary
CREATE VIEW course_dashboard_summary AS
SELECT 
    c.id AS course_id,
    c.name AS course_name,
    COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'confirmed') AS total_confirmed_splits,
    COUNT(DISTINCT s.id) FILTER (WHERE s.status IN ('pending', 'timer_active', 'partially_paid')) AS pending_splits,
    COALESCE(SUM(t.course_amount) FILTER (WHERE t.status = 'succeeded' AND t.type IN ('capture', 'immediate_charge')), 0) AS total_revenue,
    COALESCE(SUM(t.course_amount) FILTER (
        WHERE t.status = 'succeeded' 
        AND t.type IN ('capture', 'immediate_charge')
        AND t.created_at >= date_trunc('week', NOW())
    ), 0) AS weekly_revenue,
    COUNT(DISTINCT s.id) FILTER (WHERE s.tee_date = CURRENT_DATE) AS todays_splits
FROM courses c
LEFT JOIN splits s ON s.course_id = c.id
LEFT JOIN transactions t ON t.course_id = c.id
GROUP BY c.id, c.name;

-- Admin platform summary
CREATE VIEW platform_summary AS
SELECT 
    COUNT(DISTINCT c.id) AS total_courses,
    COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'active') AS active_courses,
    COUNT(DISTINCT s.id) AS total_splits,
    COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'confirmed') AS confirmed_splits,
    COALESCE(SUM(t.platform_fee) FILTER (WHERE t.status = 'succeeded'), 0) AS total_platform_revenue,
    COALESCE(SUM(t.amount) FILTER (WHERE t.status = 'succeeded'), 0) AS total_processed_volume,
    COUNT(DISTINCT r.id) FILTER (WHERE r.status = 'escalated') AS escalated_refunds
FROM courses c
LEFT JOIN splits s ON s.course_id = c.id
LEFT JOIN transactions t ON t.course_id = c.id
LEFT JOIN refunds r ON r.split_id = s.id;

-- ============================================
-- INITIAL DATA (Optional - for testing)
-- ============================================

-- Create a test admin (password: 'admin123' - CHANGE IN PRODUCTION)
-- INSERT INTO admins (email, name, password_hash, role)
-- VALUES (
--     'admin@splittee.com',
--     'Platform Admin',
--     '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/X4.VTtYf7Q7JQKXuy',
--     'super_admin'
-- );
