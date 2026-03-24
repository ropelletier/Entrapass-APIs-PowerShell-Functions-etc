/**
 * routes/access-levels.js
 *
 * GET    /api/v1/access-levels                          list all access levels
 * GET    /api/v1/users/:id/access-level                 get cardholder's main access level
 * PUT    /api/v1/users/:id/access-level                 set (or clear) main access level
 * GET    /api/v1/users/:id/access-exceptions            list door exceptions
 * POST   /api/v1/users/:id/access-exceptions            add a door exception
 * DELETE /api/v1/users/:id/access-exceptions/:componentId  remove a door exception
 *
 * Reverse-engineered from Watch-KantechChanges monitor sessions:
 *
 * Main access level (ObjectCard=38):
 *   - One ItemCard row per cardholder: FkDataGSI=67, ObjectCard=38
 *   - FkICDataAccessLevel = access level PK
 *   - To SET: INSERT with FkDataGSI=67/ObjectCard=38, or UPDATE existing
 *   - To CLEAR: DELETE the ObjectCard=38 row (desktop does DELETE, not update to 0)
 *   - Card.ItemCount = total ItemCard rows for this cardholder (all types)
 *
 * Door exceptions (ObjectCard=12):
 *   - One ItemCard row per door: FkDataGSI=door/component PK, ObjectCard=12
 *   - FkICDataSchedule=25 ("Always valid"), FkICDataAccessLevel=0
 *   - Card.ItemCount counts these rows too
 */

'use strict';

const router = require('express').Router();
const { query, execute, esc, escStr } = require('../db');
const { notifyGateway } = require('../card-helpers');

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
// PUT /api/v1/users/:id/access-level
//
// Body: { accessLevelId: 69 }            - assign by PK
//       { accessLevelName: "Bus Driver" } - assign by name (case-insensitive)
//       { accessLevelId: 0 }             - clear (removes ObjectCard=38 row)
//       { accessLevelId: null }          - same as clear
// ---------------------------------------------------------------------------
router.put('/:id/access-level', async (req, res) => {
  try {
    const pkCard = esc(parseInt(req.params.id, 10));
    let { accessLevelId, accessLevelName } = req.body;

    // Resolve by name if ID not provided
    if ((accessLevelId === undefined || accessLevelId === null) && accessLevelName) {
      const found = await query(
        `SELECT PkData FROM AccessLevel WHERE UPPER(Description1) = UPPER(${escStr(accessLevelName)})`
      );
      if (!found.length) return res.status(404).json({ error: `Access level not found: ${accessLevelName}` });
      accessLevelId = parseInt(found[0].PkData, 10);
    }

    const clearing = !accessLevelId || parseInt(accessLevelId, 10) === 0;
    const fkLevel  = clearing ? 0 : parseInt(accessLevelId, 10);

    // Verify cardholder exists
    const cardRows = await query(`SELECT PkData, TransactionId FROM Card WHERE PkData = ${pkCard}`);
    if (!cardRows.length) return res.status(404).json({ error: 'Cardholder not found' });

    // Check for existing main access level row (ObjectCard=38)
    const existing = await query(`SELECT FkDataCard FROM ItemCard WHERE FkDataCard = ${pkCard} AND ObjectCard = 38`);

    if (clearing) {
      // Delete the main access level row (desktop behavior: DELETE, not update to 0)
      if (existing.length) {
        await execute(`DELETE FROM ItemCard WHERE FkDataCard = ${pkCard} AND ObjectCard = 38`);
      }
    } else {
      // Verify the access level exists
      const alRows = await query(`SELECT PkData, Description1 FROM AccessLevel WHERE PkData = ${esc(fkLevel)}`);
      if (!alRows.length) return res.status(404).json({ error: `Access level ID ${fkLevel} not found` });

      if (existing.length) {
        await execute(
          `UPDATE ItemCard SET FkICDataAccessLevel = ${esc(fkLevel)} WHERE FkDataCard = ${pkCard} AND ObjectCard = 38`
        );
      } else {
        // INSERT new main access level row.
        // FkDataGSI=67, ObjectCard=38 are confirmed installation-wide constants for
        // main access level rows (138 rows all use this combination).
        await execute(
          `INSERT INTO ItemCard (FkDataCard, FkDataGSI, ObjectCard, FkICDataAccessLevel)
           VALUES (${pkCard}, 67, 38, ${esc(fkLevel)})`
        );
      }
      accessLevelName = alRows[0].Description1;
    }

    // ItemCount = total ItemCard rows after change
    const newCount    = await itemCount(pkCard);
    const currentTxId = parseInt((await query(`SELECT TransactionId FROM Card WHERE PkData = ${pkCard}`))[0].TransactionId || '0', 10);
    await execute(
      `UPDATE Card SET ItemCount = ${newCount},
                       TransactionId  = ${currentTxId + 1},
                       TransactionTag = NOW()
       WHERE PkData = ${pkCard}`
    );

    await notifyGateway(pkCard);

    res.json({
      ok:              true,
      cardholderId:    req.params.id,
      accessLevelId:   clearing ? null : fkLevel,
      accessLevelName: clearing ? null : accessLevelName,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
