# Users (Cardholders)

Source: `api/routes/users.js`

Cardholders from the EntraPass `Card` table. Each user response includes a `cards[]` array of their assigned card numbers, resolved from `CardNumber` table via JOIN.

## Endpoints

### GET /api/v1/users

Returns all cardholders with their cards.

**Query parameters (all optional, combinable):**

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | LIKE search — matches any part of the name |
| `card` | string | Exact card number (formatted or raw) |
| `state` | number | Filter by state: `1`=Active, `2`=Inactive, `0`=Lost/Stolen |
| `access_level` | string | LIKE search on access level name |

**Response:**
```json
{
  "count": 184,
  "users": [
    {
      "id": "601",
      "name": "Jane Smith",
      "state": "1",
      "stateLabel": "Active",
      "email": "jsmith@school.org",
      "createdAt": "2021-08-18 12:17:23",
      "externalId": "",
      "info": { "info1": "", "info2": "", "info3": "", "info4": "" },
      "cardInfo": {
        "powerschool_id": "",
        "badge_number": "",
        "cardInfo3": "", "cardInfo4": "", "cardInfo5": ""
      },
      "cardCount": 1,
      "cards": [
        {
          "number": "00001234",
          "numberRaw": "1234",
          "lostStolen": false,
          "deactivated": false,
          "hasExpiry": false,
          "endDate": null,
          "accessLevel": "Staff"
        }
      ]
    }
  ]
}
```

Note: `cardInfo` field names are customizable via `api/field-map.json`. Default names are `cardInfo1`-`cardInfo5`.

---

### GET /api/v1/users/:id

Single cardholder by numeric CardholderID. Same response shape as array item above.

Returns 404 if not found.

---

### GET /api/v1/users/:id/cards

Returns only the cards array for a cardholder.

```json
{ "cardholderID": 601, "cards": [...] }
```

---

### GET /api/v1/users/:id/events

Today's events for one cardholder. Optional `?date=YYYY-MM-DD` for a different day.

```json
{ "cardholderID": 601, "date": "2026-03-26", "count": 5, "events": [...] }
```

---

### POST /api/v1/users

Create a new cardholder in EntraPass ADS.

**Required body:** `{ "name": "Doe, John" }`

**Optional fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | number | auto | CardholderID (PkData). Auto-assigned if omitted |
| `state` | string | "0" | 1=Active, 2=Inactive, 0=Lost/Stolen |
| `email` | string | "" | Email address |
| `externalId` | string | "" | External reference (numeric column in ADS) |
| `startDate` | string | - | Start date (YYYY-MM-DD format) |
| `endDate` | string | - | End date (also sets UsingEndDate=1) |
| `cardType` | string/number | - | Card type name or PK |
| `accessLevel` | string/number | - | Access level name or PK |
| `info1`-`info4` | number | 0 | Info fields (integer columns). info1 defaults to PkData |
| Custom cardInfo names | string | "" | e.g. `powerschool_id`, `badge_number` per field-map.json |

**What it creates:**
1. `Card` row with all fields
2. `ItemCard` row for access level assignment (if accessLevel provided)

**Response:** `201 { "id": 602, "name": "Doe, John", "state": "0", "email": "", "externalId": "" }`

---

### PUT /api/v1/users/:id

Update cardholder fields. Only supplied fields are updated.

**Card table fields:** `name`, `state`, `email`, `externalId`, `info1`-`info4`, `cardInfo1`-`cardInfo5` (or custom names), `startDate`, `endDate`, `cardType`

**ItemCard table fields:** `accessLevel`, `accessException`, `accessExceptionExpiry`

**Response:** `{ "ok": true, "id": 601, "updated": 2 }`

## SQL Details

Base query joins: `Card` LEFT JOIN `CardNumber` LEFT JOIN `ItemCard` LEFT JOIN `AccessLevel`

The `groupUsers()` function groups flat card rows (one row per card) into user objects with a `cards[]` array.

## Internal Helpers

- `resolveAccessLevel(nameOrId)` — returns numeric PK, resolves name via case-insensitive lookup
- `resolveCardType(nameOrId)` — same for card types
- `mapInbound(body)` — translates custom field names (e.g. `powerschool_id`) back to `cardInfo1`
- `mapOutbound(cardInfo)` — translates `cardInfo1` to custom names in responses
