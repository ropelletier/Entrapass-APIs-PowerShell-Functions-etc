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
const { query, esc } = require('../db');

const ADS_WRITE_ERROR = 'This operation is disabled. Direct ADS writes bypass SmartService and cause sync issues. Please make this change through the EntraPass workstation instead.';

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
// POST /api/v1/users/:id/access-exceptions — DISABLED
// ---------------------------------------------------------------------------
router.post('/:id/access-exceptions', (req, res) => {
  res.status(403).json({ error: ADS_WRITE_ERROR });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/users/:id/access-exceptions/:componentId — DISABLED
// ---------------------------------------------------------------------------
router.delete('/:id/access-exceptions/:componentId', (req, res) => {
  res.status(403).json({ error: ADS_WRITE_ERROR });
});

module.exports = router;
