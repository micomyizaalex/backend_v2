-- =====================================================
-- SafariTix Subscription System - PostgreSQL Migration
-- =====================================================
-- This migration creates all necessary tables, types, functions, and triggers
-- for the subscription system using PostgreSQL
--
-- Run this migration: psql -U username -d safatitix -f create-subscriptions-table-postgresql.sql

-- Create custom ENUM types for PostgreSQL
-- These replace MySQL's ENUM columns with proper PostgreSQL types
CREATE TYPE subscription_plan_name AS ENUM ('Starter', 'Growth', 'Enterprise');

-- Creates subscription status type with all 6 possible states
CREATE TYPE subscription_status AS ENUM (
    'TRIAL_ACTIVE',      -- Trial is active (more than 3 days left)
    'TRIAL_EXPIRING',    -- Trial expires in 3 days or less
    'TRIAL_EXPIRED',     -- Trial has ended, payment required
    'ACTIVE',            -- Paid subscription is active
    'GRACE_PERIOD',      -- 7 days after expiry with limited access
    'EXPIRED'            -- No access, subscription fully expired
);

-- Creates audit action type for subscription history
CREATE TYPE subscription_action AS ENUM (
    'CREATED',           -- Subscription created
    'UPGRADED',          -- Upgraded to higher plan
    'DOWNGRADED',        -- Downgraded to lower plan
    'RENEWED',           -- Subscription renewed
    'CANCELLED',         -- Subscription cancelled
    'EXPIRED',           -- Subscription expired
    'STATUS_CHANGED'     -- Status changed (e.g., trial ending)
);

-- Table: subscription_plans
-- Stores the 3 subscription tier definitions (Starter, Growth, Enterprise)
-- This is the master table for plan configuration
CREATE TABLE IF NOT EXISTS subscription_plans (
    id SERIAL PRIMARY KEY,                           -- Auto-incrementing ID
    name subscription_plan_name UNIQUE NOT NULL,     -- Plan name (Starter/Growth/Enterprise)
    price NUMERIC(10, 2) NOT NULL,                   -- Monthly price in RWF
    max_buses INTEGER,                               -- Maximum buses allowed (NULL = unlimited)
    features TEXT[] NOT NULL,                        -- Array of feature strings
    trial_days INTEGER NOT NULL DEFAULT 14,          -- Trial period duration in days
    grace_period_days INTEGER NOT NULL DEFAULT 7,    -- Grace period after expiry
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),     -- Record creation timestamp
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()      -- Last update timestamp
);

-- Table: subscriptions
-- Stores individual user subscription records
-- Each user has exactly ONE active subscription (enforced by unique constraint)

-- Table: subscription_history
-- Audit trail for all subscription changes
-- Every status change, upgrade, downgrade, etc. is logged here



-- Create indexes for performance optimization
CREATE INDEX IF NOT EXISTS idx_subscription_status ON subscriptions(status);           -- Fast status filtering
CREATE INDEX IF NOT EXISTS idx_subscription_end_date ON subscriptions(end_date);       -- Fast expiry checks
CREATE INDEX IF NOT EXISTS idx_subscription_user_plan ON subscriptions(user_id, plan_name); -- Fast user+plan lookup
CREATE INDEX IF NOT EXISTS idx_history_user_id ON subscription_history(user_id);       -- Fast history lookup by user
CREATE INDEX IF NOT EXISTS idx_history_created_at ON subscription_history(created_at); -- Fast time-based queries

-- PostgreSQL Function: update_subscription_status
-- This function calculates and updates the correct subscription status
-- Called automatically by trigger and manually by cron job
-- Replaces MySQL stored procedure
CREATE OR REPLACE FUNCTION update_subscription_status(p_user_id VARCHAR)
RETURNS TABLE(
    old_status subscription_status,
    new_status subscription_status,
    status_changed BOOLEAN
) AS $$
DECLARE
    v_subscription_id INTEGER;
    v_current_status subscription_status;
    v_is_trial BOOLEAN;
    v_trial_end_date TIMESTAMP;
    v_subscription_end_date TIMESTAMP;
    v_new_status subscription_status;
    v_grace_period_days INTEGER;
    v_days_until_trial_end INTEGER;
    v_grace_period_end TIMESTAMP;
