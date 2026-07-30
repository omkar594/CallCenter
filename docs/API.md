# Outbound Campaign Module — API Reference

Base URL (production): `https://callcenter-edpl.onrender.com`

This backend has two distinct API surfaces living in the same codebase:

1. **Campaign Broadcast API** — zero-auth, the outbound voice-broadcast dialer (CSV/number upload + audio prompt → calls). This is the primary API for this module.
2. **Contact Center / Agent API** — JWT-authenticated, a separate agent-desk/ACD system (click-to-dial, dispositions, breaks, analytics) that ships in the same backend.

**Security note for the developer you're sharing this with:** the Campaign Broadcast and Gateway Telemetry endpoints currently have **no authentication and no rate limiting** — anyone with the base URL can create a campaign and place real calls on your Dinstar SIMs. Access control for external consumers was intentionally deferred (see project history) — do not put this base URL somewhere public until that's added. Treat the URL itself as the only access control for now.

---

## 1. Health Check

### `GET /health`
No auth. Returns live connectivity status — useful for confirming the deploy is actually working end-to-end, not just that the process is up.

```bash
curl https://callcenter-edpl.onrender.com/health
```

```json
{
  "status": "healthy",
  "timestamp": "2026-07-30T12:22:16.869Z",
  "connections": {
    "postgres": "connected",
    "redis": "disconnected",
    "asterisk_ami": "connected"
  }
}
```
`redis: disconnected` is normal/expected — Redis is optional and the backend runs fine without it. `asterisk_ami` must say `connected` for campaigns to actually dial; if it doesn't, calls will sit at `pending` forever.

---

## 2. Campaign Broadcast API (zero-auth)

### 2.1 Create a campaign — `POST /api/campaigns/broadcast`

**Content-Type:** `multipart/form-data`

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | **Yes** | Campaign name/label |
| `broadcastAudio` | file | Yes\* | Audio prompt (`.mp3`/`.wav`, must have an `audio/*` MIME type, max 25MB) — transcoded server-side to 8kHz/16-bit mono WAV and pushed to the Asterisk box automatically |
| `audioBase64` | string | Yes\* | Alternative to `broadcastAudio`: a base64-encoded audio string (`data:audio/...;base64,...` or raw base64) |
| `leadsCsv` | file | Yes\*\* | CSV with a header row. Accepted phone-number columns (any one): `phone`, `phone_number`, `number`, `mobile`, `msisdn`. Accepted name columns: `name`, `customer_name`, `full_name`. Column order doesn't matter — matched by header name. |
| `phoneNumbers` | string or array | Yes\*\* | Manual number list instead of a CSV, e.g. `["9324479120","8422063087"]` or `"9324479120, 8422063087"` |
| `allowedPorts` | string or array | No | e.g. `[0,1]` or `"0,1"`. **This is a soft concurrency hint, not a hard pin** — it does not guarantee a call goes out on a specific physical SIM slot; the Dinstar gateway makes that decision internally. See §2.4. |

\* one of `broadcastAudio` / `audioBase64` required. \*\* one of `leadsCsv` / `phoneNumbers` required.

```bash
curl -X POST https://callcenter-edpl.onrender.com/api/campaigns/broadcast \
  -F "name=Q3_Sales_Campaign" \
  -F "broadcastAudio=@/path/to/prompt.mp3;type=audio/mpeg" \
  -F "leadsCsv=@/path/to/leads.csv" \
  -F "allowedPorts=[0,1]"
```

**Response `201 Created`:**
```json
{
  "message": "Outbound campaign initiated successfully",
  "campaignId": "186c7a11-f2da-4a51-bacd-215c4cbbcbf6",
  "name": "Q3_Sales_Campaign",
  "totalLeads": 2,
  "allowedPorts": "0,1",
  "status": "running"
}
```

**Error responses** (`400`): missing `name`, missing audio, missing numbers/CSV, wrong file MIME type, invalid CSV. (`500`): audio transcode failed, audio delivery to Asterisk failed (SSH not configured/unreachable), database error.

### 2.2 List campaigns — `GET /api/campaigns`

```bash
curl https://callcenter-edpl.onrender.com/api/campaigns
```

```json
[
  {
    "id": "186c7a11-f2da-4a51-bacd-215c4cbbcbf6",
    "name": "Q3_Sales_Campaign",
    "audio_url": "1785413392223_transcoded",
    "status": "running",
    "allowed_ports": "0,1",
    "total_leads": 2,
    "processed_leads": 2,
    "created_at": "2026-07-30T12:10:00.924Z",
    "answered_count": "1",
    "busy_count": "0",
    "no_answer_count": "0",
    "failed_count": "1",
    "pending_count": "0"
  }
]
```

