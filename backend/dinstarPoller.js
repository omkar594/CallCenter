import axios from 'axios';
import https from 'https';
import pg from 'pg';
import dotenv from 'dotenv';
import crypto from 'crypto';
import redis from './config/redis.js';

dotenv.config();

// PostgreSQL connection setup. Redis goes through the shared config/redis.js proxy (which
// falls back to a safe no-op mock when Redis is unreachable) instead of a second raw ioredis
// client - the previous standalone client here had enableOfflineQueue:false and would throw
// an UNHANDLED rejection (crashing the whole process) whenever a gateway poll failure tried
// to reset the Redis concurrency key while Redis was also down.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const DINSTAR_IP = process.env.DINSTAR_GATEWAY_IP || '192.168.1.186';
const DINSTAR_USER = process.env.DINSTAR_API_USER || 'admin';
const DINSTAR_PASS = process.env.DINSTAR_API_PASS || 'admin';

const protocol = DINSTAR_IP.includes('127.0.0.1') || DINSTAR_IP.includes('localhost') ? 'http' : 'https';

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

/**
 * Executes a request with HTTP Digest Authentication support.
 * Automatically falls back to standard execution if no 401 challenge is returned (e.g. on simulators).
 */
async function makeDigestRequest(url, method, username, password, data = null) {
  let res;
  try {
    res = await axios({ 
      method, 
      url, 
      data, 
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
      timeout: 5000
    });
  } catch (err) {
    throw err;
  }

  if (res.status !== 401) {
    return res;
  }

  const authHeader = res.headers['www-authenticate'];
  if (!authHeader) {
    throw new Error('No WWW-Authenticate header found');
  }

  // Parse Digest headers
  const params = {};
  const regex = /(\w+)="?([^",]+)"?/g;
  let match;
  while ((match = regex.exec(authHeader)) !== null) {
    params[match[1]] = match[2];
  }

  const realm = params.realm || 'Web Server';
  const nonce = params.nonce;
  const opaque = params.opaque;
  const qop = params.qop || 'auth';
  const algorithm = params.algorithm || 'MD5';

  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';

  const parsedUrl = new URL(url);
  const uri = parsedUrl.pathname + parsedUrl.search;

  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method.toUpperCase()}:${uri}`);
  const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);

  const authVal = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", algorithm="${algorithm}", qop="${qop}", nc=${nc}, cnonce="${cnonce}", response="${response}", opaque="${opaque}"`;

  return axios({
    method,
    url,
    data,
    headers: {
      'Authorization': authVal,
      'Content-Type': 'application/json'
    },
    validateStatus: () => true,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    timeout: 5000
  });
}

/**
 * Poll Dinstar GSM ports and calculate active SIM registration count
 */
async function pollDinstarPorts() {
  console.log(`[Poller] Starting hardware poll on Dinstar Gateway at ${DINSTAR_IP}...`);
  try {
    const portParams = Array.from({ length: 32 }, (_, i) => i).join(',');
    const infoTypes = 'imei,number,reg,callstate,signal';

    const params = new URLSearchParams({
      port: portParams,
      info_type: infoTypes
    }).toString();

    const url = `${protocol}://${DINSTAR_IP}/api/get_port_info?${params}`;
    const response = await makeDigestRequest(url, 'GET', DINSTAR_USER, DINSTAR_PASS);

    if (response.data && response.data.error_code === 200) {
      const ports = response.data.info;
      let activePortsCount = 0;

      const dbClient = await pool.connect();
      try {
        await dbClient.query('BEGIN');

        for (const port of ports) {
          const isRegistered = port.reg === 'REGISTER_OK';
          if (isRegistered) activePortsCount++;

          await dbClient.query(`
            INSERT INTO gateway_port_telemetry (gateway_ip, port_number, sim_number, signal_strength, registration_status, call_state, last_polled)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (gateway_ip, port_number)
            DO UPDATE SET 
              sim_number = EXCLUDED.sim_number,
              signal_strength = EXCLUDED.signal_strength,
              registration_status = EXCLUDED.registration_status,
              call_state = EXCLUDED.call_state,
              last_polled = NOW()
          `, [DINSTAR_IP, port.port, port.number, port.signal, port.reg, port.callstate]);
        }

        await dbClient.query('COMMIT');
      } catch (err) {
        await dbClient.query('ROLLBACK');
        throw err;
      } finally {
        dbClient.release();
      }

      console.log(`[Poller] Gateways synced. Active SIMs found: ${activePortsCount} / 32`);

      await redis.set('campaign:concurrency:limit', activePortsCount);
      console.log(`[Poller] Dynamic Redis Queue Concurrency updated to: ${activePortsCount}`);

    } else {
      const errCode = response.data ? response.data.error_code : response.status;
      throw new Error(`Invalid gateway response code: ${errCode}`);
    }
  } catch (error) {
    console.error('[Poller] Failed to sync gateway port telemetry:', error.message);
    await redis.set('campaign:concurrency:limit', 0);
  }
}

// Execute polling interval every 15 seconds. Guarded the same way as bulkCampaignWorker.js
// so an old standalone `node dinstarPoller.js` launch (see README history) can't double-poll
// alongside the in-process import from server.js.
if (global.isDinstarPollerRunning) {
  console.log('[Poller] Duplicate poller start prevented (already running in this process).');
} else {
  global.isDinstarPollerRunning = true;
  setInterval(pollDinstarPorts, 15000);
  pollDinstarPorts();
}
