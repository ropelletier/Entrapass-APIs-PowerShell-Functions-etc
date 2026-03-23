# Kantech EntraPass MySQL Integration

Tools for exporting EntraPass Corporate Edition data to MySQL:

1. **Nightly card export** — cardholders, card numbers, and access levels synced to MySQL every night via Windows Task Scheduler
2. **Live door event monitor** — door access events streamed to MySQL in near-real-time via a Windows service

Both tools query the EntraPass Advantage database directly using `asqlcmd.exe`, which is already bundled with the EntraPass installation. No additional database drivers are required.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Windows (x86/x64) | Must run on the EntraPass server machine or a machine with access to the EntraPass `Data` and `Archive` directories |
| PowerShell 5.1+ | Included with Windows 10 / Server 2016 and later |
| .NET Framework 4.6+ | Already present — required by EntraPass |
| Advantage Data Architect v12 | Already installed at `C:\Program Files (x86)\Advantage 12.0\` |
| MySQL server | Remote server reachable from this machine |
| `MySqlConnector.dll` + dependencies | Already downloaded to `C:\Projects\Kantech\` (MySqlConnector 1.3.14 + System.Buffers/Memory/etc.) |

---

## File Reference

```
C:\Projects\Kantech\
  .env                          Configuration — credentials and paths (edit this)
  .env.example                  Safe template showing all available settings
  Load-Env.ps1                  Shared .env loader used by all scripts
  MySqlConnector.dll            MySqlConnector 1.3.14 — MySQL 8 compatible (no install needed)
  System.Buffers.dll            Dependency for MySqlConnector
  System.Memory.dll             Dependency for MySqlConnector
  System.Runtime.CompilerServices.Unsafe.dll  Dependency for MySqlConnector
  System.Threading.Tasks.Extensions.dll       Dependency for MySqlConnector

  Export-KantechCards.ps1       Nightly export script
  Register-NightlyExport.ps1    Registers the export as a Scheduled Task (run once)

  Watch-Kantech.ps1             Combined monitor — door events, alarms, after-hours, denials
  KantechEventService.cs        Windows Service wrapper source
  KantechEventService.exe       Compiled service binary (rebuilt by installer)
  Install-KantechEventService.ps1  Builds and installs the Windows service (run once, non-interactive)
  Install-Kantech.ps1           Interactive installer — prompts for all settings, installs all components

  Create-KantechEventsView.ps1  Creates the kantech_events MySQL view (run once)
  Create-ChangeLogTriggers.sql  MySQL change-log table + triggers definition
  Apply-Triggers.ps1            Applies Create-ChangeLogTriggers.sql to MySQL (requires admin)

  KantechApiService.cs          Windows Service wrapper for the Node.js API
  KantechApiService.exe         Compiled service binary (rebuilt by installer)
  Install-KantechApiService.ps1 Builds and installs KantechApiServer service

  api\                          REST API (Node.js + Express, port 3000)
    server.js                   Main entry point
    db.js                       ADS query helper (wraps asqlcmd.exe)
    auth.js                     API key middleware
    keys.js                     Key store (api-keys.json)
    manage-keys.js              CLI: create / list / revoke API keys
    routes\users.js             /api/v1/users endpoints
    routes\cards.js             /api/v1/cards endpoints
    routes\events.js            /api/v1/events endpoints
    routes\admin.js             /api/v1/admin/keys endpoints
```

---

## REST API

### Install as a Windows Service (recommended)

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Projects\Kantech\Install-KantechApiService.ps1"
```

Installs as **KantechApiServer** (auto-start, restarts on crash). Then create your first API key:

```cmd
cd C:\Projects\Kantech\api
node manage-keys.js create "Admin" 365
```

### Run manually (development)

```cmd
cd C:\Projects\Kantech\api
npm install
node server.js
```

Full documentation with request/response examples: **[api/API.md](api/API.md)**

### Endpoint reference

