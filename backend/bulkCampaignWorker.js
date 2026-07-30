import pg from 'pg';
import dotenv from 'dotenv';
import asteriskService from './services/asteriskService.js';

dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// How long to ring before giving up on a lead (Originate's Timeout, ms).
const ORIGINATE_RING_TIMEOUT_MS = parseInt(process.env.ORIGINATE_RING_TIMEOUT_MS) || 45000;
// How long to wait for Asterisk's OriginateResponse event before assuming the dial died silently.
const ORIGINATE_RESPONSE_TIMEOUT_MS = ORIGINATE_RING_TIMEOUT_MS + 20000;
// Safety cap on how long an answered call may hold its slot before we free it even without
// a Hangup event (covers a dropped/missed event - the SIM channel physically stays busy
// through ringing + the voice prompt, so this must comfortably exceed both).
const MAX_CALL_DURATION_MS = parseInt(process.env.MAX_CALL_DURATION_MS) || 5 * 60 * 1000;
// DB-level backstop for leads still stuck 'processing' after a worker crash/restart lost
// its in-memory event listeners entirely.
const STALE_LEAD_TIMEOUT_SEC = parseInt(process.env.STALE_LEAD_TIMEOUT_SEC) || 400;
// Small stagger between simultaneous dispatches within one tick, so a burst of free slots
// doesn't fire a wall of simultaneous INVITEs at the gateway. This is NOT the call-pacing
// mechanism anymore - real concurrency is gated by getMaxConcurrentCalls() below.
const DISPATCH_STAGGER_MS = (() => {
  const raw = parseInt(process.env.PACING_BUFFER_DELAY_SEC);
  return (isNaN(raw) || raw < 0 ? 2 : raw) * 1000;
})();
const POLL_INTERVAL_MS = 2000;
// Used only when gateway_port_telemetry has no live rows yet (e.g. dinstarPoller hasn't
// polled since boot) - a conservative single-call-at-a-time fallback.
const FALLBACK_MAX_CONCURRENT_CALLS = parseInt(process.env.MAX_CONCURRENT_CALLS) || 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Track Round-Robin counters for campaigns with specific allowed ports. This remains an
// informational hint only (logged + passed as a channel variable) - actual per-port SIM
// pinning is a Dinstar-gateway-side routing decision, not something this codebase controls.
const campaignPortCounters = {};

function pickPort(allowedPorts, campaignId) {
  if (!allowedPorts || allowedPorts === 'all') {
    return { targetPort: null, label: 'All Gateway Ports (Round-Robin)' };
  }
  const portList = String(allowedPorts).split(',').map(p => p.trim()).filter(Boolean);
  if (portList.length === 0) {
    return { targetPort: null, label: 'All Gateway Ports (Round-Robin)' };
  }
  if (campaignPortCounters[campaignId] === undefined) {
    campaignPortCounters[campaignId] = 0;
  }
  const idx = campaignPortCounters[campaignId] % portList.length;
  const targetPort = portList[idx];
  campaignPortCounters[campaignId]++;
  return { targetPort, label: `Selected Port ${targetPort} (out of restricted ports: [${portList.join(', ')}])` };
}

// India-only normalization, matching the SIMs this gateway currently carries. A genuine
// 12-digit non-Indian number that happens to start with "91" will be mis-stripped - extend
// this (or bring in a real phone-number library) before dialing outside India.
function normalizePhoneNumber(rawNumber) {
  const raw = String(rawNumber).trim();
  let digits = raw.replace(/[^0-9]/g, '');
  if (raw.startsWith('+91') && digits.length === 12) {
    digits = digits.substring(2);
  } else if (digits.startsWith('91') && digits.length === 12) {
    digits = digits.substring(2);
  } else if (digits.startsWith('0') && digits.length === 11) {
    digits = digits.substring(1);
  }
  return digits;
}

// Best-effort mapping of AMI OriginateResponse "Reason" codes. Exact values vary slightly
// across Asterisk versions, so unknown codes fall back to the generic 'failed' status rather
// than guessing.
function mapFailureReason(reason) {
  switch (String(reason)) {
    case '4': return 'busy';
    case '1':
    case '8': return 'no-answer';
    default: return 'failed';
  }
}

async function reapStaleLeads() {
  await pool.query(
    `UPDATE campaign_leads SET dial_status = 'failed', updated_at = NOW()
     WHERE dial_status = 'processing' AND updated_at < NOW() - ($1 || ' seconds')::interval`,
    [STALE_LEAD_TIMEOUT_SEC]
  );
}

