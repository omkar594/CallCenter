import net from 'net';
import pg from 'pg';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const AMI_HOST = process.env.ASTERISK_AMI_HOST || '127.0.0.1';
const AMI_PORT = parseInt(process.env.ASTERISK_AMI_PORT) || 5038;
const AMI_USER = process.env.ASTERISK_AMI_USER || 'ccmanager';
const AMI_PASS = process.env.ASTERISK_AMI_PASS || 'ami_secret_change_me';
const rawDelay = parseInt(process.env.PACING_BUFFER_DELAY_SEC);
const PACING_BUFFER_DELAY_SEC = (isNaN(rawDelay) || rawDelay < 12) ? 12 : rawDelay;

/**
 * Sends a raw AMI Action to Asterisk
 */
function sendAMIAction(actionPayload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: AMI_HOST, port: AMI_PORT });
    let responseData = '';
    let loginSent = false;

    socket.setTimeout(8000, () => {
      socket.destroy();
      reject(new Error(`AMI Connection Timeout connecting to ${AMI_HOST}:${AMI_PORT} (Check AWS EC2 Security Group Port 5038)`));
    });

    socket.on('connect', () => {
      let loginMsg = `Action: Login\r\nUsername: ${AMI_USER}\r\nSecret: ${AMI_PASS}\r\n\r\n`;
      socket.write(loginMsg);
    });

    socket.on('data', (chunk) => {
      responseData += chunk.toString();

      if (!loginSent && responseData.includes('Response: Success') && responseData.includes('Authentication accepted')) {
        loginSent = true;
        responseData = '';

        let actionMsg = '';
        for (const [key, val] of Object.entries(actionPayload)) {
          actionMsg += `${key}: ${val}\r\n`;
        }
        actionMsg += '\r\n';
        socket.write(actionMsg);
        return;
      }

      if (loginSent && responseData.includes('Response:')) {
        socket.end();
        resolve(responseData);
      }
    });

    socket.on('error', (err) => {
      reject(err);
    });
  });
}

// Track Round-Robin counters for campaigns with specific allowed ports
const campaignPortCounters = {};

