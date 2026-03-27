# Access Levels & Door Exceptions

Source: `api/routes/access-levels.js`

Per-cardholder access level assignment and door exception management. Access levels belong to the **cardholder**, not individual cards — all cards for a person inherit the same access level.

## Data Model

### Main Access Level (ObjectCard=38)
- One `ItemCard` row per cardholder: `FkDataGSI=67`, `ObjectCard=38`
- `FkICDataAccessLevel` = access level PK
- To clear: DELETE the row (desktop behavior, not update to 0)
- `Card.ItemCount` = total ItemCard rows (all types)

### Door Exceptions (ObjectCard=12)
- One `ItemCard` row per door: `FkDataGSI=door/component PK`, `ObjectCard=12`
- Default schedule: `FkICDataSchedule=25` ("Always valid")
- `doorExceptionMode`: 0=grant access, 1=deny access

## Endpoints

### GET /api/v1/users/:id/access-level

Get the cardholder's main access level.

**Response:**
```json
{ "accessLevelId": 69, "accessLevelName": "Staff" }
```

Returns `{ "accessLevelId": null, "accessLevelName": null }` if no access level is assigned.

---

### PUT /api/v1/users/:id/access-level

Set or clear the main access level.

**Body options:**
```json
{ "accessLevelId": 69 }              // assign by PK
{ "accessLevelName": "Bus Driver" }   // assign by name (case-insensitive)
{ "accessLevelId": 0 }               // clear
{ "accessLevelId": null }            // clear
```

**What it does:**
- If clearing: DELETEs the `ObjectCard=38` ItemCard row
- If setting and no existing row: INSERTs new ItemCard with `FkDataGSI=67, ObjectCard=38`
- If setting and row exists: UPDATEs `FkICDataAccessLevel`
- Bumps Card.TransactionId and Card.ItemCount
- Triggers gateway notification

---

### GET /api/v1/users/:id/access-exceptions

List door exceptions for a cardholder.

**Response:**
```json
{
  "count": 2,
  "exceptions": [
    {
      "componentId": 591,
      "scheduleId": 25,
      "scheduleName": "Always valid",
      "doorExceptionMode": 0
    }
  ]
}
```

---

### POST /api/v1/users/:id/access-exceptions

Add a door exception.

**Body:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `componentId` | number | required | Door/component PK |
| `scheduleId` | number | 25 | When active (25 = "Always valid") |
| `doorExceptionMode` | number | 0 | 0=grant, 1=deny |

Returns 409 if exception already exists for that component.

---

### DELETE /api/v1/users/:id/access-exceptions/:componentId

Remove a door exception. Returns 404 if not found.

## Transaction Handling

All write operations:
1. Update `Card.ItemCount` to reflect total ItemCard rows
2. Bump `Card.TransactionId` and set `Card.TransactionTag = NOW()`
3. Call `notifyGateway()` to push changes to door controllers