| Method | URL | Description |
|--------|-----|-------------|
| GET | `/api/v1/users` | All cardholders (with cards array) |
| GET | `/api/v1/users?name=Smith` | Name search (LIKE, any part) |
| GET | `/api/v1/users?card=00001234` | By card number |
| GET | `/api/v1/users?state=0` | By state (0=Active 1=Lost 2=Inactive) |
| GET | `/api/v1/users?access_level=Staff` | By access level (LIKE) |
| GET | `/api/v1/users/:id` | Single user by CardholderID |
| GET | `/api/v1/users/:id/cards` | Cards for a user |
| GET | `/api/v1/users/:id/events` | Today's events for a user (add `?date=` for other days) |
| POST | `/api/v1/users` | Create cardholder |
| PUT | `/api/v1/users/:id` | Update cardholder fields (name, email, state, accessLevel, accessException, accessExceptionExpiry, startDate, endDate, cardType) |
| GET | `/api/v1/cards` | All card records |
| GET | `/api/v1/cards?user_id=123` | Cards for a cardholder |
| GET | `/api/v1/cards?lost=true` | Lost/stolen cards |
| GET | `/api/v1/cards/:number` | Single card by number |
| POST | `/api/v1/cards` | Assign card to cardholder |
| PUT | `/api/v1/cards/:number` | Update card (number, numberRaw, lostStolen, deactivated, endDate) |
| GET | `/api/v1/events` | Today's door events (from ADS archive) |
| GET | `/api/v1/events?date=2026-03-22` | Events for a specific date |
| GET | `/api/v1/events?user_id=123` | Events for a cardholder |
| GET | `/api/v1/events?door=CES` | Filter by door name |
| GET | `/api/v1/events?granted=true` | Access-granted events only |
| GET | `/api/v1/events/recent?minutes=60` | Events in the last N minutes |
| GET | `/api/v1/doors` | All doors with current mode and active overrides |
| GET | `/api/v1/doors/:id` | Single door |
| POST | `/api/v1/doors/:id/unlock` | Unlock for N seconds (default 5), then relock |
| POST | `/api/v1/doors/:id/lock` | Lock for N seconds (default 5), then restore |
| POST | `/api/v1/doors/:id/normal` | Cancel override, restore normal mode immediately |
| GET | `/api/v1/access-levels` | All access levels (id, name, allValid flag) |
| POST | `/api/v1/access-levels` | Create access level (name, description, allValid) |
| PUT | `/api/v1/access-levels/:id` | Update access level (name, description, allValid, noneValid) |
| GET | `/api/v1/card-types` | All card types (id, name) |
| POST | `/api/v1/card-types` | Create card type (name, description) |
| PUT | `/api/v1/card-types/:id` | Update card type (name, description) |
| GET | `/api/v1/admin/keys` | List API keys |
| POST | `/api/v1/admin/keys` | Create API key |
| DELETE | `/api/v1/admin/keys/:id` | Revoke API key |

All requests require header: `X-Api-Key: kntk_<your-key>`

### API key management (CLI)

```cmd
node manage-keys.js create "App Name" 365    # create key, expires in 365 days
node manage-keys.js create "No-Expiry App"   # create key with no expiry
node manage-keys.js list                     # show all keys and status
node manage-keys.js revoke <id>              # deactivate a key
```

Keys are stored in `api\api-keys.json` (gitignored). The raw key is shown once on creation.

---

## Quick Install (Interactive)

Run the interactive installer as Administrator. It will prompt for all settings, back up your existing `.env`, and install whatever components you choose:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Projects\Kantech\Install-Kantech.ps1"
```

The installer handles:
- Writing `.env` from prompted values (backs up any existing `.env` to `.env.backups\`)
- Registering the nightly card export as a Scheduled Task
- Compiling and installing the door event monitor as a Windows Service
- Optionally creating MySQL views and applying change-log triggers

Re-run the installer any time you change a setting — it will stop the old service, recompile, and reinstall cleanly.

---

## Step 1 — Configuration

All settings live in a single `.env` file. Edit it before running anything else.

```
C:\Projects\Kantech\.env
```

```ini
# EntraPass database paths (defaults match a standard install)
KANTECH_DATA_DIR=C:\Program Files (x86)\Kantech\Server_CE\Data
KANTECH_ARCHIVE_DIR=C:\Program Files (x86)\Kantech\Server_CE\Archive
KANTECH_ASQLCMD=C:\Program Files (x86)\Advantage 12.0\ARC\asqlcmd.exe

# MySQL connection
MYSQL_HOST=10.10.100.10
MYSQL_PORT=3306
MYSQL_DATABASE=entrapass
MYSQL_USER=entrapass
MYSQL_PASSWORD=your_password_here

# Card export
EXPORT_OUTPUT_DIR=C:\Exports\Kantech
EXPORT_RETAIN_DAYS=30
EXPORT_RUN_TIME=02:00

