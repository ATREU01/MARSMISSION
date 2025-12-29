# ORBIT API Integration Specification

**Version:** 1.0.0
**Date:** December 29, 2025
**Classification:** Technical Integration Document

---

## Overview

ORBIT (Ongoing Routine Background Integration Technology) provides a real-time transparency layer for automated token distribution systems. This API enables external platforms to monitor active distribution instances, query activity logs, and display public operational data.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      ORBIT PUBLIC API                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   /api/orbit/status     →  All active instances (summary)       │
│   /api/orbit/check/:m   →  Single instance by mint address      │
│   /api/orbit/activity   →  Recent activity log (last N events)  │
│   /api/orbit/stats      →  Aggregate platform statistics        │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                      RATE LIMITING                              │
│              100 requests/minute per IP address                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Endpoints

### 1. Get All Active Instances

**Endpoint:** `GET /api/orbit/status`

**Description:** Returns summary data for all currently active ORBIT instances.

**Response:**
```json
{
  "success": true,
  "activeCount": 3,
  "instances": [
    {
      "mint": "ABC123...xyz",
      "status": "active",
      "startedAt": 1735420800000,
      "lastClaimAt": 1735424400000,
      "lastDistributeAt": 1735424400000,
      "totalClaimed": 1500000000,
      "totalDistributed": 1500000000,
      "claimCount": 15,
      "distributeCount": 15,
      "uptime": 86400000
    }
  ],
  "timestamp": 1735424400000
}
```

---

### 2. Check Single Instance

**Endpoint:** `GET /api/orbit/check/:mint`

**Description:** Query status for a specific token by mint address.

**Parameters:**
| Parameter | Type   | Required | Description                    |
|-----------|--------|----------|--------------------------------|
| mint      | string | Yes      | Solana token mint address      |

**Response (Active):**
```json
{
  "success": true,
  "active": true,
  "instance": {
    "mint": "ABC123...xyz",
    "status": "active",
    "startedAt": 1735420800000,
    "lastClaimAt": 1735424400000,
    "totalClaimed": 1500000000,
    "totalDistributed": 1500000000,
    "claimCount": 15,
    "distributeCount": 15,
    "uptime": 86400000
  }
}
```

**Response (Not Found):**
```json
{
  "success": true,
  "active": false,
  "message": "No active ORBIT instance for this mint"
}
```

---

### 3. Activity Log

**Endpoint:** `GET /api/orbit/activity`

**Description:** Returns recent activity events across all ORBIT instances.

**Query Parameters:**
| Parameter | Type   | Default | Description                    |
|-----------|--------|---------|--------------------------------|
| limit     | number | 50      | Number of events (max 100)     |

**Response:**
```json
{
  "success": true,
  "activities": [
    {
      "mint": "ABC123...xyz",
      "action": "claimed",
      "data": {
        "amount": 100000000,
        "amountSOL": "0.100000"
      },
      "timestamp": 1735424400000
    },
    {
      "mint": "ABC123...xyz",
      "action": "distributed",
      "data": {
        "amount": 100000000,
        "amountSOL": "0.100000"
      },
      "timestamp": 1735424401000
    }
  ],
  "count": 2
}
```

**Activity Types:**
| Action        | Description                              |
|---------------|------------------------------------------|
| `started`     | ORBIT instance activated                 |
| `claimed`     | Creator fees claimed from bonding curve  |
| `distributed` | Funds distributed (burn/buyback/pool/LP) |
| `stopped`     | ORBIT instance deactivated               |
| `error`       | Error occurred during operation          |

---

### 4. Aggregate Statistics

**Endpoint:** `GET /api/orbit/stats`

**Description:** Platform-wide aggregate statistics.

**Response:**
```json
{
  "success": true,
  "stats": {
    "totalActiveInstances": 12,
    "totalClaimed": 150000000000,
    "totalDistributed": 150000000000,
    "totalClaimEvents": 1500,
    "totalDistributeEvents": 1500,
    "oldestInstance": 1735334400000
  },
  "timestamp": 1735424400000
}
```

---

## Rate Limiting

All endpoints enforce rate limiting:

- **Limit:** 100 requests per minute per IP
- **Response on exceed:** HTTP 429

```json
{
  "success": false,
  "error": "Rate limit exceeded. Please wait before retrying."
}
```

**Headers Included:**
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1735424460
```

---

## Integration Examples

### JavaScript/Node.js

```javascript
const ORBIT_BASE = 'https://api.launchr.xyz';

async function getOrbitStatus() {
  const res = await fetch(`${ORBIT_BASE}/api/orbit/status`);
  return res.json();
}

async function checkToken(mint) {
  const res = await fetch(`${ORBIT_BASE}/api/orbit/check/${mint}`);
  return res.json();
}

async function getActivity(limit = 50) {
  const res = await fetch(`${ORBIT_BASE}/api/orbit/activity?limit=${limit}`);
  return res.json();
}
```

### React Component

```jsx
import { useState, useEffect } from 'react';