### 2.3 Get campaign detail & per-lead status — `GET /api/campaigns/:id`

```bash
curl https://callcenter-edpl.onrender.com/api/campaigns/186c7a11-f2da-4a51-bacd-215c4cbbcbf6
```

```json
{
  "campaign": { "id": "...", "name": "...", "status": "running", "total_leads": 2, "processed_leads": 2 },
  "metrics": { "total": 2, "answered": 1, "busy": 0, "noAnswer": 0, "failed": 1, "processing": 0, "pending": 0 },
  "leads": [
    {
      "id": "d5f9d215-9d21-4e8a-bd60-2d800fcd7e90",
      "phone_number": "9324479120",
      "customer_name": "Contact",
      "dial_status": "answered",
      "attempts": 1,
      "call_duration": 14,
      "updated_at": "2026-07-30T13:52:28.436Z"
    }
  ]
}
```

`dial_status` values: `pending` → `processing` → one of `answered` / `busy` / `no-answer` / `failed`. These reflect **real Asterisk call-completion events** (AMI `OriginateResponse`/`Hangup`), not just "the dial request was accepted."

### 2.4 How call concurrency and `allowedPorts` actually work

- The dialer only runs as many simultaneous calls as there are SIM ports currently reporting registered (`REGISTER_OK`) in the gateway telemetry table. If that telemetry is unavailable (gateway unreachable from the backend), it falls back to **1 call at a time**.
- A lead only leaves `processing` when Asterisk reports the real call outcome — this fixed a bug where a 2nd number would never dial because the 1st lead's slot was freed the instant Asterisk *accepted* the dial request, not when the call actually finished.
- `allowedPorts` is passed through as a round-robin hint and logged, but the physical SIM/port a call goes out on is decided by the Dinstar gateway itself, not this API.

---

## 3. Gateway Telemetry API (zero-auth)

### `GET /api/gateways`
List configured gateways.

### `GET /api/gateways/ports` (alias: `GET /api/gateways/allocations`)
Port-to-tenant allocation records (static config, not live status):
```json
[{ "id": "...", "port_number": 0, "mapped_trunk_name": "ClientHDFC_Trunk", "status": "idle", "gateway_name": "Dinstar UC2000-1", "ip_address": "192.168.1.186" }]
```

### `GET /api/gateways/:gatewayId/live`
Live poll of the physical Dinstar hardware. Returns `502` if the gateway is genuinely unreachable (this used to silently return fake data — fixed).
```json
{ "gatewayId": "...", "name": "Dinstar UC2000-1", "ip": "192.168.1.186", "live_ports": [ /* per-port reg/signal/callstate */ ] }
```

---

## 4. Contact Center / Agent API (JWT-authenticated)

Separate subsystem in the same backend — a multi-tenant agent desk with ACD routing. Every route below requires `Authorization: Bearer <token>` from `/api/auth/login`, and most are further role-gated.

### 4.1 Auth
- `POST /api/auth/login` — body `{ "username": "...", "password": "..." }` → `{ message, token, user: { id, username, role, tenant_id, tenant_name } }`. Token expires in 12h.
- `POST /api/auth/logout` — requires `Authorization` header.

### 4.2 Calls (role: `agent`, unless noted)
- `POST /api/calls/dial` — body `{ customerNumber, campaignId?, bucketId? }` → `{ message, callId }`. Click-to-dial for a logged-in agent.
- `POST /api/calls/disposition` — body `{ callId, dispositionCode, comments?, bucketId? }`. Closes out a call and frees the agent.
- `POST /api/calls/break` — body `{ status: "break"|"idle", breakType? }` (`breakType` required when `status=break`, e.g. `tea`/`lunch`).
- `GET /api/calls/bucket` — agent's pending assigned call queue (SLA-ordered).
- `POST /api/calls/transfer-language` — body `{ callId, targetLanguage }`.
- `POST /api/calls/reassign-bucket` — role: `team_leader`/`mentor`/`client_admin`. Body `{ absentAgentId, targetAgentId }`.

### 4.3 Analytics (role: `client_admin`/`mentor`/`team_leader`, `logs` also allows `super_admin`)
- `GET /api/analytics/live` — dashboard: agent status counts, today's conversions, queue volume, SLA breaches.
- `GET /api/analytics/logs` — last 100 calls with disposition/agent info.

---

## 5. Known limitations to tell the other developer about

- **No auth on the Campaign/Gateway APIs.** Add an API-key layer before exposing this URL beyond trusted use.
- **No rate limiting.**
- **`allowedPorts` is advisory, not enforced** — see §2.4.
- **India-only phone normalization** (`bulkCampaignWorker.js`) — strips a `91` country code prefix; not tested against other countries.
- CSV/number list dedup is exact-string match only (no phone-number canonicalization across formats).