# Door event monitor
EVENT_POLL_SECONDS=5
EVENT_LOG_DIR=C:\Exports\Kantech
```

All scripts read `.env` automatically at startup. You only need to edit `.env` — never edit the scripts directly to change connection settings.

---

## Step 2 — Nightly Card Export

Exports all cardholders, card numbers, and access levels to both a dated CSV file and the `kantech_cards` MySQL table. Runs nightly via Windows Task Scheduler.

### MySQL table created

`kantech_cards` — one row per cardholder/card combination

| Column | Description |
|--------|-------------|
| `CardholderID` | EntraPass internal ID |
| `FullName` | Cardholder name |
| `State` / `StateLabel` | Numeric state + label (Active, Lost/Stolen, Inactive) |
| `Email` | Cardholder email |
| `CreationDate` | Date record was created in EntraPass |
| `ExternalUserID` | External system ID (if populated) |
| `Info1`–`Info4` | Configurable label fields |
| `CardInfo1`–`CardInfo5` | Additional custom card fields |
| `CardCount` | Number of cards assigned to this cardholder |
| `CardNumberFormatted` | Card number in `FacilityCode:CardNumber` format |
| `CardNumberRaw` | Raw 20-digit card number |
| `CardLostStolen` | Per-card lost/stolen flag |
| `CardDeactivated` | Per-card deactivated flag |
| `CardHasExpiry` / `CardEndDate` | Expiry settings |
| `AccessLevel` | Access level name assigned to this cardholder |
| `LastSynced` | Timestamp of last sync |

Primary key: `(CardholderID, CardNumberFormatted)`

Cardholders with multiple cards produce multiple rows. Cardholders with no card assigned produce one row with blank card fields.

### Test the export manually

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Projects\Kantech\Export-KantechCards.ps1"
```

Output CSV: `C:\Exports\Kantech\kantech_cards_YYYY-MM-DD.csv`

### Register the nightly scheduled task (run once as Administrator)

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Projects\Kantech\Register-NightlyExport.ps1"
```

- Runs daily at the time set in `EXPORT_RUN_TIME` (default `02:00`)
- Runs under the `SYSTEM` account
- Old CSV files are purged after `EXPORT_RETAIN_DAYS` days

### Trigger the task manually (for testing)

```powershell
Start-ScheduledTask -TaskName "Kantech - Nightly Card Export"
```

### Update credentials or schedule

1. Edit `.env`
2. Re-run `Register-NightlyExport.ps1` as Administrator to re-register the task

---

## Step 3 — Door Event Monitor Service

Polls the EntraPass archive every few seconds, picks up new door access events, and inserts them into MySQL. Runs as a Windows service that starts automatically on boot and restarts itself on failure.

### MySQL tables created

**`kantech_door_events`** — one row per door access event

| Column | Description |
|--------|-------------|
| `EventID` | Auto-increment primary key |
| `ArchiveDate` | Date of the EntraPass archive file |
| `PkSequence` | EntraPass sequence number within that day |
| `EventDateTime` | When the event occurred (controller time) |
| `ServerDateTime` | When the server received the event |
| `EventTypeID` | EntraPass event type code |
| `EventType` | Human-readable event description |
| `DoorID` / `DoorName` | Door that was accessed |
| `CardholderID` / `CardholderName` | Who accessed it |
| `CardNumber` | Card number used |
| `AccessGranted` | `1` = granted, `0` = denied |
| `Cluster` / `Site` | EntraPass topology identifiers |
| `InsertedAt` | When this row was written to MySQL |

Unique key: `(ArchiveDate, PkSequence)` — safe to restart, no duplicates.

**`kantech_event_cursor`** — single-row resume tracker

Stores the last processed archive date and sequence number so the service picks up exactly where it left off after a restart or reboot.

### Tracked event types

Access granted (203, 202, 225, etc.), access denied (204–232), door forced open (82), door open too long (84), door locked/unlocked by schedule or operator, and tenant access events.

### Install the service (run once as Administrator)

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Projects\Kantech\Install-KantechEventService.ps1"
```

This will:
1. Read credentials from `.env`
2. Compile `KantechEventService.exe` with credentials baked in
3. Stop and remove any existing version of the service
4. Install and start the new service
5. Configure automatic restart on failure (3 attempts: 10s / 30s / 60s)

### Verify the service is running

```powershell
Get-Service -Name KantechEventMonitor
```

### Service management

```powershell
# Stop
Stop-Service -Name KantechEventMonitor

# Start
Start-Service -Name KantechEventMonitor

# Restart
Restart-Service -Name KantechEventMonitor

# Remove completely
Stop-Service -Name KantechEventMonitor -Force
sc.exe delete KantechEventMonitor
```

### Update credentials or poll interval

1. Edit `.env`
2. Re-run `Install-KantechEventService.ps1` as Administrator — it will stop the old service, recompile, and reinstall

