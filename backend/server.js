import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Import configs & services
import pool from './config/database.js';
import redis from './config/redis.js';
import asteriskService from './services/asteriskService.js';
import spamService from './services/spamService.js';
import routingService from './services/routingService.js';
import { executeTenantQuery } from './config/database.js';

// Import routes
import authRoutes from './routes/auth.js';
import gatewayRoutes from './routes/gateway.js';
import campaignRoutes from './routes/campaign.js';
import callRoutes from './routes/call.js';
import analyticsRoutes from './routes/analytics.js';

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Expose Socket.io globally for real-time escalations
global.io = io;

// Ensure upload static directories exist on server boot
const uploadsDir = path.resolve(process.cwd(), 'uploads');
const tempUploadsDir = path.resolve(process.cwd(), 'uploads', 'temp');
const audioUploadsDir = path.resolve(process.cwd(), 'uploads', 'campaign_audio');

[uploadsDir, tempUploadsDir, audioUploadsDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {}
  }
});

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadsDir));

// Mount API routes
app.use('/api/auth', authRoutes);
app.use('/api/gateways', gatewayRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/analytics', analyticsRoutes);

/**
 * Endpoint for Asterisk to verify inbound caller details and initiate ACD routing.
 * Triggers when Dinstar pushes calls to Asterisk.
 * 
 * Route: POST /api/voice/incoming-filter
 */
app.post('/api/voice/incoming-filter', async (req, res) => {
  const { callerNumber, trunkName } = req.body;

  if (!callerNumber || !trunkName) {
    return res.status(400).json({ error: 'callerNumber and trunkName are required' });
  }

  console.log(`[Incoming Call] Received CLI: ${callerNumber} on Trunk: ${trunkName}`);

  try {
    // 1. Spam check
    const isSpam = await spamService.checkIsSpam(callerNumber);
    if (isSpam) {
      console.log(`[Incoming Call] Rejecting spam call from ${callerNumber}`);
      return res.json({ action: 'reject', reason: 'Spam number detected' });
    }

    // 2. Identify Tenant associated with this trunk line
    const portResult = await executeTenantQuery(null, `
      SELECT tenant_id FROM gateway_ports WHERE mapped_trunk_name = $1 LIMIT 1
    `, [trunkName]);

    if (portResult.rows.length === 0 || !portResult.rows[0].tenant_id) {
      console.warn(`[Incoming Call] Trunk ${trunkName} is not allocated to any tenant. Hanging up.`);
      return res.json({ action: 'reject', reason: 'Trunk not configured' });
    }

    const tenantId = portResult.rows[0].tenant_id;

    // 3. Create call log entry (inbound, queued state)
    const callResult = await executeTenantQuery(tenantId, `
      INSERT INTO calls (tenant_id, caller_number, callee_number, direction, status)
      VALUES ($1, $2, 'InboundHotline', 'inbound', 'queued')
      RETURNING id
    `, [tenantId, callerNumber]);

    const callId = callResult.rows[0].id;

    // 4. Trigger ACD Agent Routing in background (longest idle agent)
    // Non-blocking response to Asterisk: tell it to send the call to hold queue while we route
    routingService.routeCallToAgent(tenantId, callId, callerNumber).catch(err => {
      console.error('[ACD] Background routing failed:', err);
    });

    res.json({
      action: 'queue',
      callId: callId,
      message: 'Call accepted and routed to ACD queue'
    });

  } catch (error) {
    console.error('incoming-filter failed:', error);
    res.status(500).json({ error: 'Internal server error handling inbound call' });
  }
});

// Webhook for Asterisk dialplan to report voice campaign call status updates
app.get('/api/campaigns/callback', async (req, res) => {
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
});

// App health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date(),
    connections: {
      postgres: pool ? 'connected' : 'disconnected',
      redis: redis ? 'connected' : 'disconnected',
      asterisk_ami: asteriskService.isConnected ? 'connected' : 'disconnected'
    }
  });
});

// Socket.io connection logic for real-time dashboard events
io.on('connection', (socket) => {
  console.log(`Socket client connected: ${socket.id}`);

  // Room subscription based on userId for targeted supervisor escalations
  socket.on('subscribe', (userId) => {
    socket.join(userId);
    console.log(`Socket ${socket.id} subscribed to room: ${userId}`);
  });

  socket.on('disconnect', () => {
    console.log(`Socket client disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, async () => {
  console.log(`Contact Center Server running on port ${PORT}`);
  
  // Connect to Asterisk AMI Socket
  await asteriskService.connect();
});
