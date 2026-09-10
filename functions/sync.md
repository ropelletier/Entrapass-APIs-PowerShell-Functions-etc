# Sync — Change Feed for External Caches

Two read-only endpoints for consumers that keep a local copy of cardholder data (e.g. the School Tech Ops MySQL cache). Both read ADS only; polling costs no SmartService sessions.

Built on `TransactionTag`, a last-modified timestamp on `Card`, `AccessLevel`, and `CardType` that EntraPass updates on every change from any source (API or workstation). `CardNumber` and `ItemCard` have no tag — their changes roll up to the parent `Card` row.

---

### GET /api/v1/sync/cursor

Latest TransactionTag per entity type, as ISO 8601.

**Response:**
```json
{ "cardholders": "2026-09-09T14:22:31.000Z", "accessLevels": "2026-08-30T09:01:12.000Z", "cardTypes": "2026-05-01T10:15:00.000Z" }
```

Poll every 60 s. If nothing changed since the last poll, stop.

---

### GET /api/v1/sync/changes?since=<iso>

Full records for everything changed after `since`.

| Param | Required | Notes |
|-------|----------|-------|
| `since` | yes | ISO 8601 timestamp — the cursor from the previous call |

**Response:**
```json
{
  "since": "2026-09-09T14:00:00.000Z",
  "cursor": { "cardholders": "...", "accessLevels": "...", "cardTypes": "..." },
  "cardholders": [ { "id": "605", "name": "...", "state": "1", "uuid": "...", "keys": [], "accessLevelId": 69,
                     "cards": [ ... ], "exceptions": [ ... ] } ],
  "accessLevels": [ { "id": 69, "name": "...", "active": true } ],
  "cardTypes":    [ { "id": 18, "name": "Employee", "active": true } ]
}
```

Save the returned `cursor` as the next `since`.

---

## Deletions

Deleted rows have no TransactionTag and never appear in the delta. Take a full snapshot of `/users`, `/cards`, `/access-levels`, and `/card-types` every 5 minutes and remove anything missing.

## ADS date literals

Internally, `since` is converted to an ADS `{ts 'YYYY-MM-DD HH:MM:SS'}` literal. Comparing TransactionTag against a plain string silently returns zero rows — any direct ADS query must use the `{ts ...}` form.
