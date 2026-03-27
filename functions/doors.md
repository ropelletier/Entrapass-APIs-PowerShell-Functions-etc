# Door Control

Source: `api/routes/doors.js`

Controls physical door lock/unlock state via the EntraPass ADS `Door` table. The EntraPass Server service propagates mode changes to KT-400 door controllers.

## OperationMode Values (KT-400 Protocol)

| Code | Label | Behavior |
|------|-------|----------|
| 0 | Normal | Door follows its unlock schedule |
| 1 | Secured (Locked) | Always locked regardless of schedule |
| 2 | Unsecured (Unlocked) | Always unlocked regardless of schedule |

## Endpoints

### GET /api/v1/doors

List all doors with current mode and any active override.

**Response:**
```json
{
  "count": 12,
  "doors": [
    {
      "id": "591",
      "name": "CES Main Entrance",
      "mode": "normal",
      "modeCode": 0,
      "override": null
    },
    {
      "id": "592",
      "name": "CES Office",
      "mode": "unlocked",
      "modeCode": 2,
      "override": {
        "action": "unlock",
        "endsAt": "2026-03-26T14:30:05.000Z",
        "secondsRemaining": 3
      }
    }
  ]
}
```

---

### GET /api/v1/doors/:id

Single door by PkData.

---

### POST /api/v1/doors/:id/unlock

Unlock door for N seconds, then revert to previous mode.

**Body (optional):** `{ "seconds": 10 }` (default: 5)

Also accepts GET with `?seconds=10` query parameter.

**Response:**
```json
{
  "ok": true,
  "doorId": 591,
  "doorName": "CES Main Entrance",
  "action": "unlock",
  "mode": "unlocked",
  "seconds": 10,
  "revertsAt": "2026-03-26T14:30:15.000Z",
  "revertsToMode": "normal"
}
```

---

### POST /api/v1/doors/:id/lock

Lock door for N seconds, then revert to previous mode. Same interface as unlock.

---

### POST /api/v1/doors/:id/normal

Cancel any active override and restore normal mode immediately. No body needed.

**Response:** `{ "ok": true, "doorId": 591, "doorName": "CES Main Entrance", "mode": "normal" }`

## Override Timer Behavior

- Overrides are tracked in-memory on the Node.js process
- If the API service restarts while an override is active, the revert timer is lost — the door stays in the overridden state until `/normal` is called
- Chaining overrides (e.g. unlock then lock while unlock is active) preserves the original pre-override mode for the revert
- Expect up to a few seconds of delay before the physical door responds (EntraPass Server must propagate to the controller)
