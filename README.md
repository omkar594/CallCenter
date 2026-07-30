# Enterprise Standalone Outbound Campaign API Microservice

## Executive Summary & Overview
This standalone repository package delivers a **Pure Backend REST API Microservice** for Automated Voice Broadcasting & Outbound Campaign Management, driving an Asterisk PBX (AWS EC2) over AMI, which routes calls through a Dinstar GSM gateway.

* **No Frontend Required**: Connects to Postman, cURL, or any custom dashboard (a reference React component ships in `frontend_component/`).
* **No Authentication / Login Required** on the campaign/gateway endpoints: zero-auth REST for direct API consumption. **This means anyone with the URL can dial on your account and your Dinstar SIMs** - do not hand this URL out publicly without adding access control first (not included in this build; see the project's remediation plan).
* **Dual Input Modes**: Supports bulk CSV file uploads **AND** manual phone number lists via JSON/text payload.
* **Live Call Tracking & Analytics**: Real call outcomes (`answered`, `busy`, `no-answer`, `failed`, `processing`, `pending`), tracked via real Asterisk AMI events rather than the moment a dial request is merely accepted.
* **Concurrency-aware dialing**: The number of simultaneous calls is gated by how many Dinstar SIM ports are actually registered right now (via `dinstarPoller.js` telemetry), not a hardcoded value.

---

## 1. Zero-Auth REST API Documentation

### A. Create Outbound Campaign
**Endpoint:** `POST /api/campaigns/broadcast`
**Content-Type:** `multipart/form-data`

#### Form Parameters:
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `name` | String | **Yes** | Campaign title (e.g. `July_Promotions`) |
| `broadcastAudio` | File | **Yes**\* | Audio prompt file (`.mp3` or `.wav`, max 25MB) |
| `audioBase64` | String | **Yes**\* | Base64-encoded audio, alternative to `broadcastAudio` |
| `leadsCsv` | File | Optional\*\* | CSV file with a header row - accepts `phone`/`phone_number`/`number`/`mobile` and `name`/`customer_name` columns, in any order |
| `phoneNumbers` | String/Array | Optional\*\* | Manual phone numbers (e.g. `["9324479120", "8422063087"]` or `"9324479120, 8422063087"`) |
| `allowedPorts` | String/Array | Optional | SIM ports to restrict Round-Robin (e.g. `[0, 1]` or `"0, 1"`) - see the note in Section 2 on what this does and doesn't control |

*\*Either `broadcastAudio` OR `audioBase64` must be provided.*
*\*\*Either `leadsCsv` OR `phoneNumbers` must be provided.*

Every uploaded prompt is transcoded to 8kHz/16-bit mono WAV and pushed over SFTP to the Asterisk box's sounds directory before the campaign is created - the API call fails with a clear error if that delivery isn't configured or the Asterisk box is unreachable, rather than silently creating a campaign that will play dead air.

#### Sample cURL Request (CSV Upload + Audio Prompt + Port Selection):
```bash
curl -X POST https://YOUR_RENDER_SERVICE.onrender.com/api/campaigns/broadcast \
  -F "name=Q3_Sales_Campaign" \
  -F "broadcastAudio=@/path/to/prompt.mp3" \
  -F "leadsCsv=@/path/to/leads.csv" \
  -F "allowedPorts=[0, 1]"
```

#### Sample cURL Request (Manual Numbers List + Audio Prompt):
```bash
curl -X POST https://YOUR_RENDER_SERVICE.onrender.com/api/campaigns/broadcast \
  -F "name=VIP_Direct_Call" \
  -F "broadcastAudio=@/path/to/prompt.mp3" \
  -F "phoneNumbers=9324479120, 8422063087, 7304763972" \
  -F "allowedPorts=[0]"
```

#### Sample Response (`201 Created`):
```json
{
  "message": "Outbound campaign initiated successfully",
  "campaignId": "c9d2e7e1-d01e-bf1e-7c6a-7beb6266717d",
  "name": "VIP_Direct_Call",
  "totalLeads": 3,
  "allowedPorts": "0",
  "status": "running"
}
```

---

### B. Get Real-Time Campaign Status & Tracking Report
**Endpoint:** `GET /api/campaigns/:id`

#### Sample Response (`200 OK`):
```json
{
  "campaign": {
    "id": "c9d2e7e1-d01e-bf1e-7c6a-7beb6266717d",
    "name": "VIP_Direct_Call",
    "status": "running",
    "total_leads": 3,
    "processed_leads": 2
  },
  "metrics": {
    "total": 3,
    "answered": 1,
    "busy": 0,
    "noAnswer": 0,
    "failed": 1,
    "processing": 0,
    "pending": 1
  },
  "leads": [
    {
      "id": "lead_123",
      "phone_number": "9324479120",
      "customer_name": "Omkar",
      "dial_status": "answered",
      "attempts": 1,
      "call_duration": 14,
      "updated_at": "2026-07-27T13:25:00Z"
    },
    {
      "id": "lead_124",
      "phone_number": "8422063087",
      "customer_name": "Surabha",
      "dial_status": "failed",
      "attempts": 1,
      "call_duration": 0,
      "updated_at": "2026-07-27T13:26:00Z"
    }
  ]
}
```

`dial_status` is now set from the real Asterisk `OriginateResponse`/`Hangup` events, not from the moment Asterisk merely accepted the dial request - see `backend/bulkCampaignWorker.js`.

---

### C. Get List of All Campaigns
**Endpoint:** `GET /api/campaigns`

#### Sample Response (`200 OK`):
```json
[
  {
    "id": "c9d2e7e1-d01e-bf1e-7c6a-7beb6266717d",
    "name": "VIP_Direct_Call",
    "status": "running",
    "total_leads": 3,
    "answered_count": "1",
    "busy_count": "0",
    "no_answer_count": "0",
    "failed_count": "1",
    "pending_count": "1"
  }
]
```

---

### D. Get Live GSM Gateway Ports Telemetry
**Endpoint:** `GET /api/gateways/ports` (allocation records) and `GET /api/gateways/:gatewayId/live` (live hardware poll)

`GET /api/gateways/ports` returns `gateway_ports` allocation rows (`port_number`, `mapped_trunk_name`, `status`, `gateway_name`). For live registration/call-state per port (`registration_status`, `call_state`, `signal_strength`), query the `gateway_port_telemetry` table directly or use `GET /api/gateways/:gatewayId/live`, which now returns a `502` if the Dinstar gateway is actually unreachable instead of silently returning fabricated port data.

---

## 2. Call Concurrency and Port Selection - what's real and what isn't

- **Concurrency is real.** `bulkCampaignWorker.js` only starts as many simultaneous calls as there are SIM ports currently reporting `REGISTER_OK` in `gateway_port_telemetry` (kept live by `dinstarPoller.js`, polling every 15s). If telemetry is empty (poller hasn't run yet, or the gateway is unreachable), it falls back to a conservative `MAX_CONCURRENT_CALLS` (default `1`) rather than guessing.
- **A given lead's real completion is tracked via Asterisk AMI events** (`OriginateResponse`, then `Hangup`), not assumed the instant the dial request is accepted - this is what fixes the previous bug where a 2nd number would never actually ring because the 1st lead's slot was freed ~50ms after dispatch instead of when the call actually ended.
- **`allowedPorts` is a soft hint, not a hard pin.** It's round-robined and passed to Asterisk as a `TARGET_PORT` channel variable for logging/diagnostics, but the Dinstar gateway - not Asterisk or this codebase - makes the final decision on which physical SIM answers a given call. True per-port pinning would require configuring outbound routing rules on the Dinstar UC2000's own admin panel (e.g. CallerID-prefix-to-port mapping); that's gateway configuration, not something fixable in this repo.
- Daily throughput now scales with however many SIM ports are actually registered, instead of the fixed capacity table this README used to publish (which assumed all ports could be dialed simultaneously with a fixed pacing delay - it wasn't achievable with the previous single-call-at-a-time lock, and a flat multiplier isn't meaningful now that concurrency is dynamic).

---

## 3. Package Directory Structure

```
outbound_campaign_module/
├── README.md                           # Comprehensive REST API Documentation & Setup
├── render.yaml                         # Render Blueprint (reproducible service config)
├── backend/                            # Node.js Express backend
│   ├── server.js                       # Core REST API server; boots the dialer + poller
│   ├── bulkCampaignWorker.js           # Event-driven dialer (AMI-tracked completion, concurrency gate)
│   ├── dinstarPoller.js                # Hardware GSM Port Telemetry Poller
│   ├── package.json                    # Backend dependencies
│   ├── .env.example                    # Environment variable template
│   ├── config/                         # Database & Redis configuration
│   ├── controllers/                    # Campaign creation & report controllers
│   ├── routes/                         # Public Zero-Auth REST API endpoints
│   └── services/                       # asteriskService (AMI), dinstarService, audioTranscoder, audioDeliveryService
├── telephony_config/                   # Asterisk Telephony Engine Settings
│   ├── pjsip.conf                      # PJSIP Trunking to Dinstar Gateway
│   ├── extensions.conf                 # Playback dialplan (reads from the Asterisk-local sounds dir)
│   └── amd.conf                        # Answering Machine Detection Config
├── frontend_component/                 # Reference React upload/status UI (no build tooling of its own)
└── database/                           # PostgreSQL Schema & Setup Scripts
    ├── schema.sql                      # Database Schema (Campaigns, Leads, Telemetry) - kept in sync with server.js's initSchema()
    ├── seed.sql                        # Sample Test Data
    └── setupDb.js                      # Automated DB Initialization Script
```

---

## 4. Local Development Setup

### Step 1: Database
```bash
cd database
node setupDb.js
```

### Step 2: Configure Environment Variables
Copy `backend/.env.example` to `backend/.env` and fill in real values (never commit `.env` - it's git-ignored). For local dev without a real Asterisk box, set `AMI_MOCK_MODE=true` to exercise the dialer against a built-in AMI simulator instead of a live PBX.

### Step 3: Launch
```bash
cd backend
npm install
npm start
```
`npm start` runs `server.js`, which starts the campaign dialer (`bulkCampaignWorker.js`) and the Dinstar telemetry poller (`dinstarPoller.js`) in-process automatically. **Do not launch either of those files as a separate process** - both now guard against a duplicate instance in the same process, but two separate OS processes would each hold their own lock/poll loop against the same database.

---

## 5. Production Deployment (AWS EC2 Asterisk + Render Backend)

### 5.1 Asterisk on EC2
1. Copy `telephony_config/*.conf` into `/etc/asterisk/`, reload (`asterisk -rx "core reload"`).
2. In `telephony_config/extensions.conf`, set the `CAMPAIGN_CALLBACK_BASE` global to your actual Render service URL (this is only a best-effort secondary status signal; the backend's own AMI event tracking is authoritative).
3. Open port `5038` (AMI) in the EC2 security group, scoped to Render's egress IPs if possible - do not expose AMI to the whole internet.
4. Create a dedicated `campaign-uploader` SSH user, chrooted via `sshd_config`'s `ChrootDirectory /var/lib/asterisk/sounds` + `ForceCommand internal-sftp`, so it can only reach that one directory tree and has no shell access - do not reuse a full-access SSH key for this. `ASTERISK_SOUNDS_DIR` is then set relative to that chroot (`/campaign_audio`, not the full host path). Open port `22` to Render's egress for this user.

### 5.2 Backend on Render
1. Use the included `render.yaml` Blueprint (New > Blueprint in the Render dashboard, pointing at this repo) so the service config (root dir `backend`, build/start commands, health check) is reproducible instead of dashboard-only.
2. Fill in the env vars flagged `sync: false` in `render.yaml` via the Render dashboard - notably `DATABASE_URL`, `ASTERISK_AMI_HOST/USER/PASS`, `DINSTAR_*`, and `ASTERISK_SSH_HOST/USER`.
3. Upload your SSH private key for audio delivery as a Render **Secret File** named `asterisk_deploy_key` (mounted at `/etc/secrets/asterisk_deploy_key`, matching `ASTERISK_SSH_PRIVATE_KEY_PATH`'s default). Never commit this key to the repo.
4. Confirm `/health` reports real connectivity for Postgres, Redis, and Asterisk AMI (this now performs live checks rather than just confirming the client objects exist).
