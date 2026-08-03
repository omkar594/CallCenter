import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { executeTenantQuery } from '../config/database.js';
import { syncAgentQueueMembership } from '../services/queueMembershipService.js';
import { getOrProvisionAgentSipCredentials } from '../services/agentProvisioningService.js';

const DEFAULT_TENANT_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

export async function login(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    // Look up user globally (Super Admin check requires no tenant ID filtering at query start)
    const userResult = await executeTenantQuery(null, `
      SELECT u.id, u.username, u.password_hash, u.role, u.tenant_id, u.parent_id, u.status, t.name as tenant_name 
      FROM users u
      LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE u.username = $1
    `, [username]);

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = userResult.rows[0];

    if (user.status !== 'active') {
      return res.status(403).json({ error: 'This user account is inactive' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Update agent status to 'login' in database (if user is an agent)
    if (user.role === 'agent') {
      await executeTenantQuery(user.tenant_id, `
        INSERT INTO agent_profiles (user_id, current_status, last_status_change)
        VALUES ($1, 'login', NOW())
        ON CONFLICT (user_id) DO UPDATE SET current_status = 'login', last_status_change = NOW()
      `, [user.id]);
      // 'login' is not 'idle' - not eligible for the campaign_agents queue yet until they
      // explicitly go ready (POST /api/calls/ready).
      syncAgentQueueMembership(user.id, 'login').catch(() => {});
    }

    // Generate JWT token containing roles, parent report hierarchy and tenant mapping
    const token = jwt.sign(
      {
        id: user.id,
        tenant_id: user.tenant_id,
        username: user.username,
        role: user.role,
        parent_id: user.parent_id
      },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        tenant_id: user.tenant_id,
        tenant_name: user.tenant_name
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error during login' });
  }
}

export async function logout(req, res) {
  const { id, role, tenant_id } = req.user;
  
  try {
    if (role === 'agent') {
      // Set agent profile status to offline
      await executeTenantQuery(tenant_id, `
        UPDATE agent_profiles SET current_status = 'offline', last_status_change = NOW() WHERE user_id = $1
      `, [id]);
      syncAgentQueueMembership(id, 'offline').catch(() => {});
    }
    
    res.json({ message: 'Logout successful' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error during logout' });
  }
}

// Workstream 7: there was previously no endpoint anywhere in this codebase that creates an
// agent - only database/seed.sql inserted demo users directly. Admin/TL-gated; creates the
// users + agent_profiles rows (agent starts 'offline', matching every other new-agent state)
// and provisions their SIP endpoint so a softphone can register immediately.
export async function createAgent(req, res) {
  const { username, password, parentId } = req.body;
  const tenantId = req.user?.tenant_id || DEFAULT_TENANT_ID;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    const userResult = await executeTenantQuery(tenantId, `
      INSERT INTO users (tenant_id, username, password_hash, role, parent_id)
      VALUES ($1, $2, $3, 'agent', $4)
      RETURNING id, username, role, tenant_id
    `, [tenantId, username, passwordHash, parentId || null]);

    const agent = userResult.rows[0];

    await executeTenantQuery(tenantId, `
      INSERT INTO agent_profiles (user_id, current_status)
      VALUES ($1, 'offline')
      ON CONFLICT (user_id) DO NOTHING
    `, [agent.id]);

    const credentials = await getOrProvisionAgentSipCredentials(agent.id);

    res.status(201).json({
      message: 'Agent created successfully',
      agent,
      sip: credentials
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Username already exists' });
    }
    console.error('createAgent failed:', error);
    res.status(500).json({ error: 'Failed to create agent' });
  }
}

// Workstream 7: lets the agent softphone (frontend_component/agent_softphone/) fetch its own
// SIP registration credentials right after JWT login, without ever exposing them anywhere
// except this authenticated call. Lazily provisions on first call so pre-existing seed.sql
// agents (created before this feature existed) work without a manual migration step.
export async function getMySipCredentials(req, res) {
  const agentId = req.user.id;

  if (req.user.role !== 'agent') {
    return res.status(403).json({ error: 'Only agents have SIP softphone credentials' });
  }

  try {
    const { sipUsername, sipPassword } = await getOrProvisionAgentSipCredentials(agentId);
    const wssUrl = process.env.ASTERISK_WSS_URL
      || `wss://${process.env.ASTERISK_AMI_HOST || '127.0.0.1'}:8089/ws`;

    res.json({ sipUsername, sipPassword, wssUrl });
  } catch (error) {
    console.error('getMySipCredentials failed:', error);
    res.status(500).json({ error: 'Failed to fetch SIP credentials' });
  }
}
