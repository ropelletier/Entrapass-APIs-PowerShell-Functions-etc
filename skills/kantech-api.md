# Kantech EntraPass API Skill

Use this skill to interact with the Kantech EntraPass REST API server.

## Server

```
Host:      10.10.32.15
Port:      3000
Base URL:  http://10.10.32.15:3000/api/v1
Auth:      X-Api-Key header (every request)
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

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/users` | List cardholders (filter: `?name=`, `?card=`, `?state=`, `?access_level=`) |
| GET | `/api/v1/users/:id` | Single cardholder with cards array |
| POST | `/api/v1/users` | Create cardholder |
| PUT | `/api/v1/users/:id` | Update cardholder fields |
| GET | `/api/v1/users/:id/cards` | Cards for a cardholder |
| GET | `/api/v1/users/:id/events` | Today's events for a cardholder (`?date=YYYY-MM-DD`) |
| GET | `/api/v1/users/:id/access-level` | Get cardholder's access level |
| PUT | `/api/v1/users/:id/access-level` | Set or clear access level |
| GET | `/api/v1/users/:id/access-exceptions` | List door exceptions |
| POST | `/api/v1/users/:id/access-exceptions` | Add door exception |
| DELETE | `/api/v1/users/:id/access-exceptions/:componentId` | Remove door exception |
| GET | `/api/v1/cards` | List all cards (filter: `?user_id=`, `?access_level=`, `?lost=true`, `?deactivated=true`) |
| GET | `/api/v1/cards/:number` | Single card by number |
| POST | `/api/v1/cards` | Assign card to cardholder |
| PUT | `/api/v1/cards/:number` | Update card status |
| DELETE | `/api/v1/cards/:number` | Remove card assignment |
| GET | `/api/v1/doors` | List all doors with current mode |
| GET | `/api/v1/doors/:id` | Single door |
| POST | `/api/v1/doors/:id/unlock` | Unlock for N seconds |
| POST | `/api/v1/doors/:id/lock` | Lock for N seconds |
| POST | `/api/v1/doors/:id/normal` | Cancel override, restore normal |
| GET | `/api/v1/events` | Today's events (`?date=`, `?user_id=`, `?door=`, `?granted=true`) |
| GET | `/api/v1/events/recent` | Events from last N minutes (`?minutes=60`) |
| GET | `/api/v1/access-levels` | List access level definitions |
| POST | `/api/v1/access-levels` | Create access level |
| PUT | `/api/v1/access-levels/:id` | Update access level |
| GET | `/api/v1/card-types` | List card type definitions |
| POST | `/api/v1/card-types` | Create card type |
| PUT | `/api/v1/card-types/:id` | Update card type |
| GET | `/api/v1/admin/keys` | List API keys |
| POST | `/api/v1/admin/keys` | Create API key |
| DELETE | `/api/v1/admin/keys/:id` | Revoke API key |

---

## Workflow: Issue a Card to a User

### Step 1 — Find the user

```http
GET /api/v1/users?name=Andrews
X-Api-Key: <key>
```

Confirm the returned record matches the intended person. Note their `id`.

### Step 2 — Check existing cards

The user object includes `cards[]`. Each entry has a position:
- `cards[0]` = slot 1 (primary)
- `cards[1]` = slot 2 (secondary)

### Step 3 — Assign the card

```http
POST /api/v1/cards
X-Api-Key: <key>
Content-Type: application/json

{
  "cardholderID": 601,
  "cardNumber": "1234:12345",
  "cardSlot": 1
}
```

- `cardSlot` is **1-based** (omit or pass `1` for primary)
- If the slot is occupied, existing cards shift up automatically

### Step 4 — Verify

```http
GET /api/v1/users/601/cards
X-Api-Key: <key>
```

---

## Workflow: Set Access Level

Access levels belong to the **cardholder**, not individual cards. All cards for a person inherit the same level.

```http
PUT /api/v1/users/601/access-level
X-Api-Key: <key>
Content-Type: application/json

{ "accessLevelName": "Staff" }
```

Options:
```json
{ "accessLevelId": 69 }              // by PK
{ "accessLevelName": "Bus Driver" }   // by name (case-insensitive)
{ "accessLevelId": 0 }               // clear
{ "accessLevelId": null }            // clear
```

---

## Workflow: Door Exceptions

Per-cardholder overrides that grant/deny access to specific doors regardless of main access level.

```http
POST /api/v1/users/601/access-exceptions
X-Api-Key: <key>
Content-Type: application/json

{ "componentId": 591, "scheduleId": 25, "doorExceptionMode": 0 }
```

- `componentId` — door PK (required)
- `scheduleId` — when active (default: 25 = "Always valid")
- `doorExceptionMode` — `0` = grant (default), `1` = deny

---

## Workflow: Door Control

```http
POST /api/v1/doors/591/unlock
X-Api-Key: <key>
Content-Type: application/json

{ "seconds": 10 }
```

Door auto-reverts to previous mode after the timer expires.

```http
POST /api/v1/doors/591/normal
```

Cancel any active override immediately.

---

## Common Update Operations

### Mark card lost/stolen
```http
PUT /api/v1/cards/00001234
X-Api-Key: <key>
Content-Type: application/json

{ "lostStolen": true }
```

### Delete a card
```http
DELETE /api/v1/cards/00001234
X-Api-Key: <key>
```

Higher-slot cards shift down automatically.

### Update cardholder
```http
PUT /api/v1/users/601
X-Api-Key: <key>
Content-Type: application/json

{ "name": "Andrews, Jaime", "email": "jandrews@school.org" }
```

### Create cardholder
```http
POST /api/v1/users
X-Api-Key: <key>
Content-Type: application/json

{ "name": "Doe, John", "state": "1", "accessLevel": "Staff" }
```

---

## Key Concepts

### State Values (Card.State)

| Value | Label |
|-------|-------|
| 1 | Active |
| 2 | Inactive |
| 0 | Lost/Stolen |

### Gateway Notification

Every write operation triggers `CardLastAction` INSERT+DELETE to push changes to door controllers via the EntraPass gateway service. Expect a few seconds delay before physical doors reflect changes.

### Transaction Tracking

All writes bump `Card.TransactionId` and set `Card.TransactionTag = NOW()`. This is how EntraPass detects and replicates changes.

### Pre-Change Backup

Every write operation snapshots affected rows before modifying them. Revert SQL is logged for rollback if needed.

### Access-Granted Event Type IDs

Events with these IDs indicate successful door access: `202, 203, 225, 908, 913, 914, 934`

---

## Detailed Function Reference

See the [functions/](../functions/) directory for complete endpoint documentation:

- [users.md](../functions/users.md) — Cardholder CRUD, cards-per-user, events-per-user
- [cards.md](../functions/cards.md) — Card assignment with slot management
- [doors.md](../functions/doors.md) — Door control with timed overrides
- [events.md](../functions/events.md) — Access event queries
- [access-levels.md](../functions/access-levels.md) — Per-cardholder access levels and door exceptions
- [lookup.md](../functions/lookup.md) — Access level and card type definitions
- [admin.md](../functions/admin.md) — API key management