function OrbitStatus({ mint }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/orbit/check/${mint}`)
      .then(res => res.json())
      .then(data => {
        setStatus(data);
        setLoading(false);
      });
  }, [mint]);

  if (loading) return <div className="orbit-loading">Checking ORBIT...</div>;
  if (!status?.active) return <div className="orbit-inactive">ORBIT Inactive</div>;

  return (
    <div className="orbit-active">
      <span className="orbit-indicator"></span>
      ORBIT Active
      <div className="orbit-stats">
        Claims: {status.instance.claimCount} |
        Distributed: {(status.instance.totalDistributed / 1e9).toFixed(4)} SOL
      </div>
    </div>
  );
}
```

### Python

```python
import requests

ORBIT_BASE = "https://api.launchr.xyz"

def get_orbit_status():
    r = requests.get(f"{ORBIT_BASE}/api/orbit/status")
    return r.json()

def check_token(mint: str):
    r = requests.get(f"{ORBIT_BASE}/api/orbit/check/{mint}")
    return r.json()

def get_activity(limit: int = 50):
    r = requests.get(f"{ORBIT_BASE}/api/orbit/activity", params={"limit": limit})
    return r.json()
```

---

## 24/7 ORBIT Server-Side Signing (Privy Integration)

For applications using Privy embedded wallets, ORBIT supports server-side signing that continues even when the user's browser is closed.

### Prerequisites

1. User authenticates via Privy with a Solana embedded wallet
2. Server has `PRIVY_APP_SECRET` and `PRIVY_AUTH_PRIVATE_KEY` configured
3. Authorization key registered in Privy Dashboard

### Register for 24/7 ORBIT

**Endpoint:** `POST /api/privy/register-orbit`

**Request Body:**
```json
{
  "privyAuthToken": "eyJhbGciOiJFUz...",
  "privyWalletId": "privy:user_abc123",
  "publicKey": "ABC123...xyz",
  "tokenMint": "DEF456...uvw"
}
```

**Response:**
```json
{
  "success": true,
  "orbitSessionToken": "a1b2c3d4...",
  "message": "24/7 ORBIT signing enabled. Your token will auto-claim even when browser is closed.",
  "privyEnabled": true
}
```

### Check Privy Status

**Endpoint:** `GET /api/privy/status`

**Response:**
```json
{
  "success": true,
  "privyEnabled": true,
  "serverSideSigningAvailable": true,
  "activeSessions": 5,
  "message": "24/7 ORBIT available - close browser and auto-claim continues"
}
```

### Revoke 24/7 Session

**Endpoint:** `POST /api/privy/revoke-orbit`

**Request Body:**
```json
{
  "orbitSessionToken": "a1b2c3d4...",
  "privyAuthToken": "eyJhbGciOiJFUz..."
}
```

**Response:**
```json
{
  "success": true,
  "message": "24/7 ORBIT session revoked. Auto-claim stopped."
}
```

### JavaScript Integration

```javascript
// After Privy authentication
async function enable24_7Orbit(privyCredentials, tokenMint) {
  const res = await fetch('/api/privy/register-orbit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      privyAuthToken: privyCredentials.authToken,
      privyWalletId: privyCredentials.walletId,
      publicKey: privyCredentials.address,
      tokenMint: tokenMint
    })
  });

  const data = await res.json();
  if (data.success) {
    // Store orbitSessionToken for later revocation
    localStorage.setItem('orbitSession', data.orbitSessionToken);
    console.log('24/7 ORBIT enabled!');
  }
}
```

---

## UI/UX Recommendations

### Status Indicator CSS

```css
.orbit-indicator {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 8px;
  animation: orbit-pulse 2s ease-in-out infinite;
}

.orbit-active .orbit-indicator {
  background: #00ff88;
  box-shadow: 0 0 10px #00ff88;
}

.orbit-inactive .orbit-indicator {
  background: #666;
}

@keyframes orbit-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.7; transform: scale(1.1); }
}
```

### Recommended Display Format

```
┌─────────────────────────────────────┐
│  ● ORBIT Active                     │
│    Uptime: 24h 15m                  │
│    Claims: 145 | 12.5 SOL total     │
│    Last activity: 2 min ago         │
└─────────────────────────────────────┘
```

---

## Error Handling

| HTTP Code | Meaning                           | Action                      |
|-----------|-----------------------------------|-----------------------------|
| 200       | Success                           | Process response            |
| 400       | Invalid mint format               | Validate input              |
| 429       | Rate limited                      | Implement backoff           |
| 500       | Server error                      | Retry with exponential back |

### Recommended Retry Logic

```javascript
async function fetchWithRetry(url, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
        continue;
      }
      return res.json();
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
    }
  }
}
```

---

## Changelog

| Version | Date           | Changes                              |
|---------|----------------|--------------------------------------|
| 1.1.0   | Dec 29, 2025   | Added 24/7 ORBIT with Privy server-side signing |
| 1.0.0   | Dec 29, 2025   | Initial ORBIT API release            |

---

## Contact

For integration support or technical questions, reference this specification document.

---

*ORBIT - Ongoing Routine Background Integration Technology*
*Transparent. Automated. 24/7.*
