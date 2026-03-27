/**
 * routes/doors.js — Door control
 *
 * GET  /api/v1/doors                  list all doors with current mode
 * GET  /api/v1/doors/:id              single door
 * POST /api/v1/doors/:id/unlock       momentary unlock for N seconds (default 5)
 * POST /api/v1/doors/:id/lock         lock (secured) until /normal
 * POST /api/v1/doors/:id/normal       restore to schedule
 * POST /api/v1/doors/:id/arm          arm door alarm
 * POST /api/v1/doors/:id/disarm       disarm door alarm
 * POST /api/v1/doors/:id/one-time-access  grant single access
 *
 * Control operations go through SmartService so the command reaches the
 * door controller directly (no ADS polling delay) and generates proper
 * EntraPass audit events.
 */

'use strict';

const router = require('express').Router();
const { query, esc } = require('../db');
const ss = require('../smartservice');

const MODE_LABEL = { 0: 'normal', 1: 'locked', 2: 'unlocked' };

function formatDoor(r) {
  const modeCode = parseInt(r.mode, 10);
  return {
    id:       r.id,
    name:     r.name,
    mode:     MODE_LABEL[modeCode] || String(modeCode),
    modeCode,
  };
}

// ---------------------------------------------------------------------------
// SmartService door command helper
// ---------------------------------------------------------------------------
async function ssDoorCommand(endpoint, doorId, extraParams = {}) {
  const params = { id: String(doorId), ...extraParams };
  const res = await ss.ssCall('PUT', endpoint, { query: params, body: '', contentType: 'application/xml' });
  if (res.status !== 200) {
    throw new Error(`SmartService ${endpoint} returned ${res.status}: ${res.body}`);
  }
  // Response is <ServiceCommandResult>OK</ServiceCommandResult> or error text
  const match = res.body.match(/<ServiceCommandResult>([^<]*)<\/ServiceCommandResult>/);
  const result = match ? match[1] : res.body;
  if (result !== 'OK') {
    throw new Error(`SmartService ${endpoint}: ${result}`);
  }
  return result;
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
    const id = parseInt(req.params.id, 10);
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
// POST /api/v1/doors/:id/unlock — momentary unlock for N seconds
// Body: { "seconds": 5 }  (default 5, max 3600)
// Uses SmartService TemporarilyUnlockDoor — the controller handles the revert.
// ---------------------------------------------------------------------------
async function handleUnlock(req, res) {
  try {
    const id      = parseInt(req.params.id, 10);
    const seconds = Math.max(1, Math.min(3600, parseInt((req.body && req.body.seconds) || req.query.seconds || 5, 10)));
    if (isNaN(id)) return res.status(400).json({ error: 'id must be a number' });

    const rows = await query(
      `SELECT PkData AS id, Description1 AS name FROM Door WHERE PkData = ${id}`
    );
    if (!rows.length) return res.status(404).json({ error: 'Door not found' });

    await ssDoorCommand('TemporarilyUnlockDoor', id, { delay: String(seconds) });

    res.json({
      ok:       true,
      doorId:   id,
      doorName: rows[0].name,
      action:   'unlock',
      seconds,
      revertsAt: new Date(Date.now() + seconds * 1000).toISOString(),
    });
  } catch (err) {
    console.error('POST /doors/unlock error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
router.get('/:id/unlock',  handleUnlock);
router.post('/:id/unlock', handleUnlock);

// ---------------------------------------------------------------------------
// POST /api/v1/doors/:id/lock — lock door (secured) until /normal
// ---------------------------------------------------------------------------
async function handleLock(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'id must be a number' });

    const rows = await query(
      `SELECT PkData AS id, Description1 AS name FROM Door WHERE PkData = ${id}`
    );
    if (!rows.length) return res.status(404).json({ error: 'Door not found' });

    await ssDoorCommand('LockDoor', id);

    res.json({ ok: true, doorId: id, doorName: rows[0].name, action: 'lock', mode: 'locked' });
  } catch (err) {
    console.error('POST /doors/lock error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
router.get('/:id/lock',  handleLock);
router.post('/:id/lock', handleLock);

// ---------------------------------------------------------------------------
// POST /api/v1/doors/:id/normal — restore door to schedule
// ---------------------------------------------------------------------------
async function handleNormal(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'id must be a number' });

    const rows = await query(
      `SELECT PkData AS id, Description1 AS name FROM Door WHERE PkData = ${id}`
    );
    if (!rows.length) return res.status(404).json({ error: 'Door not found' });

    await ssDoorCommand('DoorBackToSchedule', id);

    res.json({ ok: true, doorId: id, doorName: rows[0].name, action: 'normal', mode: 'normal' });
  } catch (err) {
    console.error('POST /doors/normal error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
router.get('/:id/normal',  handleNormal);
router.post('/:id/normal', handleNormal);

// ---------------------------------------------------------------------------
// POST /api/v1/doors/:id/arm — arm door alarm
// ---------------------------------------------------------------------------
router.post('/:id/arm', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'id must be a number' });

    const rows = await query(
      `SELECT PkData AS id, Description1 AS name FROM Door WHERE PkData = ${id}`
    );
    if (!rows.length) return res.status(404).json({ error: 'Door not found' });

    await ssDoorCommand('ArmDoor', id, { forceSend: '0' });

    res.json({ ok: true, doorId: id, doorName: rows[0].name, action: 'arm' });
  } catch (err) {
    console.error('POST /doors/arm error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/doors/:id/disarm — disarm door alarm
// ---------------------------------------------------------------------------
router.post('/:id/disarm', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'id must be a number' });

    const rows = await query(
      `SELECT PkData AS id, Description1 AS name FROM Door WHERE PkData = ${id}`
    );
    if (!rows.length) return res.status(404).json({ error: 'Door not found' });

    await ssDoorCommand('DisarmDoor', id, { forceSend: '0' });

    res.json({ ok: true, doorId: id, doorName: rows[0].name, action: 'disarm' });
  } catch (err) {
    console.error('POST /doors/disarm error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/doors/:id/one-time-access — grant single access
// ---------------------------------------------------------------------------
router.post('/:id/one-time-access', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'id must be a number' });

    const rows = await query(
      `SELECT PkData AS id, Description1 AS name FROM Door WHERE PkData = ${id}`
    );
    if (!rows.length) return res.status(404).json({ error: 'Door not found' });

    await ssDoorCommand('OneTimeAccess', id);

    res.json({ ok: true, doorId: id, doorName: rows[0].name, action: 'one-time-access' });
  } catch (err) {
    console.error('POST /doors/one-time-access error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
