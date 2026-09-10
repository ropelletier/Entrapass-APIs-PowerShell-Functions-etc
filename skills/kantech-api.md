# Kantech EntraPass API Skill

Use this skill to interact with the Kantech EntraPass REST API server.

## Server

```
Host:      10.10.32.15
Port:      3000
Base URL:  http://10.10.32.15:3000/api/v1
Auth:      X-Api-Key header (every request except /health)
```

API keys are SHA-256 hashed at rest in `C:\Projects\Kantech\api\api-keys.json`. Generate one via CLI:
```bash
cd C:\Projects\Kantech\api
node manage-keys.js create "My App" 365
```

Or via the API itself (requires an existing key):
```http
POST /api/v1/admin/keys
X-Api-Key: <key>
Content-Type: application/json

{ "name": "My App", "days": 365 }
```

The raw key (`kntk_...`) is shown exactly once on creation — store it securely.

---

## Endpoints Quick Reference

All endpoints are live. Reads come from the local ADS database; writes go through SmartService (see Architecture).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/users` | List cardholders (filter: `?name=`, `?card=`, `?state=`, `?access_level=`) |
| GET | `/api/v1/users/:id` | Single cardholder with cards array |
| POST | `/api/v1/users` | Create cardholder (name required; optional email, cardType, accessLevel) |
| PUT | `/api/v1/users/:id` | Update cardholder (name, state, email, cardType, cardInfo1-5, uuid, keys / key1-6) |
| GET | `/api/v1/users/:id/cards` | Cards for a cardholder |
| GET | `/api/v1/users/:id/events` | Today's events for a cardholder (`?date=YYYY-MM-DD`) |
| GET | `/api/v1/users/:id/access-level` | Get cardholder's access level |
| PUT | `/api/v1/users/:id/access-level` | Set or clear access level (rejects inactive levels) |
| GET | `/api/v1/users/:id/access-exceptions` | List door exceptions |
| POST | `/api/v1/users/:id/access-exceptions` | Add door exception |
| DELETE | `/api/v1/users/:id/access-exceptions/:componentId` | Remove door exception |
| GET | `/api/v1/cards` | List all cards (filter: `?user_id=`, `?access_level=`, `?lost=true`, `?deactivated=true`) |
| GET | `/api/v1/cards/:number` | Single card by number |
| POST | `/api/v1/cards` | Assign card to cardholder |
| PUT | `/api/v1/cards/:number` | Update card status (lostStolen, deactivated, endDate, trace) |
| DELETE | `/api/v1/cards/:number` | Remove card assignment |
| GET | `/api/v1/doors` | List controllable doors with current mode |
| GET | `/api/v1/doors/:id` | Single door (id, name, mode) |
| GET | `/api/v1/doors/:id/config` | **Full door config** — contacts, REX, relays, timing, behaviour flags. Diagnostic; one SmartService call per request, do not poll. |
| POST | `/api/v1/doors/:id/unlock` | Momentary unlock for N seconds |
| POST | `/api/v1/doors/:id/lock` | Lock (secured) until /normal is called |
| POST | `/api/v1/doors/:id/normal` | Restore door to configured schedule |
| POST | `/api/v1/doors/:id/arm` | Arm door alarm |
| POST | `/api/v1/doors/:id/disarm` | Disarm door alarm |
| POST | `/api/v1/doors/:id/one-time-access` | Grant single access |
| GET | `/api/v1/events` | Today's events (`?date=`, `?user_id=`, `?door=`, `?granted=true`) |
| GET | `/api/v1/events/recent` | Events from last N minutes (`?minutes=60`) |
| GET | `/api/v1/access-levels` | List access levels — includes `active` flag |
| POST | `/api/v1/access-levels` | Create access level |
| PUT | `/api/v1/access-levels/:id` | Update access level |
| GET | `/api/v1/card-types` | List card types — includes `active` flag |
| POST | `/api/v1/card-types` | Create card type |
| PUT | `/api/v1/card-types/:id` | Update card type |
| GET | `/api/v1/lookup/schedules` | List schedule options (for exceptions) |
| GET | `/api/v1/sync/cursor` | **Change cursor** — latest TransactionTag per entity type (ISO 8601) |
| GET | `/api/v1/sync/changes?since=<iso>` | **Delta feed** — full records changed since cursor, all entity types |
| GET | `/api/v1/admin/keys` | List API keys |
| POST | `/api/v1/admin/keys` | Create API key |
| DELETE | `/api/v1/admin/keys/:id` | Revoke API key |

---

## User object shape

Every user endpoint returns this shape (fields added 2026-04/05/09 marked ★):

```json
{
  "id": "605",
  "name": "Pelletier, Robert",
  "state": "1", "stateLabel": "Active",
  "email": "ropelletier@rsu87.org",
  "createdAt": "08/26/2021 09:55:26 AM",
  "externalId": ".0000",
  "info":     { "info1": "605", "info2": "0", "info3": "0", "info4": "0" },
  "cardInfo": { "cardInfo1": "", "cardInfo2": "", "cardInfo3": "", "cardInfo4": "", "cardInfo5": "" },
  "cardCount": 2,
  "uuid": "574b4dde-510d-40e9-bb98-2bcf9bc45fa0",        ★ CardInfo20
  "key1": "GM1", "key2": "SES2", "key3": "CES1",         ★ physical key slots 1-6
  "key4": "",    "key5": "",     "key6": "",
  "keys": ["GM1", "SES2", "CES1"],                       ★ non-empty slots in order
  "cardTypeId": 17, "cardTypeName": "Administrator",     ★
  "accessLevelId": 69, "accessLevelName": "Full District Access",  ★
  "cards": [ { "number": "8006:08743", "numberRaw": "…", "lostStolen": false,
               "deactivated": false, "hasExpiry": false, "endDate": null,
               "accessLevel": "Full District Access" } ]
}
```

**Cards are physical badges only.** They do not tell you which doors a person can open. A user with 1 card and 8 door exceptions has 1 card. To understand a person's actual access, read three things: `accessLevelId/Name` (main door set), `GET /users/:id/access-exceptions` (per-door grant/deny overrides), and `state` (Active/Inactive). Some users have no access level and rely entirely on exceptions.

---

## Workflow: Issue a Card to a User

### Step 1 — Find the user

```http
GET /api/v1/users?name=Andrews
X-Api-Key: <key>
```

Confirm the returned record matches the intended person (check full name). Note their `id`.

### Step 2 — Check existing cards

The user object includes `cards[]`. Note which slots are occupied:
- `cards[0]` = slot 1 (CardPosition 0, primary)
- `cards[1]` = slot 2 (CardPosition 1, secondary)
- etc.

### Step 3 — Assign the card

```http
POST /api/v1/cards
X-Api-Key: <key>
Content-Type: application/json

