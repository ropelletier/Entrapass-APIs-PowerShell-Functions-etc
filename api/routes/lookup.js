/**
 * routes/lookup.js — Reference data endpoints (access levels, card types)
 *
 * GET    /api/v1/access-levels          all access levels
 * POST   /api/v1/access-levels          create access level (via SmartService)
 * PUT    /api/v1/access-levels/:id      update access level (via SmartService)
 * GET    /api/v1/card-types             all card types
 * POST   /api/v1/card-types             create card type (via ADS)
 * PUT    /api/v1/card-types/:id         update card type (via ADS)
 */

'use strict';

const router = require('express').Router();
const { query, execute, esc, escStr } = require('../db');
const ss = require('../smartservice');

// ---------------------------------------------------------------------------
// GET /api/v1/access-levels
// ---------------------------------------------------------------------------
router.get('/access-levels', async (req, res) => {
  try {
    const rows = await query(
      'SELECT PkData AS id, Description1 AS name, Description2 AS description, AllValid AS allValid, NoneValid AS noneValid, State FROM AccessLevel ORDER BY Description1'
    );

    const levels = rows.map(r => ({
      id:          r.id,
      name:        r.name,
      description: r.description || '',
      allValid:    r.allValid === '1' || r.allValid === 'True',
      noneValid:   r.noneValid === '1' || r.noneValid === 'True',
      active:      r.State === '1',
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
// POST /api/v1/card-types — create via ADS
//
// No SmartService endpoint exists for card types. ADS writes are safe here
// because our GET reads from ADS and SmartService picks up the FkCardType
// value when it reads Card records.
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

    res.status(201).json({ ok: true, id: pkData, name, description: desc });
  } catch (err) {
    console.error('POST /card-types error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/v1/card-types/:id — update via ADS
//
// Updatable: name, description
// ---------------------------------------------------------------------------
router.put('/card-types/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'id must be a number' });

    const { name, description } = req.body;
    const sets = [];
    if (name !== undefined)        sets.push(`Description1 = ${escStr(name)}`);
    if (description !== undefined)  sets.push(`Description2 = ${escStr(description)}`);

    if (!sets.length) return res.status(400).json({ error: 'No recognised fields to update' });

    const existing = await query(`SELECT PkData FROM CardType WHERE PkData = ${esc(id)}`);
    if (!existing.length) return res.status(404).json({ error: `Card type ${id} not found` });

    await execute(`UPDATE CardType SET ${sets.join(', ')} WHERE PkData = ${esc(id)}`);

    res.json({ ok: true, id, updated: sets.length });
  } catch (err) {
    console.error('PUT /card-types error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
