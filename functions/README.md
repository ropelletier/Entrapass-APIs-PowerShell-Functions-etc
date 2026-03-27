# Kantech EntraPass API — Function Reference

This directory contains documented function modules for the Kantech EntraPass REST API server running at `http://10.10.32.15:3000`.

## Architecture

The API runs as a Node.js Express server on the EntraPass Windows server. It queries the local EntraPass Advantage Database Server (ADS) directly via `asqlcmd.exe` — no ODBC drivers or middleware needed.

```
Client (School Tech Ops)
  → HTTP request with X-Api-Key header
  → Express server (server.js, port 3000)
    → Route handler (routes/*.js)
      → db.js → asqlcmd.exe → EntraPass ADS (.adt files)
      → Response JSON
```

## Function Modules

| File | Domain | Endpoints |
|------|--------|-----------|
| [users.md](users.md) | Cardholders | GET/POST/PUT users, cards-per-user, events-per-user |
| [cards.md](cards.md) | Card Numbers | GET/POST/PUT/DELETE card assignments, slot management |
| [doors.md](doors.md) | Door Control | GET doors, POST unlock/lock/normal with auto-revert |
| [events.md](events.md) | Access Events | GET events by date/user/door, recent events window |
| [access-levels.md](access-levels.md) | Access Levels | GET/PUT per-cardholder access level, door exceptions, CRUD levels |
| [lookup.md](lookup.md) | Reference Data | GET/POST/PUT access levels, card types |
| [admin.md](admin.md) | API Keys | GET/POST/DELETE API keys |

## Core Modules

| File | Purpose |
|------|---------|
| `api/db.js` | ADS query helper — wraps asqlcmd.exe, returns parsed CSV as objects |
| `api/auth.js` | X-Api-Key middleware — validates against hashed keys in api-keys.json |
| `api/keys.js` | API key store — SHA-256 hashed, create/validate/revoke/list |
| `api/field-map.js` | Custom field name mapping for cardInfo1-5 |
| `api/card-helpers.js` | Gateway notification — triggers controller push after card changes |
| `api/backup.js` | Pre-change row capture — snapshots affected rows before every write |
| `api/logger.js` | Audit logger — request/response/db_write events to JSONL |

## Key Concepts

### ADS Database Tables
- **Card** — Cardholders (one row per person)
- **CardNumber** — Card assignments (one row per physical card, linked to Card via PkCard)
- **ItemCard** — Access level and door exception assignments (ObjectCard=38 for main level, 12 for door exceptions)
- **AccessLevel** — Named access level definitions
- **CardType** — Card type categories
- **Door** — Physical door definitions with OperationMode
- **Schedule** — Time schedules for access control

### State Values (Card.State)
| Value | Label |
|-------|-------|
| 1 | Active |
| 2 | Inactive |
| 0 | Lost/Stolen |

### Gateway Notification
After any card or access level change, the API triggers `CardLastAction` INSERT+DELETE to notify the EntraPass gateway service (`EpCeServiceGateway`), which pushes updates to door controllers.

### Transaction Tracking
Every write operation bumps `Card.TransactionId` and sets `Card.TransactionTag = NOW()`. This is how EntraPass detects changes for replication.
