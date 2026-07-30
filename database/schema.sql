-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Drop existing tables if they exist
DROP TABLE IF EXISTS campaign_leads CASCADE;
DROP TABLE IF EXISTS voice_campaigns CASCADE;
DROP TABLE IF EXISTS gateway_port_telemetry CASCADE;
DROP TABLE IF EXISTS escalations CASCADE;
DROP TABLE IF EXISTS buckets CASCADE;
DROP TABLE IF EXISTS dispositions CASCADE;
DROP TABLE IF EXISTS calls CASCADE;
DROP TABLE IF EXISTS campaigns CASCADE;
DROP TABLE IF EXISTS gateway_ports CASCADE;
DROP TABLE IF EXISTS gateways CASCADE;
DROP TABLE IF EXISTS agent_breaks CASCADE;
DROP TABLE IF EXISTS agent_profiles CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS tenants CASCADE;

-- 1. Tenants Table
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL UNIQUE,
    subdomain VARCHAR(100) NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Users Table (Role-based access hierarchy)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE, -- NULL for Super Admin
    username VARCHAR(150) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL CHECK (role IN ('super_admin', 'client_admin', 'mentor', 'team_leader', 'agent')),
    parent_id UUID REFERENCES users(id) ON DELETE SET NULL, -- Maps Agent to TL, TL to Mentor, Mentor to Client Admin
    status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Agent Profiles (Holds status, break states, etc.)
CREATE TABLE agent_profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    current_status VARCHAR(50) DEFAULT 'offline' CHECK (current_status IN ('offline', 'login', 'idle', 'break', 'holiday')),
    last_status_change TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    current_language VARCHAR(50) DEFAULT 'English',
    daily_transfer_count INTEGER DEFAULT 0,
    is_temporary_blocked BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Agent Breaks (Timesheet logs)
CREATE TABLE agent_breaks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_profile_id UUID NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
    break_type VARCHAR(50) NOT NULL CHECK (break_type IN ('tea', 'lunch', 'meeting', 'other')),
    start_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    end_time TIMESTAMP WITH TIME ZONE
);

-- 5. Dinstar Gateways Table
CREATE TABLE gateways (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL UNIQUE,
    ip_address VARCHAR(100) NOT NULL UNIQUE,
    sn VARCHAR(100) NOT NULL UNIQUE,
    total_ports INTEGER DEFAULT 8,
    status VARCHAR(50) DEFAULT 'online',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 6. Gateway Ports (Port mapping to Tenants)
CREATE TABLE gateway_ports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gateway_id UUID NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
    port_number INTEGER NOT NULL CHECK (port_number BETWEEN 0 AND 31),
    tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL, -- Mapped tenant (Null means unassigned)
    mapped_trunk_name VARCHAR(100), -- Maps to Asterisk trunk ClientA_Trunk, ClientB_Trunk
    status VARCHAR(50) DEFAULT 'idle',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (gateway_id, port_number)
);

-- 7. Campaigns
CREATE TABLE campaigns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) DEFAULT 'outbound' CHECK (type IN ('inbound', 'outbound')),
    status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 8. Dispositions (Standard outcome labels per Tenant)
CREATE TABLE dispositions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code VARCHAR(100) NOT NULL,
    description VARCHAR(255),
    is_resolved BOOLEAN DEFAULT FALSE, -- Resolved resets SLAs
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, code)
);

-- 9. Calls Log (Central call registry)
CREATE TABLE calls (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
    caller_number VARCHAR(50) NOT NULL,
    callee_number VARCHAR(50) NOT NULL,
    agent_id UUID REFERENCES users(id) ON DELETE SET NULL,
    direction VARCHAR(50) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    status VARCHAR(50) DEFAULT 'queued' CHECK (status IN ('queued', 'ringing', 'active', 'completed', 'missed', 'failed')),
    start_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    answer_time TIMESTAMP WITH TIME ZONE,
    end_time TIMESTAMP WITH TIME ZONE,
    duration INTEGER DEFAULT 0, -- In seconds
    recording_url VARCHAR(512), -- Pointer to S3 bucket
    disposition_id UUID REFERENCES dispositions(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 10. Daily Outbound Buckets (Call assignments for Agents with SLAs)
CREATE TABLE buckets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    customer_number VARCHAR(50) NOT NULL,
    customer_name VARCHAR(255),
    assigned_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    sla_deadline TIMESTAMP WITH TIME ZONE NOT NULL,
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'escalated')),
    is_sla_breached BOOLEAN DEFAULT FALSE,
    call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 11. Escalations (If Missed call or SLA breached)
