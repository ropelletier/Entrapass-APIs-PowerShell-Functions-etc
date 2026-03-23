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
// Optional:      { cardNumberFormatted }
//
// WARNING: Writes directly to the EntraPass ADS CardNumber table.
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const { cardholderID, cardNumber, cardNumberFormatted } = req.body;

    if (!cardholderID) return res.status(400).json({ error: 'cardholderID is required' });
    if (!cardNumber)   return res.status(400).json({ error: 'cardNumber is required' });

    const formatted = cardNumberFormatted || cardNumber;

    // Verify the cardholder exists
    const existing = await query(`SELECT PkData FROM Card WHERE PkData = ${esc(parseInt(cardholderID, 10))}`);
    if (!existing.length) return res.status(404).json({ error: 'Cardholder not found' });

    const sql = `
      INSERT INTO CardNumber (PkCard, CardNumber, CardNumberFormatted)
      VALUES (${esc(parseInt(cardholderID, 10))}, ${escStr(cardNumber)}, ${escStr(formatted)})
    `;

    await execute(sql);
    res.status(201).json({ ok: true, cardholderID, cardNumber: formatted });
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
// ---------------------------------------------------------------------------
router.delete('/:number', async (req, res) => {
  try {
    const num = escStr(req.params.number);
    const rows = await query(
      `SELECT CardNumberFormatted FROM CardNumber WHERE CardNumberFormatted = ${num} OR CardNumber = ${num}`
    );
    if (!rows.length) return res.status(404).json({ error: 'Card not found' });

    await execute(
      `DELETE FROM CardNumber WHERE CardNumberFormatted = ${num} OR CardNumber = ${num}`
    );
    res.json({ ok: true, deleted: req.params.number });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
