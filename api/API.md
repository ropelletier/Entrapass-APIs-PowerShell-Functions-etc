# Kantech EntraPass REST API

**Base URL:** `http://<host>:3000/api/v1`
**Data source:** EntraPass Advantage Database (live, direct query via asqlcmd)
**Authentication:** All endpoints require `X-Api-Key: kntk_<key>` header
**Health check:** `GET /health` (no auth required)

---

## Custom Field Names (cardInfo mapping)

The five `cardInfo1`–`cardInfo5` fields on each cardholder can be renamed to meaningful names in `api/field-map.json`. This affects all GET responses and all POST/PUT request bodies — you use your custom name everywhere and the API maps it to the underlying ADS column transparently.

**`api/field-map.json`** (edit and restart the service to apply):
```json
{
  "cardInfo1": "powerschool_id",
  "cardInfo2": "badge_number",
  "cardInfo3": "",
  "cardInfo4": "",
  "cardInfo5": ""
}
```

Leave a field blank (`""`) to keep the default name (`cardInfo3`, etc.).

**Effect on GET response:**
```json
"cardInfo": {
  "powerschool_id": "123456",
  "badge_number":   "B-9001",
  "cardInfo3":      "",
  "cardInfo4":      "",
  "cardInfo5":      ""
}
```

**Effect on PUT — use your custom name directly:**
```bash
curl -X PUT \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{"powerschool_id": "123456", "badge_number": "B-9001"}' \
  http://10.10.32.15:3000/api/v1/users/601
```

**Effect on POST — same:**
```bash
curl -X POST \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{"name": "Doe, John", "powerschool_id": "123456"}' \
  http://10.10.32.15:3000/api/v1/users
```

> `field-map.json` is gitignored (site-specific config). Changes require a service restart.

---

## Authentication

Every request (except `/health`) must include the API key header:

```
X-Api-Key: kntk_746db8172ebc908edfbd250c86effca152bb6387e8f0ff2a
```

Invalid or expired keys return:
```json
{ "error": "Invalid or expired API key" }
```

Missing key returns:
```json
{ "error": "Missing X-Api-Key header" }
```

---

## Users

Cardholders from the EntraPass `Card` table. Each user response includes a `cards` array of their assigned card numbers.

### State values

| Value | Label |
|-------|-------|
| `0` | Active |
| `1` | Lost/Stolen |
| `2` | Inactive |

---

### GET /api/v1/users

Returns all cardholders.

**Query parameters (all optional, mutually exclusive):**

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | LIKE search — matches any part of the name |
| `card` | string | Exact card number (formatted or raw) |
| `state` | number | Filter by state: `0`, `1`, or `2` |
| `access_level` | string | LIKE search on access level name |

**Example — all users:**
```bash
curl -H "X-Api-Key: kntk_..." http://10.10.32.15:3000/api/v1/users
```

**Example — name search:**
```bash
curl -H "X-Api-Key: kntk_..." "http://10.10.32.15:3000/api/v1/users?name=Smith"
```

**Example — by card number:**
```bash
curl -H "X-Api-Key: kntk_..." "http://10.10.32.15:3000/api/v1/users?card=00001234"
```

**Example — active users only:**
```bash
curl -H "X-Api-Key: kntk_..." "http://10.10.32.15:3000/api/v1/users?state=0"
```

**Example — by access level:**
```bash
curl -H "X-Api-Key: kntk_..." "http://10.10.32.15:3000/api/v1/users?access_level=Staff"
```

