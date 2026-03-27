# Access Events

Source: `api/routes/events.js`

Door access events read from the EntraPass ADS archive. Each day's events are stored in a separate archive table named `YYYY-MM-DD`.

## Endpoints

### GET /api/v1/events

Today's events (or a specific date).

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `date` | string | YYYY-MM-DD (default: today) |
| `user_id` | number | Filter by cardholder ID |
| `door` | string | LIKE filter on door name |
| `granted` | "true" | Only access-granted events |

**Response:**
```json
{
  "date": "2026-03-26",
  "count": 450,
  "events": [
    {
      "seq": "1234",
      "eventDateTime": "2026-03-26 07:32:15",
      "serverDateTime": "2026-03-26 07:32:16",
      "eventTypeID": 202,
      "cluster": "1",
      "site": "1",
      "doorID": "591",
      "doorName": "CES Main Entrance",
      "cardholderID": "601",
      "cardholderName": "Jane Smith",
      "cardNumber": "00001234",
      "accessGranted": true
    }
  ]
}
```

---

### GET /api/v1/events/recent?minutes=60

Events from the last N minutes (default 60, max 1440).

Handles midnight rollover by querying both today's and yesterday's archive when needed.

**Response:**
```json
{
  "since": "2026-03-26T13:30:00.000Z",
  "minutes": 60,
  "count": 25,
  "events": [...]
}
```

## Access-Granted Event Type IDs

The following event type IDs indicate a successful access grant:
`202, 203, 225, 908, 913, 914, 934`

## Archive Structure

- Each day's events are in a separate ADS table named by date (e.g. `[2026-03-26]`)
- Tables must be bracket-quoted in SQL because they start with a digit
- Archive connection string uses `KANTECH_ARCHIVE_DIR` env var
- If the archive file for a date doesn't exist, the query returns empty (no error)

## Enrichment

Raw event rows only contain numeric IDs. The `enrichEvents()` function:
1. Collects unique door IDs and cardholder IDs from the event batch
2. Queries the live `Door` and `Card` tables for names
3. Maps IDs to names in the response

This means door/cardholder names reflect current values, not historical names at event time.
