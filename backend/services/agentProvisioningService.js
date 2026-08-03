import crypto from 'crypto';
import pool from '../config/database.js';

// Provisions (or re-provisions) the Asterisk Realtime rows an agent's WebRTC softphone needs to
// register - see telephony_config/sorcery.conf + res_pgsql.conf, which point res_pjsip's
// endpoint/auth/aor lookups at these same tables on the EC2 box. Idempotent: safe to call on
// every login/credential-fetch, not just once at agent creation, so password rotation or a
// retried partial failure never leaves stale/duplicate rows behind.
//
// Endpoint id, auth id, and aor id are all just the agent's own users.id (as text) - one agent,
// one softphone identity, matching how routingService/callController already assume
// `PJSIP/${agentId}` exists as a channel target.
export async function provisionAgentSipEndpoint(agentId) {
  const secret = crypto.randomBytes(16).toString('hex');

  await pool.query(
    `INSERT INTO ps_aors (id, max_contacts, remove_existing)
     VALUES ($1, 1, 'yes')
     ON CONFLICT (id) DO NOTHING`,
    [agentId]
  );

  await pool.query(
    `INSERT INTO ps_auths (id, auth_type, username, password)
     VALUES ($1, 'userpass', $1, $2)
     ON CONFLICT (id) DO UPDATE SET password = EXCLUDED.password`,
    [agentId, secret]
  );

  await pool.query(
    `INSERT INTO ps_endpoints (id, aors, auth)
     VALUES ($1, $1, $1)
     ON CONFLICT (id) DO NOTHING`,
    [agentId]
  );

  await pool.query(
    `UPDATE agent_profiles SET sip_secret = $2 WHERE user_id = $1`,
    [agentId, secret]
  );

  return { sipUsername: agentId, sipPassword: secret };
}

// Returns existing credentials without generating a new secret (which would break an
// already-registered softphone), provisioning for the first time only if none exist yet -
// covers pre-existing seed.sql agents created before this feature existed.
export async function getOrProvisionAgentSipCredentials(agentId) {
  const existing = await pool.query(
    `SELECT sip_secret FROM agent_profiles WHERE user_id = $1`,
    [agentId]
  );

  if (existing.rows.length > 0 && existing.rows[0].sip_secret) {
    return { sipUsername: agentId, sipPassword: existing.rows[0].sip_secret };
  }

  return provisionAgentSipEndpoint(agentId);
}