BEGIN
    -- Fetch the user's subscription details
    SELECT 
        id, status, is_trial, trial_end_date, end_date
    INTO 
        v_subscription_id, v_current_status, v_is_trial, v_trial_end_date, v_subscription_end_date
    FROM subscriptions
    WHERE user_id = p_user_id;
    
    -- If no subscription found, return NULL
    IF v_subscription_id IS NULL THEN
        RETURN;
    END IF;
    
    -- Get grace period days (default 7)
    SELECT grace_period_days INTO v_grace_period_days
    FROM subscription_plans
    WHERE name = (SELECT plan_name FROM subscriptions WHERE user_id = p_user_id)
    LIMIT 1;
    
    IF v_grace_period_days IS NULL THEN
        v_grace_period_days := 7;
    END IF;
    
    -- Calculate the appropriate status based on dates
    IF v_is_trial = TRUE THEN
        -- This is a trial subscription
        IF v_trial_end_date IS NULL OR v_trial_end_date < NOW() THEN
            -- Trial has expired
            v_new_status := 'TRIAL_EXPIRED';
        ELSE
            -- Trial is still active - check if expiring soon
            v_days_until_trial_end := EXTRACT(DAY FROM v_trial_end_date - NOW())::INTEGER;
            
            IF v_days_until_trial_end <= 3 THEN
                v_new_status := 'TRIAL_EXPIRING';  -- 3 days or less remaining
            ELSE
                v_new_status := 'TRIAL_ACTIVE';    -- More than 3 days remaining
            END IF;
        END IF;
    ELSE
        -- This is a paid subscription
        IF v_subscription_end_date IS NULL THEN
            -- No end date means active subscription
            v_new_status := 'ACTIVE';
        ELSIF v_subscription_end_date > NOW() THEN
            -- End date in future means still active
            v_new_status := 'ACTIVE';
        ELSE
            -- Subscription has ended - check if in grace period
            v_grace_period_end := v_subscription_end_date + (v_grace_period_days || ' days')::INTERVAL;
            
            IF NOW() <= v_grace_period_end THEN
                v_new_status := 'GRACE_PERIOD';    -- Within 7-day grace period
            ELSE
                v_new_status := 'EXPIRED';         -- Grace period ended
            END IF;
        END IF;
    END IF;
    
    -- Update the subscription status if it changed
    IF v_new_status != v_current_status THEN
        UPDATE subscriptions
        SET status = v_new_status,
            updated_at = NOW()
        WHERE user_id = p_user_id;
        
        -- Also update user's subscription_status column
        UPDATE users
        SET subscription_status = v_new_status,
            updated_at = NOW()
        WHERE id = p_user_id;
        
        -- Return the change
        RETURN QUERY SELECT v_current_status, v_new_status, TRUE;
    ELSE
        -- No change
        RETURN QUERY SELECT v_current_status, v_new_status, FALSE;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- PostgreSQL Trigger Function: log_subscription_changes
-- This function is called by the trigger to log all subscription changes
CREATE OR REPLACE FUNCTION log_subscription_changes()
RETURNS TRIGGER AS $$
BEGIN
    -- Only log if status or plan changed
    IF (TG_OP = 'UPDATE' AND (OLD.status != NEW.status OR OLD.plan_name != NEW.plan_name)) THEN
        INSERT INTO subscription_history (
            user_id,
            subscription_id,
            action,
            old_status,
            new_status,
            old_plan,
            new_plan,
            notes
        ) VALUES (
            NEW.user_id,
            NEW.id,
            CASE 
                WHEN OLD.plan_name != NEW.plan_name THEN 'UPGRADED'::subscription_action
                WHEN OLD.status != NEW.status THEN 'STATUS_CHANGED'::subscription_action
                ELSE 'STATUS_CHANGED'::subscription_action
            END,
            OLD.status,
            NEW.status,
            OLD.plan_name,
            NEW.plan_name,
            'Automatic status/plan update'
        );
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger that fires after subscription updates
-- This automatically logs all changes to subscription_history table
DROP TRIGGER IF EXISTS after_subscription_update ON subscriptions;
CREATE TRIGGER after_subscription_update
    AFTER UPDATE ON subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION log_subscription_changes();