---

## Log Files

All logs are written to `C:\Exports\Kantech\` (or whatever `EVENT_LOG_DIR` is set to).

| File | Written by | Contains |
|------|-----------|---------|
| `Export-KantechCards.log` | Card export script | Row counts, errors, purged files |
| `KantechEventService.log` | Windows service wrapper | Service start/stop, process crashes, restarts |
| `DoorEvents_YYYY-MM.log` | Door event monitor script | Per-poll activity, MySQL insert counts, errors |

Logs rotate monthly for door events. The card export log is appended indefinitely (small volume).

---

## Troubleshooting

**Export script fails with "asqlcmd error"**
- Verify EntraPass Server service is running
- Confirm `KANTECH_DATA_DIR` path in `.env` is correct
- Test manually: `"C:\Program Files (x86)\Advantage 12.0\ARC\asqlcmd.exe" /?`

**MySQL connection fails**
- Confirm the MySQL server is reachable: `Test-NetConnection -ComputerName <MYSQL_HOST> -Port 3306`
- Verify credentials in `.env`
- Ensure the MySQL user has `CREATE`, `INSERT`, `UPDATE`, `SELECT` privileges on the target database

**Service won't start**
- Check `C:\Exports\Kantech\KantechEventService.log` for the error
- Confirm `.env` was populated before running the installer
- Re-run `Install-KantechEventService.ps1` as Administrator after fixing `.env`

**Door events stop appearing after midnight**
- The service handles day rollover automatically — check `DoorEvents_YYYY-MM.log` for rollover messages
- If the service was stopped at midnight, it will resume from the cursor on restart with no data loss

**"Access denied" reading archive files**
- The service must run as `SYSTEM` or an account with read access to `C:\Program Files (x86)\Kantech\`
- The installer configures `SYSTEM` by default, which has the required access

---

## Step 4 — MySQL Views and Change Tracking

### kantech_events view (mirrors entrapass_events)

Run once after the door event monitor is installed:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Projects\Kantech\Create-KantechEventsView.ps1"
```

Creates `kantech_events` with the same columns as the existing `entrapass_events` view:

| Column | Source | Notes |
|--------|--------|-------|
| `datetime` | `EventDateTime` | When the event occurred |
| `door` | `DoorName` | Door name with site-prefix substitutions applied |
| `username` | `CardholderName` | Cardholder full name |
| `Name_exp_4` | `AccessLevel` | Access level (title-cased) from `kantech_cards` |
| `event` | `EventType` | Human-readable event type |

Door name substitutions match `entrapass_events`: strips `RSU_87, `, replaces `Carmel Elementary` → `CES`, replaces `Caravel` → `CMS`.

### Change log triggers

Fires on every `INSERT`, `UPDATE`, or `DELETE` on `kantech_cards`, logging the change to `kantech_change_log`. A stub procedure `on_kantech_change()` is included for future automation.

**Requires MySQL admin** to enable first (binary logging restriction):

```sql
SET GLOBAL log_bin_trust_function_creators = 1;
```

Then apply:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Projects\Kantech\Apply-Triggers.ps1"
```

To implement the future action, edit the `on_kantech_change` procedure body in `Create-ChangeLogTriggers.sql` and re-run `Apply-Triggers.ps1`.

---

## MySQL — Useful Queries

```sql
-- All access events today
SELECT EventDateTime, CardholderName, DoorName, EventType, AccessGranted
FROM kantech_door_events
WHERE DATE(EventDateTime) = CURDATE()
ORDER BY EventDateTime DESC;

-- All active cardholders with their access level
SELECT FullName, CardNumberFormatted, AccessLevel
FROM kantech_cards
WHERE StateLabel = 'Active'
ORDER BY FullName;

-- Access denied events in the last 24 hours
SELECT EventDateTime, CardholderName, DoorName, EventType
FROM kantech_door_events
WHERE AccessGranted = 0
  AND EventDateTime >= NOW() - INTERVAL 1 DAY
ORDER BY EventDateTime DESC;

-- Cardholders with no card assigned
SELECT CardholderID, FullName, StateLabel, CreationDate
FROM kantech_cards
WHERE CardNumberFormatted = ''
ORDER BY FullName;

-- kantech_events view (same format as entrapass_events)
SELECT * FROM kantech_events LIMIT 50;

-- Recent changes to cardholder/card data
SELECT ChangedAt, ChangeType, FullName, CardNumber, AccessLevel, ProcessedAt
FROM kantech_change_log
ORDER BY ChangedAt DESC
LIMIT 50;
```