{
  "cardholderID": 601,
  "cardNumber": "8006:12345",
  "cardSlot": 1
}
```

- `cardSlot` is **1-based** (slot 1 = primary, slot 2 = secondary, etc.)
- Omit `cardSlot` or pass `1` for the primary card
- Card numbers use `FFFF:NNNNN` format (facility code : card number)
- If the target slot is already occupied, existing cards at that slot and above shift up to make room
- SmartService rejects a card number already assigned to another user ("Card Already Exist", error 37)

### Step 4 — Verify

```http
GET /api/v1/users/601/cards
X-Api-Key: <key>
```

---

## Workflow: Create a User

```http
POST /api/v1/users
X-Api-Key: <key>
Content-Type: application/json

{ "name": "Doe, John", "email": "jdoe@rsu87.org", "cardType": 18, "accessLevel": "Caravel Middle School (Teacher Access)" }
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | "Last, First" |
| `email` | no | |
| `cardType` | no | ID; default 18 (Employee). Only 18 Employee and 19 Visitor are `active`. |
| `accessLevel` | no | ID or name (case-insensitive). **Inactive/legacy levels are rejected with 400.** Check `active: true` in `GET /access-levels`. |

Response includes the SmartService-assigned `id` — it may not equal MAX+1. Always use the returned `id`.

Users are created `state: "1"` (Active). Set `state` afterwards via PUT if needed.

---

## Workflow: Update a User

```http
PUT /api/v1/users/605
X-Api-Key: <key>
Content-Type: application/json

{ "name": "Pelletier, Robert", "email": "ropelletier@rsu87.org", "state": "1", "uuid": "574b…", "keys": ["GM1", "SES2"] }
```

