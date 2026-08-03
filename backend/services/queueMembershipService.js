import asteriskService from './asteriskService.js';
import { executeTenantQuery } from '../config/database.js';

const QUEUE_NAME = process.env.CAMPAIGN_AGENT_QUEUE || 'campaign_agents';

// Keeps the Asterisk `campaign_agents` queue's live membership in sync with
// agent_profiles.current_status, so Queue() in the campaign dialplan (Workstream 7) always
// rings whoever Postgres currently considers idle. Postgres stays the single source of truth;
// Asterisk's queue membership is just a mirror of it, rebuilt on every AMI reconnect (see
// resyncAllIdleAgents below) rather than persisted independently in Asterisk's own AstDB
// (queues.conf sets persistentmembers=no for exactly this reason).
//
// Callers must never let a sync failure fail the HTTP request it's attached to - this is why
// every call site wraps this in try/catch, and why this function itself never rethrows.
export async function syncAgentQueueMembership(agentId, newStatus) {
  try {
    const interfaceName = `PJSIP/${agentId}`;
    if (newStatus === 'idle') {
      await asteriskService.queueAdd(QUEUE_NAME, interfaceName, { MemberName: agentId });
    } else {
      await asteriskService.queueRemove(QUEUE_NAME, interfaceName);
    }
  } catch (err) {
    // "already a member" / "not found" AMI errors are expected here and harmless - queue
    // membership is treated as idempotent. If AMI isn't connected at all yet, this agent just
    // gets picked up by resyncAllIdleAgents() on the next successful connect instead.
    console.warn(`[QueueMembership] sync failed for agent ${agentId} -> ${newStatus}: ${err.message}`);
  }
}

// Re-adds every currently-idle agent to the queue. Call this once per AMI 'ami_ready' event
// (fresh connect, or reconnect after an Asterisk restart) so a restarted PBX - which comes back
// with an empty queue - converges back to whatever Postgres says right away, instead of staying
// empty until each agent's next unrelated status change.
export async function resyncAllIdleAgents() {
  try {
    const result = await executeTenantQuery(null, `SELECT user_id FROM agent_profiles WHERE current_status = 'idle'`);
    for (const row of result.rows) {
      await syncAgentQueueMembership(row.user_id, 'idle');
    }
    console.log(`[QueueMembership] Resynced ${result.rows.length} idle agent(s) into '${QUEUE_NAME}'.`);
  } catch (err) {
    console.warn('[QueueMembership] resyncAllIdleAgents failed:', err.message);
  }
}
