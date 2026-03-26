/**
 * routes/cards.js — Card number endpoints
 *
 * GET  /api/v1/cards                    all card records
 * GET  /api/v1/cards?user_id=123        cards for a specific cardholder
 * GET  /api/v1/cards?access_level=Staff filter by access level (LIKE)
 * GET  /api/v1/cards?lost=true          filter lost/stolen cards
 * GET  /api/v1/cards?deactivated=true   filter deactivated cards
 * GET  /api/v1/cards/:number            single card by formatted or raw number
 * POST /api/v1/cards                    assign a new card to a cardholder
 * PUT  /api/v1/cards/:number            update card status fields
 * DELETE /api/v1/cards/:number          remove a card assignment
 *
 * Write operations (POST/PUT/DELETE) go through SmartService so changes are
 * immediately visible in the EntraPass workstation.
 */

'use strict';

const router = require('express').Router();
const { query, esc, escStr } = require('../db');
const ss = require('../smartservice');

// ---------------------------------------------------------------------------
// Base SELECT — CardNumber joined to Card and AccessLevel
// ---------------------------------------------------------------------------
const BASE_SQL = `
SELECT
  n.PkCard                AS CardholderID,
  c.UserName              AS CardholderName,
  n.CardNumberFormatted   AS CardNumber,
  n.CardNumber            AS CardNumberRaw,
  n.LostStolen            AS LostStolen,
  n.Deactivated           AS Deactivated,
  n.Trace                 AS Trace,
  n.UseEndDate            AS HasExpiry,
  n.EndDate               AS EndDate,
  al.Description1         AS AccessLevel
FROM CardNumber n
LEFT OUTER JOIN Card        c  ON n.PkCard = c.PkData
LEFT OUTER JOIN ItemCard    ic ON c.PkData = ic.FkDataCard AND ic.ObjectCard = 38
LEFT OUTER JOIN AccessLevel al ON ic.FkICDataAccessLevel = al.PkData
`;

function formatCard(r) {
  return {
    cardholderID:    r.CardholderID,
    cardholderName:  r.CardholderName  || '',
    number:          r.CardNumber,
    numberRaw:       r.CardNumberRaw   || '',
    lostStolen:      r.LostStolen      === '1' || r.LostStolen  === 'True',
    deactivated:     r.Deactivated     === '1' || r.Deactivated === 'True',
    trace:           r.Trace           === '1' || r.Trace       === 'True',
    hasExpiry:       r.HasExpiry       === '1' || r.HasExpiry   === 'True',
    endDate:         r.EndDate         || null,
    accessLevel:     r.AccessLevel     || '',
  };
}


