/**
 * routes/access-levels.js
 *
 * GET    /api/v1/users/:id/access-level                 get cardholder's main access level
 * GET    /api/v1/users/:id/access-exceptions            list door exceptions
 *
 * DISABLED (direct ADS writes bypass SmartService and cause sync issues):
 * PUT    /api/v1/users/:id/access-level                 set (or clear) main access level
 * POST   /api/v1/users/:id/access-exceptions            add a door exception
 * DELETE /api/v1/users/:id/access-exceptions/:componentId  remove a door exception
 */

'use strict';

const router = require('express').Router();
const { query, esc, escStr } = require('../db');

const ADS_WRITE_ERROR = 'This operation is disabled. Direct ADS writes bypass SmartService and cause sync issues. Please make this change through the EntraPass workstation instead.';

// ---------------------------------------------------------------------------
// Helper: get total ItemCard row count for a cardholder
// ---------------------------------------------------------------------------
async function itemCount(pkCardEscaped) {
  const rows = await query(`SELECT COUNT(*) AS cnt FROM ItemCard WHERE FkDataCard = ${pkCardEscaped}`);
  return parseInt(rows[0].cnt || '0', 10);
}

// ---------------------------------------------------------------------------
// GET /api/v1/users/:id/access-level
// ---------------------------------------------------------------------------
router.get('/:id/access-level', async (req, res) => {
  try {
    const pkCard = esc(parseInt(req.params.id, 10));
    const rows = await query(
      `SELECT ic.FkICDataAccessLevel AS accessLevelId, al.Description1 AS accessLevelName
       FROM ItemCard ic
       LEFT JOIN AccessLevel al ON ic.FkICDataAccessLevel = al.PkData
       WHERE ic.FkDataCard = ${pkCard} AND ic.ObjectCard = 38`
    );
    if (!rows.length) return res.json({ accessLevelId: null, accessLevelName: null });
    const r = rows[0];
    const id = parseInt(r.accessLevelId, 10);
    res.json({
      accessLevelId:   id || null,
      accessLevelName: id ? (r.accessLevelName || '') : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/v1/users/:id/access-level — DISABLED
// ---------------------------------------------------------------------------
router.put('/:id/access-level', (req, res) => {
  res.status(403).json({ error: ADS_WRITE_ERROR });
});

// ---------------------------------------------------------------------------
// GET /api/v1/users/:id/access-exceptions
// ---------------------------------------------------------------------------
router.get('/:id/access-exceptions', async (req, res) => {
  try {
    const pkCard = esc(parseInt(req.params.id, 10));
    const rows = await query(
      `SELECT ic.FkDataGSI AS componentId, ic.FkICDataSchedule AS scheduleId,
              s.Description1 AS scheduleName, ic.DoorExceptionMode AS doorExceptionMode
       FROM ItemCard ic
       LEFT JOIN Schedule s ON ic.FkICDataSchedule = s.PkData
       WHERE ic.FkDataCard = ${pkCard} AND ic.ObjectCard = 12
       ORDER BY ic.FkDataGSI`
    );
    res.json({
      count: rows.length,
      exceptions: rows.map(r => ({
        componentId:       parseInt(r.componentId,       10),
        scheduleId:        parseInt(r.scheduleId        || '0', 10),
        scheduleName:      r.scheduleName               || '',
        doorExceptionMode: parseInt(r.doorExceptionMode || '0', 10),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/users/:id/access-exceptions
//
// Body: { componentId: 591 }
//       { componentId: 591, scheduleId: 25, doorExceptionMode: 0 }
//
//   scheduleId       — defaults to 25 ("Always valid")
//   doorExceptionMode — 0 = grant access (default), 1 = deny access
// ---------------------------------------------------------------------------
router.post('/:id/access-exceptions', async (req, res) => {
  try {
    const pkCard = esc(parseInt(req.params.id, 10));
    const { componentId, scheduleId, doorExceptionMode } = req.body;

    if (!componentId) return res.status(400).json({ error: 'componentId is required' });

    const fkGsi      = esc(parseInt(componentId,                   10));
    const fkSchedule = esc(parseInt(scheduleId        || 25,       10));
    const exMode     = esc(parseInt(doorExceptionMode || 0,        10));

    // Verify cardholder exists
    const cardRows = await query(`SELECT PkData, TransactionId FROM Card WHERE PkData = ${pkCard}`);
    if (!cardRows.length) return res.status(404).json({ error: 'Cardholder not found' });

    // Check if exception already exists for this component
    const existing = await query(
      `SELECT FkDataCard FROM ItemCard WHERE FkDataCard = ${pkCard} AND ObjectCard = 12 AND FkDataGSI = ${fkGsi}`
    );
    if (existing.length) return res.status(409).json({ error: `Exception already exists for component ${componentId}` });

    await execute(
      `INSERT INTO ItemCard (FkDataCard, FkDataGSI, ObjectCard, FkICDataAccessLevel, FkICDataSchedule, DoorExceptionMode)
       VALUES (${pkCard}, ${fkGsi}, 12, 0, ${fkSchedule}, ${exMode})`
    );

    const newCount    = await itemCount(pkCard);
    const currentTxId = parseInt(cardRows[0].TransactionId || '0', 10);
    await execute(
      `UPDATE Card SET ItemCount = ${newCount},
                       TransactionId  = ${currentTxId + 1},
                       TransactionTag = NOW()
       WHERE PkData = ${pkCard}`
    );

    await notifyGateway(pkCard);

    res.status(201).json({
      ok:                true,
      cardholderId:      req.params.id,
      componentId:       parseInt(componentId,       10),
      scheduleId:        parseInt(scheduleId || 25,  10),
      doorExceptionMode: parseInt(doorExceptionMode || 0, 10),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/users/:id/access-exceptions/:componentId
// ---------------------------------------------------------------------------
router.delete('/:id/access-exceptions/:componentId', async (req, res) => {
  try {
    const pkCard = esc(parseInt(req.params.id,          10));
    const fkGsi  = esc(parseInt(req.params.componentId, 10));

    const cardRows = await query(`SELECT PkData, TransactionId FROM Card WHERE PkData = ${pkCard}`);
    if (!cardRows.length) return res.status(404).json({ error: 'Cardholder not found' });

    const existing = await query(
      `SELECT FkDataCard FROM ItemCard WHERE FkDataCard = ${pkCard} AND ObjectCard = 12 AND FkDataGSI = ${fkGsi}`
    );
    if (!existing.length) return res.status(404).json({ error: `Exception not found for component ${req.params.componentId}` });

    await execute(
      `DELETE FROM ItemCard WHERE FkDataCard = ${pkCard} AND ObjectCard = 12 AND FkDataGSI = ${fkGsi}`
    );

    const newCount    = await itemCount(pkCard);
    const currentTxId = parseInt(cardRows[0].TransactionId || '0', 10);
    await execute(
      `UPDATE Card SET ItemCount = ${newCount},
                       TransactionId  = ${currentTxId + 1},
                       TransactionTag = NOW()
       WHERE PkData = ${pkCard}`
    );

    await notifyGateway(pkCard);

    res.json({ ok: true, cardholderId: req.params.id, componentId: parseInt(req.params.componentId, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
