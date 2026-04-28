/**
 * routes/lookup.js — Reference data endpoints (access levels, card types)
 *
 * GET    /api/v1/access-levels          all access levels
 * GET    /api/v1/card-types             all card types
 *
 * DISABLED (direct ADS writes bypass SmartService and cause sync issues):
 * POST   /api/v1/access-levels          create access level
 * PUT    /api/v1/access-levels/:id      update access level
 * POST   /api/v1/card-types             create card type
 * PUT    /api/v1/card-types/:id         update card type
 */

'use strict';

const router = require('express').Router();
const { query } = require('../db');

const ADS_WRITE_ERROR = 'This operation is disabled. Direct ADS writes bypass SmartService and cause sync issues. Please make this change through the EntraPass workstation instead.';

// ---------------------------------------------------------------------------
// GET /api/v1/access-levels
// ---------------------------------------------------------------------------
router.get('/access-levels', async (req, res) => {
  try {
    const rows = await query(
      'SELECT PkData AS id, Description1 AS name, Description2 AS description, AllValid AS allValid, NoneValid AS noneValid FROM AccessLevel ORDER BY Description1'
    );
    const levels = rows.map(r => ({
      id:          r.id,
      name:        r.name,
      description: r.description || '',
      allValid:    r.allValid === '1' || r.allValid === 'True',
      noneValid:   r.noneValid === '1' || r.noneValid === 'True',
    }));
    res.json({ count: levels.length, accessLevels: levels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/access-levels — DISABLED
// ---------------------------------------------------------------------------
router.post('/access-levels', (req, res) => {
  res.status(403).json({ error: ADS_WRITE_ERROR });
});

// ---------------------------------------------------------------------------
// PUT /api/v1/access-levels/:id — DISABLED
// ---------------------------------------------------------------------------
router.put('/access-levels/:id', (req, res) => {
  res.status(403).json({ error: ADS_WRITE_ERROR });
});

// ---------------------------------------------------------------------------
// GET /api/v1/card-types
// ---------------------------------------------------------------------------
router.get('/card-types', async (req, res) => {
  try {
    const rows = await query(
      'SELECT PkData AS id, Description1 AS name, Description2 AS description FROM CardType ORDER BY Description1'
    );
    res.json({ count: rows.length, cardTypes: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/card-types — DISABLED
// ---------------------------------------------------------------------------
router.post('/card-types', (req, res) => {
  res.status(403).json({ error: ADS_WRITE_ERROR });
});

// ---------------------------------------------------------------------------
// PUT /api/v1/card-types/:id — DISABLED
// ---------------------------------------------------------------------------
router.put('/card-types/:id', (req, res) => {
  res.status(403).json({ error: ADS_WRITE_ERROR });
});

module.exports = router;
