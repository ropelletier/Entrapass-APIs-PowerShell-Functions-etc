/**
 * routes/lookup.js — Reference data endpoints (access levels, card types)
 *
 * GET    /api/v1/access-levels          all access levels
 * POST   /api/v1/access-levels          create access level (via SmartService)
 * PUT    /api/v1/access-levels/:id      update access level (via SmartService)
 * GET    /api/v1/card-types             all card types
 *
 * DISABLED (no SmartService endpoint):
 * POST   /api/v1/card-types             create card type
 * PUT    /api/v1/card-types/:id         update card type
 */

'use strict';

const router = require('express').Router();
const { query } = require('../db');
const ss = require('../smartservice');

const NO_SS_ENDPOINT = 'This operation is disabled. No SmartService endpoint exists for card types. Please make this change through the EntraPass workstation instead.';

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
// POST /api/v1/access-levels — create via SmartService
//
// Required: { name }
// Optional: { description, allValid }
// ---------------------------------------------------------------------------
router.post('/access-levels', async (req, res) => {
  try {
    const { name, description, allValid = false } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const maxRows = await query('SELECT MAX(PkData) AS MaxPk FROM AccessLevel');
    const nextId = (parseInt((maxRows[0] && maxRows[0].MaxPk) || '0', 10) || 0) + 1;

    const resultId = await ss.createAccessLevel(nextId, name, description || name, !!allValid);

    res.status(201).json({ ok: true, id: resultId, name, description: description || name, allValid: !!allValid });
  } catch (err) {
    console.error('POST /access-levels error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/v1/access-levels/:id — update via SmartService
//
// Updatable: name, description
// ---------------------------------------------------------------------------
router.put('/access-levels/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'id must be a number' });

    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const existing = await query(`SELECT PkData FROM AccessLevel WHERE PkData = ${id}`);
    if (!existing.length) return res.status(404).json({ error: `Access level ${id} not found` });

    await ss.updateAccessLevel(id, name, description || name);

    res.json({ ok: true, id, name, description: description || name });
  } catch (err) {
    console.error('PUT /access-levels error:', err.message);
    res.status(500).json({ error: err.message });
  }
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