CREATE TABLE escalations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
    bucket_id UUID REFERENCES buckets(id) ON DELETE SET NULL,
    from_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    to_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    reason VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);


-- =========================================================================
-- ROW-LEVEL SECURITY (RLS) SETUP
-- =========================================================================

-- Enable RLS on Tenant-specific tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_breaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_ports ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalations ENABLE ROW LEVEL SECURITY;

-- Helper RLS condition function:
-- Check if session 'app.current_tenant_id' matches row tenant_id OR if session is empty (Super Admin)
CREATE OR REPLACE FUNCTION rls_tenant_check(row_tenant_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN (
        NULLIF(current_setting('app.current_tenant_id', true), '') IS NULL 
        OR row_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- Define policies referencing rls_tenant_check
CREATE POLICY users_isolation ON users FOR ALL USING (rls_tenant_check(tenant_id));
CREATE POLICY agent_profiles_isolation ON agent_profiles FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = agent_profiles.user_id AND rls_tenant_check(users.tenant_id))
);
CREATE POLICY agent_breaks_isolation ON agent_breaks FOR ALL USING (
    EXISTS (
        SELECT 1 FROM agent_profiles 
        JOIN users ON users.id = agent_profiles.user_id 
        WHERE agent_profiles.id = agent_breaks.agent_profile_id AND rls_tenant_check(users.tenant_id)
    )
);
CREATE POLICY gateway_ports_isolation ON gateway_ports FOR ALL USING (rls_tenant_check(tenant_id));
CREATE POLICY campaigns_isolation ON campaigns FOR ALL USING (rls_tenant_check(tenant_id));
CREATE POLICY dispositions_isolation ON dispositions FOR ALL USING (rls_tenant_check(tenant_id));
CREATE POLICY calls_isolation ON calls FOR ALL USING (rls_tenant_check(tenant_id));
CREATE POLICY buckets_isolation ON buckets FOR ALL USING (rls_tenant_check(tenant_id));
CREATE POLICY escalations_isolation ON escalations FOR ALL USING (rls_tenant_check(tenant_id));

-- 12. Voice Campaigns
-- NOTE: tenant_id is intentionally nullable with a default and NOT a foreign key, matching
-- server.js's initSchema() - the outbound_campaign_module is deployed standalone (see README)
-- without the full multi-tenant `tenants` table existing, so a hard FK here would break the
-- deployed-on-Render path. Keep this table's definition identical to initSchema() in server.js.
CREATE TABLE voice_campaigns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID DEFAULT 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    name VARCHAR(255) NOT NULL,
    audio_url VARCHAR(512),
    status VARCHAR(50) DEFAULT 'pending',
    allowed_ports VARCHAR(255) DEFAULT 'all',
    total_leads INTEGER DEFAULT 0,
    processed_leads INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 13. Campaign Leads
CREATE TABLE campaign_leads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id UUID REFERENCES voice_campaigns(id) ON DELETE CASCADE,
    phone_number VARCHAR(50) NOT NULL,
    customer_name VARCHAR(255),
    dial_status VARCHAR(50) DEFAULT 'pending',
    call_duration INTEGER DEFAULT 0,
    attempts INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_leads_dial_status ON campaign_leads(dial_status, updated_at);
CREATE INDEX IF NOT EXISTS idx_leads_campaign_id ON campaign_leads(campaign_id);

-- 14. Gateway Port Telemetry
CREATE TABLE gateway_port_telemetry (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gateway_ip VARCHAR(100) NOT NULL,
    port_number INTEGER NOT NULL,
    sim_number VARCHAR(50),
    signal_strength INTEGER DEFAULT 0,
    registration_status VARCHAR(50) NOT NULL DEFAULT 'UNREGISTER',
    call_state VARCHAR(50) DEFAULT 'Idle',
    last_polled TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (gateway_ip, port_number)
);

ALTER TABLE voice_campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY voice_campaigns_isolation ON voice_campaigns FOR ALL USING (rls_tenant_check(tenant_id));

