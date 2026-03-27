# API Key Management

Source: `api/routes/admin.js`, `api/keys.js`

API keys are stored in `api/api-keys.json` (gitignored). Keys are SHA-256 hashed at rest — the raw key is shown exactly once on creation.

Key format: `kntk_<48-hex-chars>`

## Endpoints

### GET /api/v1/admin/keys

List all API keys (hashes not shown).

**Response:**
```json
{
  "count": 2,
  "keys": [
    {
      "id": "abc123-...",
      "name": "School Tech Ops",
      "createdAt": "2026-03-20T10:00:00.000Z",
      "expiresAt": "2027-03-20T10:00:00.000Z",
      "active": true
    }
  ]
}
```

---

### POST /api/v1/admin/keys

Create a new API key.

**Body:** `{ "name": "My App", "days": 365 }`

`days` is optional — omit for no expiry.

**Response (201):**
```json
{
  "id": "abc123-...",
  "name": "My App",
  "key": "kntk_746db8172ebc908edfbd250c86effca152bb6387e8f0ff2a",
  "createdAt": "2026-03-26T10:00:00.000Z",
  "expiresAt": "2027-03-26T10:00:00.000Z",
  "note": "Store this key securely — it will NOT be shown again"
}
```

---

### DELETE /api/v1/admin/keys/:id

Revoke a key by ID. The key remains in the file but is marked `active: false`.

## CLI Key Management

For creating the first key (before any API key exists):

```bash
cd C:\Projects\Kantech\api
node manage-keys.js create "Admin" 365
node manage-keys.js list
node manage-keys.js revoke <id>
```
