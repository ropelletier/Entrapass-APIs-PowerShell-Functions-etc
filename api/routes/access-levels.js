/**
 * routes/access-levels.js
 *
 * GET    /api/v1/users/:id/access-level                 get cardholder's main access level
 * PUT    /api/v1/users/:id/access-level                 set or clear access level (via SmartService)
 * GET    /api/v1/users/:id/access-exceptions            list door exceptions
 * POST   /api/v1/users/:id/access-exceptions            add door exception (via SmartService)
 * DELETE /api/v1/users/:id/access-exceptions/:componentId  remove door exception (via SmartService)
 */

'use strict';

const router = require('express').Router();
const { query, execute, esc, escStr } = require('../db');
const ss = require('../smartservice');

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
// PUT /api/v1/users/:id/access-level — set or clear via SmartService
//
// Body: { accessLevelId: 69 }            - assign by PK
//       { accessLevelName: "Bus Driver" } - assign by name (case-insensitive)
//       { accessLevelId: 0 }             - clear
//       { accessLevelId: null }          - clear
// ---------------------------------------------------------------------------
router.put('/:id/access-level', async (req, res) => {
  try {
    const pkCard = parseInt(req.params.id, 10);
    if (isNaN(pkCard)) return res.status(400).json({ error: 'id must be a number' });

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

    // Verify cardholder exists in ADS
    const cardRows = await query(`SELECT PkData FROM Card WHERE PkData = ${esc(pkCard)}`);
    if (!cardRows.length) return res.status(404).json({ error: 'Cardholder not found' });

    // Verify access level exists (if not clearing)
    if (!clearing) {
      const alRows = await query(`SELECT PkData, Description1 FROM AccessLevel WHERE PkData = ${esc(fkLevel)}`);
      if (!alRows.length) return res.status(404).json({ error: `Access level ID ${fkLevel} not found` });
      accessLevelName = alRows[0].Description1;
    }

    // Build Card XML with ONLY ID + CardAccessLevels (no UserName — avoids duplicate bug)
    const fragment = ss.buildAccessLevelsFragment(clearing ? 0 : fkLevel);
    await ss.updateCardFull(pkCard, {}, [fragment]);

    res.json({
      ok:              true,
      cardholderId:    pkCard,
      accessLevelId:   clearing ? null : fkLevel,
      accessLevelName: clearing ? null : accessLevelName,
    });
  } catch (err) {
    console.error('PUT /access-level error:', err.message);
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
// POST /api/v1/users/:id/access-exceptions — add via SmartService
//
// Body: { componentId: 591 }
//       { componentId: 591, scheduleId: 25, doorExceptionMode: 0 }
// ---------------------------------------------------------------------------
router.post('/:id/access-exceptions', async (req, res) => {
  try {
    const pkCard = parseInt(req.params.id, 10);
    if (isNaN(pkCard)) return res.status(400).json({ error: 'id must be a number' });

    const { componentId, scheduleId, doorExceptionMode } = req.body;
    if (!componentId) return res.status(400).json({ error: 'componentId is required' });

    const doorId   = parseInt(componentId, 10);
    const schedId  = parseInt(scheduleId || ss.ALWAYS_VALID_SCHEDULE, 10);
    const prevent  = parseInt(doorExceptionMode || 0, 10) === 1;

    // Verify cardholder exists
    const cardRows = await query(`SELECT PkData FROM Card WHERE PkData = ${esc(pkCard)}`);
    if (!cardRows.length) return res.status(404).json({ error: 'Cardholder not found' });

    // Get current card from SmartService and parse existing exceptions
    const cardXml = await ss.getCard(pkCard);
    const existing = ss.parseCardDoorAccess(cardXml);

    // Check for duplicate
    if (existing.some(e => e.doorId === doorId)) {
      return res.status(409).json({ error: `Exception already exists for component ${componentId}` });
    }

    // Append new exception and PUT back the full list
    existing.push({ doorId, scheduleId: schedId, prevent });
    const fragment = ss.buildDoorAccessFragment(existing);
    await ss.updateCardFull(pkCard, {}, [fragment]);

    res.status(201).json({
      ok:                true,
      cardholderId:      pkCard,
      componentId:       doorId,
      scheduleId:        schedId,
      doorExceptionMode: prevent ? 1 : 0,
    });
  } catch (err) {
    console.error('POST /access-exceptions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/users/:id/access-exceptions/:componentId
//
// SmartService ignores empty CardDoorAccessList (treats as "no change"),
// so exception removal uses a direct ADS delete on the ItemCard row.
// This is safe because ItemCard is not cached by SmartService.
// ---------------------------------------------------------------------------
router.delete('/:id/access-exceptions/:componentId', async (req, res) => {
  try {
    const pkCard = parseInt(req.params.id, 10);
    const doorId = parseInt(req.params.componentId, 10);
    if (isNaN(pkCard) || isNaN(doorId)) return res.status(400).json({ error: 'id and componentId must be numbers' });

    // Verify cardholder exists
    const cardRows = await query(`SELECT PkData FROM Card WHERE PkData = ${esc(pkCard)}`);
    if (!cardRows.length) return res.status(404).json({ error: 'Cardholder not found' });

    // Verify exception exists
    const existing = await query(
      `SELECT FkDataCard FROM ItemCard WHERE FkDataCard = ${esc(pkCard)} AND ObjectCard = 12 AND FkDataGSI = ${esc(doorId)}`
    );
    if (!existing.length) return res.status(404).json({ error: `Exception not found for component ${doorId}` });

    // Delete the ItemCard row directly (SmartService can't clear exceptions via PUT)
    await execute(
      `DELETE FROM ItemCard WHERE FkDataCard = ${esc(pkCard)} AND ObjectCard = 12 AND FkDataGSI = ${esc(doorId)}`
    );

    res.json({ ok: true, cardholderId: pkCard, componentId: doorId });
  } catch (err) {
    console.error('DELETE /access-exceptions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
