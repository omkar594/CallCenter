import { executeTenantQuery } from '../config/database.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { transcodeCampaignAudio } from '../services/audioTranscoder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  const { name, allowedPorts, phoneNumbers, audioBase64, audioUrl, audioPath } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Campaign name is required' });
  }

  // Audio prompt input check (Supports file upload OR Base64 JSON OR existing audioUrl/audioPath)
  const audioFile = req.files?.broadcastAudio?.[0] || req.files?.audioFile?.[0] || req.files?.audio?.[0] || req.files?.file?.[0] || null;

  if (!audioFile && !audioBase64 && !audioUrl && !audioPath) {
    return res.status(400).json({ 
      error: 'Audio prompt is required. Pass audioFile / broadcastAudio file OR audioBase64 string OR audioUrl in JSON' 
    });
  }

  const csvFile = req.files?.leadsCsv?.[0] || req.files?.csv?.[0] || null;

  // Extract phone numbers from CSV file OR manual phoneNumbers input
  const leads = [];

  if (csvFile) {
    const csvContent = fs.readFileSync(csvFile.path, 'utf8');
    const lines = csvContent.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const parts = line.split(',');
      const num = parts[0]?.trim();
      const nameVal = parts[1]?.trim() || 'Valued Customer';
      if (num) leads.push({ phoneNumber: num, customerName: nameVal });
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

  try {
    // Prepare directory paths for transcoded voice prompts
    const targetDir = path.resolve(process.cwd(), 'uploads', 'campaign_audio');
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const outputFilename = `${Date.now()}_transcoded.wav`;
    const outputPath = path.join(targetDir, outputFilename);
    let finalAudioUrl = `/uploads/campaign_audio/${outputFilename}`;

    // Handle Audio Source:
    if (audioFile) {
      // 1. Multipart File Upload
      await transcodeCampaignAudio(audioFile.path, outputPath);
    } else if (audioBase64) {
      // 2. Pure JSON Base64 Audio String
      const tempInputPath = path.join(targetDir, `temp_${Date.now()}.mp3`);
      const base64Data = audioBase64.replace(/^data:audio\/\w+;base64,/, '');
      fs.writeFileSync(tempInputPath, Buffer.from(base64Data, 'base64'));
      await transcodeCampaignAudio(tempInputPath, outputPath);
      try { if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath); } catch (e) {}
    } else if (audioUrl || audioPath) {
      // 3. Existing Audio File Path/URL
      const srcPath = audioUrl || audioPath;
      if (fs.existsSync(srcPath)) {
        await transcodeCampaignAudio(srcPath, outputPath);
      } else {
        finalAudioUrl = srcPath;
      }
    }

    const defaultTenantId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

    // Insert Campaign Master Record with fallback if tenant_id column missing
    let campaignResult;
    try {
      campaignResult = await executeTenantQuery(null, `
        INSERT INTO voice_campaigns (tenant_id, name, audio_url, status, allowed_ports, total_leads)
        VALUES ($1, $2, $3, 'running', $4, $5)
        RETURNING *
      `, [defaultTenantId, name, finalAudioUrl, parsedPorts, leads.length]);
    } catch (err) {
      if (err.message.includes('tenant_id')) {
        campaignResult = await executeTenantQuery(null, `
          INSERT INTO voice_campaigns (name, audio_url, status, allowed_ports, total_leads)
          VALUES ($1, $2, 'running', $3, $4)
          RETURNING *
        `, [name, finalAudioUrl, parsedPorts, leads.length]);
      } else {
        throw err;
      }
    }

    const campaign = campaignResult.rows[0];

    // Save Leads to DB (Worker will pick them up directly from PostgreSQL table)
    let totalLeadsCount = 0;
    for (const lead of leads) {
      await executeTenantQuery(null, `
        INSERT INTO campaign_leads (campaign_id, phone_number, customer_name, dial_status)
        VALUES ($1, $2, $3, 'pending')
      `, [campaign.id, lead.phoneNumber, lead.customerName]);
      totalLeadsCount++;
    }

    // Clean up temporary uploads
    try {
      if (csvFile && fs.existsSync(csvFile.path)) fs.unlinkSync(csvFile.path);
      if (audioFile && fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
    } catch (err) {
      console.warn('[CampaignController] Failed to delete temp upload files:', err);
    }

    res.status(201).json({
      message: 'Outbound campaign initiated successfully',
      campaignId: campaign.id,
      name: campaign.name,
      totalLeads: totalLeadsCount,
      allowedPorts: parsedPorts,
      status: 'running'
    });

  } catch (error) {
    console.error('[CampaignController] Error initiating voice broadcast:', error);
    res.status(500).json({ error: `Campaign initiation failed: ${error.message}` });
  }
}
