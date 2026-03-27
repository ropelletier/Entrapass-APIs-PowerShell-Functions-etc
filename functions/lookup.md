# Reference Data (Access Levels & Card Types)

Source: `api/routes/lookup.js`

CRUD operations for access level and card type definitions (not per-cardholder assignments — see [access-levels.md](access-levels.md) for that).

## Endpoints

### GET /api/v1/access-levels

List all access level definitions.

**Response:**
```json
{
  "count": 12,
  "accessLevels": [
    {
      "id": "69",
      "name": "Staff",
      "description": "All staff doors",
      "allValid": false,
      "noneValid": false
    }
  ]
}
```

- `allValid=true` means access to all doors at all times (no schedule needed)
- `noneValid=true` means no access to any door

---

### POST /api/v1/access-levels

Create a new access level.

**Body:** `{ "name": "Volunteers", "description": "Volunteer access", "allValid": false }`

Auto-assigns PkData and Info1 (sequential). Inherits FkObject, FkParent, Cluster from existing records.

---

### PUT /api/v1/access-levels/:id

Update access level fields: `name`, `description`, `allValid`, `noneValid`.

---

### GET /api/v1/card-types

List all card type definitions.

**Response:**
```json
{
  "count": 3,
  "cardTypes": [
    { "id": "1", "name": "Standard", "description": "Standard badge" }
  ]
}
```

---

### POST /api/v1/card-types

Create a new card type.

**Body:** `{ "name": "Visitor", "description": "Temporary visitor badge" }`

---

### PUT /api/v1/card-types/:id

Update card type fields: `name`, `description`.
