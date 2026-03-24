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
const { notifyGateway } = require('../card-helpers');

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
//              Defaults to 1. Maps to CardPosition = cardSlot - 1 in ADS.
//
// Replicates the full EntraPass write sequence (reverse-engineered):
//   1. Shift existing CardNumber positions up to make room
//   2. INSERT CardNumber row (with CardDisplayFormat=7, CardDisplayMode=1)
//   3. UPDATE Card: CardNumberCount++, TransactionId++, TransactionTag=now
//   4. INSERT + DELETE CardLastAction  ← triggers gateway push to controllers
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const { cardholderID, cardNumber, cardNumberFormatted, cardSlot } = req.body;

    if (!cardholderID) return res.status(400).json({ error: 'cardholderID is required' });
    if (!cardNumber)   return res.status(400).json({ error: 'cardNumber is required' });

    const formatted    = cardNumberFormatted || cardNumber;
    const slot         = Math.max(1, parseInt(cardSlot || 1, 10));
    const cardPosition = slot - 1;
    const pkCard       = esc(parseInt(cardholderID, 10));

    // Verify cardholder exists and read current transaction state
    const existing = await query(`SELECT PkData, CardNumberCount, TransactionId FROM Card WHERE PkData = ${pkCard}`);
    if (!existing.length) return res.status(404).json({ error: 'Cardholder not found' });

    const currentCount = parseInt(existing[0].CardNumberCount || '0', 10);
    const currentTxId  = parseInt(existing[0].TransactionId  || '0', 10);

    // 1. Make room at the target slot
    await execute(
      `UPDATE CardNumber SET CardPosition = CardPosition + 1
       WHERE PkCard = ${pkCard} AND CardPosition >= ${cardPosition}`
    );

    // 2. Insert new card number (CardDisplayFormat=7, CardDisplayMode=1 match EntraPass defaults)
    await execute(
      `INSERT INTO CardNumber (PkCard, CardNumber, CardNumberFormatted, CardPosition, CardDisplayFormat, CardDisplayMode)
       VALUES (${pkCard}, ${escStr(cardNumber)}, ${escStr(formatted)}, ${cardPosition}, 7, 1)`
    );

    // 3. Update Card row to reflect new count and bump transaction marker
    await execute(
      `UPDATE Card SET CardNumberCount = ${currentCount + 1},
                       TransactionId   = ${currentTxId + 1},
                       TransactionTag  = NOW()
       WHERE PkData = ${pkCard}`
    );

    // 4. Trigger gateway push to door controllers
    await notifyGateway(pkCard);

    res.status(201).json({ ok: true, cardholderID, cardNumber: formatted, cardSlot: slot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/v1/cards/:number — update card status
//
// Updatable: lostStolen, deactivated, endDate, trace
// trace=true  sets CardNumber.Trace=1 and Card.IsTrace=1
// trace=false sets CardNumber.Trace=0 and Card.IsTrace=0 if no other card is traced
// Also bumps TransactionId/TransactionTag and triggers gateway notification.
// ---------------------------------------------------------------------------
router.put('/:number', async (req, res) => {
  try {
    const num = req.params.number;
    const { lostStolen, deactivated, endDate, number, numberRaw, trace } = req.body;
    const sets = [];

    if (number      !== undefined) sets.push(`CardNumberFormatted = ${escStr(number)}`);
    if (numberRaw   !== undefined) sets.push(`CardNumber = ${escStr(numberRaw)}`);
    if (lostStolen  !== undefined) sets.push(`LostStolen = ${lostStolen  ? 1 : 0}`);
    if (deactivated !== undefined) sets.push(`Deactivated = ${deactivated ? 1 : 0}`);
    if (endDate     !== undefined) sets.push(`EndDate = ${escStr(endDate)}, UseEndDate = 1`);
    if (trace       !== undefined) sets.push(`Trace = ${trace ? 1 : 0}`);

    if (!sets.length) return res.status(400).json({ error: 'No recognised fields to update' });

    await execute(
      `UPDATE CardNumber SET ${sets.join(', ')}
       WHERE CardNumberFormatted = ${escStr(num)} OR CardNumber = ${escStr(num)}`
    );

    // Bump transaction marker on the Card row and trigger gateway
    const cardRow = await query(
      `SELECT c.PkData, c.TransactionId FROM Card c
       JOIN CardNumber n ON c.PkData = n.PkCard
       WHERE n.CardNumberFormatted = ${escStr(num)} OR n.CardNumber = ${escStr(num)}`
    );
    if (cardRow.length) {
      const pkCard      = esc(parseInt(cardRow[0].PkData, 10));
      const currentTxId = parseInt(cardRow[0].TransactionId || '0', 10);

      // Sync Card.IsTrace: 1 if any card for this cardholder has Trace=1
      const cardSets = [`TransactionId = ${currentTxId + 1}`, `TransactionTag = NOW()`];
      if (trace !== undefined) {
        const traced = await query(`SELECT COUNT(*) AS cnt FROM CardNumber WHERE PkCard = ${pkCard} AND Trace = 1`);
        cardSets.push(`IsTrace = ${parseInt(traced[0].cnt, 10) > 0 ? 1 : 0}`);
      }

      await execute(`UPDATE Card SET ${cardSets.join(', ')} WHERE PkData = ${pkCard}`);
      await notifyGateway(pkCard);
    }

    res.json({ ok: true, number: num, updated: sets.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/cards/:number — remove a card assignment
//
// Replicates the full EntraPass write sequence (reverse-engineered):
//   1. DELETE the CardNumber row
//   2. Shift remaining cards at higher positions down by one
//   3. UPDATE Card: CardNumberCount--, TransactionId++, TransactionTag=now
//   4. INSERT + DELETE CardLastAction  ← triggers gateway push to controllers
// ---------------------------------------------------------------------------
router.delete('/:number', async (req, res) => {
  try {
    const num = escStr(req.params.number);

    // Fetch the card being deleted (need PkCard + CardPosition)
    const rows = await query(
      `SELECT PkCard, CardPosition FROM CardNumber WHERE CardNumberFormatted = ${num} OR CardNumber = ${num}`
    );
    if (!rows.length) return res.status(404).json({ error: 'Card not found' });

    const pkCard      = esc(parseInt(rows[0].PkCard, 10));
    const deletedSlot = parseInt(rows[0].CardPosition, 10);

    // Read current Card transaction state before modifying
    const cardRows = await query(`SELECT CardNumberCount, TransactionId FROM Card WHERE PkData = ${pkCard}`);
    const currentCount = cardRows.length ? parseInt(cardRows[0].CardNumberCount || '0', 10) : 0;
    const currentTxId  = cardRows.length ? parseInt(cardRows[0].TransactionId  || '0', 10) : 0;

    // 1. Delete the card number
    await execute(`DELETE FROM CardNumber WHERE CardNumberFormatted = ${num} OR CardNumber = ${num}`);

    // 2. Shift higher-slot cards down to fill the gap
    await execute(
      `UPDATE CardNumber SET CardPosition = CardPosition - 1
       WHERE PkCard = ${pkCard} AND CardPosition > ${deletedSlot}`
    );

    // 3. Update Card row
    await execute(
      `UPDATE Card SET CardNumberCount = ${Math.max(0, currentCount - 1)},
                       TransactionId   = ${currentTxId + 1},
                       TransactionTag  = NOW()
       WHERE PkData = ${pkCard}`
    );

    // 4. Trigger gateway push to door controllers
    await notifyGateway(pkCard);

    res.json({ ok: true, deleted: req.params.number, slotsShifted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