async function getActiveProcessingCount() {
  const result = await pool.query(`SELECT COUNT(*)::int AS c FROM campaign_leads WHERE dial_status = 'processing'`);
  return result.rows[0].c;
}

// Real concurrency capacity, driven by how many SIM ports are actually registered right now
// (kept live by dinstarPoller.js). Falls back to a conservative default if telemetry is empty
// (poller not running yet, or gateway unreachable) so we never over-dial an unknown gateway.
async function getMaxConcurrentCalls() {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS registered FROM gateway_port_telemetry WHERE registration_status = 'REGISTER_OK'`
    );
    const registered = result.rows[0]?.registered || 0;
    return registered > 0 ? registered : FALLBACK_MAX_CONCURRENT_CALLS;
  } catch (err) {
    return FALLBACK_MAX_CONCURRENT_CALLS;
  }
}

async function claimNextPendingLead() {
  const result = await pool.query(`
    WITH target_lead AS (
      SELECT cl.id, cl.phone_number, cl.customer_name, cl.campaign_id, vc.audio_url, vc.allowed_ports
      FROM campaign_leads cl
      JOIN voice_campaigns vc ON cl.campaign_id = vc.id
      WHERE cl.dial_status = 'pending' AND vc.status IN ('running', 'pending')
      ORDER BY cl.updated_at ASC
      LIMIT 1
      FOR UPDATE OF cl SKIP LOCKED
    )
    UPDATE campaign_leads
    SET dial_status = 'processing', attempts = campaign_leads.attempts + 1, updated_at = NOW()
    FROM target_lead
    WHERE campaign_leads.id = target_lead.id
    RETURNING
      campaign_leads.id AS lead_id,
      target_lead.phone_number,
      target_lead.customer_name,
      target_lead.campaign_id,
      target_lead.audio_url,
      target_lead.allowed_ports;
  `);
  return result.rows[0] || null;
}

async function finalizeLead(leadId, campaignId, dialStatus, durationSec) {
  await pool.query(
    `UPDATE campaign_leads SET dial_status = $1, call_duration = $2, updated_at = NOW() WHERE id = $3`,
    [dialStatus, durationSec, leadId]
  );
  await pool.query(
    `UPDATE voice_campaigns SET processed_leads = processed_leads + 1 WHERE id = $1`,
    [campaignId]
  );
  console.log(`[Worker] Lead ${leadId} finalized: ${dialStatus} (${durationSec}s)`);
}

// Dispatches one lead and tracks it through to REAL completion via AMI events, instead of
// marking it done the instant Asterisk acknowledges the Originate request. This is the fix
// for the "2nd number never dials" bug: dial_status now stays 'processing' for the actual
// duration of the call, so the concurrency gate in tick() genuinely reflects channel busy-ness.
async function dispatchLead(lead) {
  const cleanPhoneNumber = normalizePhoneNumber(lead.phone_number);
  const { targetPort, label } = pickPort(lead.allowed_ports, lead.campaign_id);
  const channelName = `PJSIP/${cleanPhoneNumber}@DinstarTrunk`;

  console.log(`\n[Worker] Dispatching lead ${lead.lead_id} -> ${cleanPhoneNumber} | Port strategy: ${label}`);

  const { actionId, ackPromise } = asteriskService.originateAsync(
    channelName,
    cleanPhoneNumber,
    'campaign-broadcast-context',
    1,
    {
      CAMPAIGN_AUDIO_FILE: lead.audio_url || '',
      LEAD_ID: lead.lead_id,
      CAMP_ID: lead.campaign_id,
      TARGET_PORT: targetPort || ''
    },
    'VoiceBroadcast',
    ORIGINATE_RING_TIMEOUT_MS
  );

  let ack;
  try {
    ack = await ackPromise;
  } catch (err) {
    console.error(`[Worker] AMI rejected dispatch for lead ${lead.lead_id}: ${err.message}`);
    await finalizeLead(lead.lead_id, lead.campaign_id, 'failed', 0);
    return;
  }

  if (ack.Response !== 'Success') {
    console.error(`[Worker] Asterisk rejected Originate for lead ${lead.lead_id}: ${ack.Message}`);
    await finalizeLead(lead.lead_id, lead.campaign_id, 'failed', 0);
    return;
  }

  const dispatchedAt = Date.now();
  const originateResponse = await asteriskService.waitForEvent(
    'OriginateResponse',
    (evt) => evt.ActionID === actionId,
    ORIGINATE_RESPONSE_TIMEOUT_MS
  );

  if (!originateResponse) {
    console.warn(`[Worker] Lead ${lead.lead_id}: no OriginateResponse within ${ORIGINATE_RESPONSE_TIMEOUT_MS}ms - treating as failed and freeing the slot`);
    await finalizeLead(lead.lead_id, lead.campaign_id, 'failed', Math.round((Date.now() - dispatchedAt) / 1000));
    return;
  }

  if (originateResponse.Response !== 'Success') {
    const status = mapFailureReason(originateResponse.Reason);
    console.log(`[Worker] Lead ${lead.lead_id}: call did not connect (${status}, reason=${originateResponse.Reason})`);
    await finalizeLead(lead.lead_id, lead.campaign_id, status, Math.round((Date.now() - dispatchedAt) / 1000));
    return;
  }

  // Call connected - the SIM channel stays genuinely busy through ringing + prompt playback,
  // so keep this lead 'processing' (holding a concurrency slot) until the real Hangup.
  const uniqueid = originateResponse.Uniqueid;
  const hangupEvent = uniqueid
    ? await asteriskService.waitForEvent('Hangup', (evt) => evt.Uniqueid === uniqueid, MAX_CALL_DURATION_MS)
    : null;

  if (!hangupEvent) {
    console.warn(`[Worker] Lead ${lead.lead_id}: answered but no Hangup event within ${MAX_CALL_DURATION_MS}ms - freeing the slot anyway`);
  }

  const durationSec = Math.round((Date.now() - dispatchedAt) / 1000);
  await finalizeLead(lead.lead_id, lead.campaign_id, 'answered', durationSec);
}

async function tick() {
  if (!asteriskService.isConnected) {
    return; // AMI connects during server startup; skip until it's up rather than burning leads
  }

  await reapStaleLeads();

  const [activeCount, maxConcurrent] = await Promise.all([getActiveProcessingCount(), getMaxConcurrentCalls()]);
  let freeSlots = maxConcurrent - activeCount;

  while (freeSlots > 0) {
    const lead = await claimNextPendingLead();
    if (!lead) break;

    // Fire-and-forget: dispatchLead tracks the call to completion asynchronously via AMI
    // events and does not block this loop, so free slots can keep filling up.
    dispatchLead(lead).catch((err) => {
      console.error(`[Worker] Unhandled error dispatching lead ${lead.lead_id}:`, err.message || err);
    });

    freeSlots--;
    if (freeSlots > 0 && DISPATCH_STAGGER_MS > 0) {
      await sleep(DISPATCH_STAGGER_MS);
    }
  }
}

async function startWorkerLoop() {
  console.log('[Worker] Event-driven campaign dialer started.');
  console.log(`[Worker] Asterisk AMI target: ${process.env.ASTERISK_AMI_HOST || '(default)'}:${process.env.ASTERISK_AMI_PORT || 5038}`);

  while (true) {
    try {
      await tick();
    } catch (error) {
      console.error('[Worker] Error in dialer tick:', error.message || error);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// Postgres session-level advisory lock: guards against two backend processes (e.g. a stray
// manually-launched `node bulkCampaignWorker.js`, or two Render instances) both dialing off
// the same table at once. The lock is held for the process lifetime via a dedicated client
// that is never released back to the pool; Postgres frees it automatically if the process dies.
// Bumped from 727511: an orphaned process from an earlier broken two-process deployment
// (before the Start Command was fixed to run a single process) never released the old key,
// permanently blocking every subsequent deploy's worker from ever acquiring it. A fresh key
// means this deploy's worker doesn't contend with that zombie at all - the orphan can only
// ever hold the old key, which nothing else needs anymore.
const WORKER_LOCK_KEY = 727512;

async function acquireSingletonLock() {
  const client = await pool.connect();
  const result = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [WORKER_LOCK_KEY]);
  if (!result.rows[0].locked) {
    client.release();
    return null;
  }
  return client;
}

if (global.isWorkerRunning) {
  console.log('[Worker] Duplicate worker start prevented (already running in this process).');
} else {
  global.isWorkerRunning = true;
  (async () => {
    const lockClient = await acquireSingletonLock();
    if (!lockClient) {
      console.warn('[Worker] Another process already holds the campaign dialer lock - not starting a second dialer.');
      return;
    }
    console.log('[Worker] Acquired singleton dialer lock.');
    startWorkerLoop();
  })();
}
