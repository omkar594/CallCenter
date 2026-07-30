import axios from 'axios';
import https from 'https';
import crypto from 'crypto';

class DinstarService {
  constructor(gatewayIp, username, password) {
    this.gatewayIp = gatewayIp;
    this.username = username;
    this.password = password;
    this.protocol = gatewayIp.includes('127.0.0.1') || gatewayIp.includes('localhost') ? 'http' : 'https';
  }

  _md5(str) {
    return crypto.createHash('md5').update(str).digest('hex');
  }

  /**
   * Helper to execute API requests with HTTP Digest Authentication
   */
  async _request(endpoint, method, data = null) {
    const url = `${this.protocol}://${this.gatewayIp}/api${endpoint}`;
    
    let res;
    try {
      res = await axios({
        method,
        url,
        data: method.toUpperCase() === 'POST' ? data : null,
        params: method.toUpperCase() === 'GET' ? data : null,
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

    const ha1 = this._md5(`${this.username}:${realm}:${this.password}`);
    const ha2 = this._md5(`${method.toUpperCase()}:${uri}`);
    const response = this._md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);

    const authVal = `Digest username="${this.username}", realm="${realm}", nonce="${nonce}", uri="${uri}", algorithm="${algorithm}", qop="${qop}", nc=${nc}, cnonce="${cnonce}", response="${response}", opaque="${opaque}"`;

    return axios({
      method,
      url,
      data: method.toUpperCase() === 'POST' ? data : null,
      params: method.toUpperCase() === 'GET' ? data : null,
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
   * Get real-time status of all or specified ports.
   * @param {Array<number>} ports - Ports array. E.g., [0, 1, 2, 3]
   * @returns {Promise<Array>} port info status array
   */
  async getPortsInfo(ports = []) {
    const portParam = ports.length > 0 ? ports.join(',') : '0,1,2,3,4,5,6,7';
    const infoTypes = 'imei,imsi,iccid,number,reg,slot,callstate,signal,gprs';

    const response = await this._request('/get_port_info', 'GET', {
      port: portParam,
      info_type: infoTypes
    });

    if (response.data && response.data.error_code === 200) {
      return response.data.info;
    }
    // Deliberately not falling back to mock data here: a dead/unreachable gateway must be
    // visible as an error to callers (/health, telemetry dashboards), not disguised as a
    // healthy fake response. See plan Workstream 4.
    throw new Error(`Dinstar error code: ${response.data ? response.data.error_code : 'Unknown'}`);
  }

  /**
   * Get device health/performance status.
   */
  async getDeviceStatus() {
    const response = await this._request('/get_status', 'POST', ['performance']);
    if (response.data && response.data.performance) {
      return response.data.performance;
    }
    throw new Error('Invalid performance status format');
  }

  /**
   * Send SMS via a specific port.
   */
  async sendSms(text, phoneNumber, port = 0) {
    const payload = {
      text: text,
      param: [
        {
          number: phoneNumber,
          port: port,
          user_id: Math.floor(Math.random() * 10000)
        }
      ]
    };

    const response = await this._request('/send_sms', 'POST', payload);
    if (response.data && response.data.error_code === 200) {
      return { success: true, ref_id: response.data.ref_id || 101 };
    }
    throw new Error(`Dinstar SMS send failed: ${JSON.stringify(response.data)}`);
  }
}

export default DinstarService;