**Response:**
```json
{
  "count": 184,
  "users": [
    {
      "id": "601",
      "name": "Jane Smith",
      "state": "0",
      "stateLabel": "Active",
      "email": "jsmith@school.org",
      "createdAt": "2021-08-18 12:17:23",
      "externalId": "",
      "info": {
        "info1": "",
        "info2": "",
        "info3": "",
        "info4": ""
      },
      "cardInfo": {
        "cardInfo1": "",
        "cardInfo2": "",
        "cardInfo3": "",
        "cardInfo4": "",
        "cardInfo5": ""
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

---

### GET /api/v1/users/:id

Returns a single cardholder by their numeric CardholderID.

**Example:**
```bash
curl -H "X-Api-Key: kntk_..." http://10.10.32.15:3000/api/v1/users/601
```

**Response:** Single user object (same shape as array item above).

**404 if not found:**
```json
{ "error": "User not found" }
```

---

### GET /api/v1/users/:id/cards

Returns only the cards array for a cardholder.

**Example:**
```bash
curl -H "X-Api-Key: kntk_..." http://10.10.32.15:3000/api/v1/users/601/cards
```

**Response:**
```json
{
  "cardholderID": "601",
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
```

---

### POST /api/v1/users

Creates a new cardholder in the EntraPass database.

> **Warning:** Writes directly to the live EntraPass ADS database. Provide a unique `id` or omit it to auto-calculate from `MAX(PkData)+1`.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Full name |
| `id` | number | No | CardholderID (auto-assigned if omitted) |
| `state` | string | No | `"0"` Active (default), `"1"` Lost/Stolen, `"2"` Inactive |
| `email` | string | No | Email address |
| `externalId` | number | No | External system numeric ID (default `0`) |
| `info1`–`info4` | number | No | Integer info fields (`info1` defaults to `id`) |
| `startDate` | string | No | Activation date (`YYYY-MM-DD`) |
| `endDate` | string | No | Expiry date (`YYYY-MM-DD`) — also sets `UsingEndDate = 1` |
| `cardType` | string\|number | No | Card type name (e.g. `"Employee"`) or numeric ID — see `GET /api/v1/card-types` |
| `accessLevel` | string\|number | No | Access level name or numeric ID — see `GET /api/v1/access-levels` |

**Example — minimal:**
```bash
curl -X POST \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{"name": "John Doe", "state": "0", "email": "jdoe@school.org"}' \
  http://10.10.32.15:3000/api/v1/users
```

**Example — all parameters:**
```bash
curl -X POST \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name":        "Doe, John",
    "state":       "0",
    "email":       "jdoe@school.org",
    "externalId":  12345,
    "startDate":   "2026-09-01",
    "endDate":     "2027-06-30",
    "cardType":    "Employee",
    "accessLevel": "Carmel Elementary School (Teacher Access)",
    "info1":       950,
    "info2":       0,
    "info3":       0,
    "info4":       0
  }' \
  http://10.10.32.15:3000/api/v1/users
```

> `info1` defaults to the auto-assigned `id` if omitted — match EntraPass convention unless you have a specific reason to override it.

**Response (201):**
```json
{ "id": 950, "name": "Doe, John", "state": "0", "email": "jdoe@school.org", "externalId": "" }
```

---

### PUT /api/v1/users/:id

Updates fields on an existing cardholder. Only supplied fields are changed.

Fields that write to the `Card` table and fields that write to the `ItemCard` table (access level, exception) can be combined freely in one request.

**Request body (all optional):**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Full name |
| `state` | string | `"0"`, `"1"`, or `"2"` |
| `email` | string | Email address |
| `externalId` | string | External system ID |
| `info1`–`info4` | string | Custom info fields |
| `cardInfo1`–`cardInfo5` | string | Custom card info fields |
| `startDate` | string | Card activation date (`YYYY-MM-DD`) |
| `endDate` | string | Card expiry date (`YYYY-MM-DD`) — also sets `UsingEndDate = 1` |
| `cardType` | string\|number | Card type name (e.g. `"Employee"`) or numeric ID — see `GET /api/v1/card-types` |
| `accessLevel` | string\|number | Access level name (e.g. `"Full District Access"`) or numeric ID — see `GET /api/v1/access-levels` |
| `accessException` | string\|number | Exception access level name or ID. Pass `""` or `0` to clear. |
| `accessExceptionExpiry` | string | Expiry date for the exception access level (`YYYY-MM-DD`) |

**Example — change email and state:**
```bash
curl -X PUT \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{"email": "jdoe@school.org", "state": "0"}' \
  http://10.10.32.15:3000/api/v1/users/601
