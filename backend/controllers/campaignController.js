import { executeTenantQuery } from '../config/database.js';
import pool from '../config/database.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parse as parseCsv } from 'csv-parse/sync';
import { transcodeCampaignAudio } from '../services/audioTranscoder.js';
import { deliverCampaignAudio } from '../services/audioDeliveryService.js';

const PHONE_HEADER_ALIASES = ['phone', 'phone_number', 'phonenumber', 'number', 'mobile', 'msisdn'];
const NAME_HEADER_ALIASES = ['name', 'customer_name', 'customername', 'full_name'];

// Parses a lead CSV using its header row (quote/escape-aware), instead of assuming
// column position, so "name,phone" and "phone,name" files both work correctly.
function parseLeadsCsv(csvContent) {
  const records = parseCsv(csvContent, {
    columns: (header) => header.map(h => h.trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true
  });

  const leads = [];
  for (const record of records) {
    const phoneKey = PHONE_HEADER_ALIASES.find(k => record[k]);
    const nameKey = NAME_HEADER_ALIASES.find(k => record[k]);
    const phoneNumber = phoneKey ? String(record[phoneKey]).trim() : '';
    if (!phoneNumber) continue;
    leads.push({
      phoneNumber,
      customerName: nameKey ? String(record[nameKey]).trim() : 'Valued Customer'
    });
  }
  return leads;
}

// Webhook for Asterisk dialplan to report voice campaign call status updates.
// Moved here (and mounted before '/:id' in routes/campaign.js) to fix a route-shadowing
// bug where Express matched this as GET /api/campaigns/:id with id='callback'.
export async function handleCampaignCallback(req, res) {
  const { leadId, status, duration } = req.query;

  if (!leadId || !status) {
    return res.status(400).send('Missing leadId or status');
  }

  try {
    await pool.query(`
      UPDATE campaign_leads
      SET dial_status = $1, call_duration = $2, updated_at = NOW()
      WHERE id = $3
    `, [status, parseInt(duration) || 0, leadId]);

    console.log(`[Campaign Callback] Lead ID: ${leadId} status updated to: ${status}`);
    res.send('OK');
  } catch (error) {
    console.error('[Campaign Callback] Database update failed:', error.message);
    res.status(500).send(error.message);
  }
}

// 1. Get list of all campaigns with progress metrics
export async function getCampaigns(req, res) {
  try {
    const result = await executeTenantQuery(null, `
      SELECT 
        vc.id,
        vc.name,
        vc.audio_url,
        vc.status,
        vc.allowed_ports,
        vc.total_leads,
        vc.processed_leads,
        vc.created_at,
        COUNT(CASE WHEN cl.dial_status = 'answered' THEN 1 END) AS answered_count,
        COUNT(CASE WHEN cl.dial_status = 'busy' THEN 1 END) AS busy_count,
        COUNT(CASE WHEN cl.dial_status = 'no-answer' THEN 1 END) AS no_answer_count,
        COUNT(CASE WHEN cl.dial_status = 'failed' THEN 1 END) AS failed_count,
        COUNT(CASE WHEN cl.dial_status = 'processing' THEN 1 END) AS processing_count,
        COUNT(CASE WHEN cl.dial_status = 'pending' THEN 1 END) AS pending_count
      FROM voice_campaigns vc
      LEFT JOIN campaign_leads cl ON vc.id = cl.campaign_id
      GROUP BY vc.id
      ORDER BY vc.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('[CampaignController] getCampaigns failed:', error);
    res.status(500).json({ error: 'Failed to retrieve campaigns' });
  }
}

// 2. Get detailed campaign status report (Connected vs Failed breakdown)
export async function getCampaignReport(req, res) {
  const { id } = req.params;
  try {
    const campaignResult = await executeTenantQuery(null, `
      SELECT * FROM voice_campaigns WHERE id = $1
    `, [id]);

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignResult.rows[0];

    const leadsResult = await executeTenantQuery(null, `
      SELECT id, phone_number, customer_name, dial_status, attempts, call_duration, updated_at
      FROM campaign_leads
      WHERE campaign_id = $1
      ORDER BY updated_at DESC
    `, [id]);

    const leads = leadsResult.rows;
    const metrics = {
      total: leads.length,
      answered: leads.filter(l => l.dial_status === 'answered').length,
      busy: leads.filter(l => l.dial_status === 'busy').length,
      noAnswer: leads.filter(l => l.dial_status === 'no-answer').length,
      failed: leads.filter(l => l.dial_status === 'failed').length,
      processing: leads.filter(l => l.dial_status === 'processing').length,
      pending: leads.filter(l => l.dial_status === 'pending').length
    };

    res.json({
      campaign,
      metrics,
      leads
    });
  } catch (error) {
    console.error('[CampaignController] getCampaignReport failed:', error);
    res.status(500).json({ error: 'Failed to fetch campaign report' });
  }
}

// 3. Initiate Bulk Outbound Voice Broadcast (Supports JSON payloads OR Multipart Form-Data)
export async function createBroadcastCampaign(req, res) {
  const { name, allowedPorts, phoneNumbers, audioBase64 } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Campaign name is required' });
  }

  // Audio prompt input check (Supports file upload OR Base64 JSON).
  // Note: an earlier "audioUrl"/"audioPath" option that fed an unauthenticated client-supplied
  // filesystem path straight into ffmpeg (arbitrary local file read) was removed - see plan Workstream 1.
  const audioFile = req.files?.broadcastAudio?.[0] || req.files?.audioFile?.[0] || req.files?.audio?.[0] || req.files?.file?.[0] || null;

  if (!audioFile && !audioBase64) {
    return res.status(400).json({
      error: 'Audio prompt is required. Pass audioFile / broadcastAudio file OR audioBase64 string'
    });
  }

  const csvFile = req.files?.leadsCsv?.[0] || req.files?.csv?.[0] || null;

  // Extract phone numbers from CSV file OR manual phoneNumbers input
  let leads = [];

  if (csvFile) {
    const csvContent = fs.readFileSync(csvFile.path, 'utf8');
    try {
      leads = parseLeadsCsv(csvContent);
    } catch (err) {
      return res.status(400).json({ error: `Invalid CSV file: ${err.message}` });
    }
  }

  if (phoneNumbers) {
    let rawNumbers = [];
    if (Array.isArray(phoneNumbers)) {
      rawNumbers = phoneNumbers;
    } else if (typeof phoneNumbers === 'string') {
      try {
        const parsed = JSON.parse(phoneNumbers);
        rawNumbers = Array.isArray(parsed) ? parsed : phoneNumbers.split(/[\n,]+/);
      } catch (e) {
        rawNumbers = phoneNumbers.split(/[\n,]+/);
      }
    }

    for (const num of rawNumbers) {
      const cleanNum = String(num).trim();
      if (cleanNum && !leads.some(l => l.phoneNumber === cleanNum)) {
        leads.push({ phoneNumber: cleanNum, customerName: 'Contact' });
      }
    }
  }

  if (leads.length === 0) {
    return res.status(400).json({ error: 'No valid target phone numbers provided (upload leadsCsv or pass phoneNumbers in JSON)' });
  }

  // Parse allowed ports string/array (e.g. [0, 1] or "0,1")
  let parsedPorts = 'all';
  if (allowedPorts) {
    try {
      const p = typeof allowedPorts === 'string' ? JSON.parse(allowedPorts) : allowedPorts;
      if (Array.isArray(p) && p.length > 0) {
        parsedPorts = p.map(Number).join(',');
      }
    } catch (e) {
      parsedPorts = String(allowedPorts);
    }
  }

  let tempInputPath = null;

  try {
    // Prepare directory paths for transcoded voice prompts (using OS tmpdir guaranteed to be writable on cloud hosts like Render)
    const targetDir = path.join(os.tmpdir(), 'campaign_audio');
    try {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
    } catch (err) {
      console.warn('[CampaignController] Storage directory creation notice:', err.message);
    }

    const outputFilename = `${Date.now()}_transcoded.wav`;
    const outputPath = path.join(targetDir, outputFilename);

    // Handle Audio Source, then push the transcoded prompt to the Asterisk box itself -
    // it must live where Playback() can find it, not just in Render's ephemeral /tmp.
    if (audioFile) {
      await transcodeCampaignAudio(audioFile.path, outputPath);
    } else {
      tempInputPath = path.join(targetDir, `temp_${Date.now()}.mp3`);
      const base64Data = audioBase64.replace(/^data:audio\/\w+;base64,/, '');
      fs.writeFileSync(tempInputPath, Buffer.from(base64Data, 'base64'));
      await transcodeCampaignAudio(tempInputPath, outputPath);
    }

    // audioFilename is the extension-less basename Asterisk's Playback() expects,
    // once the file has actually landed in its sounds directory over SFTP.
    const audioFilename = await deliverCampaignAudio(outputPath);
    try { fs.unlinkSync(outputPath); } catch (e) {}

    const defaultTenantId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

    // Insert Campaign Master Record with fallback if tenant_id column missing
    let campaignResult;
    try {
      campaignResult = await executeTenantQuery(null, `
        INSERT INTO voice_campaigns (tenant_id, name, audio_url, status, allowed_ports, total_leads)
        VALUES ($1, $2, $3, 'running', $4, $5)
        RETURNING *
      `, [defaultTenantId, name, audioFilename, parsedPorts, leads.length]);
    } catch (err) {
      if (err.message.includes('tenant_id')) {
        campaignResult = await executeTenantQuery(null, `
          INSERT INTO voice_campaigns (name, audio_url, status, allowed_ports, total_leads)
          VALUES ($1, $2, 'running', $3, $4)
          RETURNING *
        `, [name, audioFilename, parsedPorts, leads.length]);
      } else {
        throw err;
      }
    }

    const campaign = campaignResult.rows[0];

    // Save all leads in a single multi-row INSERT (one round-trip, one transaction) instead
    // of one INSERT per lead - matters once CSVs run into the thousands of rows.
    const valuesSql = leads.map((_, i) => {
      // Each lead contributes exactly 2 params (phone, name) on top of the shared $1
      // campaign_id - this was previously stride-3, which skipped a placeholder number
      // for every lead after the first and left it unreferenced anywhere in the query
      // text, hence Postgres's "could not determine data type of parameter" error.
      const base = i * 2;
      return `($1, $${base + 2}, $${base + 3}, 'pending')`;
    }).join(', ');
    const insertParams = [campaign.id];
    for (const lead of leads) {
      insertParams.push(lead.phoneNumber, lead.customerName);
    }
    await executeTenantQuery(null, `
      INSERT INTO campaign_leads (campaign_id, phone_number, customer_name, dial_status)
      VALUES ${valuesSql}
    `, insertParams);

    res.status(201).json({
      message: 'Outbound campaign initiated successfully',
      campaignId: campaign.id,
      name: campaign.name,
      totalLeads: leads.length,
      allowedPorts: parsedPorts,
      status: 'running'
    });

  } catch (error) {
    console.error('[CampaignController] Error initiating voice broadcast:', error);
    res.status(500).json({ error: `Campaign initiation failed: ${error.message}` });
  } finally {
    // Always clean up temp uploads, including on the error path (previously these leaked on any throw).
    try { if (tempInputPath && fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath); } catch (e) {}
    try { if (csvFile && fs.existsSync(csvFile.path)) fs.unlinkSync(csvFile.path); } catch (e) {}
    try { if (audioFile && fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path); } catch (e) {}
  }
}
