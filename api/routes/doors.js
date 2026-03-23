/**
 * routes/doors.js — Door lock/unlock control
 *
 * GET  /api/v1/doors                  list all doors with current mode
 * GET  /api/v1/doors/:id              single door
 * POST /api/v1/doors/:id/unlock       unlock for N seconds (default 5), then relock
 * POST /api/v1/doors/:id/lock         lock for N seconds (default 5), then restore
 * POST /api/v1/doors/:id/normal       cancel override, restore normal mode immediately
 *
 * OperationMode values (KT-400 protocol):
 *   0 = Normal    — door follows its unlock schedule
 *   1 = Secured   — always locked regardless of schedule
 *   2 = Unsecured — always unlocked regardless of schedule
 *
 * NOTE: This writes to the EntraPass ADS database. The EntraPass Server service
 * must be running to propagate the mode change to the door controller hardware.
 * Expect up to a few seconds of delay before the physical door responds.
 * If the API service restarts while an override is active, the revert timer is
 * lost and the door stays in the overridden state until /normal is called.
 */

'use strict';

const router = require('express').Router();
const { query, execute, esc } = require('../db');

const MODE = { normal: 0, locked: 1, unlocked: 2 };
const MODE_LABEL = { 0: 'normal', 1: 'locked', 2: 'unlocked' };

// In-memory store: doorId (string) → { action, originalMode, endsAt, timer }
const overrides = new Map();

function cancelOverride(doorId) {
  const o = overrides.get(doorId);
  if (o) {
    clearTimeout(o.timer);
    overrides.delete(doorId);
  }
  return o || null;
}

function formatDoor(r) {
  const modeCode = parseInt(r.mode, 10);
  const ov       = overrides.get(String(r.id));
  return {
    id:       r.id,
    name:     r.name,
    mode:     MODE_LABEL[modeCode] || String(modeCode),
    modeCode,
    override: ov
      ? { action: ov.action, endsAt: ov.endsAt.toISOString(), secondsRemaining: Math.max(0, Math.round((ov.endsAt - Date.now()) / 1000)) }
      : null,
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/doors
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const rows = await query(
      'SELECT PkData AS id, Description1 AS name, OperationMode AS mode FROM Door ORDER BY Description1'
    );
    res.json({ count: rows.length, doors: rows.map(formatDoor) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/doors/:id
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const id   = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'id must be a number' });
    const rows = await query(
      `SELECT PkData AS id, Description1 AS name, OperationMode AS mode FROM Door WHERE PkData = ${id}`
    );
    if (!rows.length) return res.status(404).json({ error: 'Door not found' });
    res.json(formatDoor(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Shared helper: apply a mode change, schedule revert
// ---------------------------------------------------------------------------
async function applyOverride(req, res, action) {
  const id      = parseInt(req.params.id, 10);
  const seconds = Math.max(1, parseInt((req.body && req.body.seconds) || req.query.seconds || 5, 10));
  if (isNaN(id)) return res.status(400).json({ error: 'id must be a number' });

  // Fetch current state
  const rows = await query(
    `SELECT PkData AS id, Description1 AS name, OperationMode AS mode FROM Door WHERE PkData = ${id}`
  );
  if (!rows.length) return res.status(404).json({ error: 'Door not found' });

  // Determine what mode to restore to when the timer fires:
  // if there's already an active override, restore to *that* override's originalMode
  // so we always return to what the door was before any API intervention.
  const existing     = overrides.get(String(id));
  const originalMode = existing ? existing.originalMode : parseInt(rows[0].mode, 10);
  const newMode      = action === 'unlock' ? MODE.unlocked : MODE.locked;

  // Cancel existing timer (don't revert yet — we're about to set a new state)
  cancelOverride(String(id));

  // Apply new mode
  await execute(`UPDATE Door SET OperationMode = ${newMode} WHERE PkData = ${id}`);

  // Schedule revert
  const endsAt = new Date(Date.now() + seconds * 1000);
  const timer  = setTimeout(async () => {
    try {
      await execute(`UPDATE Door SET OperationMode = ${originalMode} WHERE PkData = ${id}`);
    } catch (e) {
      console.error(`[doors] Revert failed for door ${id}:`, e.message);
    }
    overrides.delete(String(id));
  }, seconds * 1000);

  overrides.set(String(id), { action, originalMode, endsAt, timer });

  res.json({
    ok:            true,
    doorId:        id,
    doorName:      rows[0].name,
    action,
    mode:          MODE_LABEL[newMode],
    seconds,
    revertsAt:     endsAt.toISOString(),
    revertsToMode: MODE_LABEL[originalMode] || String(originalMode),
  });
}

// ---------------------------------------------------------------------------
// GET|POST /api/v1/doors/:id/unlock
// Query/body: seconds=5  (default 5)
// ---------------------------------------------------------------------------
router.get('/:id/unlock',  async (req, res) => { try { await applyOverride(req, res, 'unlock'); } catch (err) { res.status(500).json({ error: err.message }); } });
router.post('/:id/unlock', async (req, res) => { try { await applyOverride(req, res, 'unlock'); } catch (err) { res.status(500).json({ error: err.message }); } });

// ---------------------------------------------------------------------------
// GET|POST /api/v1/doors/:id/lock
// Query/body: seconds=5  (default 5)
// ---------------------------------------------------------------------------
router.get('/:id/lock',  async (req, res) => { try { await applyOverride(req, res, 'lock'); } catch (err) { res.status(500).json({ error: err.message }); } });
router.post('/:id/lock', async (req, res) => { try { await applyOverride(req, res, 'lock'); } catch (err) { res.status(500).json({ error: err.message }); } });

// ---------------------------------------------------------------------------
// GET|POST /api/v1/doors/:id/normal — cancel override, restore normal mode immediately
// ---------------------------------------------------------------------------
async function handleNormal(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'id must be a number' });

    const rows = await query(
      `SELECT PkData AS id, Description1 AS name, OperationMode AS mode FROM Door WHERE PkData = ${id}`
    );
    if (!rows.length) return res.status(404).json({ error: 'Door not found' });

    cancelOverride(String(id));
    await execute(`UPDATE Door SET OperationMode = ${MODE.normal} WHERE PkData = ${id}`);

    res.json({ ok: true, doorId: id, doorName: rows[0].name, mode: 'normal' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
router.get('/:id/normal',  handleNormal);
router.post('/:id/normal', handleNormal);

module.exports = router;