```

**Example — change access level:**
```bash
curl -X PUT \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{"accessLevel": "Carmel Elementary School (Teacher Access)"}' \
  http://10.10.32.15:3000/api/v1/users/601
```

**Example — set access exception with expiry:**
```bash
curl -X PUT \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{"accessException": "Exceptions", "accessExceptionExpiry": "2026-06-30"}' \
  http://10.10.32.15:3000/api/v1/users/601
```

**Example — clear access exception:**
```bash
curl -X PUT \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{"accessException": ""}' \
  http://10.10.32.15:3000/api/v1/users/601
```

**Example — set start and end dates:**
```bash
curl -X PUT \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{"startDate": "2026-09-01", "endDate": "2027-06-30"}' \
  http://10.10.32.15:3000/api/v1/users/601
```

**Example — change card type:**
```bash
curl -X PUT \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{"cardType": "Visitor"}' \
  http://10.10.32.15:3000/api/v1/users/601
```

**Response:**
```json
{ "ok": true, "id": 601, "updated": 2 }
```

---

## Cards

Individual card number records from the EntraPass `CardNumber` table.

---

### GET /api/v1/cards

Returns all card records.

**Query parameters (all optional, combinable):**

| Parameter | Type | Description |
|-----------|------|-------------|
| `user_id` | number | Cards for a specific CardholderID |
| `access_level` | string | LIKE search on access level |
| `lost` | boolean | `true` to return only lost/stolen cards |
| `deactivated` | boolean | `true` to return only deactivated cards |

**Example — all cards:**
```bash
curl -H "X-Api-Key: kntk_..." http://10.10.32.15:3000/api/v1/cards
```

**Example — cards for a specific user:**
```bash
curl -H "X-Api-Key: kntk_..." "http://10.10.32.15:3000/api/v1/cards?user_id=601"
```

**Example — lost/stolen cards:**
```bash
curl -H "X-Api-Key: kntk_..." "http://10.10.32.15:3000/api/v1/cards?lost=true"
```

**Response:**
```json
{
  "count": 312,
  "cards": [
    {
      "cardholderID": "601",
      "cardholderName": "Jane Smith",
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
```

---

### GET /api/v1/cards/:number

Returns a single card record by its formatted or raw card number.

**Example:**
```bash
curl -H "X-Api-Key: kntk_..." http://10.10.32.15:3000/api/v1/cards/00001234
```

**Response:** Single card object (same shape as array item above).

**404 if not found:**
```json
{ "error": "Card not found" }
```

---

### POST /api/v1/cards

Assigns a new card number to an existing cardholder.

> **Warning:** Writes directly to the live EntraPass ADS `CardNumber` table.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cardholderID` | number | Yes | CardholderID to assign the card to |
| `cardNumber` | string | Yes | Raw card number |
| `cardNumberFormatted` | string | No | Formatted card number (defaults to `cardNumber`) |

**Example:**
```bash
curl -X POST \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{"cardholderID": 601, "cardNumber": "1234", "cardNumberFormatted": "00001234"}' \
  http://10.10.32.15:3000/api/v1/cards
```

**Response (201):**
```json
{ "ok": true, "cardholderID": 601, "cardNumber": "00001234" }
```

---

### PUT /api/v1/cards/:number

Updates status fields on a card. Only supplied fields are changed.

**Request body (all optional):**

| Field | Type | Description |
|-------|------|-------------|
| `number` | string | New formatted card number (e.g. `8005:54548`) |
| `numberRaw` | string | New raw card number (20-digit zero-padded) |
| `lostStolen` | boolean | Mark card as lost/stolen |
| `deactivated` | boolean | Deactivate the card |
| `endDate` | string | Expiry date (`YYYY-MM-DD`) — also sets `UseEndDate = 1` |

**Example — change card number:**
```bash
curl -X PUT \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{"number": "8005:54548", "numberRaw": "00000000002147865876"}' \
  http://10.10.32.15:3000/api/v1/cards/8005:54547
```

**Example — mark lost:**
```bash
curl -X PUT \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{"lostStolen": true}' \
  http://10.10.32.15:3000/api/v1/cards/00001234
```

**Example — set expiry:**
```bash
curl -X PUT \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{"endDate": "2026-06-30"}' \
  http://10.10.32.15:3000/api/v1/cards/00001234
```

**Response:**
```json
{ "ok": true, "number": "00001234", "updated": 1 }
```

---

## Events

Door events read directly from EntraPass ADS archive files. Each day's events are stored in a separate archive table named after the date (`YYYY-MM-DD`).

---

### GET /api/v1/events

Returns door events for a given date (defaults to today).

**Query parameters (all optional, combinable):**

| Parameter | Type | Description |
|-----------|------|-------------|
| `date` | string | `YYYY-MM-DD` — defaults to today |
| `user_id` | number | Filter by CardholderID |
| `door` | string | Filter by door name (case-insensitive, partial match) |
| `granted` | boolean | `true` to return only access-granted events |

**Example — today's events:**
```bash
curl -H "X-Api-Key: kntk_..." http://10.10.32.15:3000/api/v1/events
```

**Example — specific date:**
```bash
curl -H "X-Api-Key: kntk_..." "http://10.10.32.15:3000/api/v1/events?date=2026-03-22"
```

**Example — one person's events today:**
```bash
curl -H "X-Api-Key: kntk_..." "http://10.10.32.15:3000/api/v1/events?user_id=601"
```

**Example — CES door, granted only:**
```bash
curl -H "X-Api-Key: kntk_..." "http://10.10.32.15:3000/api/v1/events?door=CES&granted=true"
```

**Response:**
```json
{
  "date": "2026-03-22",
  "count": 312,
  "events": [
    {
      "seq": 4391,
      "eventDateTime": "2026-03-22 08:14:05",
      "serverDateTime": "2026-03-22 08:14:05",
      "eventTypeID": 202,
      "cluster": 1,
      "site": 1,
      "doorID": "12",
      "doorName": "CES Main Entrance",
      "cardholderID": "601",
      "cardholderName": "Jane Smith",
      "cardNumber": "00001234",
      "accessGranted": true
    }
  ]
}
```

**Notes:**
- Returns `count: 0, events: []` if no archive file exists for the requested date
- `accessGranted: true` for event type IDs: 202, 203, 225, 908, 913, 914, 934

---

## Doors

Door mode is controlled by writing `OperationMode` to the EntraPass ADS database. The EntraPass Server service must be running to propagate the change to the physical door controller hardware (typically within a few seconds). If the API service restarts while an override is active, the revert timer is lost — call `/normal` to restore manually.

**Mode values:**

| Mode | Code | Meaning |
|------|------|---------|
| `normal` | 0 | Door follows its configured unlock schedule |
| `locked` | 1 | Always locked regardless of schedule |
| `unlocked` | 2 | Always unlocked regardless of schedule |

---

### GET /api/v1/doors

Returns all doors with their current mode and any active timed override.

**Example:**
```bash
curl -H "X-Api-Key: kntk_..." http://10.10.32.15:3000/api/v1/doors
```

**Response:**
```json
{
  "count": 36,
  "doors": [
    {
      "id": "279",
      "name": "RSU_87, SES Main Entrance",
      "mode": "normal",
      "modeCode": 0,
      "override": null
    },
    {
      "id": "220",
      "name": "RSU_87, Caravel Front Door #1 Door #01",
      "mode": "unlocked",
      "modeCode": 2,
      "override": {
        "action": "unlock",
        "endsAt": "2026-03-22T19:45:00.000Z",
        "secondsRemaining": 27
      }
    }
  ]
}
```

---

### GET /api/v1/doors/:id

Returns a single door by its numeric ID.

**Example:**
```bash
curl -H "X-Api-Key: kntk_..." http://10.10.32.15:3000/api/v1/doors/279
```

**Response:** Single door object (same shape as array item above).

---

### POST /api/v1/doors/:id/unlock

Immediately unlocks the door, then automatically relocks after `seconds` (default **5**).

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `seconds` | number | No | How long to stay unlocked (default `5`, minimum `1`) |

**Example — default 5-second buzz:**
```bash
curl -X POST \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://10.10.32.15:3000/api/v1/doors/279/unlock
```

**Example — unlock for 30 seconds:**
```bash
curl -X POST \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{"seconds": 30}' \
  http://10.10.32.15:3000/api/v1/doors/279/unlock
```

**Response:**
```json
{
  "ok": true,
  "doorId": 279,
  "doorName": "RSU_87, SES Main Entrance",
  "action": "unlock",
  "mode": "unlocked",
  "seconds": 30,
  "revertsAt": "2026-03-22T19:45:00.000Z",
  "revertsToMode": "normal"
}
```

> If a timed override is already active on this door, the existing timer is cancelled and replaced by the new one. The door will always revert to whatever mode it was in **before any API intervention**.

---

### POST /api/v1/doors/:id/lock

Immediately locks the door, then automatically restores the previous mode after `seconds` (default **5**).

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `seconds` | number | No | How long to stay locked (default `5`, minimum `1`) |

**Example — lock for 5 minutes:**
```bash
curl -X POST \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{"seconds": 300}' \
  http://10.10.32.15:3000/api/v1/doors/279/lock
```

**Response:** Same shape as unlock response, with `"action": "lock"`.

---

### POST /api/v1/doors/:id/normal

Cancels any active timed override and immediately restores the door to normal mode (follows its configured unlock schedule).

**Example:**
```bash
curl -X POST \
  -H "X-Api-Key: kntk_..." \
  http://10.10.32.15:3000/api/v1/doors/279/normal
```

**Response:**
```json
{ "ok": true, "doorId": 279, "doorName": "RSU_87, SES Main Entrance", "mode": "normal" }
```

---

## Reference Data

### GET /api/v1/access-levels

Returns all access levels including `allValid` and `noneValid` flags. Use `name` or `id` when setting `accessLevel` or `accessException` on a user.

**Example:**
```bash
curl -H "X-Api-Key: kntk_..." http://10.10.32.15:3000/api/v1/access-levels
```

**Response:**
```json
{
  "count": 27,
  "accessLevels": [
    { "id": "69",  "name": "Full District Access", "description": "Always valid, all doors", "allValid": true,  "noneValid": false },
    { "id": "84",  "name": "Carmel Elementary",    "description": "Carmel Elementary",       "allValid": false, "noneValid": false }
  ]
}
```

---

### POST /api/v1/access-levels

Creates a new access level. `allValid: true` grants access to all doors at all times (no further configuration needed in EntraPass). `allValid: false` creates a shell level — configure specific doors and schedules in EntraPass afterwards.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Access level name |
| `description` | string | No | Secondary description (defaults to `name`) |
| `allValid` | boolean | No | `true` = all doors always (default `false`) |

**Example:**
```bash
curl -X POST \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{"name": "Summer Rec Staff", "description": "Summer access only", "allValid": false}' \
  http://10.10.32.15:3000/api/v1/access-levels
```

**Response (201):**
```json
{ "id": 875, "name": "Summer Rec Staff", "description": "Summer access only", "allValid": false }
```

---

### PUT /api/v1/access-levels/:id

Updates an existing access level.

**Request body (all optional):**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Access level name |
| `description` | string | Secondary description |
| `allValid` | boolean | `true` = all doors always |
| `noneValid` | boolean | `true` = no access (disable) |

**Example:**
```bash
curl -X PUT \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{"name": "Summer Rec Staff (Updated)", "allValid": true}' \
  http://10.10.32.15:3000/api/v1/access-levels/875
```

**Response:**
```json
{ "ok": true, "id": 875, "updated": 2 }
```

---

### GET /api/v1/card-types

Returns all card types. Use `name` or `id` when setting `cardType` on a user.

**Example:**
```bash
curl -H "X-Api-Key: kntk_..." http://10.10.32.15:3000/api/v1/card-types
```

**Response:**
```json
{
  "count": 5,
  "cardTypes": [
    { "id": "17", "name": "Administrator", "description": "Administrator" },
    { "id": "18", "name": "Employee",      "description": "Employee" },
    { "id": "19", "name": "Visitor",       "description": "Visitor" },
    { "id": "20", "name": "Security",      "description": "Security" },
    { "id": "21", "name": "Maintenance",   "description": "Maintenance" }
  ]
}
```

---

### POST /api/v1/card-types

Creates a new card type.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Card type name |
| `description` | string | No | Secondary description (defaults to `name`) |

**Example:**
```bash
curl -X POST \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{"name": "Contractor", "description": "Temporary contractor access"}' \
  http://10.10.32.15:3000/api/v1/card-types
```

**Response (201):**
```json
{ "id": 22, "name": "Contractor", "description": "Temporary contractor access" }
```

---

### PUT /api/v1/card-types/:id

Updates an existing card type.

**Request body (all optional):**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Card type name |
| `description` | string | Secondary description |

**Example:**
```bash
curl -X PUT \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{"name": "Contractor (Short-term)"}' \
  http://10.10.32.15:3000/api/v1/card-types/22
```

**Response:**
```json
{ "ok": true, "id": 22, "updated": 1 }
```

---

## Admin — API Key Management

Any valid API key can manage keys. The **first key must be created via the CLI** since there is no unauthenticated bootstrap endpoint.

---

### CLI key management

```cmd
cd C:\Projects\Kantech\api

# Create a key (no expiry)
node manage-keys.js create "Dashboard"

# Create a key expiring in 90 days
node manage-keys.js create "Temp App" 90

# List all keys and their status
node manage-keys.js list

# Revoke a key by ID
node manage-keys.js revoke 3f2a1b4c-...
```

---

### GET /api/v1/admin/keys

Lists all API keys. Key hashes are never returned.

**Example:**
```bash
curl -H "X-Api-Key: kntk_..." http://10.10.32.15:3000/api/v1/admin/keys
```

**Response:**
```json
{
  "count": 2,
  "keys": [
    {
      "id": "3f2a1b4c-5d6e-7f8a-9b0c-1d2e3f4a5b6c",
      "name": "Admin",
      "createdAt": "2026-03-22T17:45:00.000Z",
      "expiresAt": "2027-03-22T17:45:00.000Z",
      "active": true
    }
  ]
}
```

---

### POST /api/v1/admin/keys

Creates a new API key. The raw key is shown **once only** — it is not stored.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Human-readable label |
| `days` | number | No | Expiry in days from now (omit for no expiry) |

**Example:**
```bash
curl -X POST \
  -H "X-Api-Key: kntk_..." \
  -H "Content-Type: application/json" \
  -d '{"name": "My Dashboard", "days": 365}' \
  http://10.10.32.15:3000/api/v1/admin/keys
```

**Response (201):**
```json
{
  "id": "3f2a1b4c-...",
  "name": "My Dashboard",
  "key": "kntk_a1b2c3d4e5f6...",
  "createdAt": "2026-03-22T18:00:00.000Z",
  "expiresAt": "2027-03-22T18:00:00.000Z",
  "note": "Store this key securely — it will NOT be shown again"
}
```

---

### DELETE /api/v1/admin/keys/:id

Revokes a key by its ID. The key immediately stops working.

**Example:**
```bash
curl -X DELETE \
  -H "X-Api-Key: kntk_..." \
  http://10.10.32.15:3000/api/v1/admin/keys/3f2a1b4c-...
```

**Response:**
```json
{ "ok": true, "revoked": "3f2a1b4c-..." }
```

**404 if not found:**
```json
{ "error": "Key not found" }
```

---

## Error responses

All errors follow the same shape:

```json
{ "error": "Description of what went wrong" }
```

| Status | Meaning |
|--------|---------|
| `400` | Bad request — missing required field or invalid parameter |
| `401` | No `X-Api-Key` header provided |
| `403` | Invalid or expired API key |
| `404` | Resource not found |
| `500` | Server error — check `C:\Exports\Kantech\KantechApiService.log` |
