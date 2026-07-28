import net from 'net';
import EventEmitter from 'events';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Service to connect to and control Asterisk Manager Interface (AMI).
 * Fires events when calls status changes.
 */
class AsteriskService extends EventEmitter {
  constructor() {
    super();
    this.host = process.env.ASTERISK_AMI_HOST || '192.168.1.85';
    this.port = parseInt(process.env.ASTERISK_AMI_PORT) || 5038;
    this.username = process.env.ASTERISK_AMI_USER || 'admin';
    this.secret = process.env.ASTERISK_AMI_PASS || 'admin_password';
    this.socket = null;
    this.isConnected = false;
    this.buffer = '';
    this.actionCallbacks = new Map();
    this.actionIdCounter = 1;
    this.useMock = false;
  }

  /**
   * Connect to Asterisk AMI server
   */
  async connect() {
    return new Promise((resolve) => {
      console.log(`Attempting connection to Asterisk AMI at ${this.host}:${this.port}...`);
      
      this.socket = net.connect({ host: this.host, port: this.port });
      this.socket.setKeepAlive(true);

      this.socket.on('connect', async () => {
        console.log('Connected to Asterisk AMI socket. Performing Login...');
        try {
          const response = await this.sendAction('Login', {
            Username: this.username,
            Secret: this.secret
          });
          if (response.Response === 'Success') {
            console.log('Successfully authenticated with Asterisk AMI');
            this.isConnected = true;
            resolve(true);
          } else {
            console.error('Asterisk AMI Authentication failed:', response.Message);
            this.useMock = true;
            this.isConnected = true;
            resolve(true);
          }
        } catch (err) {
          console.error('Asterisk AMI login command failed:', err.message);
          this.useMock = true;
          this.isConnected = true;
          resolve(true);
        }
      });

      this.socket.on('data', (chunk) => {
        this.buffer += chunk.toString();
        this._processBuffer();
      });

      this.socket.on('error', (err) => {
        console.warn(`Asterisk AMI connection failed: ${err.message}. Enabling AMI Simulator.`);
        this.useMock = true;
        this.isConnected = true; // Mark true to allow simulator interactions
        resolve(true);
      });

      this.socket.on('close', () => {
        if (!this.useMock) {
          console.warn('Asterisk AMI socket connection closed. Reconnecting in 5s...');
          this.isConnected = false;
          setTimeout(() => this.connect(), 5000);
        }
      });
    });
  }

  /**
   * Send an AMI Action
   * @param {string} action - Action name (e.g. Originate, Hangup)
   * @param {Object} parameters - Key-value pair parameters
   */
  async sendAction(action, parameters = {}) {
    const actionId = `act_${this.actionIdCounter++}`;
    const payload = {
      Action: action,
      ActionID: actionId,
      ...parameters
    };

    if (this.useMock) {
      return this._simulateAction(action, payload);
    }

    return new Promise((resolve, reject) => {
      if (!this.isConnected && action !== 'Login') {
        return reject(new Error('Asterisk AMI not connected'));
      }

      this.actionCallbacks.set(actionId, { resolve, reject });
      
      let rawString = '';
      for (const [key, value] of Object.entries(payload)) {
        rawString += `${key}: ${value}\r\n`;
      }
      rawString += '\r\n';
      
      this.socket.write(rawString);
    });
  }

  /**
   * Originates an outbound call via SIP channel
   */
  async originateCall(channel, exten, context, priority, variables = {}, callerId = 'ContactCenter') {
    const variablesStr = Object.entries(variables)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');

    return this.sendAction('Originate', {
      Channel: channel,
      Exten: exten,
      Context: context,
      Priority: priority,
      CallerID: callerId,
      Variable: variablesStr,
      Timeout: 15000, // 15 seconds SLA ring timeout
      Async: 'true'
    });
  }

  /**
   * Hang up a live channel
   */
  async hangupChannel(channel) {
    return this.sendAction('Hangup', { Channel: channel });
  }

  /**
   * Parser for raw buffer
   */
  _processBuffer() {
    let packetEnd;
    while ((packetEnd = this.buffer.indexOf('\r\n\r\n')) !== -1) {
      const packetStr = this.buffer.substring(0, packetEnd);
      this.buffer = this.buffer.substring(packetEnd + 4);
      
      const parsedMsg = this._parsePacket(packetStr);
      if (parsedMsg.Event) {
        this.emit('ami_event', parsedMsg);
        this.emit(parsedMsg.Event, parsedMsg);
      } else if (parsedMsg.Response) {
        const actionId = parsedMsg.ActionID;
        if (actionId && this.actionCallbacks.has(actionId)) {
          const { resolve } = this.actionCallbacks.get(actionId);
          this.actionCallbacks.delete(actionId);
          resolve(parsedMsg);
        } else if (parsedMsg.Response === 'Success' && !actionId) {
          // Check for initial handshake login response
          this.emit('login_response', parsedMsg);
        }
      }
    }
  }

  _parsePacket(packetStr) {
    const lines = packetStr.split('\r\n');
    const msg = {};
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon !== -1) {
        const key = line.substring(0, colon).trim();
        const value = line.substring(colon + 1).trim();
        msg[key] = value;
      }
    }
    return msg;
  }

  /**
   * Internal Simulator for AMI actions when hardware is missing.
   */
  _simulateAction(action, payload) {
    console.log(`[AMI Simulator] Received Action: ${action}`, payload);
    
    // Simulate events async to verify backend flow
    if (action === 'Originate') {
      setTimeout(() => {
        // Trigger ringing state
        this.emit('ami_event', {
          Event: 'Newstate',
          Channel: payload.Channel,
          ChannelState: '4', // Ringing
          ChannelStateDesc: 'Ringing',
          CallerIDNum: payload.CallerID,
          Exten: payload.Exten
        });

        // Simulate agent pickup or missed
        setTimeout(() => {
          if (payload.Channel.includes('absent')) {
            // Trigger failed call event
            this.emit('ami_event', {
              Event: 'Hangup',
              Channel: payload.Channel,
              Cause: '16', // Normal clearing but unanswered in simulation terms
              ChannelStateDesc: 'Ringing'
            });
          } else {
            // Trigger answered/bridge event
            this.emit('ami_event', {
              Event: 'Newstate',
              Channel: payload.Channel,
              ChannelState: '6', // Up/Active
              ChannelStateDesc: 'Up',
              CallerIDNum: payload.CallerID,
              Exten: payload.Exten
            });
            
            this.emit('ami_event', {
              Event: 'BridgeEnter',
              Channel1: payload.Channel,
              Channel2: `SIP/${payload.Exten}-peer`,
              CallerIDNum: payload.CallerID
            });
          }
        }, 2000);
      }, 500);
    }
    
    return Promise.resolve({
      Response: 'Success',
      ActionID: payload.ActionID,
      Message: 'Originate successfully queued (Simulated)'
    });
  }
}

// Singleton pattern
const asteriskService = new AsteriskService();
export default asteriskService;
