// Workstream 7: minimal WebRTC agent softphone. Talks to whichever backend is serving this
// page (relative fetch()s), and registers with Asterisk directly over WSS using JsSIP.
//
// Deliberately no persistence across page reloads (token kept in a plain variable, not
// localStorage) - simplicity tradeoff for a small internal team; refreshing the page means
// logging in again. A dropped SIP registration is what the OFFLINE banner below exists to
// surface loudly, since that's the failure mode that actually strands a caller.

let jwtToken = null;
let ua = null;
let currentSession = null;

const $ = (id) => document.getElementById(id);

function showPanel(loggedIn) {
  $('login-panel').style.display = loggedIn ? 'none' : 'block';
  $('phone-panel').style.display = loggedIn ? 'block' : 'none';
}

function setStatusBanner(online) {
  const el = $('status-banner');
  el.textContent = online ? 'Online - ready for calls' : 'OFFLINE - no calls can reach you';
  el.className = online ? 'status-online' : 'status-offline';
}

async function login() {
  const username = $('username').value.trim();
  const password = $('password').value;
  $('login-error').textContent = '';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) {
      $('login-error').textContent = data.error || 'Login failed';
      return;
    }
    jwtToken = data.token;
    showPanel(true);
    await primeMicPermission();
    await registerSoftphone();
  } catch (err) {
    $('login-error').textContent = 'Login request failed: ' + err.message;
  }
}

// Request mic permission proactively right after login, not mid-ring - a browser mic prompt
// appearing at the exact moment a call arrives is a common way to miss the first call.
async function primeMicPermission() {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.warn('Microphone permission not granted yet:', err.message);
  }
}

async function registerSoftphone() {
  const res = await fetch('/api/auth/me/sip-credentials', {
    headers: { Authorization: `Bearer ${jwtToken}` }
  });
  if (!res.ok) {
    setStatusBanner(false);
    console.error('Failed to fetch SIP credentials - is this account an agent?');
    return;
  }
  const { sipUsername, sipPassword, wssUrl } = await res.json();
  const sipHost = wssUrl.replace(/^wss?:\/\//, '').split('/')[0].split(':')[0];

  ua = new JsSIP.UA({
    sockets: [new JsSIP.WebSocketInterface(wssUrl)],
    uri: `sip:${sipUsername}@${sipHost}`,
    password: sipPassword,
    register: true
  });

  ua.on('registered', () => setStatusBanner(true));
  ua.on('unregistered', () => setStatusBanner(false));
  ua.on('registrationFailed', () => setStatusBanner(false));
  ua.on('disconnected', () => setStatusBanner(false));

  ua.on('newRTCSession', (e) => {
    if (e.originator !== 'remote') return; // ignore sessions this softphone itself started
    if (currentSession) {
      e.session.terminate(); // already on a call - reject a second incoming session outright
      return;
    }
    currentSession = e.session;
    $('caller-id').textContent = (e.session.remote_identity && e.session.remote_identity.uri.user) || 'Unknown';
    $('incoming-call').style.display = 'block';

    currentSession.on('ended', onCallEnded);
    currentSession.on('failed', onCallEnded);
    currentSession.on('accepted', () => {
      $('incoming-call').style.display = 'none';
      $('in-call').style.display = 'block';
    });
    currentSession.on('peerconnection', (data) => {
      data.peerconnection.addEventListener('track', (ev) => {
        $('remote-audio').srcObject = ev.streams[0];
      });
    });
  });

  ua.start();

  // Registration can silently drop mid-shift (laptop sleep, WiFi blip) without the
  // 'unregistered'/'disconnected' events always firing promptly - poll as a backstop so the
  // banner never lies about being online for long. This is the concrete fix for the "ghost
  // idle agent" edge case: Postgres may still say idle, but this banner tells the AGENT the
  // truth immediately, which is the operationally useful half of that problem.
  setInterval(() => {
    if (ua) setStatusBanner(ua.isRegistered());
  }, 5000);
}

function answerCall() {
  if (!currentSession) return;
  currentSession.answer({ mediaConstraints: { audio: true, video: false } });
}

function rejectOrHangup() {
  if (currentSession) currentSession.terminate();
}

function onCallEnded() {
  currentSession = null;
  $('incoming-call').style.display = 'none';
  $('in-call').style.display = 'none';
}

$('login-btn').addEventListener('click', login);
$('answer-btn').addEventListener('click', answerCall);
$('reject-btn').addEventListener('click', rejectOrHangup);
$('hangup-btn').addEventListener('click', rejectOrHangup);

showPanel(false);
