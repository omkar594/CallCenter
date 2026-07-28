-- Pre-calculated bcrypt hash for 'password123' is '$2a$10$Qn3nI59R6Sw5OwhK/ZtpAufHMiNhniTJk50X3rviaE6DjXDh9/Mda'

-- 1. Insert Tenants
INSERT INTO tenants (id, name, subdomain) VALUES
('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'HDFC Bank', 'hdfc'),
('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'State Bank of India', 'sbi');

-- 2. Insert Super Admin (tenant_id IS NULL)
INSERT INTO users (id, tenant_id, username, password_hash, role, parent_id) VALUES
('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01', NULL, 'superadmin', '$2a$10$Qn3nI59R6Sw5OwhK/ZtpAufHMiNhniTJk50X3rviaE6DjXDh9/Mda', 'super_admin', NULL);

-- 3. Insert Users for HDFC (tenant_id = a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11)
-- Role hierarchy: Client Admin -> Mentor -> Team Leader -> Agent
INSERT INTO users (id, tenant_id, username, password_hash, role, parent_id) VALUES
-- Client Admin
('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'hdfc_admin', '$2a$10$Qn3nI59R6Sw5OwhK/ZtpAufHMiNhniTJk50X3rviaE6DjXDh9/Mda', 'client_admin', NULL);

INSERT INTO users (id, tenant_id, username, password_hash, role, parent_id) VALUES
-- Mentor (Reporting to Client Admin)
('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'hdfc_mentor', '$2a$10$Qn3nI59R6Sw5OwhK/ZtpAufHMiNhniTJk50X3rviaE6DjXDh9/Mda', 'mentor', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');

INSERT INTO users (id, tenant_id, username, password_hash, role, parent_id) VALUES
-- Team Leader (Reporting to Mentor)
('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'hdfc_tl', '$2a$10$Qn3nI59R6Sw5OwhK/ZtpAufHMiNhniTJk50X3rviaE6DjXDh9/Mda', 'team_leader', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12');

INSERT INTO users (id, tenant_id, username, password_hash, role, parent_id) VALUES
-- Agents (Reporting to TL)
('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'hdfc_agent1', '$2a$10$Qn3nI59R6Sw5OwhK/ZtpAufHMiNhniTJk50X3rviaE6DjXDh9/Mda', 'agent', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13'),
('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a15', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'hdfc_agent2', '$2a$10$Qn3nI59R6Sw5OwhK/ZtpAufHMiNhniTJk50X3rviaE6DjXDh9/Mda', 'agent', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13');


-- 4. Insert Users for SBI (tenant_id = a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12)
INSERT INTO users (id, tenant_id, username, password_hash, role, parent_id) VALUES
-- Client Admin
('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a21', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'sbi_admin', '$2a$10$Qn3nI59R6Sw5OwhK/ZtpAufHMiNhniTJk50X3rviaE6DjXDh9/Mda', 'client_admin', NULL);

INSERT INTO users (id, tenant_id, username, password_hash, role, parent_id) VALUES
-- Mentor
('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'sbi_mentor', '$2a$10$Qn3nI59R6Sw5OwhK/ZtpAufHMiNhniTJk50X3rviaE6DjXDh9/Mda', 'mentor', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a21');

INSERT INTO users (id, tenant_id, username, password_hash, role, parent_id) VALUES
-- TL
('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a23', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'sbi_tl', '$2a$10$Qn3nI59R6Sw5OwhK/ZtpAufHMiNhniTJk50X3rviaE6DjXDh9/Mda', 'team_leader', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22');

INSERT INTO users (id, tenant_id, username, password_hash, role, parent_id) VALUES
-- Agents
('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a24', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'sbi_agent1', '$2a$10$Qn3nI59R6Sw5OwhK/ZtpAufHMiNhniTJk50X3rviaE6DjXDh9/Mda', 'agent', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a23'),
('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a25', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'sbi_agent2', '$2a$10$Qn3nI59R6Sw5OwhK/ZtpAufHMiNhniTJk50X3rviaE6DjXDh9/Mda', 'agent', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a23');


-- 5. Initialize Agent Profiles
INSERT INTO agent_profiles (user_id, current_status, current_language) VALUES
('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14', 'offline', 'English'),
('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a15', 'offline', 'Hindi'),
('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a24', 'offline', 'English'),
('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a25', 'offline', 'Hindi');


-- 6. Insert Gateways (Dinstar Gateway)
INSERT INTO gateways (id, name, ip_address, sn, total_ports) VALUES
('d0eebc99-9c0b-4ef8-bb6d-6bb9bd380b01', 'Dinstar UC2000-1', '192.168.1.186', 'DS2000-8G-AABBCCDD', 8);


-- 7. Map Dinstar Ports to Tenants
-- Ports 0, 1, 2, 3 assigned to HDFC Bank (Trunk: ClientHDFC_Trunk)
-- Ports 4, 5, 6 assigned to SBI (Trunk: ClientSBI_Trunk)
-- Port 7 remains unassigned (tenant_id = NULL)
INSERT INTO gateway_ports (gateway_id, port_number, tenant_id, mapped_trunk_name) VALUES
('d0eebc99-9c0b-4ef8-bb6d-6bb9bd380b01', 0, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'ClientHDFC_Trunk'),
('d0eebc99-9c0b-4ef8-bb6d-6bb9bd380b01', 1, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'ClientHDFC_Trunk'),
('d0eebc99-9c0b-4ef8-bb6d-6bb9bd380b01', 2, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'ClientHDFC_Trunk'),
('d0eebc99-9c0b-4ef8-bb6d-6bb9bd380b01', 3, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'ClientHDFC_Trunk'),
('d0eebc99-9c0b-4ef8-bb6d-6bb9bd380b01', 4, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'ClientSBI_Trunk'),
('d0eebc99-9c0b-4ef8-bb6d-6bb9bd380b01', 5, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'ClientSBI_Trunk'),
('d0eebc99-9c0b-4ef8-bb6d-6bb9bd380b01', 6, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'ClientSBI_Trunk'),
('d0eebc99-9c0b-4ef8-bb6d-6bb9bd380b01', 7, NULL, NULL);


-- 8. Campaigns
INSERT INTO campaigns (id, tenant_id, name, type) VALUES
('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380c11', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'HDFC Inbound Sales', 'inbound'),
('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380c12', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'HDFC Outbound Loans', 'outbound'),
('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380c21', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'SBI Inbound Support', 'inbound'),
('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380c22', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'SBI Outbound Mutual Funds', 'outbound');


-- 9. Dispositions
INSERT INTO dispositions (tenant_id, code, description, is_resolved) VALUES
('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'SALE_CLOSED', 'Product sold successfully', TRUE),
('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'FOLLOW_UP', 'Customer wants follow up call', FALSE),
('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'NOT_INTERESTED', 'Customer declined offers', TRUE),
('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'INVALID_NUMBER', 'Customer phone not in service', TRUE),
('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'SALE_CLOSED', 'SBI Mutual Fund signup completed', TRUE),
('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'CALLBACK', 'Callback required', FALSE),
('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'NOT_INTERESTED', 'Customer hung up', TRUE);
