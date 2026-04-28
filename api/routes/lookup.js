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
// POST /api/v1/card-types — create a new card type
//
// Required: { name }
// Optional: { description }
// ---------------------------------------------------------------------------
router.post('/card-types', async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const meta = await query(
      'SELECT MAX(PkData) AS MaxPk, MIN(FkObject) AS FkObj, MIN(FkParent) AS FkPar, MAX(Info1) AS MaxInfo FROM CardType'
    );
    const m      = meta[0] || {};
    const pkData = (parseInt(m.MaxPk || '0', 10) || 0) + 1;
    const info1  = (parseInt(m.MaxInfo || '0', 10) || 0) + 1;
    const fkObj  = parseInt(m.FkObj || '8', 10);
    const fkPar  = parseInt(m.FkPar || '16', 10);
    const desc   = description || name;

    await execute(
      `INSERT INTO CardType
         (PkData, FkObject, FkParent, MasterAccount, Account, Cluster,
          NTM, GSI, Site, Info1, Info2, Info3, Info4,
          State, Description1, Description2, FkAssignCardAccessGroup, NotifyBeforeAssign)
       VALUES
         (${pkData}, ${fkObj}, ${fkPar}, 0, 0, 0,
          0, 0, 0, ${info1}, 0, 0, 0,
          2, ${escStr(name)}, ${escStr(desc)}, 0, 0)`
    );

    res.status(201).json({ id: pkData, name, description: desc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/v1/card-types/:id — update a card type
//
// Updatable: name, description
// ---------------------------------------------------------------------------
router.put('/card-types/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'id must be a number' });

    const fieldMap = {
      name:        'Description1',
      description: 'Description2',
    };
    const sets = [];
    for (const [bodyKey, colName] of Object.entries(fieldMap)) {
      if (req.body[bodyKey] !== undefined) sets.push(`${colName} = ${escStr(req.body[bodyKey])}`);
    }

    if (!sets.length) return res.status(400).json({ error: 'No recognised fields to update' });

    await execute(`UPDATE CardType SET ${sets.join(', ')} WHERE PkData = ${id}`);
    res.json({ ok: true, id, updated: sets.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
