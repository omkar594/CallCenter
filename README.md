# Enterprise Standalone Outbound Campaign API Microservice

## Executive Summary & Overview
This standalone repository package delivers a **Pure Backend REST API Microservice** for Automated Voice Broadcasting & Outbound Campaign Management. 

* **No Frontend Required**: Connects to Postman, cURL, or any custom dashboard.
* **No Authentication / Login Required**: Zero-auth REST endpoints for direct API consumption.
* **Dual Input Modes**: Supports bulk CSV file uploads **AND** manual phone number lists via JSON/text payload.
* **Live Call Tracking & Analytics**: Provides real-time metrics on connected (`answered`), failed, pending, and processing calls.
* **Anti-Spam Telecom Pacing & Round-Robin**: Automatic Round-Robin distribution across Dinstar SIM ports with configurable inter-call pacing delay.

---

## 1. Zero-Auth REST API Documentation

### A. Create Outbound Campaign
**Endpoint:** `POST /api/campaigns/broadcast`  
**Content-Type:** `multipart/form-data`

#### Form Parameters:
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `name` | String | **Yes** | Campaign title (e.g. `July_Promotions`) |
| `broadcastAudio` | File | **Yes** | Audio prompt file (`.mp3` or `.wav`) |
| `leadsCsv` | File | Optional* | CSV file containing phone numbers (`phone_number,customer_name`) |
| `phoneNumbers` | String/Array | Optional* | Manual phone numbers (e.g. `["9324479120", "8422063087"]` or `"9324479120, 8422063087"`) |
| `allowedPorts` | String/Array | Optional | SIM ports to restrict Round-Robin (e.g. `[0, 1]` or `"0, 1"`) |

*\*Either `leadsCsv` OR `phoneNumbers` must be provided.*

#### Sample cURL Request (CSV Upload + Audio Prompt + Port Selection):
```bash
curl -X POST http://YOUR_SERVER_IP:5000/api/campaigns/broadcast \
  -F "name=Q3_Sales_Campaign" \
  -F "broadcastAudio=@/path/to/prompt.mp3" \
  -F "leadsCsv=@/path/to/leads.csv" \
  -F "allowedPorts=[0, 1]"
```

#### Sample cURL Request (Manual Numbers List + Audio Prompt):
```bash
curl -X POST http://YOUR_SERVER_IP:5000/api/campaigns/broadcast \
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
      "updated_at": "2026-07-27T13:25:00Z"
    },
    {
      "id": "lead_124",
      "phone_number": "8422063087",
      "customer_name": "Surabha",
      "dial_status": "failed",
      "attempts": 3,
      "updated_at": "2026-07-27T13:26:00Z"
    }
  ]
}
```

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
    "failed_count": "1",
    "pending_count": "1"
  }
]
```

---

### D. Get Live GSM Gateway Ports Telemetry
**Endpoint:** `GET /api/gateways/ports`

#### Sample Response (`200 OK`):
```json
[
  {
    "gateway_ip": "192.168.1.186",
    "port_number": 0,
    "sim_number": "9820012345",
    "registration_status": "REGISTER_OK",
    "call_state": "Idle"
  }
]
```

---

## 2. Daily Call Capacity Matrix (9-Hour Shift)

Based on standard 30-second call cycles (7s Ringing + 20s Voice Prompt + 3s Anti-Spam Buffer):

| Active SIM Ports | Output per SIM / Day | Total Calls Delivered / 9-Hour Day |
| :--- | :--- | :--- |
| **4 Ports** | ~1,080 calls | **~4,320 Calls / Day** |
| **8 Ports** | ~1,080 calls | **~8,640 Calls / Day** |
| **16 Ports** | ~1,080 calls | **~17,280 Calls / Day** |
| **32 Ports** *(Full Dinstar UC2000)* | ~1,080 calls | **~34,560 Calls / Day** |

---

## 3. Package Directory Structure

```
outbound_campaign_module/
├── README.md                           # Comprehensive REST API Documentation & Setup
├── backend/                            # Pure Node.js Express Backend & BullMQ Worker
│   ├── server.js                       # Core REST API server
│   ├── bulkCampaignWorker.js           # Dialing Worker (Round-Robin & Pacing Buffer)
│   ├── dinstarPoller.js                # Hardware GSM Port Telemetry Poller
│   ├── package.json                    # Backend dependencies
│   ├── .env.example                    # Environment variable template
│   ├── config/                         # Database & Redis configuration
│   ├── controllers/                    # Campaign creation & report controllers
│   ├── routes/                         # Public Zero-Auth REST API endpoints
│   └── services/                       # Audio Transcoder Service
├── telephony_config/                   # Asterisk Telephony Engine Settings
│   ├── pjsip.conf                      # PJSIP Trunking to Dinstar Gateway
│   ├── extensions.conf                 # Immediate Playback & Callback Dialplan
│   └── amd.conf                        # Answering Machine Detection Config
└── database/                           # PostgreSQL Schema & Setup Scripts
    ├── schema.sql                      # Database Schema (Campaigns, Leads, Telemetry)
    ├── seed.sql                        # Sample Test Data
    └── setupDb.js                      # Automated DB Initialization Script
```

---

## 4. Quickstart Setup Guide

### Step 1: Database Setup
```bash
cd database
node setupDb.js
```

### Step 2: Configure Environment Variables (`backend/.env`)
```env
PORT=5000
DATABASE_URL=postgres://callcenter:callcenter_secret@localhost:5433/callcenter
REDIS_URL=redis://localhost:6379
DINSTAR_GATEWAY_IP=192.168.1.186
DINSTAR_API_USER=cmtadmin
DINSTAR_API_PASS=CellAdmin@1973
PACING_BUFFER_DELAY_SEC=3
```

### Step 3: Launch Services
```bash
cd backend
npm start &
node bulkCampaignWorker.js &
node dinstarPoller.js &
```