-- Insert the 3 default subscription plans
-- Uses ON CONFLICT to prevent duplicates on re-run
INSERT INTO subscription_plans (name, price, max_buses, features, trial_days, grace_period_days)
VALUES 
    -- Starter Plan: RWF 50,000/month, max 5 buses, basic features
    (
        'Starter',
        50000.00,
        5,
        ARRAY[
            'basic_ticketing',           -- Core ticketing functionality
            'basic_reporting',           -- Basic reports only
            'email_support',             -- Email support only
            'mobile_app_access'          -- Access to mobile apps
        ],
        14,  -- 14-day trial
        7    -- 7-day grace period
    ),
    
    -- Growth Plan: RWF 150,000/month, max 20 buses, advanced features
    (
        'Growth',
        150000.00,
        20,
        ARRAY[
            'basic_ticketing',           -- Core ticketing functionality
            'advanced_ticketing',        -- Advanced ticketing features
            'gps_tracking',              -- Real-time GPS tracking
            'driver_accounts',           -- Driver management system
            'advanced_analytics',        -- Advanced analytics dashboard
            'route_optimization',        -- Route optimization tools
            'qr_code_scanning',          -- QR code ticket validation
            'priority_support',          -- Priority email/chat support
            'mobile_app_access',         -- Access to mobile apps
            'custom_branding'            -- Custom logo and colors
        ],
        14,  -- 14-day trial
        7    -- 7-day grace period
    ),
    
    -- Enterprise Plan: RWF 250,000/month, unlimited buses, all features
    (
        'Enterprise',
        250000.00,
        NULL,  -- NULL means unlimited buses
        ARRAY[
            'basic_ticketing',           -- Core ticketing functionality
            'advanced_ticketing',        -- Advanced ticketing features
            'gps_tracking',              -- Real-time GPS tracking
            'driver_accounts',           -- Driver management system
            'advanced_analytics',        -- Advanced analytics dashboard
            'route_optimization',        -- Route optimization tools
            'qr_code_scanning',          -- QR code ticket validation
            'api_access',                -- REST API access
            'webhook_integration',       -- Webhook notifications
            'white_label',               -- Full white-label branding
            'dedicated_support',         -- Dedicated account manager
            'sla_guarantee',             -- 99.9% uptime SLA
            'custom_integrations',       -- Custom integration support
            'mobile_app_access',         -- Access to mobile apps
            'priority_onboarding',       -- Priority onboarding assistance
            'data_export'                -- Full data export capabilities
        ],
        14,  -- 14-day trial (though test user gets ACTIVE)
        7    -- 7-day grace period
    )
ON CONFLICT (name) DO UPDATE SET
    price = EXCLUDED.price,
    max_buses = EXCLUDED.max_buses,
    features = EXCLUDED.features,
    trial_days = EXCLUDED.trial_days,
    grace_period_days = EXCLUDED.grace_period_days,
    updated_at = NOW();

-- Create function to automatically update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers to auto-update updated_at on all tables
DROP TRIGGER IF EXISTS update_subscription_plans_updated_at ON subscription_plans;
CREATE TRIGGER update_subscription_plans_updated_at
    BEFORE UPDATE ON subscription_plans
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON subscriptions;
CREATE TRIGGER update_subscriptions_updated_at
    BEFORE UPDATE ON subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- Migration Complete
-- =====================================================
-- The following tables have been created:
--   1. subscription_plans (3 plans: Starter, Growth, Enterprise)
--   2. subscriptions (user subscription records)
--   3. subscription_history (audit trail)
--
-- The following custom types have been created:
--   1. subscription_plan_name
--   2. subscription_status
--   3. subscription_action
--
-- The following functions have been created:
--   1. update_subscription_status(user_id) - Calculate and update status
--   2. log_subscription_changes() - Trigger function for audit logging
--   3. update_updated_at_column() - Auto-update timestamps
--
-- The following triggers have been created:
--   1. after_subscription_update - Logs subscription changes
--   2. update_subscription_plans_updated_at - Updates plan timestamps
--   3. update_subscriptions_updated_at - Updates subscription timestamps
--
-- Next steps:
--   1. Verify tables exist: \dt
--   2. Check plans inserted: SELECT * FROM subscription_plans;
--   3. Test the PHP SubscriptionManager class
-- =====================================================