// ----------------- Atomic Single-Query Direct DB Queue Worker -----------------
async function processNextPendingLead() {
  try {
    // Single Atomic SQL query: locks 1 lead in CTE and updates status = 'processing' safely
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

    if (result.rows.length === 0) {
      return false; // No pending leads
    }

    const lead = result.rows[0];

    // Format phone number for GSM Gateway (e.g. "+919324479120" -> "9324479120")
    let cleanPhoneNumber = String(lead.phone_number).replace(/[^0-9]/g, '');
    if (cleanPhoneNumber.startsWith('91') && cleanPhoneNumber.length === 12) {
      cleanPhoneNumber = cleanPhoneNumber.substring(2);
    }

    // Determine specific Round-Robin port if allowedPorts is specified
    const allowedPorts = lead.allowed_ports;
    let targetPort = null;
    let selectedPortText = 'All Gateway Ports (Round-Robin)';
    if (allowedPorts && allowedPorts !== 'all') {
      const portList = String(allowedPorts).split(',').map(p => p.trim()).filter(Boolean);
      if (portList.length > 0) {
        if (campaignPortCounters[lead.campaign_id] === undefined) {
          campaignPortCounters[lead.campaign_id] = 0;
        }
        const portIdx = campaignPortCounters[lead.campaign_id] % portList.length;
        targetPort = portList[portIdx];
        campaignPortCounters[lead.campaign_id]++;
        selectedPortText = `Selected Port ${targetPort} (out of restricted ports: [${portList.join(', ')}])`;
      }
    }

    console.log(`\n======================================================`);
    console.log(`[Worker] 📞 Dispatching Outbound Dial Job for Lead #${lead.lead_id}`);
    console.log(`[Worker] Original Number: ${lead.phone_number}`);
    console.log(`[Worker] Clean GSM Dial : ${cleanPhoneNumber}`);
    console.log(`[Worker] Asterisk Host  : ${AMI_HOST}:${AMI_PORT}`);
    console.log(`[Worker] Port Strategy  : 🔄 ${selectedPortText}`);
    console.log(`======================================================\n`);

    // Prepare Asterisk Channel string: Clean GSM numeric format for Dinstar Gateway
    const channelName = `PJSIP/${cleanPhoneNumber}@DinstarTrunk`;

    let audioPath = lead.audio_url || '';
    const audioFilename = path.basename(audioPath);
    if (audioPath.startsWith('/uploads/')) {
      audioPath = `/home/cell24x7/Downloads/Project/ofc/CallCenter/backend${audioPath}`;
    }
    const cleanAudioPath = audioPath.replace(/\.[^/.]+$/, "");

    try {
      const response = await sendAMIAction({
        Action: 'Originate',
        Channel: channelName,
        Context: 'campaign-broadcast-context',
        Exten: cleanPhoneNumber,
        Priority: 1,
        CallerID: 'VoiceBroadcast',
        Timeout: 60000, // 60 seconds full ringing duration
        Async: 'true',
        Variable: `CAMPAIGN_AUDIO_PATH=${cleanAudioPath},AUDIO_FILENAME=${audioFilename},LEAD_ID=${lead.lead_id},CAMP_ID=${lead.campaign_id},TARGET_PORT=${targetPort || ''}`
      });

      const singleLineResp = response.trim().replace(/\r?\n/g, ' | ');
      console.log(`[Worker] AMI Response: ${singleLineResp}`);

      if (response.includes('Response: Error')) {
        console.error(`[Worker] ❌ Asterisk Rejected Originate Channel (${channelName})`);
        await pool.query(`UPDATE campaign_leads SET dial_status = 'failed', updated_at = NOW() WHERE id = $1`, [lead.lead_id]);
      } else {
        console.log(`[Worker] ✅ Call Originate Successfully Dispatched!`);
        await pool.query(`UPDATE campaign_leads SET dial_status = 'completed', updated_at = NOW() WHERE id = $1`, [lead.lead_id]);
        await pool.query(`UPDATE voice_campaigns SET processed_leads = processed_leads + 1 WHERE id = $1`, [lead.campaign_id]);
      }

    } catch (err) {
      console.error(`[Worker] ❌ Failed to dispatch call for lead ${lead.lead_id}:`, err.message);
      await pool.query(`
        UPDATE campaign_leads SET dial_status = 'failed', updated_at = NOW() WHERE id = $1
      `, [lead.lead_id]);
    }

    // Apply Anti-Spam Carrier Pacing Delay Buffer
    if (PACING_BUFFER_DELAY_SEC > 0) {
      console.log(`[Worker] ⏳ Anti-Spam Pacing Buffer: Pausing ${PACING_BUFFER_DELAY_SEC}s to prevent SIM rate-limiting...`);
      await new Promise(r => setTimeout(r, PACING_BUFFER_DELAY_SEC * 1000));
    }

    return true; // Lead processed, check for next lead immediately
  } catch (error) {
    console.error('[Worker] Error in DB Queue Loop:', error.message || error);
    return false;
  }
}

// Continuous non-blocking Queue Loop
async function startWorkerLoop() {
  console.log('[Worker] 🚀 Single-Query Direct DB Worker started (Zero Redis mode).');
  console.log(`[Worker] Connected to Asterisk AMI at ${AMI_HOST}:${AMI_PORT}`);

  while (true) {
    const processed = await processNextPendingLead();
    if (!processed) {
      // If no pending leads in DB, sleep 2 seconds before checking DB again
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

if (global.isWorkerRunning) {
  console.log('[Worker] ⚠️ Duplicate worker start prevented. Single worker instance active.');
} else {
  global.isWorkerRunning = true;
  startWorkerLoop();
}
