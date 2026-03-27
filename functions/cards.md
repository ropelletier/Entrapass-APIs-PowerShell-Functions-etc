# Cards

Source: `api/routes/cards.js`

Card number assignments from the EntraPass `CardNumber` table. Each card is linked to a cardholder via `PkCard`.

## Endpoints

### GET /api/v1/cards

All card records with cardholder names and access levels.

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `user_id` | number | Cards for a specific cardholder |
| `access_level` | string | LIKE filter on access level name |
| `lost` | "true" | Only lost/stolen cards |
| `deactivated` | "true" | Only deactivated cards |

**Response:**
```json
{
  "count": 200,
  "cards": [
    {
      "cardholderID": "601",
      "cardholderName": "Jane Smith",
      "number": "00001234",
      "numberRaw": "1234",
      "lostStolen": false,
      "deactivated": false,
      "trace": false,
      "hasExpiry": false,
      "endDate": null,
      "accessLevel": "Staff"
    }
  ]
}
```

---

### GET /api/v1/cards/:number

Single card by formatted or raw number. Returns 404 if not found.

---

### POST /api/v1/cards

Assign a new card number to an existing cardholder.

**Required body:**

| Field | Type | Description |
|-------|------|-------------|
| `cardholderID` | number | Cardholder PkData |
| `cardNumber` | string | Raw card number |

**Optional:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cardNumberFormatted` | string | same as cardNumber | Display format |
| `cardSlot` | number | 1 | 1-based slot position (maps to CardPosition = slot - 1) |

**Write sequence (reverse-engineered from EntraPass desktop):**
1. Shift existing CardNumber positions up to make room at target slot
2. INSERT CardNumber row (CardDisplayFormat=7, CardDisplayMode=1)
3. UPDATE Card: CardNumberCount++, TransactionId++, TransactionTag=NOW()
4. Trigger gateway push (CardLastAction INSERT+DELETE)

**Response:** `201 { "ok": true, "cardholderID": 601, "cardNumber": "00001234", "cardSlot": 1 }`

---

### PUT /api/v1/cards/:number

Update card status fields.

**Updatable fields:**

| Field | Type | Description |
|-------|------|-------------|
| `lostStolen` | boolean | Mark as lost/stolen |
| `deactivated` | boolean | Deactivate the card |
| `endDate` | string | Set expiry date (also sets UseEndDate=1) |
| `number` | string | Change formatted card number |
| `numberRaw` | string | Change raw card number |
| `trace` | boolean | Enable card trace (sets CardNumber.Trace + Card.IsTrace) |

Also bumps TransactionId/TransactionTag and triggers gateway notification.

**Response:** `{ "ok": true, "number": "00001234", "updated": 1 }`

---

### DELETE /api/v1/cards/:number

Remove a card assignment.

**Write sequence:**
1. DELETE the CardNumber row
2. Shift remaining cards at higher positions down by one (fills the gap)
3. UPDATE Card: CardNumberCount--, TransactionId++, TransactionTag=NOW()
4. Trigger gateway push

**Response:** `{ "ok": true, "deleted": "00001234", "slotsShifted": true }`

## Card Slot Management

Cards use 0-based `CardPosition` in ADS but the API exposes 1-based `cardSlot`:
- Slot 1 (CardPosition 0) = primary card
- Slot 2 (CardPosition 1) = secondary card
- etc.

When inserting at an occupied slot, existing cards shift up. When deleting, higher cards shift down.