Any subset of: `name`, `state` ("1" Active / "2" Inactive / "0" Lost-Stolen), `email`, `cardType`, `cardInfo1`–`cardInfo5`, `uuid`, and either `keys` (array — replaces all 6 slots in order) or individual `key1`…`key6` (slot-level edits). At least one field required.

Physical key slots map to workstation labels Key 1–6. The ADS columns behind them are **not sequential** (CardInfo 3, 8, 4, 9, 5, 10) — never reference CardInfo numbers downstream, only the API field names.

---

## Workflow: Set Access Level

Access levels belong to the **cardholder**, not individual cards. All cards for a person inherit the same level.

```http
PUT /api/v1/users/601/access-level
X-Api-Key: <key>
Content-Type: application/json

{ "accessLevelName": "Bus Driver" }
```

Options:
```json
{ "accessLevelId": 69 }              // by PK
{ "accessLevelName": "Bus Driver" }   // by name (case-insensitive)
{ "accessLevelId": 0 }               // clear
{ "accessLevelId": null }            // clear
```

Only levels with `active: true` can be assigned. There are 15 active and 12 legacy (State=2) levels; legacy ones exist in ADS but SmartService does not recognise them.

---

## Workflow: Door Exceptions

Per-cardholder overrides that grant or deny access to specific doors regardless of main access level.

```http
POST /api/v1/users/601/access-exceptions
X-Api-Key: <key>
Content-Type: application/json

{ "componentId": 591, "scheduleId": 25, "doorExceptionMode": 0 }
```

- `componentId` — door PK (required); from `GET /doors`
- `scheduleId` — when active (default 25 = "Always valid"); `GET /lookup/schedules` lists options
- `doorExceptionMode` — `0` = grant (default), `1` = deny

Deny exceptions subtract a door from an access level that would otherwise allow it. Grant exceptions add doors beyond the level.

---

## Workflow: Door Control (via SmartService)

```http
POST /api/v1/doors/591/unlock
X-Api-Key: <key>
Content-Type: application/json

{ "seconds": 5 }
```

| Endpoint | Behavior |
|----------|----------|
| `/unlock` | Momentary unlock for N seconds (1–3600) — controller auto-reverts |
| `/lock` | Lock (secured) — persists until `/normal` is called |
| `/normal` | Restore door to its configured schedule immediately |
| `/arm` | Arm door alarm |
| `/disarm` | Disarm door alarm |
| `/one-time-access` | Grant single access |

All operations generate proper EntraPass audit events. Door **state** is real-time — never cache it.

---

## Workflow: Diagnose Door Hardware

`GET /api/v1/doors/:id/config` returns the door's full wiring and behaviour configuration from SmartService, with FK IDs resolved to names:

```json
{
  "id": 280, "name": "RSU_87, SES Rear Entry/Exit", "mode": "normal",
  "hardware": { "ktType": "KT400", "doorLockMode": "FailsSecure" },
  "timing":   { "unlockTimeSec": 10, "openTimeSec": 30, "extendedUnlockTimeSec": 40, … },
  "contacts": { "doorContact": { "id": 294, "name": "…DPS", "schedule": {…} },
                "rexContact":  { "id": 295, "name": "…REX", "schedule": {…} }, … },
  "relays":   { "lockingDevice": { "id": 284, "name": "…Relay #003" }, "accessGranted": { "id": 0 }, … },
  "behaviour":{ "onAccess": true, "onRex": true, "unlockOnRex": false, "rexRestartPrimary": true, … },
  "alarms":   { "alarmOnDOTL": true, "alarmOnDOTLDelaySec": 15 },
  "schedules":{ "rex": {…}, "unlock": {…}, "doorContact": {…} }
}
```

Compare two doors with `diff <(curl … /doors/280/config | jq -S .) <(curl … /doors/399/config | jq -S .)`. **Config equality does not imply behavioural equality** — EntraPass has no knowledge of door-side hardware (operators, logic modules, push plates). Only compare doors known to share physical hardware.

Costs one SmartService session per call. Diagnostic only; do not poll.

---

## Workflow: Sync an External Cache

For consumers keeping a local copy (e.g. the STO MySQL cache):