// ---------------------------------------------------------------------------
// GET /api/v1/cards
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { user_id, access_level, lost, deactivated } = req.query;
    const conditions = [];

    if (user_id)      conditions.push(`n.PkCard = ${esc(parseInt(user_id, 10))}`);
    if (access_level) conditions.push(`UPPER(al.Description1) LIKE UPPER(${escStr('%' + access_level + '%')})`);
    if (lost === 'true')        conditions.push(`n.LostStolen = 1`);
    if (deactivated === 'true') conditions.push(`n.Deactivated = 1`);

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const rows  = await query(BASE_SQL + where + ' ORDER BY c.UserName, n.CardNumberFormatted');
    const cards = rows.map(formatCard);
    res.json({ count: cards.length, cards });
  } catch (err) {
    console.error('/cards error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/cards/:number
// ---------------------------------------------------------------------------
router.get('/:number', async (req, res) => {
  try {
    const num  = escStr(req.params.number);
    const rows = await query(
      BASE_SQL + `WHERE n.CardNumberFormatted = ${num} OR n.CardNumber = ${num}`
    );
    if (!rows.length) return res.status(404).json({ error: 'Card not found' });
    res.json(formatCard(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/cards — assign a new card number to an existing cardholder
//
// Required body: { cardholderID, cardNumber }
// Optional:      { cardNumberFormatted, cardSlot }
//
//   cardSlot — 1-based slot position (1 = primary card, 2 = secondary card, etc.)
//              Defaults to 1. Max 5 slots.
//
// Writes through SmartService so the workstation sees the change immediately.
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const { cardholderID, cardNumber, cardNumberFormatted, cardSlot } = req.body;

    if (!cardholderID) return res.status(400).json({ error: 'cardholderID is required' });
    if (!cardNumber)   return res.status(400).json({ error: 'cardNumber is required' });

    const formatted = cardNumberFormatted || cardNumber;
    const slot      = Math.max(1, Math.min(5, parseInt(cardSlot || 1, 10)));
    const pkCard    = parseInt(cardholderID, 10);

    // Verify cardholder exists
    const existing = await query(`SELECT PkData FROM Card WHERE PkData = ${esc(pkCard)}`);
    if (!existing.length) return res.status(404).json({ error: 'Cardholder not found' });

    // Read current card to find the first empty slot if needed, and shift existing cards
    const currentXml = await ss.getCard(pkCard);

    // Find which slots are occupied
    const occupied = {};
    for (let i = 1; i <= 5; i++) {
      const m = currentXml.match(new RegExp(`<CardNumber${i}>([^<]+)</CardNumber${i}>`));
      if (m && m[1]) occupied[i] = m[1];
    }

    // If the target slot is occupied, shift cards up to make room
    if (occupied[slot]) {
      const fields = {};
      // Shift from slot 5 down to target slot
      for (let i = 4; i >= slot; i--) {
        if (occupied[i]) {
          fields[`CardNumber${i + 1}`]        = occupied[i];
          fields[`DisplayCardNumber${i + 1}`] = 'True';
          // Preserve state for shifted card
          const stateMatch = currentXml.match(new RegExp(`<CardState${i}>([^<]*)</CardState${i}>`));
          if (stateMatch) fields[`CardState${i + 1}`] = stateMatch[1];
          const traceMatch = currentXml.match(new RegExp(`<Trace${i}>([^<]*)</Trace${i}>`));
          if (traceMatch) fields[`Trace${i + 1}`] = traceMatch[1];
        }
      }
      // Set the new card in the target slot
      fields[`CardNumber${slot}`]        = formatted;
      fields[`DisplayCardNumber${slot}`] = 'True';
      fields[`CardState${slot}`]         = 'Valid';
      fields[`Trace${slot}`]             = 'False';

      await ss.updateCard(pkCard, fields);
    } else {
      // Slot is empty, just set it
      await ss.updateCard(pkCard, {
        [`CardNumber${slot}`]:        formatted,
        [`DisplayCardNumber${slot}`]: 'True',
        [`CardState${slot}`]:         'Valid',
        [`Trace${slot}`]:             'False',
      });
    }

    res.status(201).json({ ok: true, cardholderID: pkCard, cardNumber: formatted, cardSlot: slot });
  } catch (err) {
    console.error('POST /cards error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/v1/cards/:number — update card status
//
// Updatable: lostStolen, deactivated, endDate, trace
// Writes through SmartService so the workstation sees the change immediately.
//
// SmartService CardState (overall, numeric): 0=Valid, 1=Invalid, 2=StolenLost
// Trace uses per-slot fields (Trace1-5) and overall (Trace).
// EndDate uses per-slot fields (EndDate1-5, UsingEndDate1-5).
// ---------------------------------------------------------------------------
router.put('/:number', async (req, res) => {
  try {
    const num = req.params.number;
    const { lostStolen, deactivated, endDate, trace } = req.body;

    if (lostStolen === undefined && deactivated === undefined &&
        endDate === undefined && trace === undefined) {
      return res.status(400).json({ error: 'No recognised fields to update' });
    }

    // Find the cardholder and slot for this card number
    const rows = await query(
      `SELECT n.PkCard, n.CardPosition FROM CardNumber n
       WHERE n.CardNumberFormatted = ${escStr(num)} OR n.CardNumber = ${escStr(num)}`
    );
    if (!rows.length) return res.status(404).json({ error: 'Card not found' });

    const pkCard = parseInt(rows[0].PkCard, 10);
    const slot   = parseInt(rows[0].CardPosition, 10) + 1;  // 0-based → 1-based

    // Build SmartService update fields
    const fields = {};
    let updated = 0;

    // Per-slot CardState: "Valid" or "StolenLost" (string enum name)
    if (lostStolen !== undefined || deactivated !== undefined) {
      fields[`CardState${slot}`] = (lostStolen || deactivated) ? 'StolenLost' : 'Valid';
      updated++;
    }

    if (trace !== undefined) {
      fields[`Trace${slot}`] = trace ? 'True' : 'False';
      updated++;
    }

    if (endDate !== undefined) {
      fields[`EndDate${slot}`]      = endDate;
      fields[`UsingEndDate${slot}`] = 'True';
      updated++;
    }

    await ss.updateCard(pkCard, fields);

    res.json({ ok: true, number: num, updated });
  } catch (err) {
    console.error('PUT /cards error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/cards/:number — remove a card assignment
//
// Clears the card slot via SmartService and shifts higher-slot cards down.
// ---------------------------------------------------------------------------
router.delete('/:number', async (req, res) => {
  try {
    const num = req.params.number;

    // Find the cardholder and slot for this card
    const rows = await query(
      `SELECT PkCard, CardPosition FROM CardNumber
       WHERE CardNumberFormatted = ${escStr(num)} OR CardNumber = ${escStr(num)}`
    );
    if (!rows.length) return res.status(404).json({ error: 'Card not found' });

    const pkCard      = parseInt(rows[0].PkCard, 10);
    const deletedSlot = parseInt(rows[0].CardPosition, 10) + 1;  // 0-based → 1-based

    // Read current card state from SmartService
    const currentXml = await ss.getCard(pkCard);

    // Collect all occupied slots
    const occupied = {};
    for (let i = 1; i <= 5; i++) {
      const m = currentXml.match(new RegExp(`<CardNumber${i}>([^<]+)</CardNumber${i}>`));
      if (m && m[1]) occupied[i] = m[1];
    }

    // Build update: shift cards above the deleted slot down, clear the last occupied slot
    const fields = {};

    // Shift cards down
    for (let i = deletedSlot; i <= 4; i++) {
      if (occupied[i + 1]) {
        fields[`CardNumber${i}`]        = occupied[i + 1];
        fields[`DisplayCardNumber${i}`] = 'True';
        // Preserve state
        const stateMatch = currentXml.match(new RegExp(`<CardState${i + 1}>([^<]*)</CardState${i + 1}>`));
        if (stateMatch) fields[`CardState${i}`] = stateMatch[1];
        const traceMatch = currentXml.match(new RegExp(`<Trace${i + 1}>([^<]*)</Trace${i + 1}>`));
        if (traceMatch) fields[`Trace${i}`] = traceMatch[1];
      } else {
        // No card above — clear this slot
        fields[`CardNumber${i}`]        = '';
        fields[`DisplayCardNumber${i}`] = 'False';
        break;
      }
    }

    // Clear the highest previously occupied slot (it shifted down or is the deleted one)
    const maxOccupied = Math.max(...Object.keys(occupied).map(Number));
    if (maxOccupied >= deletedSlot) {
      fields[`CardNumber${maxOccupied}`]        = '';
      fields[`DisplayCardNumber${maxOccupied}`] = 'False';
    }

    await ss.updateCard(pkCard, fields);

    res.json({ ok: true, deleted: num, slotsShifted: true });
  } catch (err) {
    console.error('DELETE /cards error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
