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
 */

'use strict';

const router = require('express').Router();
const { query, execute, esc, escStr } = require('../db');

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
  n.UseEndDate            AS HasExpiry,
  n.EndDate               AS EndDate,
  al.Description1         AS AccessLevel
FROM CardNumber n
LEFT OUTER JOIN Card        c  ON n.PkCard = c.PkData
LEFT OUTER JOIN ItemCard    ic ON c.PkData = ic.FkDataCard
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
//              Defaults to 1. Maps to CardPosition = cardSlot - 1 in ADS.
//
// WARNING: Writes directly to the EntraPass ADS CardNumber table.
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const { cardholderID, cardNumber, cardNumberFormatted, cardSlot } = req.body;

    if (!cardholderID) return res.status(400).json({ error: 'cardholderID is required' });
    if (!cardNumber)   return res.status(400).json({ error: 'cardNumber is required' });

    const formatted     = cardNumberFormatted || cardNumber;
    const slot          = Math.max(1, parseInt(cardSlot || 1, 10));
    const cardPosition  = slot - 1;  // ADS CardPosition is 0-indexed
    const pkCard        = esc(parseInt(cardholderID, 10));

    // Verify the cardholder exists
    const existing = await query(`SELECT PkData, CardNumberCount FROM Card WHERE PkData = ${pkCard}`);
    if (!existing.length) return res.status(404).json({ error: 'Cardholder not found' });

    // Make room at the target slot — shift any cards at >= cardPosition up by one.
    // If no cards occupy that range this is a no-op, so no pre-check needed.
    await execute(
      `UPDATE CardNumber SET CardPosition = CardPosition + 1
       WHERE PkCard = ${pkCard} AND CardPosition >= ${cardPosition}`
    );

    await execute(
      `INSERT INTO CardNumber (PkCard, CardNumber, CardNumberFormatted, CardPosition)
       VALUES (${pkCard}, ${escStr(cardNumber)}, ${escStr(formatted)}, ${cardPosition})`
    );

    // Keep CardNumberCount in sync
    const currentCount = parseInt(existing[0].CardNumberCount || '0', 10);
    await execute(`UPDATE Card SET CardNumberCount = ${currentCount + 1} WHERE PkData = ${pkCard}`);

    res.status(201).json({ ok: true, cardholderID, cardNumber: formatted, cardSlot: slot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/v1/cards/:number — update card status
//
// Updatable: lostStolen, deactivated, endDate
// ---------------------------------------------------------------------------
router.put('/:number', async (req, res) => {
  try {
    const num = req.params.number;
    const { lostStolen, deactivated, endDate, number, numberRaw } = req.body;
    const sets = [];

    if (number      !== undefined) sets.push(`CardNumberFormatted = ${escStr(number)}`);
    if (numberRaw   !== undefined) sets.push(`CardNumber = ${escStr(numberRaw)}`);
    if (lostStolen  !== undefined) sets.push(`LostStolen = ${lostStolen  ? 1 : 0}`);
    if (deactivated !== undefined) sets.push(`Deactivated = ${deactivated ? 1 : 0}`);
    if (endDate     !== undefined) sets.push(`EndDate = ${escStr(endDate)}, UseEndDate = 1`);

    if (!sets.length) return res.status(400).json({ error: 'No recognised fields to update' });

    await execute(
      `UPDATE CardNumber SET ${sets.join(', ')}
       WHERE CardNumberFormatted = ${escStr(num)} OR CardNumber = ${escStr(num)}`
    );
    res.json({ ok: true, number: num, updated: sets.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/cards/:number — remove a card assignment
//
// After deletion, any remaining cards with a higher CardPosition than the
// deleted card are shifted down by one so there are no gaps in slot numbering.
// e.g. deleting slot 1 promotes slot 2 → slot 1, slot 3 → slot 2, etc.
// ---------------------------------------------------------------------------
router.delete('/:number', async (req, res) => {
  try {
    const num = escStr(req.params.number);

    // Fetch the card being deleted (need PkCard + CardPosition)
    const rows = await query(
      `SELECT PkCard, CardPosition FROM CardNumber WHERE CardNumberFormatted = ${num} OR CardNumber = ${num}`
    );
    if (!rows.length) return res.status(404).json({ error: 'Card not found' });

    const { PkCard, CardPosition } = rows[0];
    const deletedSlot = parseInt(CardPosition, 10);

    await execute(
      `DELETE FROM CardNumber WHERE CardNumberFormatted = ${num} OR CardNumber = ${num}`
    );

    // Shift higher-slot cards down to fill the gap
    await execute(
      `UPDATE CardNumber SET CardPosition = CardPosition - 1
       WHERE PkCard = ${esc(parseInt(PkCard, 10))} AND CardPosition > ${deletedSlot}`
    );

    // Keep CardNumberCount in sync
    const cardRows = await query(`SELECT CardNumberCount FROM Card WHERE PkData = ${esc(parseInt(PkCard, 10))}`);
    if (cardRows.length) {
      const newCount = Math.max(0, parseInt(cardRows[0].CardNumberCount || '0', 10) - 1);
      await execute(`UPDATE Card SET CardNumberCount = ${newCount} WHERE PkData = ${esc(parseInt(PkCard, 10))}`);
    }

    res.json({ ok: true, deleted: req.params.number, slotsShifted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