1. Every 60 s: `GET /api/v1/sync/cursor` → `{ "cardholders": "2026-…Z", "accessLevels": "…", "cardTypes": "…" }`. If unchanged from last poll, stop.
2. If any changed: `GET /api/v1/sync/changes?since=<last cursor>` → full records for changed cardholders (with cards and exceptions rolled up), access levels, card types, plus a new `cursor`.
3. Save the returned `cursor` as the next `since`.
4. Every 5 min: full snapshot of `/users`, `/cards`, `/access-levels`, `/card-types` to catch **deletions** — deleted rows have no TransactionTag and never appear in the delta.

All sync reads hit ADS only. Polling does not consume SmartService sessions.

---

## Common Update Operations

### Mark card lost/stolen
```http
PUT /api/v1/cards/8006:12345
X-Api-Key: <key>
Content-Type: application/json

{ "lostStolen": true }
```

### Set card expiry
```http
PUT /api/v1/cards/8006:12345
{ "endDate": "2026-12-31" }
```

### Delete a card
```http
DELETE /api/v1/cards/8006:12345
X-Api-Key: <key>
```

Higher-slot cards shift down automatically.

---

## Key Concepts

### State Values (Card.State)

| Value | Label |
|-------|-------|
| 1 | Active |
| 2 | Inactive |
| 0 | Lost/Stolen |

### `active` flag on access levels and card types

Derived from the ADS `State` column (1 = active, 2 = legacy). Writes that reference an inactive access level are rejected. Filter on `active: true` for any UI dropdown or write path.

### Access-Granted Event Type IDs

Events with these IDs indicate successful door access: `202, 203, 225, 908, 913, 914, 934`

Event type `86` = **Request to exit granted** (a REX/push-plate press) — high-frequency, normal, not an alarm. Authoritative names for any code: ADS table `eventtype`.

**Config changes (user created, access level changed) do not appear in the event stream.** Use the sync endpoints.

### TransactionTag

`Card`, `AccessLevel`, `CardType` rows carry a `TransactionTag` last-modified timestamp updated on every change from any source (API or workstation). `CardNumber` and `ItemCard` do not — their changes roll up to the parent `Card`. This is what `/sync/*` is built on. In ADS SQL, compare with `{ts 'YYYY-MM-DD HH:MM:SS'}` literals — string comparison silently returns nothing.

### SmartService IDs

SmartService assigns its own PkData on create. Never predict the next ID; always use the `id` from the response.

---

## Architecture Note

**Reads** query the local ADS database directly (fast, no session cost).

**Writes** go through the Kantech SmartService WCF REST API (port 8801) so changes are immediately visible in the EntraPass workstation and reach door controllers. SmartService has ~5 concurrent session slots; the API holds one and queues internally, with logout-before-refresh and graceful shutdown.

Four write exceptions use ADS directly, each because SmartService cannot do it:

| Operation | Why ADS |
|-----------|---------|
| UserName change | SmartService PUT with a changed UserName creates a duplicate record. ADS update + no-op PUT flushes the cache. |
| State change | SmartService `CardState` is per-card lost/stolen, not cardholder Active/Inactive. |
| Card type create/update | No SmartService endpoint exists for card types. |
| Door exception removal | SmartService ignores an empty `CardDoorAccessList` (treats it as no change). |

Everything else is SmartService. Direct ADS writes outside these four cases create records SmartService cannot see ("Invalid PKData", "Component Do Not Exist").

Authentication to SmartService uses a PowerShell bridge (`api/smartservice-login.ps1`) that calls ENCRYPTEDLOGIN via the EntraPassWeb client library. Session keys are cached and auto-refreshed by `api/smartservice.js`.

---

## Related documentation

`C:\Projects\Kantech\remote-docs\` (mirrored to the STO server at `rpadmin@10.10.100.12:/opt/claude_config/entrapass/`):

- `kantech-api.md` — full endpoint reference with field tables, examples, user templates, and workflows
- `database-schema.md` — ADS schema, ItemCard discriminator, CardInfo map, TransactionTag mechanics, query cheat sheet
- `sto-sync-plan.md` / `sto-sync-plan-responses.md` — STO integration contract
- `door-280-wiring-reference.md` — KT-400, Aiphone LEF-3L, BEA Br3, record DFA 127 wiring and config
- `door-280-layperson-troubleshooting.md` — field guide for non-electricians
